'use strict';
/**
 * 테스트용 Mock TextSense(textsense-gateway) 서버 - 실제 REST API 명세를 따른다.
 *   POST /textsense/api/job/build   → 200 { id, name, status:'AWAITING' } / 400 / 500
 *   POST /textsense/api/job/status  → 200 { status } / 400 / 404
 *   GET  /textsense/api/job/errors  → 200 { errors:[...] } (정상 작업은 {})
 * 옵션: failWith(build HTTP 오류) / failJob(FAILURE 종료) / skipOutput(결과 미생성) / ftpMode(epsv|pasv) / dropStatusTimes(상태 조회 N회 연결 끊김)
 * 작업은 AWAITING → PROGRESSING → SUCCESS 로 진행하며, SUCCESS 가 되면 outputUri 의 파일명으로
 * 결과 JSON(document.pages.pages_N 구조)을 outputDir 에 쓴다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uploadViaFtp } = require('./ftp-upload.client');

/** TextSense 결과 JSON 형식의 샘플 (1000x1400 페이지, "청구서") */
function createSampleOcr() {
  let id = 0;
  const word = (text, x1, y1, x2, y2) => ({
    detection: { class: 1, confidence: 0.9 }, id: ++id, points: [[x1, y1], [x2, y2]],
    recognition: { confidence: [1, 0.95, 0.93], content: text }, region_type: 'rectangle', type: 'word',
  });
  const line = (words) => {
    const x1 = Math.min(...words.map((w) => w.points[0][0])); const y1 = Math.min(...words.map((w) => w.points[0][1]));
    const x2 = Math.max(...words.map((w) => w.points[1][0])); const y2 = Math.max(...words.map((w) => w.points[1][1]));
    const content = words.map((w) => w.recognition.content).join(' ');
    return { content, detection: { class: 1, confidence: 0.9 }, id: ++id, points: [[x1, y1], [x2, y2]], recognition: { confidence: 0, content }, region_type: 'rectangle', texts: words, type: 'textline' };
  };
  const cell = (r, c, text, x1, y1, x2, y2) => ({
    column_index: c, column_span: 0, content: text, description: '', detection: { confidence: 0.97 }, id: ++id,
    points: [[x1, y1], [x2, y2]], region_type: 'rectangle', row_index: r, row_span: 0, texts: [word(text, x1 + 4, y1 + 4, x2 - 4, y2 - 4)], type: 'cell',
  });

  const cells = [cell(0, 0, '품목', 50, 500, 250, 540), cell(0, 1, '금액', 250, 500, 450, 540), cell(1, 0, '서비스이용료', 50, 540, 250, 580), cell(1, 1, '1,234,000', 250, 540, 450, 580)];
  const elements = [
    line([word('청구서', 400, 50, 600, 100)]),
    line([word('문서번호', 50, 200, 150, 230), word('A-2025-001', 160, 200, 300, 230)]),
    line([word('합계금액', 50, 300, 150, 330), word('1,234,000', 160, 300, 300, 330)]),
    { cells, content: '품목 금액 서비스이용료 1,234,000', detection: { confidence: 1 }, id: ++id, num_cols: 2, num_rows: 2, points: [[50, 500], [450, 580]], region_type: 'rectangle', type: 'table' },
    line([word('1/1', 940, 1360, 1000, 1400)]), // 페이지 우하단 (페이지 크기 추정 기준점)
  ];
  return {
    document: {
      pages: {
        pages_1: {
          alignment: { confidence: null, reference: null }, classification: { class: null, confidence: null },
          content: '청구서\n문서번호 A-2025-001\n합계금액 1,234,000\n품목 금액\n서비스이용료 1,234,000\n1/1',
          description: '', orientation: 0, elements, fields: {}, flags: null, version: '2.0.0',
        },
      },
      version: '2.0.0',
    },
  };
}

/**
 * @param {{ outputDir:string, buildPath?:string, failWith?:number, failJob?:boolean, delayMs?:number }} opts
 *   failWith: build 요청에 이 HTTP 상태로 응답 / failJob: 작업을 FAILURE 로 종료 / skipOutput: 결과 파일을 쓰지 않음
 */
function createMockTextSenseServer({ outputDir, buildPath = '/textsense/api/job/build', failWith = 0, failJob = false, skipOutput = false, ftpMode = 'epsv', dropStatusTimes = 0, delayMs = 50, resultFactory = createSampleOcr }) {
  let dropStatus = dropStatusTimes; // 앞의 N 번 상태 조회를 연결 끊김으로 응답
  const requests = [];
  const jobs = new Map();
  const timers = new Set();

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  /** http(s) 입력이면 실제로 가져와 본다 (DigitalLeader 의 /files/input 제공 검증용). file: 등은 그대로 통과 */
  function checkInput(uri) {
    return new Promise((resolve) => {
      if (!/^https?:\/\//i.test(uri)) return resolve(null);
      http.get(uri, (res) => { res.resume(); resolve(res.statusCode === 200 ? null : `input HTTP ${res.statusCode}`); }).on('error', (e) => resolve(`input fetch error: ${e.code}`));
    });
  }

  function startJob(body) {
    const id = crypto.randomUUID();
    const job = { id, name: body.taskName, status: 'AWAITING', errors: [] };
    jobs.set(id, job);
    const outFile = path.join(outputDir, decodeURIComponent(body.outputUri.split('/').pop()));
    later(async () => {
      job.status = 'PROGRESSING';
      const inputError = await checkInput(body.inputUri);
      later(async () => {
        if (!failJob && !inputError && !skipOutput && /^ftp:\/\//i.test(body.outputUri)) {
          try { await uploadViaFtp(body.outputUri, Buffer.from(JSON.stringify(resultFactory(body))), { mode: ftpMode }); } // 실제 TextSense 처럼 FTP 로 업로드
          catch (e) { job.status = 'FAILURE'; job.errors = [{ id: crypto.randomUUID(), code: 'RMRSNT-11010', message: e.message, timestamp: Date.now() }]; return; }
          job.status = 'SUCCESS';
          return;
        }
        if (failJob || inputError) {
          job.status = 'FAILURE';
          job.errors = [{ id: crypto.randomUUID(), code: 'RuntimeException', message: inputError || 'Invalid image file', cause: 'mock failure', timestamp: Date.now() }];
          return;
        }
        if (!skipOutput) { // skipOutput: 공유 저장소가 연결되지 않은 상황 재현 (SUCCESS 지만 결과 파일 없음)
          fs.mkdirSync(outputDir, { recursive: true });
          fs.writeFileSync(`${outFile}.tmp`, JSON.stringify(resultFactory(body)));
          fs.renameSync(`${outFile}.tmp`, outFile);
        }
        job.status = 'SUCCESS';
      }, delayMs);
    }, Math.min(delayMs, 20));
    return job;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reply = (status, obj) => {
        if (obj === undefined) { res.writeHead(status); return res.end(); } // 명세: 400/404/500 은 본문 없이 상태만
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const url = new URL(req.url, 'http://x');
      let body = {};
      if (req.method === 'POST') {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return reply(400); }
      }

      if (req.method === 'POST' && url.pathname === buildPath) {
        requests.push(body);
        if (failWith) return reply(failWith);
        const ej = Array.isArray(body.extraJobs) ? body.extraJobs[0] : null;
        if (!body.inputUri || !body.outputUri || !body.taskName || !ej || ej.type !== 'textSense' || !ej.option || !ej.option.url || !ej.option.reqOption) return reply(400);
        const job = startJob(body);
        return reply(200, { id: job.id, name: job.name, status: job.status });
      }
      if (req.method === 'POST' && url.pathname === '/textsense/api/job/status') {
        if (dropStatus > 0) { dropStatus -= 1; return req.socket.destroy(); } // 일시적 연결 끊김(ECONNRESET) 재현
        if (body.type !== 'OBJECT_ID' || !body.id) return reply(400);
        const job = jobs.get(body.id);
        return job ? reply(200, { status: job.status }) : reply(404);
      }
      if (req.method === 'GET' && url.pathname === '/textsense/api/job/errors') {
        if (url.searchParams.get('type') !== 'OBJECT_ID' || !url.searchParams.get('id')) return reply(400);
        const job = jobs.get(url.searchParams.get('id'));
        if (!job) return reply(404);
        return reply(200, job.errors.length ? { errors: job.errors } : {});
      }
      return reply(404);
    });
  });

  return {
    server, requests, jobs,
    start: (port = 0) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    stop: () => new Promise((r) => {
      timers.forEach(clearTimeout);
      timers.clear();
      server.close(() => r());
    }),
  };
}

module.exports = { createMockTextSenseServer, createSampleOcr };
