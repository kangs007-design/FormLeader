'use strict';
/**
 * 모듈 연결 테스트 (REST API 매뉴얼 보완분)
 *   pages/reqOption 전달 · 서식 SearchAPI 규칙 · 결과 페이지 번호 복원 · 완료 콜백 · 오류 정보 처리 · 호환성
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { request: api, setup, upload, waitJob } = require('../mock/test-harness.util');

const form = (extra = {}) => ({
  name: '청구서', docType: 'invoice', keywords: ['청구서'],
  keys: [{ name: 'docNo', rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 }, required: true }],
  ...extra,
});
const sentOption = (env, i = 0) => env.mock.requests[i].extraJobs[0].option;

test('옵션을 지정하지 않으면 이전과 동일한 요청 (pages=all, reqOption={}, callbackUri 없음)', async () => {
  const env = await setup();
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    assert.equal(created.status, 200);
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(sentOption(env).pages, 'all');
    assert.deepEqual(sentOption(env).reqOption, {});
    assert.equal('callbackUri' in env.mock.requests[0], false);
    assert.equal(job.options.pages, 'all');
    assert.equal(job.ocrResult.pageCount, 1);
  } finally { await env.close(); }
});

test('pages/PlainText/전처리/CustomSetting 이 명세의 위치와 키로 전달된다', async () => {
  const env = await setup();
  try {
    const created = await api(env.port, 'POST', '/api/jobs', {
      ...upload(), options: { pages: '3,1-2', plainText: true, denoising: true, scaleUp: true, customSetting: { TextInputMaxAxis: 2200 } },
    });
    assert.equal(created.status, 200);
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    const o = sentOption(env);
    assert.equal(o.pages, '1-3'); // 정렬·정규화되어 전달
    assert.deepEqual(o.reqOption, { PreProcessOption: { denoising: true, ScaleUp: true }, ResultOption: { Format: 'PlainText' }, CustomSetting: { TextInputMaxAxis: 2200 } });
  } finally { await env.close(); }
});

test('일부 페이지만 요청해도 결과 페이지 번호는 원본 기준 (pages_N → 원본 페이지)', async () => {
  const env = await setup();
  try {
    const created = await api(env.port, 'POST', '/api/jobs', { ...upload(), options: { pages: '2,5-6' } });
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(sentOption(env).pages, '2,5-6');
    assert.equal(job.ocrResult.pageCount, 3);

    const view = (await api(env.port, 'GET', `/api/jobs/${job.id}/ocr`)).json.data;
    assert.deepEqual(view.pages.map((p) => p.page), [2, 5, 6]);
    assert.deepEqual(view.pages.map((p) => /SEQ(\d)/.exec(p.content)[1]), ['1', '2', '3']); // 결과 순번은 그대로, 번호만 원본으로 복원
    assert.equal(view.version, '2.0.0');
    assert.ok(view.pages[0].tables[0].layout.length >= 2); // 표 layout 제공
  } finally { await env.close(); }
});

test('서식의 Key 는 원본 페이지 번호 기준으로 적용된다', async () => {
  const env = await setup();
  try {
    const f = await api(env.port, 'POST', '/api/forms', form({ keys: [
      { name: 'p5', page: 5, rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 } },
      { name: 'p1', page: 1, rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 } },
    ] }));
    const created = await api(env.port, 'POST', '/api/jobs', { ...upload(), templateId: f.json.data.id, options: { pages: '4-5' } });
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.ocrResult.values.p5.value, 'A-2025-001'); // 결과의 두 번째 페이지 = 원본 5페이지
    assert.equal(job.ocrResult.values.p1.value, '');            // 1페이지는 요청하지 않음
  } finally { await env.close(); }
});

test('서식의 SearchAPI 규칙 + 직접 지정한 규칙이 reqOption.SearchAPI 로 함께 전달된다', async () => {
  const env = await setup();
  try {
    const f = await api(env.port, 'POST', '/api/forms', form({ searchRules: [{ type: 'FindLine', name: 'date', key: ['일시'] }] }));
    assert.equal(f.status, 200);
    assert.equal(f.json.data.searchRules.length, 1);
    const created = await api(env.port, 'POST', '/api/jobs', {
      ...upload(), templateId: f.json.data.id,
      options: { searchApi: [{ type: 'FindRegion', name: 'box', key: [[10, 20], [110, 60]] }] },
    });
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(sentOption(env).reqOption.SearchAPI, [
      { Type: 'FindLine', Name: 'date', Key: ['일시'] },
      { Type: 'FindRegion', Name: 'box', Key: [[10, 20], [110, 60]] },
    ]);
  } finally { await env.close(); }
});

test('잘못된 옵션은 업로드 시점에 400 이고 작업/파일이 만들어지지 않는다', async () => {
  const env = await setup();
  try {
    const f = await api(env.port, 'POST', '/api/forms', form({ searchRules: [{ type: 'FindLine', name: 'dup', key: ['a'] }] }));
    const cases = [
      { options: { pages: '0' } },
      { options: { pages: '5-2' } },
      { options: { pages: 'abc' } },
      { options: { customSetting: { Foo: 1 } } },
      { options: { searchApi: [{ type: 'FindRegion', name: 'x', key: [[1, 2]] }] } },
      { options: { searchApi: [{ type: 'Bad', name: 'x', key: ['a'] }] } },
      { templateId: f.json.data.id, options: { searchApi: [{ type: 'FindWord', name: 'dup', key: ['b'] }] } }, // 서식 규칙과 이름 충돌
    ];
    for (const c of cases) {
      const res = await api(env.port, 'POST', '/api/jobs', { ...upload(), ...c });
      assert.equal(res.status, 400, JSON.stringify(c));
      assert.equal(res.json.error.code, 'BAD_REQUEST');
    }
    assert.deepEqual((await api(env.port, 'GET', '/api/jobs')).json.data, []);
    const inputDir = path.join(env.dir, 'input');
    assert.deepEqual(fs.existsSync(inputDir) ? fs.readdirSync(inputDir) : [], []); // 거부된 업로드는 파일을 남기지 않는다
    assert.equal(env.mock.requests.length, 0);
  } finally { await env.close(); }
});

test('서식 저장: 잘못된 SearchAPI 규칙은 400, 규칙 없는 기존 서식도 그대로 동작', async () => {
  const env = await setup();
  try {
    assert.equal((await api(env.port, 'POST', '/api/forms', form({ searchRules: [{ type: 'FindRow', name: '', key: ['a'] }] }))).status, 400);
    // 규칙 기능 이전에 저장된 서식(searchRules 필드 없음)을 직접 저장소에 넣어 호환성 확인
    const legacy = { id: 'form_legacy', name: '구서식', docType: 'invoice', keywords: ['청구서'], keys: [{ name: 'docNo', page: 1, mode: 'rect', rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 }, required: true, verify: false, pattern: '', min: null, max: null, exceptValues: [] }], createdAt: 'x', updatedAt: 'x' };
    fs.writeFileSync(path.join(env.dir, 'form-templates.json'), JSON.stringify([legacy]));
    const created = await api(env.port, 'POST', '/api/jobs', { ...upload(), templateId: 'form_legacy' });
    assert.equal(created.status, 200);
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(sentOption(env).reqOption, {});
    assert.equal(job.ocrResult.values.docNo.value, 'A-2025-001');
  } finally { await env.close(); }
});

test('옵션 기능 이전에 저장된 작업(options 없음)도 실행된다', async () => {
  const env = await setup();
  try {
    // 작업 레코드를 직접 만들어 run 호출 (options/pageList 없음)
    const svc = env.app.services.formJobService;
    fs.mkdirSync(path.join(env.dir, 'input'), { recursive: true });
    fs.writeFileSync(path.join(env.dir, 'input', 'job_old.pdf'), '%PDF-1.4');
    await svc.repo.insert({ id: 'job_old', fileName: 'old.pdf', storedName: 'job_old.pdf', templateId: null, status: 'pending', engineStatus: null, taskId: null, error: null, ocrResult: null, createdAt: 'x', updatedAt: 'x' });
    await svc.run('job_old');
    const job = (await api(env.port, 'GET', '/api/jobs/job_old')).json.data;
    assert.equal(job.status, 'done', job.error);
    assert.equal(sentOption(env).pages, 'all');
    const view = await api(env.port, 'GET', '/api/jobs/job_old/ocr');
    assert.equal(view.status, 200);
    assert.deepEqual(view.json.data.pages.map((p) => p.page), [1]);
  } finally { await env.close(); }
});

test('완료 콜백: callbackUri 전달 + 폴링 간격이 길어도 콜백으로 즉시 완료', async () => {
  const env = await setup({ auto: true, configExtra: { callback: { enabled: true }, jobPollIntervalMs: 5000 }, mockOpts: { delayMs: 30 } });
  try {
    const t0 = Date.now();
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id, 4000); // 폴링만이라면 5초 이상 걸린다
    assert.equal(job.status, 'done', job.error);
    assert.ok(Date.now() - t0 < 4000, `콜백으로 깨어나야 한다 (${Date.now() - t0}ms)`);
    const sent = env.mock.requests[0];
    assert.equal(sent.callbackUri, `http://127.0.0.1:${env.port}/api/textsense/callback`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(env.mock.callbacks.length, 1);
    assert.equal(env.mock.callbacks[0].status, 200);
    assert.equal(env.mock.callbacks[0].payload.status, 'SUCCESS');
    assert.equal(env.mock.callbacks[0].payload.id, job.taskId);
  } finally { await env.close(); }
});

test('완료 콜백: 실패 작업도 콜백으로 즉시 FAILURE 처리 (오류 정보 조회)', async () => {
  const env = await setup({ auto: true, configExtra: { callback: { enabled: true }, jobPollIntervalMs: 5000 }, mockOpts: { failJob: true, delayMs: 30 } });
  try {
    const t0 = Date.now();
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id, 4000);
    assert.equal(job.status, 'failed');
    assert.ok(job.error.includes('RuntimeException'), job.error);
    assert.ok(Date.now() - t0 < 4000);
  } finally { await env.close(); }
});

test('콜백은 신뢰하지 않는다: 위조/모르는 id 는 무시되고 상태는 항상 status API 로 확인', async () => {
  const env = await setup({ auto: true, configExtra: { callback: { enabled: true } }, mockOpts: { noCallback: true, delayMs: 80 } });
  try {
    // 모르는 id / 잘못된 본문 → 200 이지만 아무 일도 일어나지 않는다 (작업 존재 여부를 알려주지 않는다)
    for (const body of [{ id: 'nope', status: 'SUCCESS' }, {}, { id: 123 }, { id: null }]) {
      const res = await api(env.port, 'POST', '/api/textsense/callback', body);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.data, { received: true });
    }
    assert.equal((await api(env.port, 'POST', '/api/textsense/callback', '{bad json')).status, 400);

    // 진행 중인 작업의 id 로 SUCCESS 를 위조해도 완료 처리되지 않고, 실제 상태(status API)가 SUCCESS 가 되어야 완료
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    await new Promise((r) => setTimeout(r, 40));
    const running = (await api(env.port, 'GET', `/api/jobs/${created.json.data.id}`)).json.data;
    if (running.taskId) await api(env.port, 'POST', '/api/textsense/callback', { id: running.taskId, status: 'SUCCESS' });
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.engineStatus, 'SUCCESS');
  } finally { await env.close(); }
});

test('콜백 기능이 꺼져 있으면 callbackUri 를 보내지 않고 콜백 경로도 없다 (기본값)', async () => {
  const env = await setup({ auto: true });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    await waitJob(env.port, created.json.data.id);
    assert.equal('callbackUri' in env.mock.requests[0], false);
    assert.equal((await api(env.port, 'POST', '/api/textsense/callback', { id: 'x' })).status, 404);
  } finally { await env.close(); }
});

test('작업 실패 메시지에 FTP 접속 정보(비밀번호)가 노출되지 않는다', async () => {
  const env = await setup({ ftp: true, auto: true, mockOpts: { failJob: true } });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'failed');
    // Mock 오류 본문에 접속 정보가 든 URI 를 넣어 TextSense 의 실제 오류 메시지(URI 포함)를 재현
    for (const j of env.mock.jobs.values()) j.errors = [{ id: 'e', code: 'RMRSNT-11010', message: `Failed to upload ftp://formreader:testpw1234@127.0.0.1:2121/${job.id}.json`, timestamp: 1 }];
    const svc = env.app.services.formJobService;
    const text = await svc._describeFailure([...env.mock.jobs.keys()][0]);
    assert.ok(text.includes('RMRSNT-11010'));
    assert.ok(!text.includes('testpw1234'), text);
    assert.ok(text.includes('ftp://***@127.0.0.1:2121'), text);
    assert.ok(!JSON.stringify(job).includes('testpw1234'));
  } finally { await env.close(); }
});

test('오류 조회 API 상태별 동작: 404/400/빈 객체여도 실패 사유 문장이 만들어진다', async () => {
  const env = await setup();
  try {
    const svc = env.app.services.formJobService;
    // 존재하지 않는 작업 id → 404 (본문 없음)
    let text = await svc._describeFailure('no-such-task');
    assert.ok(text.includes('FAILURE'), text);
    // 오류 내역이 없는 정상 작업 → 빈 객체
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    text = await svc._describeFailure(job.taskId);
    assert.ok(text.includes('FAILURE'), text);
    // TextSense 에 접속 불가 → 예외를 삼키고 기본 메시지
    svc.client.config.textsense.port = 1;
    text = await svc._describeFailure('x');
    assert.ok(text.includes('FAILURE'), text);
  } finally { await env.close(); }
});

test('build 요청이 명세를 어기면(Mock 이 400) 작업은 실패 처리되고 사유가 남는다', async () => {
  const env = await setup();
  try {
    // 클라이언트가 보낸 pages 가 명세 형식이 아닌 경우를 Mock 이 거부하는지 직접 확인
    const bad = await api(env.mock.server.address().port, 'POST', '/textsense/api/job/build', {
      inputUri: 'a', outputUri: 'b', taskName: 't', extraJobs: [{ type: 'textSense', option: { url: 'u', reqType: 'Document', reqOption: {}, outputType: 'json', pages: '1;2' } }],
    });
    assert.equal(bad.status, 400);
    const badType = await api(env.mock.server.address().port, 'POST', '/textsense/api/job/build', {
      inputUri: 'a', outputUri: 'b', taskName: 't', extraJobs: [{ type: 'textSense', option: { url: 'u', reqType: 'Document', reqOption: { SearchAPI: [{ Type: 'Nope', Name: 'n', Key: ['a'] }] }, outputType: 'json', pages: 'all' } }],
    });
    assert.equal(badType.status, 400);
  } finally { await env.close(); }
});
