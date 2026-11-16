"use strict";
/**
 * 개별기능[ocr-result]: TextSense 결과 JSON 파싱 + 서식 기반 Key-Value 추출/검증 (순수 함수)
 *
 * 결과 JSON 구조 (https://technet.epapyrus.com/.../output/outputFormat, output/element)
 *   { document: { version, pages: { pages_1: {
 *       content, orientation, elements: [ word | textline | cell | table ... ], fields: { Name: [element...] }
 *   } } } }
 *   element.points = [[x1,y1],[x2,y2]] (좌상단, 우하단, 이미지 픽셀 좌표)
 *   word 텍스트 = recognition.content
 */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function elementText(el) {
  const t = (el.recognition && el.recognition.content) ?? el.content ?? "";
  return String(t).trim();
}

/** points 배열(2점 또는 다각형)을 { x1,y1,x2,y2 } 로 변환 */
function toRect(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const xs = points.map((p) => num(p && p[0])).filter((n) => n !== null);
  const ys = points.map((p) => num(p && p[1])).filter((n) => n !== null);
  if (!xs.length || !ys.length) return null;
  return {
    x1: Math.min(...xs),
    y1: Math.min(...ys),
    x2: Math.max(...xs),
    y2: Math.max(...ys),
  };
}

/** 인식 신뢰도: recognition.confidence(숫자 또는 배열 평균) → 없으면 detection.confidence */
function elementConfidence(el) {
  const rc = el.recognition && el.recognition.confidence;
  let c = Array.isArray(rc)
    ? rc.length
      ? rc.reduce((a, b) => a + b, 0) / rc.length
      : null
    : num(rc);
  if (!c) c = num(el.detection && el.detection.confidence);
  return c === null ? null : Math.round(c * 1000) / 1000;
}

/** element 트리에서 word 를 평탄화한다. (textline/cell/table 은 하위 texts/cells 를 순회) */
function collectWords(elements, out = []) {
  for (const el of elements || []) {
    if (!el || typeof el !== "object") continue;
    const children = el.type === "table" ? el.cells : el.texts;
    if (Array.isArray(children) && children.length) {
      collectWords(children, out);
      continue;
    }
    if (el.type === "table" || el.type === "cell") continue; // 내용 없는 표/셀
    const text = elementText(el);
    const rect = toRect(el.points);
    if (text && rect) out.push({ text, ...rect, conf: elementConfidence(el) });
  }
  return out;
}

function collectTables(elements) {
  return (elements || [])
    .filter((e) => e && e.type === "table")
    .map((t) => {
      const cells = (t.cells || []).map((c) => ({
        row: num(c.row_index) ?? 0,
        col: num(c.column_index) ?? 0,
        text: String(
          c.content ??
            collectWords(c.texts || [])
              .map((w) => w.text)
              .join(" "),
        ).trim(),
        rect: toRect(c.points),
      }));
      const rows = Math.max(
        num(t.num_rows) || 0,
        ...cells.map((c) => c.row + 1),
        0,
      );
      const cols = Math.max(
        num(t.num_cols) || 0,
        ...cells.map((c) => c.col + 1),
        0,
      );
      const grid = Array.from({ length: rows }, () => Array(cols).fill(""));
      for (const c of cells) grid[c.row][c.col] = c.text;
      return { rows, cols, grid, cells, rect: toRect(t.points) };
    });
}

/** SearchAPI 결과(fields) → [{ name, text, items:[{text, conf}] }] */
function collectFields(fields) {
  return Object.entries(fields || {}).map(([name, entry]) => {
    const list = Array.isArray(entry) ? entry : entry?.values || [];
    const items = collectWords(Array.isArray(list) ? list : []);
    const rawItems = items.length
      ? items.map(({ text, conf }) => ({ text, conf }))
      : (Array.isArray(list) ? list : [])
          .map((e) => ({ text: elementText(e), conf: elementConfidence(e) }))
          .filter((i) => i.text);
    return {
      name,
      text: rawItems.map((i) => i.text).join(" "),
      items: rawItems,
    };
  });
}

/** 같은 줄(세로 중심이 단어 높이의 절반 이내)끼리 묶어 읽기 순서로 연결 */
function joinWords(words) {
  const sorted = [...words].sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const w of sorted) {
    const line = lines.find(
      (l) => Math.abs(l.cy - w.cy) <= Math.max(l.h, w.h) / 2,
    );
    if (line) {
      line.words.push(w);
      line.cy = (line.cy * (line.words.length - 1) + w.cy) / line.words.length;
    } else lines.push({ cy: w.cy, h: w.h, words: [w] });
  }
  return lines
    .sort((a, b) => a.cy - b.cy)
    .map((l) =>
      l.words
        .sort((a, b) => a.cx - b.cx)
        .map((w) => w.text)
        .join(" "),
    )
    .join(" ")
    .trim();
}

/**
 * 결과 JSON → 정규화 모델
 * @param raw TextSense 결과 JSON
 * @param opts.pageSize { width, height } 알고 있는 페이지 픽셀 크기(이미지 헤더 등). 없으면 단어 분포로 추정한다.
 * @returns { pages:[{ page, content, orientation, width, height, sizeSource, words, tables, fields }] }
 */
function normalizeOcr(raw, { pageSize = null, pageSizes = [] } = {}) {
  const dict = raw && raw.document && raw.document.pages;
  if (!dict || typeof dict !== "object")
    throw new Error(
      "OCR 결과에 document.pages 가 없습니다. (TextSense 결과 JSON 형식이 아님)",
    );

  const pages = Object.entries(dict)
    .map(([key, p]) => ({
      key,
      p,
      no: parseInt(String(key).replace(/\D+/g, ""), 10),
    }))
    .sort((a, b) => (a.no || 0) - (b.no || 0))
    .map(({ p, no }, i) => {
      const words = collectWords(p.elements);
      const known = pageSizes[i] || pageSize;
      let width =
        num(p.width) ||
        num(p.image_width) ||
        num(p.size?.width) ||
        known?.width ||
        0;
      let height =
        num(p.height) ||
        num(p.image_height) ||
        num(p.size?.height) ||
        known?.height ||
        0;
      const sizeSource =
        width && height
          ? p.width || p.image_width || p.size?.width
            ? "engine"
            : known?.source || "image"
          : "estimated";
      if (!width || !height) {
        // 크기를 모르면 단어가 차지하는 최대 범위로 추정
        width = Math.max(1, ...words.map((w) => w.x2));
        height = Math.max(1, ...words.map((w) => w.y2));
      }
      const norm = words.map((w) => ({
        ...w,
        cx: (w.x1 + w.x2) / 2 / width,
        cy: (w.y1 + w.y2) / 2 / height,
        h: (w.y2 - w.y1) / height,
      }));
      const content =
        typeof p.content === "string" && p.content.trim()
          ? p.content.trim()
          : joinLines(norm);
      const units = collectUnits(p.elements).map((u) => ({
        ...u,
        cx: (u.x1 + u.x2) / 2 / width,
        cy: (u.y1 + u.y2) / 2 / height,
        h: (u.y2 - u.y1) / height,
      }));
      return {
        page: no || i + 1,
        content,
        orientation: num(p.orientation) ?? 0,
        width,
        height,
        sizeSource,
        words: norm,
        units,
        tables: collectTables(p.elements),
        fields: collectFields(p.fields),
      };
    });
  return { pages };
}

/** content 가 없을 때 줄 단위로 텍스트 구성 */
function joinLines(words) {
  const lines = [];
  for (const w of [...words].sort((a, b) => a.cy - b.cy)) {
    const line = lines.find(
      (l) => Math.abs(l.cy - w.cy) <= Math.max(l.h, w.h) / 2,
    );
    if (line) line.words.push(w);
    else lines.push({ cy: w.cy, h: w.h, words: [w] });
  }
  return lines
    .map((l) =>
      l.words
        .sort((a, b) => a.cx - b.cx)
        .map((w) => w.text)
        .join(" "),
    )
    .join("\n");
}

function fullText(ocr) {
  return ocr.pages
    .map((p) => `${p.content}\n${p.words.map((w) => w.text).join(" ")}`)
    .join("\n");
}

/** 화면 표시용: 정규화 좌표(cx,cy,h)를 제외한 페이지별 추출 결과 */
function buildView(ocr) {
  return {
    pages: ocr.pages.map((p) => ({
      page: p.page,
      content: p.content,
      orientation: p.orientation,
      width: p.width,
      height: p.height,
      sizeSource: p.sizeSource,
      words: p.words.map(({ text, x1, y1, x2, y2, conf }) => ({
        text,
        x1,
        y1,
        x2,
        y2,
        conf,
      })),
      tables: p.tables,
      fields: p.fields,
      units: p.units,
    })),
  };
}

/** 저장용 요약 (작업 목록에 표시) */
function summarize(ocr) {
  const first = ocr.pages[0];
  return {
    pageCount: ocr.pages.length,
    wordCount: ocr.pages.reduce((n, p) => n + p.words.length, 0),
    tableCount: ocr.pages.reduce((n, p) => n + p.tables.length, 0),
    fieldCount: ocr.pages.reduce((n, p) => n + p.fields.length, 0),
    preview: first ? first.content.replace(/\s+/g, " ").slice(0, 120) : "",
  };
}

function validateValue(key, value) {
  if (key.exceptValues && key.exceptValues.includes(value)) return []; // 예외키: 검증 제외
  if (key.exceptPattern && new RegExp(key.exceptPattern).test(value)) return [];
  const errors = [];
  if (key.required && !value) errors.push("필수값 누락");
  if (!value) return errors;
  if (key.pattern && !new RegExp(key.pattern).test(value))
    errors.push(`형식 불일치(${key.pattern})`);
  if (key.pattern2 && !new RegExp(key.pattern2).test(value))
    errors.push(`보조 형식 불일치(${key.pattern2})`);
  const hasMin = key.min !== null && key.min !== undefined;
  const hasMax = key.max !== null && key.max !== undefined;
  if (hasMin || hasMax) {
    const n = Number(value.replace(/[,\s원]/g, ""));
    if (!Number.isFinite(n)) errors.push("숫자 아님");
    else {
      if (hasMin && n < key.min) errors.push(`최소값(${key.min}) 미만`);
      if (hasMax && n > key.max) errors.push(`최대값(${key.max}) 초과`);
    }
  }
  return errors;
}

/** 서식의 각 Key 영역에서 값을 추출하고 검증한다. */
function extractByTemplate(template, ocr, { useEngineFields = true } = {}) {
  const values = {};
  let needsReview = false;
  for (const key of template.keys || []) {
    const page = ocr.pages.find((p) => p.page === (key.page || 1));
    const field = page?.fields.find((f) => f.name === key.name);
    const value = page
      ? useEngineFields && key.searchType && field
        ? field.text
        : selectValue(key, page)
      : "";
    const errors = validateValue(key, value);
    if (errors.length && (key.verify || key.required)) needsReview = true;
    values[key.name] = {
      value,
      valid: errors.length === 0,
      errors,
      verify: !!key.verify,
    };
  }
  const groups = {};
  for (const group of template.groups || []) {
    const result = extractGroup(group, ocr);
    groups[group.name] = result;
    if (result.rows.some((r) => Object.values(r.values).some((v) => !v.valid)))
      needsReview = true;
  }
  return { values, groups, needsReview };
}

/** templateId 가 없을 때: 키워드가 모두 포함된 서식 중 키워드 수가 가장 많은 것을 선택 (없으면 null = 미분류) */
function classifyTemplate(templates, ocr) {
  const text = fullText(ocr).toLowerCase();
  let best = null;
  for (const t of templates) {
    const rule = t.documentRule || {};
    if (rule.exceptPattern && new RegExp(rule.exceptPattern, "i").test(text))
      continue;
    if ((!t.keywords || !t.keywords.length) && !rule.pattern) continue;
    if (
      (t.keywords || []).every((k) => text.includes(k.toLowerCase())) &&
      (!rule.pattern || new RegExp(rule.pattern, "i").test(text)) &&
      (!best || (t.keywords || []).length > (best.keywords || []).length)
    )
      best = t;
  }
  return best;
}

function collectUnits(elements, out = []) {
  for (const el of elements || []) {
    if (!el) continue;
    const rect = toRect(el.points);
    if (rect && ["textline", "cell"].includes(el.type))
      out.push({
        type: el.type,
        text:
          elementText(el) ||
          collectWords(el.texts || [])
            .map((w) => w.text)
            .join(" "),
        ...rect,
      });
    collectUnits(el.type === "table" ? el.cells : el.texts, out);
  }
  return out;
}
function insideRect(word, r) {
  return (
    word.cx >= r.x &&
    word.cx <= r.x + r.w &&
    word.cy >= r.y &&
    word.cy <= r.y + r.h
  );
}
function lineGroups(words) {
  const lines = [];
  for (const w of [...words].sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
    const line = lines.find(
      (l) => Math.abs(l.cy - w.cy) <= Math.max(l.h, w.h) * 0.6,
    );
    if (line) line.words.push(w);
    else lines.push({ cy: w.cy, h: w.h, words: [w] });
  }
  return lines;
}
function selectValue(key, page) {
  const words = page.words.filter((w) => insideRect(w, key.rect));
  if (key.searchType) {
    if (key.searchType === "FindRegion") return joinWords(words);
    const anchor = String(key.searchKey || "");
    if (!anchor) return "";
    if (key.searchType === "FindWord")
      return joinWords(page.words.filter((w) => w.text.includes(anchor)));
    if (key.searchType === "FindLine")
      return joinWords(
        lineGroups(page.words).find((l) =>
          l.words.some((w) => w.text.includes(anchor)),
        )?.words || [],
      );
    for (const table of page.tables) {
      const cell = table.cells.find((c) => c.text.includes(anchor));
      if (!cell) continue;
      return table.cells
        .filter((c) =>
          key.searchType === "FindRow"
            ? c.row === cell.row
            : key.searchType === "FindRightRow"
              ? c.row === cell.row && c.col > cell.col
              : key.searchType === "FindCol"
                ? c.col === cell.col
                : c.col === cell.col && c.row > cell.row,
        )
        .sort((a, b) => a.row - b.row || a.col - b.col)
        .map((c) => c.text)
        .join(" ");
    }
    return "";
  }
  if (key.mode === "word")
    return (
      [...words].sort((a, b) => a.cy - b.cy || a.cx - b.cx)[key.wordIndex || 0]
        ?.text || ""
    );
  if (key.mode === "line") {
    const lines = lineGroups(words);
    return key.lineIndex === undefined
      ? lines.map((l) => joinWords(l.words)).join("\n")
      : joinWords(lines[key.lineIndex]?.words || []);
  }
  if (key.mode === "cell") {
    if (key.row !== undefined && key.column !== undefined)
      return (
        page.tables[key.tableIndex || 0]?.grid[key.row]?.[key.column] || ""
      );
    const cells = (page.units || []).filter(
      (u) => u.type === "cell" && insideRect(u, key.rect),
    );
    return cells.map((c) => c.text).join("\n");
  }
  return joinWords(words);
}
function extractGroup(group, ocr) {
  const rows = [];
  for (const page of ocr.pages.filter((p) =>
    group.allPages ? p.page >= group.page : p.page === group.page,
  )) {
    const words = page.words.filter((w) => insideRect(w, group.rect));
    let data;
    if (group.source === "table")
      data = (page.tables[group.tableIndex || 0]?.grid || [])
        .slice(group.skipRows || 0)
        .map((cells) => ({ cells }));
    else {
      let lines;
      if (group.rowHeight > 0) {
        const bins = new Map();
        for (const w of words) {
          const n = Math.floor((w.cy - group.rect.y) / group.rowHeight);
          if (!bins.has(n)) bins.set(n, []);
          bins.get(n).push(w);
        }
        lines = [...bins]
          .sort((a, b) => a[0] - b[0])
          .map(([, ws]) => ({ words: ws }));
      } else lines = lineGroups(words);
      data = lines.slice(group.skipRows || 0);
    }
    for (const row of data.slice(0, 10000)) {
      const values = {};
      group.columns.forEach((col, index) => {
        const value = row.cells
          ? String(row.cells[col.column ?? index] || "")
          : joinWords(
              row.words.filter(
                (w) =>
                  w.cx >= group.rect.x + col.rect.x * group.rect.w &&
                  w.cx <=
                    group.rect.x + (col.rect.x + col.rect.w) * group.rect.w,
              ),
            );
        const errors = validateValue(col, value);
        values[col.name] = { value, valid: !errors.length, errors };
      });
      if (Object.values(values).some((v) => v.value))
        rows.push({ page: page.page, values });
    }
  }
  return { columns: group.columns.map((c) => c.name), rows };
}
module.exports = {
  normalizeOcr,
  buildView,
  summarize,
  extractByTemplate,
  classifyTemplate,
  validateValue,
  joinWords,
  collectWords,
  selectValue,
  extractGroup,
};
