'use strict';
/**
 * 모듈 연결 테스트 (textsense.py 연결 테스트의 확장)
 *  DigitalLeader 서버 ↔ (HTTP, 실제 REST API 명세) ↔ Mock TextSense 를 실제로 띄워 전 구간을 검증한다.
 *    1) 연결 테스트 API(build + status)   2) 연결 불가 처리
 *    3) PDF/이미지 업로드 → build → status 폴링 → 결과 JSON → OCR 추출값 + 서식 Key-Value
 *    4) TextSense 오류(FAILURE / HTTP 500 / 타임아웃)   5) 입력 검증, 보안
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../../src/server');
const { createConfig } = require('../../src/common/app.config');
const { createMockTextSenseServer } = require('../mock/mock-textsense.server');

process.env.FORMREADER_SILENT = '1';
process.env.FORMREADER_SKIP_DOTENV = '1'; // 개발자 PC 의 .env(실서버 설정)를 읽지 않는다
const sessions = new Map();

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Origin: `http://localhost:${port}`, 'X-Requested-With': 'TextSense', ...(sessions.has(port) ? { Cookie: sessions.get(port) } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const api = request;

async function setup({ mockOpts = {}, textsense = {}, jobTimeoutMs = 5000, ftp = false, auto = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formreader-'));
  const outputDir = path.join(dir, 'output');
  // FTP 모드에서는 Mock 이 파일 시스템에 직접 쓰지 못하게 분리 → 반드시 FTP 업로드로만 결과가 도착해야 통과
  const mock = createMockTextSenseServer({ outputDir: ftp ? path.join(dir, 'mock-only-output') : outputDir, ...mockOpts });
  const mockPort = await mock.start(0);
  const app = createApp(createConfig({
    port: 0, dataDir: dir, jobTimeoutMs, jobPollIntervalMs: 30, requestTimeoutMs: 2000, outputFileWaitMs: 300, publicUrl: auto ? 'auto' : '',
    textsense: { host: '127.0.0.1', port: mockPort, ...textsense },
    storage: { inputDir: path.join(dir, 'input'), outputDir },
    ftp: ftp ? { enabled: true, user: 'formreader', password: 'testpw1234', port: 0, pasvMin: 0, pasvMax: 0, publicHost: auto ? 'auto' : '127.0.0.1' } : { enabled: false },
  }));
  const port = await app.start();
  const first = await api(port, 'POST', '/api/account/setup', { name: 'Test Admin', email: 'admin@example.test', password: 'Test-only-password-2026' });
  assert.equal(first.status, 200, first.text);
  const login = await api(port, 'POST', '/api/auth/sign-in/email', { email: 'admin@example.test', password: 'Test-only-password-2026' });
  assert.equal(login.status, 200, login.text);
  sessions.set(port, login.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; '));
  return {
    port, mock, app,
    async close() { sessions.delete(port); await app.stop(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const sampleForm = {
  name: '청구서', docType: 'invoice', keywords: ['청구서'],
  keys: [
    { name: 'docNo', rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 }, required: true, verify: true, pattern: '^A-\\d{4}-\\d{3}$' },
    { name: 'amount', rect: { x: 0.15, y: 0.2, w: 0.2, h: 0.05 }, required: true, min: 0, max: 5000000 },
  ],
};
const PDF = Buffer.from('%PDF-1.4\n%fake pdf for test\n');
const upload = (name = 'sample.pdf', buf = PDF) => ({ fileName: name, contentBase64: buf.toString('base64') });

function pngHeader(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

async function waitJob(port, id, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api(port, 'GET', `/api/jobs/${id}`);
    if (['done', 'failed'].includes(json.data.status)) return json.data;
    if (Date.now() > end) throw new Error('작업 완료 대기 시간 초과');
    await new Promise((r) => setTimeout(r, 30));
  }
}

test('연결 테스트 API: build 요청 본문이 명세와 일치하고 status 까지 조회된다', async () => {
  const env = await setup();
  try {
    const { status, json } = await api(env.port, 'POST', '/api/ocr/connection-test', {});
    assert.equal(status, 200);
    assert.equal(json.data.reachable, true);
    assert.equal(json.data.accepted, true);
    assert.equal(json.data.response.status, 'AWAITING');
    assert.ok(json.data.response.id);
    assert.equal(json.data.statusCheck.httpStatus, 200);
    assert.ok(['AWAITING', 'PROGRESSING', 'SUCCESS'].includes(json.data.statusCheck.status));

    const sent = env.mock.requests[0];
    assert.equal(sent.inputUri, 'file:///ePapyrus/data/input/pdf.pdf');
    assert.equal(sent.outputUri, 'file:///ePapyrus/data/output/connection-test.json'); // outputUri 는 결과 파일 자체
    assert.equal(sent.taskName, 'simple-conversion-sample');
    assert.equal(sent.option.withoutConversion, true);
    assert.equal(sent.extraJobs[0].type, 'textSense');
    assert.equal(sent.extraJobs[0].option.url, 'http://textsense:8080');
    assert.equal(sent.extraJobs[0].option.reqType, 'Document');
    assert.deepEqual(sent.extraJobs[0].option.reqOption, {});
    assert.equal(sent.extraJobs[0].option.pages, 'all');
    assert.equal(sent.extraJobs[0].option.outputType, 'json');
  } finally { await env.close(); }
});

test('연결 불가(서버 다운): reachable=false 로 정상 응답', async () => {
  const env = await setup({ textsense: { port: 1 } });
  try {
    const { status, json } = await api(env.port, 'POST', '/api/ocr/connection-test', {});
    assert.equal(status, 200);
    assert.equal(json.data.reachable, false);
    assert.ok(json.data.error.message.includes('연결 실패'));
  } finally { await env.close(); }
});

test('PDF 업로드 → OCR → 추출값(본문/단어/표) + 서식 Key-Value', async () => {
  const env = await setup();
  try {
    const form = await api(env.port, 'POST', '/api/forms', sampleForm);
    assert.equal(form.status, 200);

    const created = await api(env.port, 'POST', '/api/jobs', { ...upload('청구서.pdf'), templateId: form.json.data.id });
    assert.equal(created.status, 200);
    assert.equal(created.json.data.status, 'pending');
    assert.equal(created.json.data.fileName, '청구서.pdf');

    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.engineStatus, 'SUCCESS');
    assert.ok(job.taskId);
    assert.equal(job.ocrResult.docType, 'invoice');
    assert.equal(job.ocrResult.values.docNo.value, 'A-2025-001');
    assert.equal(job.ocrResult.values.amount.value, '1,234,000');
    assert.equal(job.ocrResult.needsReview, false);
    assert.equal(job.ocrResult.pageCount, 1);
    assert.equal(job.ocrResult.wordCount, 10);

    // TextSense 로 전달된 URI 검증
    const sent = env.mock.requests.at(-1);
    assert.equal(sent.inputUri, `file:///ePapyrus/data/input/${job.storedName}`);
    assert.equal(sent.outputUri, `file:///ePapyrus/data/output/${job.id}.json`);

    // 페이지별 OCR 추출값 (결과 화면용 API)
    const ocr = await api(env.port, 'GET', `/api/jobs/${job.id}/ocr`);
    assert.equal(ocr.status, 200);
    const page = ocr.json.data.pages[0];
    assert.match(page.content, /문서번호 A-2025-001/);
    assert.equal(page.words.length, 10);
    assert.deepEqual(page.tables[0].grid[1], ['서비스이용료', '1,234,000']);
    assert.equal(page.sizeSource, 'estimated'); // PDF 는 페이지 크기를 모르므로 추정

    const list = await api(env.port, 'GET', '/api/jobs');
    assert.equal(list.json.data.length, 1);
    assert.equal('ocrResult' in list.json.data[0], false); // 목록은 요약만 (Key-Value 제외)
    assert.deepEqual(list.json.data[0].result, { classified: true, docType: 'invoice', needsReview: false, pageCount: 1, wordCount: 10, tableCount: 1 });
  } finally { await env.close(); }
});

/** 헤더와 바이너리 본문까지 받는 GET (원본 파일 다운로드 검증용) */
function rawGet(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: sessions.has(port) ? { Cookie: sessions.get(port) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('검수 수정값은 원본 OCR과 분리해 저장되고 목록에 검수 상태가 유지된다', async () => {
  const env = await setup();
  try {
    const form = await api(env.port, 'POST', '/api/forms', sampleForm);
    const created = await api(env.port, 'POST', '/api/jobs', { ...upload('review.pdf'), templateId: form.json.data.id });
    const original = await waitJob(env.port, created.json.data.id);
    const saved = await api(env.port, 'PUT', `/api/jobs/${original.id}/review`, { values: { docNo: 'A-2026-042', amount: '2,000,000' }, confirmed: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.data.review.values.amount.value, '2,000,000');
    assert.equal(saved.json.data.review.values.amount.originalValue, '1,234,000');
    assert.equal(saved.json.data.ocrResult.values.amount.value, '1,234,000');
    assert.equal((await api(env.port, 'GET', `/api/jobs/${original.id}`)).json.data.review.confirmed, true);
    assert.equal((await api(env.port, 'GET', '/api/jobs')).json.data[0].review.confirmed, true);
    const invalid = { values: { docNo: 'invalid', amount: '99999999' }, confirmed: true };
    assert.equal((await api(env.port, 'PUT', `/api/jobs/${original.id}/review`, invalid)).status, 400);
    const draft = await api(env.port, 'PUT', `/api/jobs/${original.id}/review`, { ...invalid, confirmed: false });
    assert.equal(draft.status, 200);
    assert.equal(draft.json.data.review.values.docNo.valid, false);
    assert.equal(draft.json.data.review.confirmed, false);
    for (const body of [{ values: { unknown: 'x' } }, { values: { docNo: 123, amount: '' } }, { values: [], confirmed: true }, null]) {
      assert.equal((await api(env.port, 'PUT', `/api/jobs/${original.id}/review`, body)).status, 400);
    }
  } finally { await env.close(); }
});

test('미분류 문서는 본문을 검수하고 저장해도 엔진 결과가 바뀌지 않는다', async () => {
  const env = await setup();
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    const saved = await api(env.port, 'PUT', `/api/jobs/${job.id}/review`, { text: '검수한 본문입니다.\n쉼표, 따옴표 "유지"', confirmed: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.data.review.text, '검수한 본문입니다.\n쉼표, 따옴표 "유지"');
    assert.equal(saved.json.data.ocrResult.classified, false);
    assert.equal((await api(env.port, 'GET', `/api/jobs/${job.id}/ocr`)).json.data.pages[0].content.includes('청구서'), true);
    assert.equal((await api(env.port, 'PUT', `/api/jobs/${job.id}/review`, { text: 3 })).status, 400);
    assert.equal((await api(env.port, 'PUT', '/api/jobs/missing/review', { text: '' })).status, 404);
  } finally { await env.close(); }
});

test('연결 복구 후 실패한 문서를 보관된 원본으로 재처리하고 이전 기록을 유지한다', async () => {
  const env = await setup();
  try {
    env.app.config.publicUrl = 'http://127.0.0.1:1';
    const created = await api(env.port, 'POST', '/api/jobs', upload('retry.pdf'));
    const failed = await waitJob(env.port, created.json.data.id);
    assert.equal(failed.status, 'failed');
    env.app.config.publicUrl = '';
    const response = await api(env.port, 'POST', `/api/jobs/${failed.id}/retry`, {});
    assert.equal(response.status, 200);
    assert.notEqual(response.json.data.id, failed.id);
    const retried = await waitJob(env.port, response.json.data.id);
    assert.equal(retried.status, 'done', retried.error);
    assert.equal(retried.fileName, 'retry.pdf');
    assert.deepEqual((await rawGet(env.port, `/api/jobs/${retried.id}/file`)).body, PDF);
    assert.equal((await api(env.port, 'GET', `/api/jobs/${failed.id}`)).json.data.status, 'failed');
    assert.equal((await api(env.port, 'POST', `/api/jobs/${retried.id}/retry`, {})).status, 400);
  } finally { await env.close(); }
});

test('엔진 연결 실패는 파일 저장과 구분해서 안내한다', async () => {
  const env = await setup({ textsense: { port: 1 } });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode, 'ENGINE_CONNECTION');
    assert.match(job.error, /정상 저장.*VPN/);
    assert.deepEqual((await rawGet(env.port, `/api/jobs/${job.id}/file`)).body, PDF);
  } finally { await env.close(); }
});

test('원본 미리보기: 작업 id 로 업로드한 원본(PDF/이미지)을 변형 없이 내려준다', async () => {
  const env = await setup();
  try {
    const pdfJob = await waitJob(env.port, (await api(env.port, 'POST', '/api/jobs', upload('원본.pdf'))).json.data.id);
    const pdf = await rawGet(env.port, `/api/jobs/${pdfJob.id}/file`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.headers['content-disposition'], 'inline');
    assert.equal(pdf.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(pdf.body, PDF); // 바이트 단위로 동일

    const png = pngHeader(100, 50);
    const imgJob = await waitJob(env.port, (await api(env.port, 'POST', '/api/jobs', upload('scan.png', png))).json.data.id);
    const img = await rawGet(env.port, `/api/jobs/${imgJob.id}/file`);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.deepEqual(img.body, png);

    // 존재하지 않는 작업 / 경로 조작 시도는 파일을 내주지 않는다
    assert.equal((await rawGet(env.port, '/api/jobs/nope/file')).status, 404);
    assert.equal((await rawGet(env.port, '/api/jobs/..%2F..%2Fpackage.json/file')).status, 404);
    // 작업을 삭제하면 원본 접근도 막힌다
    await api(env.port, 'DELETE', `/api/jobs/${pdfJob.id}`);
    assert.equal((await rawGet(env.port, `/api/jobs/${pdfJob.id}/file`)).status, 404);
  } finally { await env.close(); }
});

test('pdf.js 정적 파일이 올바른 MIME 으로 제공된다 (모듈/워커는 JavaScript, wasm)', async () => {
  const env = await setup();
  try {
    const lib = await rawGet(env.port, '/vendor/pdfjs/build/pdf.min.mjs');
    assert.equal(lib.status, 200);
    assert.match(lib.headers['content-type'], /^text\/javascript/);
    const worker = await rawGet(env.port, '/vendor/pdfjs/build/pdf.worker.min.mjs');
    assert.match(worker.headers['content-type'], /^text\/javascript/);
    assert.equal((await rawGet(env.port, '/vendor/pdfjs/wasm/openjpeg.wasm')).headers['content-type'], 'application/wasm');
    assert.equal((await rawGet(env.port, '/vendor/pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap')).status, 200); // 한글 CMap
    assert.equal((await rawGet(env.port, '/vendor/pdfjs/standard_fonts/FoxitFixed.pfb')).status, 200);
  } finally { await env.close(); }
});

test('이미지 업로드: 헤더에서 읽은 픽셀 크기로 영역 좌표를 계산한다', async () => {
  const env = await setup();
  try {
    const form = await api(env.port, 'POST', '/api/forms', sampleForm);
    // 이미지 크기를 2배로 선언 → 같은 픽셀 좌표는 비율이 절반이 되어 영역에서 벗어난다
    const wrong = await waitJob(env.port, (await api(env.port, 'POST', '/api/jobs', { ...upload('big.png', pngHeader(2000, 2800)), templateId: form.json.data.id })).json.data.id);
    assert.equal(wrong.status, 'done');
    assert.equal(wrong.ocrResult.values.docNo.value, '');
    assert.equal(wrong.ocrResult.needsReview, true);

    const right = await waitJob(env.port, (await api(env.port, 'POST', '/api/jobs', { ...upload('ok.png', pngHeader(1000, 1400)), templateId: form.json.data.id })).json.data.id);
    assert.equal(right.ocrResult.values.docNo.value, 'A-2025-001');
    const ocr = await api(env.port, 'GET', `/api/jobs/${right.id}/ocr`);
    assert.equal(ocr.json.data.pages[0].sizeSource, 'image');
  } finally { await env.close(); }
});

test('서식 미지정 업로드: 키워드 자동 분류 / 서식 없으면 미분류(추출값은 제공)', async () => {
  const env = await setup();
  try {
    const a = await api(env.port, 'POST', '/api/jobs', upload());
    const unclassified = await waitJob(env.port, a.json.data.id);
    assert.equal(unclassified.status, 'done');
    assert.equal(unclassified.ocrResult.classified, false);
    assert.equal(unclassified.ocrResult.wordCount, 10); // 미분류여도 OCR 추출값은 확인 가능
    assert.equal((await api(env.port, 'GET', `/api/jobs/${unclassified.id}/ocr`)).status, 200);

    await api(env.port, 'POST', '/api/forms', sampleForm);
    const b = await api(env.port, 'POST', '/api/jobs', upload());
    const classified = await waitJob(env.port, b.json.data.id);
    assert.equal(classified.ocrResult.classified, true);
    assert.equal(classified.ocrResult.values.docNo.value, 'A-2025-001');
  } finally { await env.close(); }
});

test('TextSense 작업이 FAILURE 면 /job/errors 내용으로 failed 처리', async () => {
  const env = await setup({ mockOpts: { failJob: true } });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.engineStatus, 'FAILURE');
    assert.match(job.error, /Invalid image file/);
    assert.equal((await api(env.port, 'GET', `/api/jobs/${job.id}/ocr`)).status, 400); // 결과 없음
  } finally { await env.close(); }
});

test('build 요청이 HTTP 500 이면 작업은 failed', async () => {
  const env = await setup({ mockOpts: { failWith: 500 } });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /HTTP 500/);
  } finally { await env.close(); }
});

test('작업이 끝나지 않으면 타임아웃으로 failed', async () => {
  const env = await setup({ mockOpts: { delayMs: 60000 }, jobTimeoutMs: 300 });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /시간 초과/);
  } finally { await env.close(); }
});

test('SUCCESS 인데 결과 파일이 공유 저장소에 없으면 원인을 안내하며 failed', async () => {
  const env = await setup({ mockOpts: { skipOutput: true } });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /LOCAL_OUTPUT_DIR/);
  } finally { await env.close(); }
});

test('FORMREADER_PUBLIC_URL 설정 시 입력 파일을 http:// 로 전달하고 TextSense 가 가져갈 수 있다', async () => {
  const env = await setup();
  try {
    env.app.config.publicUrl = `http://127.0.0.1:${env.port}`;
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error); // Mock 이 http 입력을 실제로 GET 해서 검증
    const input = new URL(env.mock.requests.at(-1).inputUri);
    assert.equal(input.pathname, `/files/input/${job.storedName}`);
    assert.ok(input.searchParams.get('token'));

    const file = await request(env.port, 'GET', `${input.pathname}${input.search}`);
    assert.equal(file.status, 200);
    assert.equal(file.text, PDF.toString());
    assert.equal((await request(env.port, 'GET', `/files/input/${job.storedName}`)).status, 403);
    assert.equal((await request(env.port, 'GET', '/files/input/nope.pdf')).status, 403);
    assert.equal((await request(env.port, 'GET', '/files/input/..%2f..%2fpackage.json')).status, 403);
    assert.equal((await request(env.port, 'GET', '/files/input/')).status, 403);
  } finally { await env.close(); }
});

test('공유 폴더 없이: 입력은 http, 결과 JSON 은 ftp 로 업로드되어 추출값까지 표시', async () => {
  const env = await setup({ ftp: true });
  try {
    env.app.config.publicUrl = `http://127.0.0.1:${env.port}`;
    const form = await api(env.port, 'POST', '/api/forms', sampleForm);
    const created = await api(env.port, 'POST', '/api/jobs', { ...upload('청구서.pdf'), templateId: form.json.data.id });
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.ocrResult.values.docNo.value, 'A-2025-001');

    const sent = env.mock.requests.at(-1);
    assert.match(sent.inputUri, /^http:\/\/127\.0\.0\.1:\d+\/files\/input\//);
    assert.match(sent.outputUri, new RegExp(`^ftp://formreader:testpw1234@127\\.0\\.0\\.1:${env.app.config.ftp.port}/${job.id}\\.json$`));
    assert.ok(fs.existsSync(path.join(env.app.config.storage.outputDir, `${job.id}.json`))); // FTP 수신기가 저장
    assert.equal((await api(env.port, 'GET', `/api/jobs/${job.id}/ocr`)).json.data.pages[0].words.length, 10);
    assert.equal(JSON.stringify(job).includes('testpw1234'), false); // 비밀번호는 작업 기록에 남지 않음
  } finally { await env.close(); }
});

test('주소 자동 감지(auto): VPN 처럼 주소가 바뀌어도 작업마다 TextSense 로 나가는 경로의 주소를 사용', async () => {
  const env = await setup({ ftp: true, auto: true }); // TextSense 가 127.0.0.1 이므로 감지 결과도 127.0.0.1
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    const sent = env.mock.requests.at(-1);
    const input = new URL(sent.inputUri);
    assert.equal(input.origin + input.pathname, `http://127.0.0.1:${env.port}/files/input/${job.storedName}`);
    assert.ok(input.searchParams.get('token'));
    assert.match(sent.outputUri, new RegExp(`^ftp://formreader:testpw1234@127\\.0\\.0\\.1:${env.app.config.ftp.port}/`));
  } finally { await env.close(); }
});

test('상태 조회가 일시적으로 끊겨도(ECONNRESET) 재시도해서 작업을 이어간다', async () => {
  const env = await setup({ mockOpts: { dropStatusTimes: 3 } });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.ocrResult.wordCount, 10);
  } finally { await env.close(); }
});

test('상태 조회 실패가 계속되면(재시도 한도 초과) 연결 오류로 failed', async () => {
  const env = await setup({ mockOpts: { dropStatusTimes: 1000 } });
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /연결 실패|ECONNRESET/);
  } finally { await env.close(); }
});

test('FTP 업로드가 실패하면(TextSense 측 FAILURE) 원인이 작업 오류로 표시된다', async () => {
  const env = await setup({ ftp: true });
  try {
    env.app.config.ftp.password = 'changed-after-start'; // 수신기 비밀번호와 불일치 → 로그인 실패 재현
    env.app.config.publicUrl = `http://127.0.0.1:${env.port}`;
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /530|PASS/);
  } finally { await env.close(); }
});

test('FTP 켜고 접속 주소를 안 주면 시작 단계에서 명확한 오류', () => {
  assert.throws(() => createApp(createConfig({ dataDir: os.tmpdir(), ftp: { enabled: true, publicHost: '' } })), /FORMREADER_PUBLIC_URL|FTP_PUBLIC_HOST/);
});

test('publicUrl 미설정이면 /files/input 은 비활성화', async () => {
  const env = await setup();
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload());
    const job = await waitJob(env.port, created.json.data.id);
    assert.equal((await request(env.port, 'GET', `/files/input/${job.storedName}`)).status, 404);
  } finally { await env.close(); }
});

test('입력 검증: 잘못된 확장자 / 없는 서식 / 없는 작업 / 깨진 JSON', async () => {
  const env = await setup();
  try {
    assert.equal((await api(env.port, 'POST', '/api/jobs', upload('evil.exe'))).status, 400);
    assert.equal((await api(env.port, 'POST', '/api/jobs', { ...upload(), templateId: 'nope' })).status, 404);
    assert.equal((await api(env.port, 'GET', '/api/jobs/nope')).status, 404);
    assert.equal((await api(env.port, 'GET', '/api/jobs/nope/ocr')).status, 404);
    assert.equal((await api(env.port, 'POST', '/api/forms', { name: 'x' })).status, 400);
    assert.equal((await api(env.port, 'GET', '/api/unknown')).status, 404);
    assert.equal((await request(env.port, 'POST', '/api/forms', '{broken')).status, 400);
  } finally { await env.close(); }
});

test('경로 조작 파일명은 입력 폴더 밖으로 저장되지 않음', async () => {
  const env = await setup();
  try {
    const created = await api(env.port, 'POST', '/api/jobs', upload('..\\..\\evil.pdf'));
    assert.equal(created.status, 200);
    assert.equal(created.json.data.fileName, 'evil.pdf');
    assert.ok(fs.existsSync(path.join(env.app.config.storage.inputDir, created.json.data.storedName)));
    await waitJob(env.port, created.json.data.id);
  } finally { await env.close(); }
});

test('서식 CRUD + 웹 화면/정적 파일 + 헬스체크', async () => {
  const env = await setup();
  try {
    const c = await api(env.port, 'POST', '/api/forms', sampleForm);
    const id = c.json.data.id;
    const u = await api(env.port, 'PUT', `/api/forms/${id}`, { ...sampleForm, name: '청구서2' });
    assert.equal(u.json.data.name, '청구서2');
    assert.equal((await api(env.port, 'DELETE', `/api/forms/${id}`)).status, 200);
    assert.equal((await api(env.port, 'GET', `/api/forms/${id}`)).status, 404);
    assert.equal((await api(env.port, 'GET', '/api/health')).json.data.status, 'UP');

    const html = await request(env.port, 'GET', '/');
    assert.equal(html.status, 200);
    assert.match(html.text, /TextSense · Document Workspace/);
    assert.equal((await request(env.port, 'GET', '/..%2f..%2fpackage.json')).status, 404);
  } finally { await env.close(); }
});
