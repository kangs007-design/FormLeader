'use strict';
/**
 * 개별기능[form-template]: 서식(Form) 입력값 검증/정규화
 *
 * 서식 구조
 *  { name, docType, keywords[], keys: [{
 *      name, page, mode('rect'|'line'|'cell'|'word'),
 *      rect:{x,y,w,h} (페이지 대비 0~1 비율),
 *      required, verify(검증키), pattern, min, max(범위), exceptValues[](예외값)
 *  }],
 *  searchRules: [{ type, name, key }]  (선택) 이 서식으로 요청할 때 TextSense reqOption.SearchAPI 로 함께 보낼 규칙
 *  }
 */
const { AppError } = require('../../common/app.error');
const { normalizeSearchRules } = require('../ocr-connect/req-option.validator');

const MODES = ['rect', 'line', 'cell', 'word'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const optNum = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function normalizeKey(raw, index) {
  const where = `keys[${index}]`;
  const name = String(raw.name || '').trim();
  if (!name) throw AppError.badRequest(`${where}: Key 이름이 필요합니다.`);

  const r = raw.rect || {};
  const rect = { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) };
  if (![rect.x, rect.y, rect.w, rect.h].every(isNum)) throw AppError.badRequest(`${where}(${name}): rect(x,y,w,h) 값이 필요합니다.`);
  if (rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > 1.0001 || rect.y + rect.h > 1.0001) {
    throw AppError.badRequest(`${where}(${name}): rect 는 0~1 비율 범위 안이어야 합니다.`);
  }

  const mode = raw.mode || 'rect';
  if (!MODES.includes(mode)) throw AppError.badRequest(`${where}(${name}): mode 는 ${MODES.join('/')} 중 하나여야 합니다.`);

  const page = raw.page === undefined ? 1 : Number(raw.page);
  if (!Number.isInteger(page) || page < 1) throw AppError.badRequest(`${where}(${name}): page 는 1 이상의 정수여야 합니다.`);

  const pattern = raw.pattern ? String(raw.pattern) : '';
  if (pattern) {
    if (pattern.length > 200) throw AppError.badRequest(`${where}(${name}): pattern 이 너무 깁니다.`);
    try { new RegExp(pattern); } catch (_) { throw AppError.badRequest(`${where}(${name}): pattern 정규식이 올바르지 않습니다.`); }
  }

  const min = optNum(raw.min);
  const max = optNum(raw.max);
  if ((min !== null && !isNum(min)) || (max !== null && !isNum(max))) throw AppError.badRequest(`${where}(${name}): min/max 는 숫자여야 합니다.`);
  if (min !== null && max !== null && min > max) throw AppError.badRequest(`${where}(${name}): min 이 max 보다 클 수 없습니다.`);

  const exceptValues = Array.isArray(raw.exceptValues) ? raw.exceptValues.map(String).filter(Boolean) : [];

  return { name, page, mode, rect, required: !!raw.required, verify: !!raw.verify, pattern, min, max, exceptValues };
}

/** 입력을 검증하고 저장 가능한 형태로 정규화한다. 잘못되면 AppError(400) */
function normalizeTemplateInput(input) {
  const name = String(input.name || '').trim();
  const docType = String(input.docType || '').trim();
  if (!name) throw AppError.badRequest('서식 이름이 필요합니다.');
  if (!docType) throw AppError.badRequest('문서유형(docType)이 필요합니다.');

  const keywords = Array.isArray(input.keywords) ? input.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
  const rawKeys = Array.isArray(input.keys) ? input.keys : [];
  if (!rawKeys.length) throw AppError.badRequest('Key-Value 를 1개 이상 등록해야 합니다.');

  const keys = rawKeys.map(normalizeKey);
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k.name)) throw AppError.badRequest(`Key 이름이 중복되었습니다: ${k.name}`);
    seen.add(k.name);
  }
  const searchRules = normalizeSearchRules(input.searchRules, 'SearchAPI 규칙');
  return { name, docType, keywords, keys, searchRules };
}

module.exports = { normalizeTemplateInput, MODES };
