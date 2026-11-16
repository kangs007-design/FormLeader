'use strict';
/** 개별기능[form-job]: API 라우트 (작업 요청/현황/OCR 결과) */

function registerFormJobRoutes(router, { formJobService }) {
  router.add('GET', '/api/jobs', async () => formJobService.list());
  router.add('GET', '/api/jobs/:id', async ({ params }) => formJobService.get(params.id));
  router.add('GET', '/api/jobs/:id/ocr', async ({ params }) => formJobService.getOcrView(params.id));
  router.add('POST', '/api/jobs', async ({ body }) => formJobService.create(body));
  router.add('DELETE', '/api/jobs/:id', async ({ params }) => formJobService.remove(params.id));
}

module.exports = { registerFormJobRoutes };
