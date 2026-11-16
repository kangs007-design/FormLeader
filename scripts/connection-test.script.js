'use strict';
/**
 * OCR 모듈 연결 테스트 (textsense.py 의 Node.js 버전)
 *   npm run test:connection        : .env 의 실제 TextSense 서버 (VPN 연결 필요)
 *   npm run test:connection:mock   : 내장 Mock 서버로 점검
 * 종료 코드: 0 = 서버 응답 수신(연결 성공), 1 = 연결 실패
 */
const path = require('path');
if (process.argv.includes('--mock')) process.env.FORMREADER_SKIP_DOTENV = '1'; // Mock 점검은 .env 를 무시한다
const { createConfig } = require('../src/common/app.config');
const { TextSenseClient } = require('../src/features/ocr-connect/textsense.client');
const { OcrConnectService } = require('../src/features/ocr-connect/ocr-connect.service');
const { createMockTextSenseServer } = require('../tests/mock/mock-textsense.server');

(async () => {
  const useMock = process.argv.includes('--mock');
  let mock = null;
  let config = createConfig();

  if (useMock) {
    mock = createMockTextSenseServer({ outputDir: path.join(config.dataDir, 'mock-output') });
    const port = await mock.start(0);
    config = createConfig({ textsense: { host: '127.0.0.1', port } });
    console.log(`[mode] MOCK (127.0.0.1:${port})`);
  } else {
    console.log(`[mode] REAL (${config.textsense.host}:${config.textsense.port}) - VPN 연결 상태를 확인하세요.`);
  }

  const service = new OcrConnectService({ config, client: new TextSenseClient(config) });
  const result = await service.testConnection();
  console.log(JSON.stringify(result, null, 2));
  console.log(result.reachable
    ? `\n[결과] 연결 성공 (HTTP ${result.httpStatus}, ${result.elapsedMs}ms)${result.accepted ? '' : ' - 단, 서버가 요청을 거부했습니다. 응답 내용을 확인하세요.'}`
    : `\n[결과] 연결 실패: ${result.error.message}`);

  if (mock) await mock.stop();
  process.exit(result.reachable ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
