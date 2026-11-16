'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOcr, buildView, summarize, extractByTemplate, classifyTemplate, validateValue, joinWords } = require('../../src/features/ocr-result/ocr-result.extractor');
const { createSampleOcr } = require('../mock/mock-textsense.server');

const template = {
  id: 't1', docType: '청구서', keywords: ['청구서'],
  keys: [
    { name: 'docNo', page: 1, rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 }, required: true, verify: true, pattern: '^A-\\d{4}-\\d{3}$', min: null, max: null, exceptValues: [] },
    { name: 'amount', page: 1, rect: { x: 0.15, y: 0.2, w: 0.2, h: 0.05 }, required: true, verify: false, pattern: '', min: 0, max: 5000000, exceptValues: [] },
  ],
};

test('normalizeOcr: document.pages.pages_N 구조 → 단어/표/본문 추출', () => {
  const ocr = normalizeOcr(createSampleOcr());
  assert.equal(ocr.pages.length, 1);
  const p = ocr.pages[0];
  assert.equal(p.page, 1);
  assert.equal(p.words.length, 10); // textline 하위 word + table/cell 하위 word 평탄화
  assert.ok(p.words.some((w) => w.text === 'A-2025-001'));
  assert.equal(p.sizeSource, 'estimated');
  assert.deepEqual([p.width, p.height], [1000, 1400]);
  assert.match(p.content, /청구서/);
  assert.deepEqual(p.tables[0].grid, [['품목', '금액'], ['서비스이용료', '1,234,000']]);
});

test('normalizeOcr: 알고 있는 페이지 크기(이미지)를 우선 사용', () => {
  const ocr = normalizeOcr(createSampleOcr(), { pageSize: { width: 2000, height: 2800 } });
  const w = ocr.pages[0].words.find((x) => x.text === 'A-2025-001');
  assert.equal(ocr.pages[0].sizeSource, 'image');
  assert.ok(Math.abs(w.cx - 0.115) < 1e-9);
});

test('normalizeOcr: 형식이 다르면 명확한 에러', () => {
  assert.throws(() => normalizeOcr({ pages: [] }), /document\.pages/);
  assert.throws(() => normalizeOcr(null), /document\.pages/);
});

test('normalizeOcr: 페이지 키를 숫자 순서로 정렬 (pages_2 < pages_10)', () => {
  const mk = (text) => ({ elements: [{ type: 'word', points: [[0, 0], [10, 10]], recognition: { content: text, confidence: 0 }, detection: { confidence: 0.5 } }] });
  const ocr = normalizeOcr({ document: { pages: { pages_10: mk('ten'), pages_2: mk('two'), pages_1: mk('one') } } });
  assert.deepEqual(ocr.pages.map((p) => [p.page, p.words[0].text]), [[1, 'one'], [2, 'two'], [10, 'ten']]);
  assert.equal(ocr.pages[0].content, 'one'); // content 가 없으면 단어로 구성
});

test('word: 신뢰도(배열 평균 → detection 대체) / 다각형 points / 빈 텍스트 제외', () => {
  const ocr = normalizeOcr({ document: { pages: { pages_1: { elements: [
    { type: 'word', points: [[10, 20], [50, 20], [50, 40], [10, 40]], recognition: { content: 'poly', confidence: [1, 0.5] }, detection: { confidence: 0.1 } },
    { type: 'word', points: [[0, 0], [5, 5]], recognition: { content: 'det', confidence: 0 }, detection: { confidence: 0.8 } },
    { type: 'word', points: [[0, 0], [5, 5]], recognition: { content: '  ', confidence: 0 } },
    { type: 'word', recognition: { content: 'nopoints' } },
  ] } } } });
  const [a, b] = ocr.pages[0].words;
  assert.equal(ocr.pages[0].words.length, 2);
  assert.deepEqual([a.x1, a.y1, a.x2, a.y2, a.conf], [10, 20, 50, 40, 0.75]);
  assert.equal(b.conf, 0.8);
});

test('SearchAPI fields 수집', () => {
  const w = (t) => ({ type: 'word', points: [[1, 1], [2, 2]], recognition: { content: t, confidence: 0 }, detection: { confidence: 0.9 } });
  const ocr = normalizeOcr({ document: { pages: { pages_1: { elements: [w('x')], fields: { Name: [w('홍길동')], phone: [w('000-0000'), w('1234')], none: [] } } } } });
  const f = Object.fromEntries(ocr.pages[0].fields.map((x) => [x.name, x.text]));
  assert.deepEqual(f, { Name: '홍길동', phone: '000-0000 1234', none: '' });
});

test('buildView/summarize: 화면용 모델과 요약', () => {
  const ocr = normalizeOcr(createSampleOcr());
  const view = buildView(ocr);
  assert.equal('cx' in view.pages[0].words[0], false);
  assert.equal(view.pages[0].words[0].text.length > 0, true);
  const s = summarize(ocr);
  assert.deepEqual([s.pageCount, s.wordCount, s.tableCount], [1, 10, 1]);
  assert.match(s.preview, /청구서/);
});

test('extractByTemplate: 영역 내 단어를 추출하고 검증 통과', () => {
  const { values, needsReview } = extractByTemplate(template, normalizeOcr(createSampleOcr()));
  assert.equal(values.docNo.value, 'A-2025-001');
  assert.equal(values.amount.value, '1,234,000');
  assert.equal(values.docNo.valid, true);
  assert.equal(values.amount.valid, true);
  assert.equal(needsReview, false);
});

test('extractByTemplate: 빈 영역 + 필수키 → 검토 필요', () => {
  const t = { ...template, keys: [{ ...template.keys[0], rect: { x: 0.8, y: 0.5, w: 0.1, h: 0.1 } }] };
  const { values, needsReview } = extractByTemplate(t, normalizeOcr(createSampleOcr()));
  assert.equal(values.docNo.value, '');
  assert.deepEqual(values.docNo.errors, ['필수값 누락']);
  assert.equal(needsReview, true);
});

test('validateValue: 패턴/범위/예외값', () => {
  assert.deepEqual(validateValue({ pattern: '^\\d+$' }, 'abc'), ['형식 불일치(^\\d+$)']);
  assert.deepEqual(validateValue({ min: 10, max: 20 }, '5'), ['최소값(10) 미만']);
  assert.deepEqual(validateValue({ min: 10, max: 20 }, '25'), ['최대값(20) 초과']);
  assert.deepEqual(validateValue({ min: 10, max: 20 }, '1,5'), []); // 쉼표 제거 → 15 (범위 내)
  assert.deepEqual(validateValue({ min: 10, max: 20 }, '0.5'), ['최소값(10) 미만']);
  assert.deepEqual(validateValue({ min: 10 }, 'abc'), ['숫자 아님']);
  assert.deepEqual(validateValue({ required: true, exceptValues: ['N/A'] }, 'N/A'), []);
  assert.deepEqual(validateValue({ min: 0, max: 0 }, '0'), []); // 0 값 경계
});

test('joinWords: 줄 단위 + 좌→우 순서', () => {
  const words = [
    { text: 'B', cx: 0.5, cy: 0.1, h: 0.02 }, { text: 'A', cx: 0.1, cy: 0.1, h: 0.02 }, { text: 'C', cx: 0.1, cy: 0.2, h: 0.02 },
  ];
  assert.equal(joinWords(words), 'A B C');
});

test('classifyTemplate: 키워드 매칭 / 미분류', () => {
  const ocr = normalizeOcr(createSampleOcr());
  assert.equal(classifyTemplate([template], ocr).id, 't1');
  assert.equal(classifyTemplate([{ ...template, keywords: ['영수증'] }], ocr), null);
  assert.equal(classifyTemplate([{ ...template, keywords: [] }], ocr), null);
});
