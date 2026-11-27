"use strict";
/** 개별기능[form-job]: API 라우트 (작업 요청/현황/OCR 결과) */

const { ownerOf } = require("./form-job.service");

function registerFormJobRoutes(router, { formJobService, authService }) {
  router.add("GET", "/api/jobs", async ({ req }) => {
    const jobs = await formJobService.list(req.user);
    if (req.user.role !== "admin") return jobs;
    // 관리자에게는 어느 계정이 올린 문서인지 함께 알려 준다
    const users = new Map(authService.listUsers().map((u) => [u.id, u]));
    return jobs.map((job) => {
      const user = users.get(ownerOf(job));
      return { ...job, owner: user ? { name: user.name, email: user.email } : null };
    });
  });
  router.add("GET", "/api/jobs/search", async ({ query, req }) =>
    formJobService.searchContent(query.q, req.user),
  );
  router.add("GET", "/api/jobs/:id", async ({ params }) =>
    formJobService.get(params.id),
  );
  router.add("GET", "/api/jobs/:id/ocr", async ({ params }) =>
    formJobService.getOcrScreenView(params.id),
  );
  router.add("GET", "/api/jobs/:id/ocr/pages/:page", async ({ params }) =>
    formJobService.getOcrPage(params.id, params.page),
  );
  router.add("GET", "/api/jobs/:id/diagnostics", ({ params }) =>
    formJobService.diagnostics(params.id),
  );
  router.add("POST", "/api/jobs", async ({ body, req }) => {
    if (body.templateSnapshot && req.user.role !== "admin")
      throw require("../../common/app.error").AppError.badRequest(
        "서식 미리보기는 관리자만 사용할 수 있습니다.",
      );
    // 요청 본문에서 허용한 값만 전달한다 (소유자·원본 관계는 서버가 정한다)
    const { fileName, contentBase64, templateId, templateSnapshot, split } = body;
    return formJobService.create({
      fileName,
      contentBase64,
      templateId,
      templateSnapshot,
      split,
      actor: req.user.id,
    });
  });
  router.add("POST", "/api/jobs/:id/retry", async ({ params, req }) =>
    formJobService.retry(params.id, req.user.id),
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
