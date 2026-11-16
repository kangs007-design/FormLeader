"use strict";
const path = require("path");
const { serveFile } = require("../../common/http-response.util");
const { imagePage } = require("../../common/document.util");
const { AppError } = require("../../common/app.error");

function registerWorkspaceRoutes(
  router,
  {
    workspaceService: workspace,
    documentExportService: exports,
    formJobService: jobs,
  },
) {
  router.add("GET", "/api/workspace/settings", () => workspace.getSettings());
  router.add("PUT", "/api/workspace/settings", ({ body }) =>
    workspace.saveSettings(body),
  );
  router.add("GET", "/api/workspace/monitor", () => workspace.monitor());
  router.add("POST", "/api/workspace/reset", ({ body, req }) =>
    workspace.reset(body, req.user.id),
  );
  router.add("POST", "/api/samples", ({ body }) => workspace.sample(body));
  router.add("GET", "/api/samples/:id", ({ params }) =>
    workspace.getSample(params.id),
  );
  router.add("GET", "/api/samples/:id/file", async ({ params, res }) => {
    const s = await workspace.getSample(params.id);
    if (!serveFile(workspace.config.storage.inputDir, s.storedName, res))
      throw AppError.notFound("샘플 파일이 없습니다.");
  });
  router.add(
    "GET",
    "/api/samples/:id/image",
    async ({ params, query, res }) => {
      const s = await workspace.getSample(params.id);
      const bytes = await imagePage(
        path.join(workspace.config.storage.inputDir, s.storedName),
        query.page || 1,
      );
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": bytes.length,
      });
      res.end(bytes);
    },
  );
  router.add("POST", "/api/samples/preview", ({ body, req }) =>
    workspace.preview(body, req.user.id),
  );
  router.add("POST", "/api/comparisons", ({ body, req }) =>
    workspace.compare(body, req.user.id),
  );
  router.add("GET", "/api/comparisons", async () =>
    (await workspace.comparisons.list()).map(({ differences, ...c }) => ({
      ...c,
      differenceCount: differences.length,
    })),
  );
  router.add("GET", "/api/comparisons/:id", async ({ params }) => {
    const c = await workspace.comparisons.get(params.id);
    if (!c) throw AppError.notFound("비교 결과가 없습니다.");
    return c;
  });
  router.add("GET", "/api/jobs/:id/export", async ({ params, query, res }) => {
    const out = await exports.export(params.id, query.format || "json");
    res.writeHead(200, {
      "Content-Type": out.type,
      "Content-Length": out.bytes.length,
      "Content-Disposition": `attachment; filename="result.${(query.format || "json").replace(/[^a-z]/g, "")}"; filename*=UTF-8''${encodeURIComponent(out.name)}`,
    });
    res.end(out.bytes);
  });
  router.add("GET", "/api/jobs/:id/image", async ({ params, query, res }) => {
    const j = await jobs.get(params.id);
    const bytes = await imagePage(
      path.join(workspace.config.storage.inputDir, j.storedName),
      query.page || 1,
    );
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": bytes.length,
    });
    res.end(bytes);
  });
  router.add("POST", "/api/jobs/:id/deliver", ({ params, req }) =>
    workspace.deliver(params.id, req.user.id),
  );
}
module.exports = { registerWorkspaceRoutes };
