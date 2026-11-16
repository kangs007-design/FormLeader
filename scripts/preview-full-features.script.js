"use strict";
// Isolated UI verification: sample documents and accounts never enter the real workspace.
process.env.FORMREADER_SKIP_DOTENV = "1";
process.env.FORMREADER_SILENT = "1";
const fs = require("fs"),
  path = require("path");
const { PDFDocument } = require("pdf-lib"),
  fontkit = require("@pdf-lib/fontkit");
const { PDF_FONT_FEATURES } = require("../src/common/pdf-font.util");
const { createConfig } = require("../src/common/app.config"),
  { createApp } = require("../src/server");
const {
  createMockTextSenseServer,
  createSampleOcr,
} = require("../tests/mock/mock-textsense.server");
(async () => {
  const dir = path.resolve(__dirname, "../data/implementation-preview"),
    outputDir = path.join(dir, "output");
  const mock = createMockTextSenseServer({ outputDir });
  const mockPort = await mock.start(0);
  const app = createApp(
    createConfig({
      port: Number(process.env.FR_PREVIEW_PORT) || 3100,
      dataDir: dir,
      mockMode: true,
      textsense: { host: "127.0.0.1", port: mockPort },
      ftp: { enabled: false },
      storage: { inputDir: path.join(dir, "input"), outputDir },
      jobPollIntervalMs: 50,
    }),
  );
  const port = await app.start();
  if (!app.services.authService.hasAdmin())
    await fetch(`http://localhost:${port}/api/account/setup`, {
      method: "POST",
      headers: {
        Origin: `http://localhost:${port}`,
        "X-Requested-With": "TextSense",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "기능 검증 관리자",
        email: "preview@example.test",
        password: "Preview-only-password-2026!",
      }),
    });
  const template = {
    name: "청구서 고급 서식",
    docType: "invoice",
    keywords: ["청구서"],
    keys: [
      {
        name: "문서번호",
        mode: "rect",
        page: 1,
        rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 },
        required: true,
        pattern: "^A-\\d{4}-\\d{3}$",
        verify: true,
      },
      {
        name: "합계금액",
        mode: "cell",
        page: 1,
        rect: { x: 0, y: 0, w: 1, h: 1 },
        tableIndex: 0,
        row: 1,
        column: 1,
        required: true,
      },
    ],
    groups: [
      {
        name: "청구내역",
        page: 1,
        rect: { x: 0, y: 0, w: 1, h: 1 },
        source: "table",
        tableIndex: 0,
        skipRows: 1,
        columns: [
          { name: "품목", rect: { x: 0, y: 0, w: 0.5, h: 1 }, column: 0 },
          {
            name: "금액",
            rect: { x: 0.5, y: 0, w: 0.5, h: 1 },
            column: 1,
            pattern: "^[0-9,]+$",
          },
        ],
      },
    ],
  };
  if (!(await app.services.formJobService.list()).length) {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../src/web/vendor/fonts/Pretendard-Regular.ttf",
        ),
      ),
      { subset: false, features: { ...PDF_FONT_FEATURES } },
    );
    const page = pdf.addPage([500, 700]),
      words = app.services.ocrResultService.view(createSampleOcr(), {
        pageSize: { width: 1000, height: 1400 },
      }).pages[0].words;
    for (const w of words) {
      const text = w.text,
        size = Math.min(
          (w.y2 - w.y1) * 0.4,
          (w.x2 - w.x1) / 2 / font.widthOfTextAtSize(text, 1),
        );
      page.drawText(text, { x: w.x1 / 2, y: 700 - w.y2 / 2, font, size });
    }
    const bytes = Buffer.from(await pdf.save()),
      sample = await app.services.workspaceService.sample({
        fileName: "청구서_샘플.pdf",
        contentBase64: bytes.toString("base64"),
      });
    const f = await app.services.formTemplateService.create({
      ...template,
      sampleId: sample.id,
    });
    const a = await app.services.formJobService.create({
      fileName: "청구서_원본.pdf",
      contentBase64: bytes.toString("base64"),
      templateId: f.id,
    });
    await app.services.formJobService.idle();
    const b = await app.services.formJobService.create({
      fileName: "청구서_비교본.pdf",
      contentBase64: bytes.toString("base64"),
      templateId: f.id,
    });
    await app.services.formJobService.idle();
    const raw = app.services.formJobService.raw(
      await app.services.formJobService.get(b.id),
    );
    raw.document.pages.pages_1.elements[0].texts[0].recognition.content =
      "변경청구서";
    raw.document.pages.pages_1.content =
      raw.document.pages.pages_1.content.replace("청구서", "변경청구서");
    fs.writeFileSync(path.join(outputDir, `${b.id}.json`), JSON.stringify(raw));
    await app.services.formJobService.reapply(b.id, f.id, "preview");
  }
  console.log(`Isolated preview ready: http://localhost:${port}`);
  const stop = async () => {
    await app.stop();
    await mock.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
