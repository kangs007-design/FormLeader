'use strict';
/** 개별기능[ocr-connect]: API 라우트 */

function registerOcrConnectRoutes(router, { ocrConnectService }) {
  router.add('GET', '/api/ocr/connection', async () => ocrConnectService.getConnectionInfo());
  router.add('POST', '/api/ocr/connection-test', async () => ocrConnectService.testConnection());
}

module.exports = { registerOcrConnectRoutes };
