'use strict';
/** 테스트 공용: 앱 + Mock TextSense 를 임시 폴더에 띄우는 도우미 (모듈 연결 테스트 확장용) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../../src/server');
const { createConfig } = require('../../src/common/app.config');
const { createMockTextSenseServer } = require('./mock-textsense.server');

process.env.FORMREADER_SILENT = '1';
process.env.FORMREADER_SKIP_DOTENV = '1'; // 개발자 PC 의 .env(실서버 설정)를 읽지 않는다

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param opts.mockOpts Mock 옵션  opts.ftp FTP 결과 수신 모드  opts.auto 주소 자동 감지(publicUrl=auto)
 * @param opts.configExtra createConfig 에 덮어쓸 최상위 설정 (예: { callback:{enabled:true}, jobPollIntervalMs:5000 })
 */
async function setup({ mockOpts = {}, textsense = {}, jobTimeoutMs = 5000, ftp = false, auto = false, configExtra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formreader-'));
  const outputDir = path.join(dir, 'output');
  const mock = createMockTextSenseServer({ outputDir: ftp ? path.join(dir, 'mock-only-output') : outputDir, ...mockOpts });
  const mockPort = await mock.start(0);
  const app = createApp(createConfig({
    port: 0, dataDir: dir, jobTimeoutMs, jobPollIntervalMs: 30, requestTimeoutMs: 2000, outputFileWaitMs: 300, publicUrl: auto ? 'auto' : '',
    textsense: { host: '127.0.0.1', port: mockPort, ...textsense },
    storage: { inputDir: path.join(dir, 'input'), outputDir },
    ftp: ftp ? { enabled: true, user: 'formreader', password: 'testpw1234', port: 0, pasvMin: 0, pasvMax: 0, publicHost: auto ? 'auto' : '127.0.0.1' } : { enabled: false },
    ...configExtra,
  }));
  const port = await app.start();
  return {
    port, mock, app, dir,
    async close() { await app.stop(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const PDF = Buffer.from('%PDF-1.4\n%fake pdf for test\n');
const upload = (name = 'sample.pdf', buf = PDF) => ({ fileName: name, contentBase64: buf.toString('base64') });

async function waitJob(port, id, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await request(port, 'GET', `/api/jobs/${id}`);
    if (['done', 'failed'].includes(json.data.status)) return json.data;
    if (Date.now() > end) throw new Error('작업 완료 대기 시간 초과');
    await new Promise((r) => setTimeout(r, 30));
  }
}

module.exports = { request, setup, upload, waitJob, PDF };
