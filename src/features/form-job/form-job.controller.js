'use strict';
/** 개별기능[form-job]: API 라우트 (작업 요청/현황/OCR 결과) */

function registerFormJobRoutes(router, { formJobService, config }) {
  router.add('GET', '/api/jobs', async () => formJobService.list());
  router.add('GET', '/api/jobs/:id', async ({ params }) => formJobService.get(params.id));
  router.add('GET', '/api/jobs/:id/ocr', async ({ params }) => formJobService.getOcrView(params.id));
  router.add('POST', '/api/jobs', async ({ body }) => formJobService.create(body));
  router.add('DELETE', '/api/jobs/:id', async ({ params }) => formJobService.remove(params.id));
  // TextSense 작업 완료 콜백 (TEXTSENSE_CALLBACK=true 일 때만 등록). 응답은 작업 존재 여부와 무관하게 동일하다.
  if (config && config.callback && config.callback.enabled) {
    router.add('POST', '/api/textsense/callback', async ({ body }) => { formJobService.notifyCallback(body); return { received: true }; });
  }
}

module.exports = { registerFormJobRoutes };
