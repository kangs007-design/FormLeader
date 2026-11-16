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

/* ---- 매뉴얼 보완: 표 병합/철자 변형, 페이지 번호 복원, 페이지 부가 정보 ---- */
const mkWord = (text, x1, y1, x2, y2) => ({ type: 'word', points: [[x1, y1], [x2, y2]], recognition: { content: text, confidence: [1, 0.9] } });
const mkCell = (extra, text) => ({ type: 'cell', content: text, texts: [mkWord(text, 0, 0, 5, 5)], points: [[0, 0], [10, 10]], ...extra });
const mkDoc = (pages) => ({ document: { version: '2.0.0', pages } });

test('표: 병합 셀(row_span/column_span)을 반영한 layout 과 단순 grid', () => {
  // 2행 3열: 첫 행의 (0,0) 은 가로 2칸 병합, (0,2)~(1,2) 는 세로 2칸 병합
  const raw = mkDoc({ pages_1: { elements: [{ type: 'table', num_rows: 2, num_cols: 3, cells: [
    mkCell({ row_index: 0, column_index: 0, column_span: 2 }, '제목'),
    mkCell({ row_index: 0, column_index: 2, row_span: 2 }, '합계'),
    mkCell({ row_index: 1, column_index: 0 }, 'A'),
    mkCell({ row_index: 1, column_index: 1 }, 'B'),
  ] }] } });
  const t = normalizeOcr(raw).pages[0].tables[0];
  assert.equal(t.rows, 2); assert.equal(t.cols, 3);
  assert.deepEqual(t.grid, [['제목', '', '합계'], ['A', 'B', '']]);
  assert.deepEqual(t.layout, [
    [{ text: '제목', rowSpan: 1, colSpan: 2 }, { text: '합계', rowSpan: 2, colSpan: 1 }],
    [{ text: 'A', rowSpan: 1, colSpan: 1 }, { text: 'B', rowSpan: 1, colSpan: 1 }],
  ]);
});

test('표: 명세 표의 철자(colum_index/colum_span)와 span 0(병합 없음)도 처리, 빈 칸은 빈 셀', () => {
  const raw = mkDoc({ pages_1: { elements: [{ type: 'table', cells: [
    mkCell({ row_index: 0, colum_index: 0, colum_span: 2, row_span: 0 }, 'X'),
    mkCell({ row_index: 1, colum_index: 1, colum_span: 0 }, 'Y'),
  ] }] } });
  const t = normalizeOcr(raw).pages[0].tables[0];
  assert.deepEqual(t.layout, [
    [{ text: 'X', rowSpan: 1, colSpan: 2 }],
    [{ text: '', rowSpan: 1, colSpan: 1 }, { text: 'Y', rowSpan: 1, colSpan: 1 }], // (1,0) 은 셀이 없어 빈 셀
  ]);
});

test('표: 범위를 벗어난 병합 값도 안전하게 처리 (행/열 확장, 무한 값 무시)', () => {
  const raw = mkDoc({ pages_1: { elements: [{ type: 'table', num_rows: 1, num_cols: 1, cells: [
    mkCell({ row_index: 0, column_index: 0, row_span: 3, column_span: 'x' }, 'Z'),
  ] }] } });
  const t = normalizeOcr(raw).pages[0].tables[0];
  assert.equal(t.rows, 3); assert.equal(t.cols, 1);
  assert.deepEqual(t.layout[0], [{ text: 'Z', rowSpan: 3, colSpan: 1 }]);
  assert.deepEqual(t.layout.slice(1), [[], []]); // 병합으로 가려진 행은 셀 없음
});

test('pageMap: 일부 페이지만 요청하면 pages_N 을 원본 페이지 번호로 복원', () => {
  const raw = mkDoc({ pages_1: { elements: [mkWord('a', 0, 0, 10, 10)] }, pages_2: { elements: [mkWord('b', 0, 0, 10, 10)] }, pages_3: { elements: [mkWord('c', 0, 0, 10, 10)] } });
  assert.deepEqual(normalizeOcr(raw).pages.map((p) => p.page), [1, 2, 3]); // 지정 없으면 기존 동작
  assert.deepEqual(normalizeOcr(raw, { pageMap: [2, 5, 7] }).pages.map((p) => p.page), [2, 5, 7]);
  assert.deepEqual(normalizeOcr(raw, { pageMap: [4] }).pages.map((p) => p.page), [4, 2, 3]); // 매핑이 모자라면 나머지는 순번 유지
  assert.deepEqual(normalizeOcr(raw, { pageMap: null }).pages.map((p) => p.page), [1, 2, 3]);
});

test('pageMap: 서식 Key 의 page 는 원본 페이지 번호 기준', () => {
  const raw = mkDoc({ pages_1: { elements: [mkWord('P2값', 100, 100, 200, 150)] }, pages_2: { elements: [mkWord('P5값', 100, 100, 200, 150)] } });
  const ocr = normalizeOcr(raw, { pageMap: [2, 5], pageSize: { width: 400, height: 400 } });
  const tpl = { keys: [{ name: 'k5', page: 5, rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.2 } }, { name: 'k1', page: 1, rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.2 } }] };
  const { values } = extractByTemplate(tpl, ocr);
  assert.equal(values.k5.value, 'P5값');
  assert.equal(values.k1.value, ''); // 1페이지는 요청하지 않았으므로 값 없음
});

test('페이지 부가 정보(meta)와 문서 버전', () => {
  const raw = mkDoc({
    pages_1: { elements: [], classification: { class: 'invoice', confidence: 0.91 }, alignment: { confidence: 0.5, reference: 'ref.png' }, description: ' 메모 ', flags: ['x'], version: '2.0.0' },
    pages_2: { elements: [], classification: { class: null, confidence: null }, alignment: { confidence: null, reference: null }, description: '', flags: null },
    pages_3: { elements: [] },
  });
  const o = normalizeOcr(raw);
  assert.equal(o.version, '2.0.0');
  assert.deepEqual(o.pages[0].meta, { classification: { class: 'invoice', confidence: 0.91 }, alignment: { confidence: 0.5, reference: 'ref.png' }, description: '메모', flags: ['x'], version: '2.0.0' });
  assert.deepEqual(o.pages[1].meta, { classification: null, alignment: null, description: null, flags: null, version: null }); // 값이 모두 null 이면 표시 안 함
  assert.deepEqual(o.pages[2].meta, { classification: null, alignment: null, description: null, flags: null, version: null });
  const v = buildView(o);
  assert.equal(v.version, '2.0.0'); assert.equal(v.pages[0].meta.classification.class, 'invoice');
  assert.equal(normalizeOcr({ document: { pages: { pages_1: { elements: [] } } } }).version, null);
});
