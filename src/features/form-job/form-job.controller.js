"use strict";
/** 개별기능[form-job]: API 라우트 (작업 요청/현황/OCR 결과) */

function registerFormJobRoutes(router, { formJobService }) {
  router.add("GET", "/api/jobs", async () => formJobService.list());
  router.add("GET", "/api/jobs/:id", async ({ params }) =>
    formJobService.get(params.id),
  );
  router.add("GET", "/api/jobs/:id/ocr", async ({ params }) =>
    formJobService.getOcrView(params.id),
  );
  router.add("GET", "/api/jobs/:id/diagnostics", ({ params }) =>
    formJobService.diagnostics(params.id),
  );
  router.add("POST", "/api/jobs", async ({ body, req }) => {
    if (body.templateSnapshot && req.user.role !== "admin")
      throw require("../../common/app.error").AppError.badRequest(
        "서식 미리보기는 관리자만 사용할 수 있습니다.",
      );
    return formJobService.create({ ...body, actor: req.user.id });
  });
  router.add("POST", "/api/jobs/:id/retry", async ({ params }) =>
    formJobService.retry(params.id),
  );
  router.add("PUT", "/api/jobs/:id/review", async ({ params, body, req }) =>
    formJobService.saveReview(params.id, { ...body, actor: req.user.id }),
  );
  router.add("POST", "/api/jobs/:id/cancel", ({ params, req }) =>
    formJobService.cancel(params.id, req.user.id),
  );
  router.add("POST", "/api/jobs/:id/reapply", ({ params, body, req }) =>
    formJobService.reapply(params.id, body.templateId, req.user.id),
  );
  router.add("POST", "/api/jobs/:id/split", ({ params, body, req }) =>
    formJobService.splitDocument(params.id, body.groups, req.user.id),
  );
  router.add("DELETE", "/api/jobs/:id", async ({ params }) =>
    formJobService.remove(params.id),
  );
}

module.exports = { registerFormJobRoutes };
