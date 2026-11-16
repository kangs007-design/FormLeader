"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path"),
  http = require("http");
const { PDFDocument } = require("pdf-lib");
const ExcelJS = require("exceljs");
const sharp = require("sharp");
const { createApp } = require("../../src/server");
const { createConfig } = require("../../src/common/app.config");
const {
  createMockTextSenseServer,
  createSampleOcr,
} = require("../mock/mock-textsense.server");
process.env.FORMREADER_SILENT = "1";
process.env.FORMREADER_SKIP_DOTENV = "1";
const rect = { x: 0, y: 0, w: 1, h: 1 };
async function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "formreader-full-")),
    outputDir = path.join(dir, "output");
  const mock = createMockTextSenseServer({ outputDir, ...opts });
  const mockPort = await mock.start(0);
  const app = createApp(
    createConfig({
      port: 0,
      dataDir: dir,
      textsense: { host: "127.0.0.1", port: mockPort },
      storage: { inputDir: path.join(dir, "input"), outputDir },
      ftp: { enabled: false },
      jobPollIntervalMs: 20,
      outputFileWaitMs: 300,
      jobTimeoutMs: 5000,
    }),
  );
  const port = await app.start();
  let cookie = "";
  async function request(method, url, body, cookieOverride) {
    const r = await fetch(`http://localhost:${port}${url}`, {
      method,
      headers: {
        Origin: `http://localhost:${port}`,
        "X-Requested-With": "TextSense",
        Cookie: cookieOverride ?? cookie,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const bytes = Buffer.from(await r.arrayBuffer());
    let json;
    try {
      json = JSON.parse(bytes);
    } catch (_) {}
    return { status: r.status, json, bytes, headers: r.headers };
  }
  let r = await request("POST", "/api/account/setup", {
    name: "검증 관리자",
    email: "admin@full.example.test",
    password: "Full-feature-test-password-2026",
  });
  assert.equal(r.status, 200);
  r = await request("POST", "/api/auth/sign-in/email", {
    email: "admin@full.example.test",
    password: "Full-feature-test-password-2026",
  });
  cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const pdf = await PDFDocument.create();
  pdf.addPage([500, 700]);
  pdf.addPage([500, 700]);
  const contentBase64 = Buffer.from(await pdf.save()).toString("base64");
  async function job(extra = {}) {
    const r = await request("POST", "/api/jobs", {
      fileName: "검증문서.pdf",
      contentBase64,
      ...extra,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.data.id;
    await app.services.formJobService.idle();
    return (await request("GET", `/api/jobs/${id}`)).json.data;
  }
  return {
    app,
    port,
    mock,
    dir,
    request,
    job,
    contentBase64,
    close: async () => {
      await app.stop();
      await mock.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("고급 서식·Sub 키 검수·버전 복원·정책 전달·실제 출력 파일", async (t) => {
  const env = await fixture();
  try {
    const form = {
      name: "청구서 전체",
      docType: "invoice",
      keywords: ["청구서"],
      keys: [
        { name: "word", mode: "word", wordIndex: 0, rect },
        { name: "line", mode: "line", lineIndex: 1, rect },
        {
          name: "cell",
          mode: "cell",
          tableIndex: 0,
          row: 1,
          column: 1,
          rect,
          pattern: "^[0-9,]+$",
        },
      ],
      groups: [
        {
          name: "items",
          page: 1,
          rect,
          source: "table",
          skipRows: 1,
          columns: [
            { name: "item", rect, column: 0, required: true },
            {
              name: "price",
              rect,
              column: 1,
              pattern: "^[0-9,]+$",
              required: true,
            },
          ],
        },
      ],
    };
    const created = await env.request("POST", "/api/forms", form);
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const f = created.json.data;
    await t.test("Word·Text Line·Cell·반복 행 추출 및 검수 규칙", async () => {
      const job = await env.job({ templateId: f.id });
      assert.equal(job.status, "done", job.error);
      assert.equal(job.ocrResult.values.word.value, "청구서");
      assert.equal(job.ocrResult.values.cell.value, "1,234,000");
      assert.match(job.ocrResult.values.line.value, /A-2025-001/);
      assert.equal(
        job.ocrResult.groups.items.rows[0].values.item.value,
        "서비스이용료",
      );
      const body = {
        values: { word: "청구서", line: "검수한 줄", cell: "1,234,000" },
        groups: { items: [{ item: "검수 품목", price: "bad" }] },
        confirmed: true,
      };
      assert.equal(
        (await env.request("PUT", `/api/jobs/${job.id}/review`, body)).status,
        400,
      );
      body.groups.items[0].price = "9,000";
      assert.equal(
        (await env.request("PUT", `/api/jobs/${job.id}/review`, body)).status,
        200,
      );
      for (const format of ["json", "xml", "txt", "csv", "md", "xlsx", "pdf"]) {
        const out = await env.request(
          "GET",
          `/api/jobs/${job.id}/export?format=${format}`,
        );
        assert.equal(out.status, 200, out.bytes.toString().slice(0, 500));
        assert.ok(out.bytes.length > 10);
        if (format === "xlsx") {
          const w = new ExcelJS.Workbook();
          await w.xlsx.load(out.bytes);
          assert.equal(
            w.getWorksheet("반복1_items").getCell("B2").value,
            "검수 품목",
          );
          assert.equal(
            w.getWorksheet("반복1_items").getCell("C2").value,
            "9,000",
          );
        }
        if (format === "pdf")
          assert.equal((await PDFDocument.load(out.bytes)).getPageCount(), 2);
        if (["json", "xml", "csv", "md"].includes(format))
          assert.match(out.bytes.toString(), /검수 품목/);
        if (process.env.FR_CAPTURE_EXPORTS) {
          fs.mkdirSync(process.env.FR_CAPTURE_EXPORTS, { recursive: true });
          fs.writeFileSync(
            path.join(process.env.FR_CAPTURE_EXPORTS, `result.${format}`),
            out.bytes,
          );
        }
      }
    });
    await t.test("버전 이력과 복원은 새 버전으로 저장", async () => {
      await env.request("PUT", `/api/forms/${f.id}`, {
        ...form,
        name: "바뀐 이름",
      });
      const h = (await env.request("GET", `/api/forms/${f.id}/history`)).json
        .data;
      assert.equal(h.length, 2);
      const restored = await env.request("POST", `/api/forms/${f.id}/restore`, {
        versionId: h[0].id,
      });
      assert.equal(restored.json.data.name, form.name);
      assert.equal(restored.json.data.version, 3);
    });
    await t.test("완료된 미분류 문서에 서식 재적용", async () => {
      const job = await env.job();
      const r = await env.request("POST", `/api/jobs/${job.id}/reapply`, {
        templateId: f.id,
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.ocrResult.docType, "invoice");
      assert.ok(
        r.json.data.events.some((e) => e.type === "template.reapplied"),
      );
    });
    await t.test(
      "기존·추가 엔진 정책을 함께 전달하고 중복 이름은 차단",
      async () => {
        await env.request("PUT", "/api/workspace/settings", {
          engine: {
            reqType: "Document",
            reqOption: {
              CustomSetting: { TextScoreThreshold: 0.5 },
              SearchAPI: [
                { Type: "FindWord", Name: "existing", Key: ["청구서"] },
              ],
            },
          },
        });
        const updated = {
          ...form,
          keys: [{ name: "region", rect, searchType: "FindRegion" }],
          engineRequest: {
            reqOption: { ResultOption: { Format: "PlainText" } },
          },
        };
        const made = await env.request("POST", "/api/forms", updated);
        const j = await env.job({ templateId: made.json.data.id });
        assert.equal(j.status, "done");
        const req = env.mock.requests.at(-1);
        assert.equal(req.extraJobs[0].option.reqOption.SearchAPI.length, 2);
        assert.deepEqual(req.extraJobs[0].option.reqOption.SearchAPI[1].Key, [
          [0, 0],
          [1000, 1400],
        ]);
        assert.equal(
          req.extraJobs[0].option.reqOption.CustomSetting.TextScoreThreshold,
          0.5,
        );
        assert.equal(
          req.extraJobs[0].option.reqOption.ResultOption.Format,
          "PlainText",
        );
        const duplicate = await env.job({
          templateSnapshot: {
            ...form,
            engineRequest: {
              reqOption: {
                SearchAPI: [{ Type: "FindWord", Name: "existing", Key: ["x"] }],
              },
            },
          },
        });
        assert.equal(duplicate.status, "failed");
        assert.match(duplicate.error, /중복/);
      },
    );
  } finally {
    await env.close();
  }
});

test("다중 페이지 자동 분리·원본 PDF 분리·비교 위치·초기화 권한과 데이터 보존", async () => {
  const resultFactory = () => {
    const r = createSampleOcr();
    r.document.pages.pages_2 = structuredClone(r.document.pages.pages_1);
    r.document.pages.pages_2.content = "두 번째 문서";
    return r;
  };
  const env = await fixture({ resultFactory });
  try {
    const j = await env.job({ split: { mode: "pages", count: 1 } });
    assert.equal(j.status, "done");
    assert.equal(j.children.length, 2);
    const child = await env.app.services.formJobService.get(j.children[1]);
    assert.equal(child.parentId, j.id);
    assert.equal(child.ocrResult.pageCount, 1);
    assert.equal(
      (
        await PDFDocument.load(
          fs.readFileSync(path.join(env.dir, "input", child.storedName)),
        )
      ).getPageCount(),
      1,
    );
    assert.equal(
      (
        await env.request("POST", `/api/jobs/${j.id}/split`, {
          groups: [[1], [1]],
        })
      ).status,
      400,
    );
    const source = env.app.services.formJobService.raw(child);
    source.document.pages.pages_1.elements[0].texts[0].recognition.content =
      "바뀐 제목";
    fs.writeFileSync(
      path.join(env.dir, "output", `${child.id}.json`),
      JSON.stringify(source),
    );
    const c = await env.request("POST", "/api/comparisons", {
      leftId: j.children[0],
      rightId: child.id,
      compareLayout: true,
    });
    assert.equal(c.status, 200);
    assert.ok(
      c.json.data.differences.some(
        (d) =>
          ["added", "changed"].includes(d.type) &&
          d.right.page === 1 &&
          d.right.rect,
      ),
    );
    const monitor = await env.request("GET", "/api/workspace/monitor");
    assert.equal(monitor.status, 200);
    assert.ok(monitor.json.data.local.memory.total > 0);
    assert.ok(monitor.json.data.events.length > 0);
    assert.equal(
      (await env.request("POST", "/api/workspace/reset", { confirm: "wrong" }))
        .status,
      400,
    );
    const reset = await env.request("POST", "/api/workspace/reset", {
      confirm: "문서 초기화",
      includeTemplates: true,
    });
    assert.equal(reset.status, 200);
    assert.equal((await env.request("GET", "/api/jobs")).json.data.length, 0);
    assert.equal((await env.request("GET", "/api/account/me")).status, 200);
    assert.ok(!fs.existsSync(path.join(env.dir, "input", j.storedName)));
  } finally {
    await env.close();
  }
});

test("진행 중 취소는 후속 완료 처리를 막고 엔진 미중단 범위를 알려준다", async () => {
  const env = await fixture({ delayMs: 1000 });
  try {
    const j = await env.request("POST", "/api/jobs", {
      fileName: "cancel.pdf",
      contentBase64: env.contentBase64,
    });
    const r = await env.request(
      "POST",
      `/api/jobs/${j.json.data.id}/cancel`,
      {},
    );
    assert.equal(r.json.data.status, "cancelled");
    assert.equal(r.json.data.cancellation.engineStopped, false);
    await env.app.services.formJobService.idle();
    assert.equal(
      (await env.request("GET", `/api/jobs/${j.json.data.id}`)).json.data
        .status,
      "cancelled",
    );
  } finally {
    await env.close();
  }
});

test("샘플 PDF 보관·페이지 정보·샘플 OCR·TIFF 미리보기", async () => {
  const env = await fixture();
  try {
    const s = await env.request("POST", "/api/samples", {
      fileName: "sample.pdf",
      contentBase64: env.contentBase64,
    });
    assert.equal(s.status, 200);
    assert.equal(s.json.data.pageSizes.length, 2);
    const p = await env.request("POST", "/api/samples/preview", {
      sampleId: s.json.data.id,
      template: {
        name: "샘플",
        docType: "sample",
        keys: [{ name: "x", rect }],
      },
    });
    assert.equal(p.status, 200);
    await env.app.services.formJobService.idle();
    assert.equal(
      (await env.request("GET", `/api/jobs/${p.json.data.id}`)).json.data
        .status,
      "done",
    );
    const tif = await sharp({
      create: { width: 100, height: 150, channels: 3, background: "white" },
    })
      .tiff()
      .toBuffer();
    const ts = await env.request("POST", "/api/samples", {
      fileName: "sample.tiff",
      contentBase64: tif.toString("base64"),
    });
    const image = await env.request(
      "GET",
      `/api/samples/${ts.json.data.id}/image?page=1`,
    );
    assert.equal(image.status, 200);
    assert.equal((await sharp(image.bytes).metadata()).format, "png");
  } finally {
    await env.close();
  }
});

test("업무 전송은 일시 실패 재시도와 동일 결과 중복 방지를 지원한다", async () => {
  let count = 0,
    keys = [];
  const receiver = http.createServer((req, res) => {
    count++;
    keys.push(req.headers["idempotency-key"]);
    req.resume();
    res.writeHead(count === 1 ? 503 : 200);
    res.end("{}");
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const env = await fixture();
  try {
    const j = await env.job();
    await env.request("PUT", "/api/workspace/settings", {
      integration: {
        url: `http://127.0.0.1:${receiver.address().port}/result`,
        token: "isolated-test-token",
      },
    });
    const r = await env.request("POST", `/api/jobs/${j.id}/deliver`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, "sent");
    assert.equal(count, 2);
    assert.equal(keys[0], keys[1]);
    await env.request("POST", `/api/jobs/${j.id}/deliver`, {});
    assert.equal(count, 2);
    assert.equal(
      (await env.request("GET", "/api/workspace/settings")).json.data
        .integration.token,
      undefined,
    );
  } finally {
    await env.close();
    await new Promise((r) => receiver.close(r));
  }
});

test("일반 사용자는 문서 기능을 사용하고 운영 설정·초기화·샘플 정책 변경은 거절된다", async () => {
  const env = await fixture();
  try {
    const signed = await env.request("POST", "/api/auth/sign-up/email", {
      name: "검수 사용자",
      email: "reviewer@full.example.test",
      password: "Full-user-test-password-2026",
    });
    assert.equal(signed.status, 200);
    const userId = signed.json.user.id;
    assert.equal(
      (
        await env.request("PUT", `/api/users/${userId}`, {
          role: "user",
          status: "active",
        })
      ).status,
      200,
    );
    const login = await env.request("POST", "/api/auth/sign-in/email", {
        email: "reviewer@full.example.test",
        password: "Full-user-test-password-2026",
      }),
      cookie = login.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    assert.equal(
      (await env.request("GET", "/api/jobs", undefined, cookie)).status,
      200,
    );
    for (const [method, url, body] of [
      ["GET", "/api/workspace/settings"],
      ["GET", "/api/workspace/monitor"],
      ["POST", "/api/workspace/reset", { confirm: "문서 초기화" }],
      [
        "POST",
        "/api/samples",
        { fileName: "x.pdf", contentBase64: env.contentBase64 },
      ],
    ])
      assert.equal((await env.request(method, url, body, cookie)).status, 403);
    assert.equal(
      (
        await env.request(
          "POST",
          "/api/jobs",
          {
            fileName: "x.pdf",
            contentBase64: env.contentBase64,
            templateSnapshot: {
              name: "x",
              docType: "x",
              keys: [{ name: "x", rect }],
            },
          },
          cookie,
        )
      ).status,
      400,
    );
    const j = await env.job();
    const diagnostic = await env.request(
      "GET",
      `/api/jobs/${j.id}/diagnostics`,
      undefined,
      cookie,
    );
    assert.equal(diagnostic.status, 200);
    assert.equal(diagnostic.json.data.sourcePresent, true);
    assert.equal(diagnostic.json.data.resultPresent, true);
  } finally {
    await env.close();
  }
});

test("빈 페이지 경계와 서식 변경 기준의 자동 문서 분리", async () => {
  let mode = "blank";
  const resultFactory = () => {
    const r = createSampleOcr();
    r.document.pages.pages_2 =
      mode === "blank"
        ? { content: "", elements: [], fields: {} }
        : structuredClone(r.document.pages.pages_1);
    if (mode !== "blank") {
      r.document.pages.pages_2.content =
        r.document.pages.pages_2.content.replace("청구서", "견적서");
      r.document.pages.pages_2.elements[0].texts[0].recognition.content =
        "견적서";
    }
    return r;
  };
  const env = await fixture({ resultFactory });
  try {
    const a = await env.job({ split: { mode: "blank" } });
    assert.equal(a.children.length, 1);
    assert.deepEqual(
      (await env.app.services.formJobService.get(a.children[0])).sourcePages,
      [1],
    );
    for (const name of ["청구서", "견적서"])
      assert.equal(
        (
          await env.request("POST", "/api/forms", {
            name,
            docType: name,
            keywords: [name],
            keys: [{ name: "text", rect }],
          })
        ).status,
        200,
      );
    mode = "template";
    const b = await env.job({ split: { mode: "template" } });
    assert.equal(b.children.length, 2);
    assert.equal(
      (await env.app.services.formJobService.get(b.children[0])).ocrResult
        .docType,
      "청구서",
    );
    assert.equal(
      (await env.app.services.formJobService.get(b.children[1])).ocrResult
        .docType,
      "견적서",
    );
  } finally {
    await env.close();
  }
});

test("자동 분류 후 엔진 정책을 적용하고 재적용 시 예전 fields를 재사용하지 않는다", async () => {
  const resultFactory = (body) => {
    const r = createSampleOcr();
    if (
      body.extraJobs[0].option.reqOption.SearchAPI?.some(
        (x) => x.Name === "engine",
      )
    )
      r.document.pages.pages_1.fields.engine = {
        keys: [],
        values: [
          {
            type: "word",
            points: [
              [160, 200],
              [300, 230],
            ],
            recognition: { content: "A-2025-001", confidence: [1] },
          },
        ],
      };
    return r;
  };
  const env = await fixture({ resultFactory });
  try {
    const form = {
      name: "자동 정책",
      docType: "auto-engine",
      keywords: ["청구서"],
      keys: [
        {
          name: "engine",
          searchType: "FindRegion",
          rect: { x: 0.15, y: 0.13, w: 0.2, h: 0.05 },
        },
      ],
    };
    const made = (await env.request("POST", "/api/forms", form)).json.data;
    const j = await env.job();
    assert.equal(j.status, "done");
    assert.equal(env.mock.requests.length, 2);
    assert.equal(j.ocrResult.values.engine.value, "A-2025-001");
    assert.ok(j.events.some((e) => e.type === "template.enginePass"));
    form.keys[0].rect = { x: 0.3, y: 0.02, w: 0.4, h: 0.08 };
    await env.request("PUT", `/api/forms/${made.id}`, form);
    const reapplied = await env.request("POST", `/api/jobs/${j.id}/reapply`, {
      templateId: made.id,
    });
    assert.equal(reapplied.json.data.ocrResult.values.engine.value, "청구서");
  } finally {
    await env.close();
  }
});
