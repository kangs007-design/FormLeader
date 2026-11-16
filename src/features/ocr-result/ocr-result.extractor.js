'use strict';
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

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function elementText(el) {
  const t = (el.recognition && el.recognition.content) ?? el.content ?? '';
  return String(t).trim();
}

/** points 배열(2점 또는 다각형)을 { x1,y1,x2,y2 } 로 변환 */
function toRect(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const xs = points.map((p) => num(p && p[0])).filter((n) => n !== null);
  const ys = points.map((p) => num(p && p[1])).filter((n) => n !== null);
  if (!xs.length || !ys.length) return null;
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** 인식 신뢰도: recognition.confidence(숫자 또는 배열 평균) → 없으면 detection.confidence */
function elementConfidence(el) {
  const rc = el.recognition && el.recognition.confidence;
  let c = Array.isArray(rc) ? (rc.length ? rc.reduce((a, b) => a + b, 0) / rc.length : null) : num(rc);
  if (!c) c = num(el.detection && el.detection.confidence);
  return c === null ? null : Math.round(c * 1000) / 1000;
}

/** element 트리에서 word 를 평탄화한다. (textline/cell/table 은 하위 texts/cells 를 순회) */
function collectWords(elements, out = []) {
  for (const el of elements || []) {
    if (!el || typeof el !== 'object') continue;
    const children = el.type === 'table' ? el.cells : el.texts;
    if (Array.isArray(children) && children.length) { collectWords(children, out); continue; }
    if (el.type === 'table' || el.type === 'cell') continue; // 내용 없는 표/셀
    const text = elementText(el);
    const rect = toRect(el.points);
    if (text && rect) out.push({ text, ...rect, conf: elementConfidence(el) });
  }
  return out;
}

function collectTables(elements) {
  return (elements || []).filter((e) => e && e.type === 'table').map((t) => {
    const cells = (t.cells || []).map((c) => ({
      row: num(c.row_index) ?? 0,
      col: num(c.column_index) ?? 0,
      text: String(c.content ?? (c.texts || []).map(elementText).join(' ')).trim(),
    }));
    const rows = Math.max(num(t.num_rows) || 0, ...cells.map((c) => c.row + 1), 0);
    const cols = Math.max(num(t.num_cols) || 0, ...cells.map((c) => c.col + 1), 0);
    const grid = Array.from({ length: rows }, () => Array(cols).fill(''));
    for (const c of cells) grid[c.row][c.col] = c.text;
    return { rows, cols, grid };
  });
}

/** SearchAPI 결과(fields) → [{ name, text, items:[{text, conf}] }] */
function collectFields(fields) {
  return Object.entries(fields || {}).map(([name, list]) => {
    const items = collectWords(Array.isArray(list) ? list : []);
    const rawItems = items.length ? items.map(({ text, conf }) => ({ text, conf }))
      : (Array.isArray(list) ? list : []).map((e) => ({ text: elementText(e), conf: elementConfidence(e) })).filter((i) => i.text);
    return { name, text: rawItems.map((i) => i.text).join(' '), items: rawItems };
  });
}

/** 같은 줄(세로 중심이 단어 높이의 절반 이내)끼리 묶어 읽기 순서로 연결 */
function joinWords(words) {
  const sorted = [...words].sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const w of sorted) {
    const line = lines.find((l) => Math.abs(l.cy - w.cy) <= Math.max(l.h, w.h) / 2);
    if (line) { line.words.push(w); line.cy = (line.cy * (line.words.length - 1) + w.cy) / line.words.length; }
    else lines.push({ cy: w.cy, h: w.h, words: [w] });
  }
  return lines.sort((a, b) => a.cy - b.cy)
    .map((l) => l.words.sort((a, b) => a.cx - b.cx).map((w) => w.text).join(' '))
    .join(' ').trim();
}

/**
 * 결과 JSON → 정규화 모델
 * @param raw TextSense 결과 JSON
 * @param opts.pageSize { width, height } 알고 있는 페이지 픽셀 크기(이미지 헤더 등). 없으면 단어 분포로 추정한다.
 * @returns { pages:[{ page, content, orientation, width, height, sizeSource, words, tables, fields }] }
 */
function normalizeOcr(raw, { pageSize = null } = {}) {
  const dict = raw && raw.document && raw.document.pages;
  if (!dict || typeof dict !== 'object') throw new Error('OCR 결과에 document.pages 가 없습니다. (TextSense 결과 JSON 형식이 아님)');

  const pages = Object.entries(dict)
    .map(([key, p]) => ({ key, p, no: parseInt(String(key).replace(/\D+/g, ''), 10) }))
    .sort((a, b) => (a.no || 0) - (b.no || 0))
    .map(({ p, no }, i) => {
      const words = collectWords(p.elements);
      let width = pageSize ? pageSize.width : 0;
      let height = pageSize ? pageSize.height : 0;
      const sizeSource = width && height ? 'image' : 'estimated';
      if (!width || !height) { // 크기를 모르면 단어가 차지하는 최대 범위로 추정
        width = Math.max(1, ...words.map((w) => w.x2));
        height = Math.max(1, ...words.map((w) => w.y2));
      }
      const norm = words.map((w) => ({ ...w, cx: (w.x1 + w.x2) / 2 / width, cy: (w.y1 + w.y2) / 2 / height, h: (w.y2 - w.y1) / height }));
      const content = typeof p.content === 'string' && p.content.trim() ? p.content.trim() : joinLines(norm);
      return { page: no || i + 1, content, orientation: num(p.orientation) ?? 0, width, height, sizeSource, words: norm, tables: collectTables(p.elements), fields: collectFields(p.fields) };
    });
  return { pages };
}

/** content 가 없을 때 줄 단위로 텍스트 구성 */
function joinLines(words) {
  const lines = [];
  for (const w of [...words].sort((a, b) => a.cy - b.cy)) {
    const line = lines.find((l) => Math.abs(l.cy - w.cy) <= Math.max(l.h, w.h) / 2);
    if (line) line.words.push(w); else lines.push({ cy: w.cy, h: w.h, words: [w] });
  }
  return lines.map((l) => l.words.sort((a, b) => a.cx - b.cx).map((w) => w.text).join(' ')).join('\n');
}

function fullText(ocr) {
  return ocr.pages.map((p) => `${p.content}\n${p.words.map((w) => w.text).join(' ')}`).join('\n');
}

/** 화면 표시용: 정규화 좌표(cx,cy,h)를 제외한 페이지별 추출 결과 */
function buildView(ocr) {
  return {
    pages: ocr.pages.map((p) => ({
      page: p.page, content: p.content, orientation: p.orientation, width: p.width, height: p.height, sizeSource: p.sizeSource,
      words: p.words.map(({ text, x1, y1, x2, y2, conf }) => ({ text, x1, y1, x2, y2, conf })),
      tables: p.tables, fields: p.fields,
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
    preview: first ? first.content.replace(/\s+/g, ' ').slice(0, 120) : '',
  };
}

function validateValue(key, value) {
  if (key.exceptValues && key.exceptValues.includes(value)) return []; // 예외키: 검증 제외
  const errors = [];
  if (key.required && !value) errors.push('필수값 누락');
  if (!value) return errors;
  if (key.pattern && !new RegExp(key.pattern).test(value)) errors.push(`형식 불일치(${key.pattern})`);
  const hasMin = key.min !== null && key.min !== undefined;
  const hasMax = key.max !== null && key.max !== undefined;
  if (hasMin || hasMax) {
    const n = Number(value.replace(/[,\s원]/g, ''));
    if (!Number.isFinite(n)) errors.push('숫자 아님');
    else {
      if (hasMin && n < key.min) errors.push(`최소값(${key.min}) 미만`);
      if (hasMax && n > key.max) errors.push(`최대값(${key.max}) 초과`);
    }
  }
  return errors;
}

/** 서식의 각 Key 영역에서 값을 추출하고 검증한다. */
function extractByTemplate(template, ocr) {
  const values = {};
  let needsReview = false;
  for (const key of template.keys) {
    const page = ocr.pages.find((p) => p.page === (key.page || 1));
    const { x, y, w, h } = key.rect;
    const inside = page ? page.words.filter((wd) => wd.cx >= x && wd.cx <= x + w && wd.cy >= y && wd.cy <= y + h) : [];
    const value = joinWords(inside);
    const errors = validateValue(key, value);
    if (errors.length && (key.verify || key.required)) needsReview = true;
    values[key.name] = { value, valid: errors.length === 0, errors, verify: !!key.verify };
  }
  return { values, needsReview };
}

/** templateId 가 없을 때: 키워드가 모두 포함된 서식 중 키워드 수가 가장 많은 것을 선택 (없으면 null = 미분류) */
function classifyTemplate(templates, ocr) {
  const text = fullText(ocr).toLowerCase();
  let best = null;
  for (const t of templates) {
    if (!t.keywords || !t.keywords.length) continue;
    if (t.keywords.every((k) => text.includes(k.toLowerCase())) && (!best || t.keywords.length > best.keywords.length)) best = t;
  }
  return best;
}

module.exports = { normalizeOcr, buildView, summarize, extractByTemplate, classifyTemplate, validateValue, joinWords, collectWords };
