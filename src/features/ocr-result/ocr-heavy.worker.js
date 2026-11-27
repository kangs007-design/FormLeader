"use strict";
/**
 * 개별기능[ocr-result]: 대용량 문서 처리
 *  - 큰 원본(페이지 크기 확인)과 큰 결과 JSON 은 별도 작업 스레드에서 읽고 해석한다. (그동안 서버는 다른 요청에 응답하고,
 *    메모리가 부족하면 이 작업만 실패한다)
 *  - 작은 파일은 같은 함수를 그대로 호출한다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PDFDocument, ParseSpeeds } = require("pdf-lib");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const { readJsonFileSync } = require("../../common/json-file.util");
const { normalizeOcr, buildView } = require("./ocr-result.extractor");
const { OcrResultService } = require("./ocr-result.service");
const { AppError } = require("../../common/app.error");
const { documentGeometry } = require("../../common/document.util");

const TASKS = {
  /** PDF 를 페이지 묶음 파일로 나눈다 (원본은 한 번만 읽는다) */
  async split({ file, parts }) {
    const source = await PDFDocument.load(fs.readFileSync(file), {
      parseSpeed: ParseSpeeds.Fastest,
    });
    for (const { first, count, target } of parts) {
      const out = await PDFDocument.create();
      const indexes = Array.from({ length: count }, (_, i) => first - 1 + i);
      for (const page of await out.copyPages(source, indexes)) out.addPage(page);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await out.save());
    }
  },

  /** 묶음별 결과 JSON 을 원본 페이지 번호로 합친다. 한 번에 한 묶음만 메모리에 올린다. */
  async merge({ parts, target }) {
    const tmp = `${target}.merging`;
    const out = fs.openSync(tmp, "w");
    try {
      let written = 0;
      for (const [index, part] of parts.entries()) {
        const { document } = readJsonFileSync(part.file);
        const { pages, ...attributes } = document;
        if (index === 0)
          fs.writeSync(out, `{"document":{${JSON.stringify(attributes).slice(1, -1)}${Object.keys(attributes).length ? "," : ""}"pages":{`);
        Object.entries(pages).forEach(([name, page], i) => {
          const number = part.offset + (parseInt(name.replace(/\D+/g, ""), 10) || i + 1);
          fs.writeSync(out, `${written++ ? "," : ""}"pages_${number}":${JSON.stringify(page)}`);
        });
      }
      fs.writeSync(out, "}}}");
    } finally {
      fs.closeSync(out);
    }
    fs.renameSync(tmp, target);
  },

  /** 원본의 페이지별 크기 */
  async geometry({ file, pdfScale }) {
    return documentGeometry(file, pdfScale);
  },

  /** 서식 분류·추출. 서식 목록은 호출하는 쪽에서 넘겨받는다. */
  async apply({ file, forms, templateId, options }) {
    const service = new OcrResultService({
      formTemplateService: {
        get: async (id) => forms.find((f) => f.id === id),
        list: async () => forms,
      },
    });
    return service.apply(readJsonFileSync(file), templateId, options);
  },

  /** 화면용 페이지 데이터: 페이지 요약 목록 + 페이지별 JSON 문자열 */
  async pages({ file, options }) {
    const view = buildView(normalizeOcr(readJsonFileSync(file), options));
    const summaries = [];
    const pages = [];
    for (let i = 0; i < view.pages.length; i++) {
      const p = view.pages[i];
      const scored = p.words.filter((w) => w.conf !== null);
      summaries.push({
        page: p.page,
        content: p.content,
        orientation: p.orientation,
        width: p.width,
        height: p.height,
        sizeSource: p.sizeSource,
        wordCount: p.words.length,
        tableCount: p.tables.length,
        fieldCount: p.fields.length,
        confSum: scored.reduce((n, w) => n + w.conf, 0),
        confCount: scored.length,
      });
      pages.push(JSON.stringify(p));
      view.pages[i] = null; // 처리한 페이지는 바로 비운다
    }
    return { summaries, pages };
  },

  /** 본문 검색용 텍스트 */
  async text({ file }) {
    const pages = readJsonFileSync(file)?.document?.pages || {};
    return Object.values(pages)
      .map((p) => p.content || "")
      .join("\n")
      .toLowerCase();
  },
};

/** 한 번에 하나만 실행해 메모리 사용이 겹치지 않게 한다 */
let queue = Promise.resolve();

function runInWorker(task, data) {
  const heapMb = Math.min(
    8192,
    Math.max(1024, Math.floor(os.totalmem() / 1048576 / 2)),
  );
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { task, data },
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    });
    const tooBig = () =>
      new AppError(
        500,
        "RESULT_TOO_LARGE",
        "인식 결과가 너무 커서 처리하지 못했습니다. 문서를 나눠서 올려 주세요.",
      );
    worker.once("message", (m) =>
      m.ok ? resolve(m.value) : reject(new Error(m.message)),
    );
    worker.once("error", (e) =>
      reject(e.code === "ERR_WORKER_OUT_OF_MEMORY" ? tooBig() : e),
    );
    worker.once("exit", (code) => {
      if (code !== 0) reject(tooBig());
    });
  });
}

/**
 * @param task TASKS 이름
 * @param data { file, ... }
 * @param thresholdBytes 이 크기를 넘는 결과 파일은 작업 스레드에서 처리
 */
function runResultTask(task, data, thresholdBytes) {
  if (fs.statSync(data.file).size <= thresholdBytes) return TASKS[task](data);
  const run = queue.then(() => runInWorker(task, data));
  queue = run.catch(() => {});
  return run;
}

if (!isMainThread && workerData?.task) {
  TASKS[workerData.task](workerData.data).then(
    (value) => parentPort.postMessage({ ok: true, value }),
    (e) => parentPort.postMessage({ ok: false, message: e.message }),
  );
}

module.exports = { runResultTask };
