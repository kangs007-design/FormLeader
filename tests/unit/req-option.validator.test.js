'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePages, normalizeSearchRules, normalizeJobOptions, buildReqOption } = require('../../src/features/ocr-connect/req-option.validator');
const { buildJobBody, parseErrors } = require('../../src/features/ocr-connect/textsense.client');
const { maskUriCredentials } = require('../../src/common/mask.util');
const { normalizeTemplateInput } = require('../../src/features/form-template/form-template.validator');

const badRequest = (fn) => assert.throws(fn, (e) => e.status === 400);

test('pages: all / 범위 / 목록 / 정규화 (정렬·중복 제거·끝 쉼표 허용)', () => {
  assert.deepEqual(normalizePages(undefined), { spec: 'all', list: null });
  assert.deepEqual(normalizePages(''), { spec: 'all', list: null });
  assert.deepEqual(normalizePages(' ALL '), { spec: 'all', list: null });
  assert.deepEqual(normalizePages('1-3'), { spec: '1-3', list: [1, 2, 3] });
  assert.deepEqual(normalizePages('1,2,3,'), { spec: '1-3', list: [1, 2, 3] }); // 명세 예시의 끝 쉼표
  assert.deepEqual(normalizePages('5,1,3-4,3'), { spec: '1,3-5', list: [1, 3, 4, 5] });
  assert.deepEqual(normalizePages('2'), { spec: '2', list: [2] });
  assert.deepEqual(normalizePages(' 1 - 2 , 4 '), { spec: '1-2,4', list: [1, 2, 4] });
});

test('pages: 잘못된 형식은 400', () => {
  for (const bad of ['0', '3-1', 'a', '1-', '-2', '1;2', '1,,x', '1.5', ',', '0-3', '1-100000']) badRequest(() => normalizePages(bad));
});

test('SearchAPI: 7가지 종류와 Key 형식 검증', () => {
  const ok = normalizeSearchRules([
    { type: 'FindRow', name: 'a', key: ['대학원'] },
    { type: 'FindRightRow', name: 'b', key: ['대학교'] },
    { type: 'FindCol', name: 'c', key: ['학교명'] },
    { type: 'FindBottomCol', name: 'd', key: ['고등학교'] },
    { type: 'FindWord', name: 'e', key: ['중국'] },
    { type: 'FindLine', name: 'f', key: ['일시'] },
    { type: 'FindRegion', name: 'g', key: [[10.5, 20], [30, 40.25]] },
  ]);
  assert.equal(ok.length, 7);
  assert.deepEqual(ok[6].key, [[10.5, 20], [30, 40.25]]);
  assert.deepEqual(normalizeSearchRules([{ Type: 'FindWord', Name: ' x ', Key: [' 값 '] }]), [{ type: 'FindWord', name: 'x', key: ['값'] }]); // 명세의 대문자 키도 허용
  assert.deepEqual(normalizeSearchRules(undefined), []);
});

test('SearchAPI: 잘못된 규칙은 400 (종류/이름/Key/좌표/중복/개수)', () => {
  const r = (x) => () => normalizeSearchRules([x]);
  badRequest(r({ type: 'FindAll', name: 'a', key: ['x'] }));
  badRequest(r({ type: 'FindRow', name: '', key: ['x'] }));
  badRequest(r({ type: 'FindRow', name: 'a', key: [] }));
  badRequest(r({ type: 'FindRow', name: 'a', key: [''] }));
  badRequest(r({ type: 'FindRow', name: 'a', key: [1] }));
  badRequest(r({ type: 'FindRow', name: 'a', key: 'x' }));
  badRequest(r({ type: 'FindRow', name: 'a'.repeat(61), key: ['x'] }));
  badRequest(r({ type: 'FindRegion', name: 'a', key: [[1, 2]] }));
  badRequest(r({ type: 'FindRegion', name: 'a', key: [[1, 2], [3]] }));
  badRequest(r({ type: 'FindRegion', name: 'a', key: [[30, 40], [10, 20]] })); // 우하단이 좌상단보다 작음
  badRequest(r({ type: 'FindRegion', name: 'a', key: [[-1, 0], [5, 5]] }));
  badRequest(r({ type: 'FindRegion', name: 'a', key: [['1', '2'], ['3', '4']] }));
  badRequest(r(null));
  badRequest(() => normalizeSearchRules({}));
  badRequest(() => normalizeSearchRules([{ type: 'FindWord', name: 'dup', key: ['a'] }, { type: 'FindLine', name: 'dup', key: ['b'] }]));
  badRequest(() => normalizeSearchRules(Array.from({ length: 51 }, (_, i) => ({ type: 'FindWord', name: `n${i}`, key: ['a'] }))));
});

test('buildReqOption: 지정하지 않으면 명세 기본값 {} (이전 동작과 동일)', () => {
  assert.deepEqual(buildReqOption(), {});
  assert.deepEqual(buildReqOption(normalizeJobOptions({})), {});
  assert.deepEqual(buildReqOption(normalizeJobOptions(undefined), undefined), {});
});

test('buildReqOption: 명세의 키 이름/대소문자 그대로 구성', () => {
  const opts = normalizeJobOptions({
    plainText: true, denoising: true, scaleUp: true, customSetting: { TextInputMaxAxis: '2200', CellAlignGridMargin: 3 },
    searchApi: [{ type: 'FindRegion', name: 'r1', key: [[1, 2], [3, 4]] }],
  });
  assert.deepEqual(buildReqOption(opts, [{ type: 'FindLine', name: 't1', key: ['일시'] }]), {
    SearchAPI: [{ Type: 'FindLine', Name: 't1', Key: ['일시'] }, { Type: 'FindRegion', Name: 'r1', Key: [[1, 2], [3, 4]] }], // 서식 규칙 + 직접 지정 규칙
    PreProcessOption: { denoising: true, ScaleUp: true },
    ResultOption: { Format: 'PlainText' },
    CustomSetting: { TextInputMaxAxis: 2200, CellAlignGridMargin: 3 },
  });
  assert.deepEqual(buildReqOption(normalizeJobOptions({ denoising: true })), { PreProcessOption: { denoising: true } });
  badRequest(() => buildReqOption(normalizeJobOptions({ searchApi: [{ type: 'FindWord', name: 'x', key: ['a'] }] }), [{ type: 'FindLine', name: 'x', key: ['b'] }])); // 서식 규칙과 이름 충돌
});

test('작업 옵션: customSetting 은 허용 항목·0 이상 숫자만', () => {
  badRequest(() => normalizeJobOptions({ customSetting: { Unknown: 1 } }));
  badRequest(() => normalizeJobOptions({ customSetting: { TextInputMaxAxis: 'abc' } }));
  badRequest(() => normalizeJobOptions({ customSetting: { TextInputMaxAxis: -1 } }));
  assert.deepEqual(normalizeJobOptions({ customSetting: { TextInputMaxAxis: '', TableInputMaxAxis: null } }).customSetting, {}); // 빈 값은 무시(기본값 사용)
  const o = normalizeJobOptions({ pages: '2-3', plainText: 1 });
  assert.equal(o.pages, '2-3'); assert.deepEqual(o.pageList, [2, 3]); assert.equal(o.plainText, true); assert.equal(o.denoising, false);
});

test('buildJobBody: pages / reqOption / callbackUri 가 명세 위치에 들어간다', () => {
  const body = buildJobBody({ inputUri: 'http://a/in.pdf', outputUri: 'ftp://b/out.json', taskName: 't', engineUrl: 'http://textsense:8080', pages: '1-2', reqOption: { ResultOption: { Format: 'PlainText' } }, callbackUri: 'http://c/cb' });
  assert.equal(body.callbackUri, 'http://c/cb');
  assert.equal(body.option.withoutConversion, true);
  assert.deepEqual(body.extraJobs[0].option, { url: 'http://textsense:8080', reqType: 'Document', reqOption: { ResultOption: { Format: 'PlainText' } }, outputType: 'json', pages: '1-2' });
  const plain = buildJobBody({ inputUri: 'a', outputUri: 'b', taskName: 't', engineUrl: 'u' });
  assert.equal('callbackUri' in plain, false); // 선택 항목은 지정하지 않으면 보내지 않는다
  assert.deepEqual(plain.extraJobs[0].option.reqOption, {});
  assert.equal(plain.extraJobs[0].option.pages, 'all');
});

test('maskUriCredentials: URI 속 user:password@ 가림', () => {
  assert.equal(maskUriCredentials('Failed ftp://formreader:p%40ss@192.168.5.5:2121/a.json'), 'Failed ftp://***@192.168.5.5:2121/a.json');
  assert.equal(maskUriCredentials('sftp://test:test1234@10.0.0.1/x and https://u:p@h/y'), 'sftp://***@10.0.0.1/x and https://***@h/y');
  assert.equal(maskUriCredentials('http://192.168.5.5:3000/files/input/a.pdf'), 'http://192.168.5.5:3000/files/input/a.pdf'); // 접속 정보 없는 URI 는 그대로
  assert.equal(maskUriCredentials('이메일 a@b.com'), '이메일 a@b.com');
  assert.equal(maskUriCredentials(undefined), '');
});

test('parseErrors: 오류 객체 → 한 줄 메시지, 접속 정보 가림, 정상/없음/오류 상태는 빈 배열', () => {
  const list = parseErrors({ status: 200, json: { errors: [
    { id: 'e1', code: 'RMRSNT-11010', message: '파일 전송 실패\r\n  ftp://formreader:secret@10.0.0.2:2121/a.json', timestamp: 5 },
    { id: 'e2', code: 'X', cause: 'java.lang.Exception: boom\r\n\tat com.x(Y.java:1)' },
  ] } });
  assert.equal(list.length, 2);
  assert.equal(list[0].message, '파일 전송 실패 ftp://***@10.0.0.2:2121/a.json');
  assert.ok(!JSON.stringify(list).includes('secret'));
  assert.equal(list[1].message, 'java.lang.Exception: boom'); // message 가 없으면 cause 의 첫 줄
  assert.equal(list[0].timestamp, 5); assert.equal(list[1].timestamp, null);
  for (const res of [{ status: 200, json: {} }, { status: 400, text: '' }, { status: 404, json: null }, { status: 200, json: { errors: 'x' } }, null]) assert.deepEqual(parseErrors(res), []);
});

test('서식: SearchAPI 규칙 저장/검증 (없어도 기존 서식과 호환)', () => {
  const base = { name: 'n', docType: 'd', keys: [{ name: 'k', rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }] };
  assert.deepEqual(normalizeTemplateInput(base).searchRules, []);
  const t = normalizeTemplateInput({ ...base, searchRules: [{ type: 'FindLine', name: 'date', key: ['일시'] }] });
  assert.deepEqual(t.searchRules, [{ type: 'FindLine', name: 'date', key: ['일시'] }]);
  badRequest(() => normalizeTemplateInput({ ...base, searchRules: [{ type: 'Nope', name: 'a', key: ['x'] }] }));
});
