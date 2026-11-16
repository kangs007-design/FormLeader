'use strict';
/**
 * DigitalLeader 서버 진입점 (모듈 조립)
 *   common      : src/common
 *   features    : src/features/{ocr-connect, form-template, form-job, ocr-result}
 *   web(UI)     : src/web
 */
const http = require('http');
const crypto = require('crypto');
const { FtpReceiver } = require('./common/ftp-receiver.server');
const { createConfig } = require('./common/app.config');
const { createLogger } = require('./common/logger.util');
const { Router } = require('./common/router.util');
const { sendJson, serveStatic, serveFile } = require('./common/http-response.util');

const { TextSenseClient } = require('./features/ocr-connect/textsense.client');
const { OcrConnectService } = require('./features/ocr-connect/ocr-connect.service');
const { registerOcrConnectRoutes } = require('./features/ocr-connect/ocr-connect.controller');
const { FormTemplateService } = require('./features/form-template/form-template.service');
const { registerFormTemplateRoutes } = require('./features/form-template/form-template.controller');
const { OcrResultService } = require('./features/ocr-result/ocr-result.service');
const { FormJobService } = require('./features/form-job/form-job.service');
const { registerFormJobRoutes } = require('./features/form-job/form-job.controller');

/** 서비스와 HTTP 서버를 조립한다. (listen 은 start 에서) */
function createApp(config = createConfig()) {
  const log = createLogger('server');

  const client = new TextSenseClient(config);
  const ocrConnectService = new OcrConnectService({ config, client });
  const formTemplateService = new FormTemplateService({ config });
  const ocrResultService = new OcrResultService({ formTemplateService });
  const formJobService = new FormJobService({ config, client, ocrResultService, formTemplateService });

  const router = new Router();
  const deps = { config, ocrConnectService, formTemplateService, formJobService, ocrResultService };
  router.add('GET', '/api/health', async () => ({ status: 'UP', time: new Date().toISOString() }));
  registerOcrConnectRoutes(router, deps);
  registerFormTemplateRoutes(router, deps);
  registerFormJobRoutes(router, deps);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        // 업로드한 원본 파일(문서 확인 화면의 미리보기용). 작업 id 로만 접근하며 경로를 직접 받지 않는다.
        const fileRoute = req.method === 'GET' && /^\/api\/jobs\/([^/]+)\/file$/.exec(url.pathname);
        if (fileRoute) {
          const job = await formJobService.get(decodeURIComponent(fileRoute[1])).catch(() => null);
          if (job && serveFile(config.storage.inputDir, job.storedName, res)) return;
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '원본 파일을 찾을 수 없습니다.' } });
          return;
        }
        if (!(await router.handle(req, res, url))) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `API 없음: ${req.method} ${url.pathname}` } });
        }
        return;
      }
      // TextSense 가 http:// 로 입력 파일을 가져갈 수 있게 한다. (FORMREADER_PUBLIC_URL 설정 시에만 활성화)
      if (config.publicUrl && req.method === 'GET' && url.pathname.startsWith('/files/input/')) {
        if (serveFile(config.storage.inputDir, url.pathname.slice('/files/input/'.length), res)) { log.info(`입력 파일 전달: ${url.pathname.split('/').pop()} → ${req.socket.remoteAddress}`); return; }
        res.writeHead(404); res.end(); return;
      }
      if (req.method === 'GET' && serveStatic(config.webDir, url.pathname, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      log.error('요청 처리 오류', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  // 내장 FTP 수신기 (TextSense 가 결과 JSON 을 업로드할 대상). 수신 폴더 = 결과를 읽는 폴더
  let ftpReceiver = null;
  if (config.ftp.enabled) {
    if (!config.ftp.publicHost) throw new Error('FTP_ENABLED=true 이면 FORMREADER_PUBLIC_URL 또는 FTP_PUBLIC_HOST 가 필요합니다. (TextSense 서버가 접속할 이 PC 의 주소)');
    if (!config.ftp.password) config.ftp.password = crypto.randomBytes(9).toString('hex');
    ftpReceiver = new FtpReceiver({ ...config.ftp, dir: config.storage.outputDir, log: createLogger('ftp') });
  }

  const start = async () => {
    if (ftpReceiver) {
      config.ftp.port = await ftpReceiver.start();
      log.info(`FTP 수신기 시작: 포트 ${config.ftp.port}, 패시브 ${config.ftp.pasvMin}-${config.ftp.pasvMax}, 저장 폴더 ${config.storage.outputDir}`);
    }
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, () => {
        const { port } = server.address();
        config.httpPort = port; // port=0(임의 포트)일 때도 TextSense 에 알려줄 실제 포트
        log.info(`DigitalLeader 시작: http://localhost:${port}  (TextSense ${config.textsense.host}:${config.textsense.port})`);
        resolve(port);
      });
    });
  };
  const stop = async () => {
    await formJobService.idle();
    if (ftpReceiver) await ftpReceiver.stop();
    await new Promise((r) => server.close(() => r()));
  };

  return { config, server, start, stop, services: deps };
}

module.exports = { createApp };

if (require.main === module) {
  createApp().start().catch((err) => { console.error('시작 실패:', err.message); process.exit(1); });
}
