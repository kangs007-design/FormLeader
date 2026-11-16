"use strict";
/**
 * 개별기능[form-template]: 서식(Form) 입력값 검증/정규화
 *
 * 서식 구조
 *  { name, docType, keywords[], keys: [{
 *      name, page, mode('rect'|'line'|'cell'|'word'),
 *      rect:{x,y,w,h} (페이지 대비 0~1 비율),
 *      required, verify(검증키), pattern, min, max(범위), exceptValues[](예외값)
 *  }] }
 */
const { AppError } = require("../../common/app.error");
const { validateOptions } = require("../ocr-connect/engine-policy.util");

const MODES = ["rect", "line", "cell", "word"];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const optNum = (v) =>
  v === undefined || v === null || v === "" ? null : Number(v);

function normalizeKey(raw, index) {
  const where = `keys[${index}]`;
  const name = String(raw.name || "").trim();
  if (!name) throw AppError.badRequest(`${where}: Key 이름이 필요합니다.`);

  const r = raw.rect || {};
  const rect = {
    x: Number(r.x),
    y: Number(r.y),
    w: Number(r.w),
    h: Number(r.h),
  };
  if (![rect.x, rect.y, rect.w, rect.h].every(isNum))
    throw AppError.badRequest(
      `${where}(${name}): rect(x,y,w,h) 값이 필요합니다.`,
    );
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.w <= 0 ||
    rect.h <= 0 ||
    rect.x + rect.w > 1.0001 ||
    rect.y + rect.h > 1.0001
  ) {
    throw AppError.badRequest(
      `${where}(${name}): rect 는 0~1 비율 범위 안이어야 합니다.`,
    );
  }

  const mode = raw.mode || "rect";
  if (!MODES.includes(mode))
    throw AppError.badRequest(
      `${where}(${name}): mode 는 ${MODES.join("/")} 중 하나여야 합니다.`,
    );

  const page = raw.page === undefined ? 1 : Number(raw.page);
  if (!Number.isInteger(page) || page < 1)
    throw AppError.badRequest(
      `${where}(${name}): page 는 1 이상의 정수여야 합니다.`,
    );

  const pattern = raw.pattern ? String(raw.pattern) : "";
  if (pattern) {
    if (pattern.length > 200)
      throw AppError.badRequest(`${where}(${name}): pattern 이 너무 깁니다.`);
    try {
      new RegExp(pattern);
    } catch (_) {
      throw AppError.badRequest(
        `${where}(${name}): pattern 정규식이 올바르지 않습니다.`,
      );
    }
  }

  const min = optNum(raw.min);
  const max = optNum(raw.max);
  if ((min !== null && !isNum(min)) || (max !== null && !isNum(max)))
    throw AppError.badRequest(`${where}(${name}): min/max 는 숫자여야 합니다.`);
  if (min !== null && max !== null && min > max)
    throw AppError.badRequest(
      `${where}(${name}): min 이 max 보다 클 수 없습니다.`,
    );

  const exceptValues = Array.isArray(raw.exceptValues)
    ? raw.exceptValues.map(String).filter(Boolean)
    : [];

  const pattern2 = normalizePattern(raw.pattern2, where);
  const exceptPattern = normalizePattern(raw.exceptPattern, where);
  const selection = {};
  for (const field of [
    "lineIndex",
    "wordIndex",
    "tableIndex",
    "row",
    "column",
  ]) {
    if (raw[field] === undefined || raw[field] === "") continue;
    const n = Number(raw[field]);
    if (!Number.isInteger(n) || n < 0 || n > 10000)
      throw AppError.badRequest(
        `${name}: ${field} 값은 0 이상의 정수여야 합니다.`,
      );
    selection[field] = n;
  }
  const searchType = raw.searchType || "";
  if (
    searchType &&
    ![
      "FindRegion",
      "FindLine",
      "FindWord",
      "FindRow",
      "FindRightRow",
      "FindCol",
      "FindBottomCol",
    ].includes(searchType)
  )
    throw AppError.badRequest("지원하지 않는 SearchAPI 방식입니다.");
  return {
    name,
    page,
    mode,
    rect,
    required: !!raw.required,
    verify: !!raw.verify,
    pattern,
    pattern2,
    exceptPattern,
    min,
    max,
    exceptValues,
    searchType,
    searchKey: String(raw.searchKey || "").slice(0, 500),
    ...selection,
  };
}

function normalizePattern(value, where) {
  const text = String(value || "");
  if (text.length > 200)
    throw AppError.badRequest(`${where}: 정규식은 200자 이내여야 합니다.`);
  try {
    if (text) new RegExp(text);
  } catch (_) {
    throw AppError.badRequest(`${where}: 정규식이 올바르지 않습니다.`);
  }
  return text;
}

function normalizeGroups(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 50)
    throw AppError.badRequest("반복 그룹은 50개 이내의 배열이어야 합니다.");
  const seen = new Set();
  return input.map((raw, i) => {
    const base = normalizeKey({ ...raw, mode: "rect" }, `group${i}`);
    if (seen.has(base.name))
      throw AppError.badRequest("반복 그룹 이름이 중복되었습니다.");
    seen.add(base.name);
    if (!["lines", "table"].includes(raw.source || "lines"))
      throw AppError.badRequest("반복 추출 방식은 lines 또는 table입니다.");
    if (
      !Array.isArray(raw.columns) ||
      !raw.columns.length ||
      raw.columns.length > 100
    )
      throw AppError.badRequest("Sub 키를 1~100개 등록하세요.");
    const columns = raw.columns.map((c, j) =>
      normalizeKey(
        {
          rect: {
            x: j / raw.columns.length,
            y: 0,
            w: 1 / raw.columns.length,
            h: 1,
          },
          ...c,
          page: 1,
        },
        j,
      ),
    );
    if (new Set(columns.map((c) => c.name)).size !== columns.length)
      throw AppError.badRequest("Sub 키 이름이 중복되었습니다.");
    const skipRows = Number(raw.skipRows || 0),
      rowHeight = Number(raw.rowHeight || 0);
    if (
      !Number.isInteger(skipRows) ||
      skipRows < 0 ||
      skipRows > 10000 ||
      !Number.isFinite(rowHeight) ||
      rowHeight < 0 ||
      rowHeight > 1
    )
      throw AppError.badRequest("반복 행 범위가 올바르지 않습니다.");
    return {
      name: base.name,
      page: base.page,
      rect: base.rect,
      source: raw.source || "lines",
      tableIndex: base.tableIndex || 0,
      allPages: !!raw.allPages,
      skipRows,
      rowHeight,
      columns,
    };
  });
}

/** 입력을 검증하고 저장 가능한 형태로 정규화한다. 잘못되면 AppError(400) */
function normalizeTemplateInput(input) {
  const name = String(input.name || "").trim();
  const docType = String(input.docType || "").trim();
  if (!name) throw AppError.badRequest("서식 이름이 필요합니다.");
  if (!docType) throw AppError.badRequest("문서유형(docType)이 필요합니다.");

  const keywords = Array.isArray(input.keywords)
    ? input.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];
  const rawKeys = Array.isArray(input.keys) ? input.keys : [];
  const groups = normalizeGroups(input.groups);
  if (!rawKeys.length && !groups.length)
    throw AppError.badRequest(
      "Key-Value 또는 반복 그룹을 1개 이상 등록해야 합니다.",
    );
  if (rawKeys.length > 200)
    throw AppError.badRequest("Key-Value는 200개 이내여야 합니다.");

  const keys = rawKeys.map(normalizeKey);
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k.name))
      throw AppError.badRequest(`Key 이름이 중복되었습니다: ${k.name}`);
    seen.add(k.name);
  }
  const documentRule = {
    pattern: normalizePattern(input.documentRule?.pattern, "문서 키"),
    exceptPattern: normalizePattern(
      input.documentRule?.exceptPattern,
      "문서 예외 키",
    ),
  };
  const engineRequest = input.engineRequest || {};
  if (
    engineRequest.reqType &&
    !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(engineRequest.reqType)
  )
    throw AppError.badRequest("엔진 요청 유형이 올바르지 않습니다.");
  if (
    engineRequest.reqOption &&
    (typeof engineRequest.reqOption !== "object" ||
      Array.isArray(engineRequest.reqOption))
  )
    throw AppError.badRequest("엔진 요청 옵션은 JSON 객체여야 합니다.");
  if (engineRequest.reqOption) validateOptions(engineRequest.reqOption);
  if (JSON.stringify(engineRequest).length > 100000)
    throw AppError.badRequest("엔진 요청 옵션이 너무 큽니다.");
  return {
    name,
    docType,
    keywords,
    keys,
    groups,
    documentRule,
    engineRequest,
    sampleId: String(input.sampleId || ""),
  };
}

module.exports = { normalizeTemplateInput, MODES };
