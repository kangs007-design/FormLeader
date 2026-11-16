'use strict';
/**
 * 개별기능[ocr-connect]: OCR 작업 요청 옵션(reqOption / pages) 검증·정규화 (순수 함수)
 *
 * TextSense REST API 명세 (job/build) 기준
 *   pages      : "all" | "1-5" | "1,2,3" (인식할 페이지 범위)
 *   reqOption  : { SearchAPI:[{Type,Name,Key}], PreProcessOption:{denoising,ScaleUp},
 *                  ResultOption:{Format:"PlainText"}, CustomSetting:{...} }  (기본값 {})
 *   SearchAPI  : FindRow / FindRightRow / FindCol / FindBottomCol / FindWord / FindLine → Key 는 문자열 배열
 *                FindRegion → Key 는 [[x1,y1],[x2,y2]] (좌상단, 우하단 좌표)
 *
 * 주의: 결과 JSON 의 페이지 키(pages_N)는 "요청한 페이지의 순서대로" 번호가 붙는다.
 *       따라서 pages 를 지정하면 pages_1 은 원본의 1페이지가 아닐 수 있다 → pageList 로 원본 페이지 번호를 복원한다.
 */
const { AppError } = require('../../common/app.error');

const SEARCH_TYPES = ['FindRow', 'FindRightRow', 'FindCol', 'FindBottomCol', 'FindWord', 'FindLine', 'FindRegion'];
const CUSTOM_SETTING_KEYS = ['TextInputMaxAxis', 'TableInputMaxAxis', 'TextScoreThreshold', 'TableCellScoreThreshold', 'CellAlignSearchMargin', 'CellAlignGridMargin'];
const MAX_PAGES = 1000;
const MAX_RULES = 50;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const bad = (msg) => AppError.badRequest(msg);

/**
 * 페이지 범위 문자열 검증 → { spec, list }
 *   spec: TextSense 에 보낼 정규화 문자열 ("all" 또는 "1,3-5"),  list: 원본 페이지 번호 배열(오름차순, 중복 제거) 또는 null(all)
 */
function normalizePages(input) {
  if (input === undefined || input === null || String(input).trim() === '' || String(input).trim().toLowerCase() === 'all') return { spec: 'all', list: null };
  const parts = String(input).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw bad('pages 형식이 올바르지 않습니다. 예: all, 1-5, 1,3,5');
  const set = new Set();
  for (const part of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw bad(`pages 형식이 올바르지 않습니다: "${part}" (예: all, 1-5, 1,3,5)`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) throw bad(`pages 범위가 올바르지 않습니다: "${part}"`);
    if (to - from + 1 > MAX_PAGES || set.size + (to - from + 1) > MAX_PAGES) throw bad(`pages 는 최대 ${MAX_PAGES}페이지까지 지정할 수 있습니다.`);
    for (let n = from; n <= to; n++) set.add(n);
  }
  const list = [...set].sort((a, b) => a - b);
  return { spec: compressPages(list), list };
}

/** [1,2,3,5] → "1-3,5" */
function compressPages(list) {
  const out = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(j > i ? `${list[i]}-${list[j]}` : String(list[i]));
    i = j + 1;
  }
  return out.join(',');
}

/** SearchAPI 규칙 1건 검증 → { type, name, key } */
function normalizeSearchRule(raw, index) {
  const where = `SearchAPI[${index}]`;
  if (!raw || typeof raw !== 'object') throw bad(`${where}: 규칙 형식이 올바르지 않습니다.`);
  const type = String(raw.type || raw.Type || '').trim();
  if (!SEARCH_TYPES.includes(type)) throw bad(`${where}: type 은 ${SEARCH_TYPES.join('/')} 중 하나여야 합니다.`);
  const name = String(raw.name || raw.Name || '').trim();
  if (!name) throw bad(`${where}: name 이 필요합니다. (결과 fields 의 이름이 됩니다)`);
  if (name.length > 60) throw bad(`${where}: name 이 너무 깁니다. (60자 이하)`);

  const key = raw.key !== undefined ? raw.key : raw.Key;
  if (type === 'FindRegion') {
    const ok = Array.isArray(key) && key.length === 2 && key.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => isNum(n) && n >= 0));
    if (!ok) throw bad(`${where}(${name}): FindRegion 의 key 는 [[x1,y1],[x2,y2]] (좌상단, 우하단 좌표) 형식이어야 합니다.`);
    if (key[1][0] <= key[0][0] || key[1][1] <= key[0][1]) throw bad(`${where}(${name}): FindRegion 은 우하단 좌표가 좌상단보다 커야 합니다.`);
    return { type, name, key: [[key[0][0], key[0][1]], [key[1][0], key[1][1]]] };
  }
  const words = Array.isArray(key) ? key.map((k) => (typeof k === 'string' ? k.trim() : '')) : [];
  if (!words.length || words.length > 20 || words.some((w) => !w || w.length > 100)) {
    throw bad(`${where}(${name}): ${type} 의 key 는 1~20개의 문자열 배열이어야 합니다. (각 100자 이하)`);
  }
  return { type, name, key: words };
}

/** SearchAPI 규칙 목록 검증 (이름 중복 불가 - 결과 fields 의 구분자이므로) */
function normalizeSearchRules(list, label = 'SearchAPI') {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad(`${label} 는 배열이어야 합니다.`);
  if (list.length > MAX_RULES) throw bad(`${label} 규칙은 최대 ${MAX_RULES}개까지 지정할 수 있습니다.`);
  const rules = list.map(normalizeSearchRule);
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.name)) throw bad(`${label} 규칙 이름이 중복되었습니다: ${r.name}`);
    seen.add(r.name);
  }
  return rules;
}

/**
 * 작업 옵션 검증 → 저장 가능한 형태
 * @param input { pages, plainText, denoising, scaleUp, customSetting:{...}, searchApi:[...] }
 */
function normalizeJobOptions(input) {
  const o = input && typeof input === 'object' ? input : {};
  const { spec, list } = normalizePages(o.pages);

  const customSetting = {};
  for (const [k, v] of Object.entries(o.customSetting && typeof o.customSetting === 'object' ? o.customSetting : {})) {
    if (v === '' || v === null || v === undefined) continue;
    if (!CUSTOM_SETTING_KEYS.includes(k)) throw bad(`customSetting 에 지원하지 않는 항목입니다: ${k} (허용: ${CUSTOM_SETTING_KEYS.join(', ')})`);
    const n = Number(v);
    if (!isNum(n) || n < 0) throw bad(`customSetting.${k} 는 0 이상의 숫자여야 합니다.`);
    customSetting[k] = n;
  }

  return {
    pages: spec,
    pageList: list,
    plainText: !!o.plainText,
    denoising: !!o.denoising,
    scaleUp: !!o.scaleUp,
    customSetting,
    searchApi: normalizeSearchRules(o.searchApi),
  };
}

/**
 * 정규화된 옵션 + 서식의 SearchAPI 규칙 → TextSense reqOption 객체
 * 지정한 항목만 포함한다. (아무것도 없으면 명세의 기본값 {})
 */
function buildReqOption(options = {}, templateRules = []) {
  const rules = normalizeSearchRules([...(templateRules || []), ...(options.searchApi || [])]);
  const req = {};
  if (rules.length) req.SearchAPI = rules.map((r) => ({ Type: r.type, Name: r.name, Key: r.key }));
  if (options.denoising || options.scaleUp) {
    req.PreProcessOption = {};
    if (options.denoising) req.PreProcessOption.denoising = true;
    if (options.scaleUp) req.PreProcessOption.ScaleUp = true;
  }
  if (options.plainText) req.ResultOption = { Format: 'PlainText' };
  if (options.customSetting && Object.keys(options.customSetting).length) req.CustomSetting = { ...options.customSetting };
  return req;
}

module.exports = { normalizePages, normalizeSearchRules, normalizeJobOptions, buildReqOption, SEARCH_TYPES, CUSTOM_SETTING_KEYS };
