"use strict";
// Uses only generated sample documents in an isolated workspace; leaves .env and real data unchanged.
const fs = require("fs"),
  path = require("path");
const { createApp } = require("../src/server"),
  { createConfig } = require("../src/common/app.config");
(async () => {
  const root = path.resolve(__dirname, ".."),
    dir = path.join(root, "data", "implementation-live-check");
  const inputRoot = path.join(root, "data", "implementation-preview", "input");
  const source = fs
    .readdirSync(inputRoot)
    .find((n) => n.startsWith("job_") && n.endsWith(".pdf"));
  if (!source)
    throw new Error(
      "Run preview-full-features.script.js once to create the generated sample.",
    );
  const app = createApp(
    createConfig({
      port: 0,
      dataDir: dir,
      publicUrl: "auto",
      storage: {
        inputDir: path.join(dir, "input"),
        outputDir: path.join(dir, "output"),
      },
      ftp: { enabled: true, port: 0, publicHost: "auto" },
      jobTimeoutMs: 90000,
      requestTimeoutMs: 15000,
    }),
  );
  try {
    await app.start();
    const template = {
      name: "실엔진 검증",
      docType: "live-test",
      keys: [
        {
          name: "documentNo",
          page: 1,
          mode: "rect",
          rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 },
          searchType: "FindRegion",
        },
        {
          name: "title",
          page: 1,
          mode: "word",
          wordIndex: 0,
          rect: { x: 0, y: 0, w: 1, h: 1 },
        },
      ],
    };
    const job = await app.services.formJobService.create({
      fileName: "generated-live-check.pdf",
      contentBase64: fs
        .readFileSync(path.join(inputRoot, source))
        .toString("base64"),
      templateSnapshot: template,
    });
    await app.services.formJobService.idle();
    const done = await app.services.formJobService.get(job.id);
    let result = {
      status: done.status,
      error: done.error,
      pageSizes: done.pageSizes,
      values: done.ocrResult?.values,
    };
    if (done.status === "done") {
      const view = await app.services.formJobService.getOcrView(done.id);
      result = {
        ...result,
        documentNoMatchesIgnoringSpaces:
          done.ocrResult.values.documentNo.value.replace(/\s/g, "") ===
          "A-2025-001",
        fieldNames: view.pages.flatMap((p) => p.fields.map((f) => f.name)),
        geometry: view.pages.map((p) => ({
          width: p.width,
          height: p.height,
          sizeSource: p.sizeSource,
        })),
        exports: {},
      };
      for (const format of ["xlsx", "pdf", "xml", "md"]) {
        const out = await app.services.documentExportService.export(
          done.id,
          format,
        );
        fs.mkdirSync(path.join(root, "artifacts", "full-implementation"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(
            root,
            "artifacts",
            "full-implementation",
            `live-result.${format}`,
          ),
          out.bytes,
        );
        result.exports[format] = out.bytes.length;
      }
    }
    fs.mkdirSync(path.join(root, "artifacts", "full-implementation"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "artifacts", "full-implementation", "live-check.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    if (done.status !== "done" || !result.documentNoMatchesIgnoringSpaces)
      process.exitCode = 1;
  } finally {
    await app.stop();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
