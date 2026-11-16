'use strict';
/**
 * Mock TextSense 와 DigitalLeader 를 함께 실행한다. (VPN 없이 화면/연동 확인용)
 *   npm run start:mock  →  http://localhost:3000
 */
const path = require('path');
process.env.FORMREADER_SKIP_DOTENV = '1'; // Mock 실행은 .env(실서버 설정)를 무시한다
process.env.FORMREADER_MOCK_MODE = '1';
process.env.FORMREADER_DATA_DIR ||= './data/mock-workspace';
const { createApp } = require('../src/server');
const { createConfig } = require('../src/common/app.config');
const { createMockTextSenseServer } = require('../tests/mock/mock-textsense.server');

(async () => {
  const base = createConfig();
  const outputDir = path.join(base.dataDir, 'mock-output');
  const mock = createMockTextSenseServer({ outputDir });
  const mockPort = await mock.start(0);

  const app = createApp(createConfig({
    textsense: { host: '127.0.0.1', port: mockPort },
    storage: { outputDir, inputDir: path.join(base.dataDir, 'mock-input') },
  }));
  await app.start();
  console.log(`[mock] TextSense Mock 서버: 127.0.0.1:${mockPort}  (샘플 문서: "청구서" / 문서번호 / 합계금액)`);
})().catch((e) => { console.error(e); process.exit(1); });
