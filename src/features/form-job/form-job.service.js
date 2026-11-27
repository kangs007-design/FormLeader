"use strict";
const {
  signInputFile,
  removeManagedFile,
} = require("../../common/file-access.util");
/**
 * 개별기능[form-job]: Form 작업 (파일 업로드 → TextSense 작업 요청 → 상태 폴링 → 결과 JSON 수신 → 서식 적용)
 * 작업 상태: pending → processing → done | failed
 * TextSense 상태: AWAITING / PROGRESSING / SUCCESS / FAILURE (engineStatus 로 보관)
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readJsonFileSync } = require("../../common/json-file.util");
const { SqliteRepository } = require("../../common/sqlite.repository");
const {
  documentGeometry,
  copyDocumentPages,
} = require("../../common/document.util");
const {
  normalizeTemplateInput,
} = require("../form-template/form-template.validator");
const { mergeOptions } = require("../ocr-connect/engine-policy.util");
const { createId, toSafeFileName } = require("../../common/id.util");
const { getImageSize } = require("../../common/image-size.util");
const { detectLocalAddress } = require("../../common/local-address.util");
const { AppError } = require("../../common/app.error");
const { createLogger } = require("../../common/logger.util");
const { runResultTask } = require("../ocr-result/ocr-heavy.worker");

const ALLOWED_EXT = [".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"];
/** 확장자별 파일 시작 바이트(시그니처). 내용이 다른 형식이면 엔진에 보내기 전에 거절한다. */
const SIGNATURES = {
  ".png": [[0x89, 0x50, 0x4e, 0x47]],
  ".jpg": [[0xff, 0xd8, 0xff]],
  ".jpeg": [[0xff, 0xd8, 0xff]],
  ".tif": [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]],
  ".tiff": [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]],
  ".bmp": [[0x42, 0x4d]],
};
function matchesFileType(ext, bytes) {
  if (ext === ".pdf") return bytes.subarray(0, 1024).includes("%PDF-");
  return (SIGNATURES[ext] || []).some((sig) => sig.every((b, i) => bytes[i] === b));
}
const MAX_TRANSIENT_STATUS_ERRORS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 서버가 재시작돼도 분할 처리를 자동으로 이어가는 최대 횟수 */
const MAX_RESUMES = 3;
/** 문서 소유자: 저장된 ownerId, 이전 데이터는 최초 이벤트의 작업자 */
const ownerOf = (job) => job.ownerId || job.events?.[0]?.actor || null;
/** 관리자는 전체, 일반 사용자는 본인 문서만 */
const canAccess = (user, job) => user?.role === "admin" || ownerOf(job) === user?.id;

class FormJobService {
  constructor({ config, client, ocrResultService, formTemplateService }) {
    this.config = config;
    this.client = client;
    this.ocrResultService = ocrResultService;
    this.formTemplateService = formTemplateService;
    this.repo = new SqliteRepository(
      path.join(config.dataDir, "form-jobs.json"),
    );
    this.log = createLogger("form-job");
    this.running = new Set(); // 테스트/종료 시 완료 대기용
    this.resetting = false;
  }

  /** 목록용: 큰 값(추출 Key-Value)은 빼고 화면 표시에 필요한 요약(result)만 포함 */
  list(user) {
    return this.repo.list().then((l) =>
      (user ? l.filter((job) => canAccess(user, job)) : l).map(({ ocrResult, pageSizes, ...summary }) => ({
        ...summary,
        result: ocrResult
          ? {
              classified: !!ocrResult.classified,
              docType: ocrResult.docType || null,
              needsReview: !!ocrResult.needsReview,
              pageCount: ocrResult.pageCount,
              wordCount: ocrResult.wordCount,
              tableCount: ocrResult.tableCount,
            }
          : null,
      })),
    );
  }

  /** 문서 본문(OCR 텍스트)에 검색어가 들어 있는 작업 id 목록. 본문은 파일 수정시각 기준으로 캐시한다. */
  async searchContent(query, user) {
    const q = String(query || "").trim().toLowerCase();
    if (q.length < 2) return [];
    this.textCache = this.textCache || new Map();
    const hits = [];
    for (const job of await this.repo.list()) {
      if (job.status !== "done" || (user && !canAccess(user, job))) continue;
      const file = path.join(this.config.storage.outputDir, `${job.id}.json`);
      let mtime;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch (_) {
        continue;
      }
      let entry = this.textCache.get(job.id);
      if (!entry || entry.mtime !== mtime) {
        let text = "";
        try {
          text = await runResultTask("text", { file }, this.config.heavyResultBytes);
        } catch (_) {
          /* 읽을 수 없는 결과는 검색에서 제외 */
        }
        entry = { mtime, text };
        this.textCache.set(job.id, entry);
      }
      // 검수로 수정한 본문은 캐시하지 않고 매번 확인한다 (수정 즉시 검색에 반영)
      if (entry.text.includes(q) || (job.review?.text || "").toLowerCase().includes(q))
        hits.push(job.id);
    }
    return hits;
  }

  /** 같은 문서의 저장을 차례로 처리해, 동시에 들어온 저장도 충돌을 감지한다 */
  saveReview(id, input = {}) {
    this.reviewQueue = this.reviewQueue || new Map();
    const previous = this.reviewQueue.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => this._saveReview(id, input));
    const tail = run.catch(() => {}).finally(() => {
      if (this.reviewQueue.get(id) === tail) this.reviewQueue.delete(id);
    });
    this.reviewQueue.set(id, tail);
    return run;
  }

  /** Keep human corrections separate from the engine output. */
  async _saveReview(id, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw AppError.badRequest("검수 요청의 형식이 올바르지 않습니다.");
    const { values = {}, groups = {}, text, confirmed = false } = input;
    const job = await this.get(id);
    if (job.status !== "done")
      throw AppError.badRequest("인식이 완료된 문서만 검수할 수 있습니다.");
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw AppError.badRequest("검수 값의 형식이 올바르지 않습니다.");
    if (typeof confirmed !== "boolean")
      throw AppError.badRequest("검수 완료 여부는 true 또는 false여야 합니다.");
    if (
      text !== undefined &&
      (typeof text !== "string" || text.length > 5000000)
    )
      throw AppError.badRequest("본문은 500만 자 이내의 문자열이어야 합니다.");
    // 화면이 알고 있는 마지막 저장 시각과 다르면 그 사이 다른 사람이 저장한 것이다
    if (
      input.baseSavedAt !== undefined &&
      (job.review?.savedAt || null) !== input.baseSavedAt
    )
      throw new AppError(
        409,
        "CONFLICT",
        "다른 사용자가 먼저 저장했습니다. 문서를 다시 연 뒤 수정해 주세요.",
      );
    const original = job.ocrResult.values || {};
    const names = Object.keys(original);
    if (
      Object.keys(values).some((name) => !Object.hasOwn(original, name)) ||
      names.some((name) => !Object.hasOwn(values, name))
    )
      throw AppError.badRequest(
        "문서의 추출 항목과 검수 항목이 일치하지 않습니다.",
      );
    const forms = await this.formTemplateService.list();
    const template =
      job.templateSnapshot ||
      forms.find((form) => form.id === job.ocrResult.templateId);
    const { validateValue } = require("../ocr-result/ocr-result.extractor");
    const fields = Object.fromEntries(
      names.map((name) => {
        const value = values[name];
        if (typeof value !== "string" || value.length > 50000)
          throw AppError.badRequest(
            "각 항목은 5만 자 이내의 문자열이어야 합니다.",
          );
        const key =
          template && template.keys.find((item) => item.name === name);
        const errors = key ? validateValue(key, value.trim()) : [];
        return [
          name,
          {
            value: value.trim(),
            valid: errors.length === 0,
            errors,
            originalValue: original[name].value,
          },
        ];
      }),
    );
    if (!groups || typeof groups !== "object" || Array.isArray(groups))
      throw AppError.badRequest("반복 그룹 검수 형식이 올바르지 않습니다.");
    const reviewedGroups = {};
    for (const [name, originalGroup] of Object.entries(
      job.ocrResult.groups || {},
    )) {
      const submitted = groups[name];
      const rows =
        submitted === undefined
          ? originalGroup.rows.map((r) =>
              Object.fromEntries(
                Object.entries(r.values).map(([k, v]) => [k, v.value]),
              ),
            )
          : submitted;
      if (!Array.isArray(rows) || rows.length !== originalGroup.rows.length)
        throw AppError.badRequest(
          "반복 그룹의 행 수가 원본과 일치해야 합니다.",
        );
      const definition = template?.groups?.find((g) => g.name === name);
      reviewedGroups[name] = {
        columns: originalGroup.columns,
        rows: rows.map((row, i) => {
          if (
            !row ||
            Object.keys(row).length !== originalGroup.columns.length ||
            originalGroup.columns.some((c) => !Object.hasOwn(row, c))
          )
            throw AppError.badRequest("Sub 키 검수 항목이 일치하지 않습니다.");
          return {
            page: originalGroup.rows[i].page,
            values: Object.fromEntries(
              originalGroup.columns.map((c) => {
                if (typeof row[c] !== "string" || row[c].length > 50000)
                  throw AppError.badRequest(
                    "Sub 키는 5만 자 이내의 문자열이어야 합니다.",
                  );
                const value = row[c].trim(),
                  key = definition?.columns.find((k) => k.name === c),
                  errors = key ? validateValue(key, value) : [];
                return [
                  c,
                  {
                    value,
                    valid: !errors.length,
                    errors,
                    originalValue: originalGroup.rows[i].values[c]?.value || "",
                  },
                ];
              }),
            ),
          };
        }),
      };
    }
    if (
      Object.keys(groups).some(
        (n) => !Object.hasOwn(job.ocrResult.groups || {}, n),
      )
    )
      throw AppError.badRequest("알 수 없는 반복 그룹입니다.");
    if (
      confirmed &&
      (Object.values(fields).some((f) => !f.valid) ||
        Object.values(reviewedGroups).some((g) =>
          g.rows.some((r) => Object.values(r.values).some((v) => !v.valid)),
        ))
    )
      throw AppError.badRequest(
        "검증 규칙에 맞지 않는 항목이 있습니다. 값을 수정하거나 검수 완료를 해제해 임시 저장하세요.",
      );
    return this._patch(
      id,
      {
        review: {
          values: fields,
          groups: reviewedGroups,
          ...(text !== undefined ? { text } : {}),
          confirmed,
          savedAt: new Date().toISOString(),
        },
      },
      "review.saved",
      input.actor,
    );
  }

  async get(id) {
    const job = await this.repo.get(id);
    if (!job) throw AppError.notFound(`작업을 찾을 수 없습니다: ${id}`);
    return job;
  }

  async remove(id) {
    const job = await this.get(id);
    if (["pending", "processing"].includes(job.status))
      throw AppError.badRequest("진행 중인 작업은 취소 후 삭제하세요.");
    await this.repo.remove(id);
    // 원본·결과 파일도 함께 파기하고, 다른 작업에 남은 참조를 정리한다
    removeManagedFile(this.config.storage.inputDir, job.storedName);
    removeManagedFile(this.config.storage.outputDir, `${id}.json`);
    removeManagedFile(this.config.storage.outputDir, `${id}.classification.json`);
    this.removeParts(id);
    this.textCache?.delete(id);
    if (this.pageCache?.id === id) this.pageCache = null;
    for (const other of await this.repo.list()) {
      const patch = {};
      if (other.children?.includes(id))
        patch.children = other.children.filter((child) => child !== id);
      if (other.parentId === id) patch.parentId = null;
      if (Object.keys(patch).length) await this.repo.update(other.id, patch);
    }
    if (this.onRemove) await this.onRemove(id);
    return { id };
  }

  /** Reuse the retained source while preserving the failed job's history. */
  async retry(id, actor) {
    const job = await this.get(id);
    if (job.status !== "failed")
      throw AppError.badRequest("실패한 문서만 다시 처리할 수 있습니다.");
    const file = path.join(this.config.storage.inputDir, job.storedName);
    if (!fs.existsSync(file))
      throw AppError.notFound(
        "보관된 원본 파일이 없습니다. 파일을 다시 업로드해 주세요.",
      );
    return this.create({
      fileName: job.fileName,
      contentBase64: fs.readFileSync(file).toString("base64"),
      templateId: job.templateId || undefined,
      parentId: id,
      relation: "retry",
      actor,
      ownerId: ownerOf(job),
      resume: job.chunkPages ? { from: id, chunkPages: job.chunkPages } : null,
    });
  }

  /** 파일을 저장하고 작업을 등록한 뒤, OCR 처리는 백그라운드로 시작한다. */
  async create({
    fileName,
    contentBase64,
    templateId,
    templateSnapshot,
    split = {},
    parentId = null,
    relation = null,
    actor = null,
    ownerId = actor,
    resume = null,
  }) {
    if (this.resetting)
      throw AppError.badRequest("초기화 중입니다. 잠시 후 다시 시도하세요.");
    const safeName = toSafeFileName(fileName);
    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXT.includes(ext))
      throw AppError.badRequest(
        `지원하지 않는 파일 형식입니다: ${ext || "(없음)"} (허용: ${ALLOWED_EXT.join(", ")})`,
      );
    if (!contentBase64 || typeof contentBase64 !== "string")
      throw AppError.badRequest("파일 내용(contentBase64)이 필요합니다.");
    if (templateId) await this.formTemplateService.get(templateId);
    const snapshot = templateSnapshot
      ? normalizeTemplateInput(templateSnapshot)
      : templateId
        ? await this.formTemplateService.get(templateId)
        : null;
    if (
      !split ||
      typeof split !== "object" ||
      !["none", "pages", "blank", "template"].includes(split.mode || "none")
    )
      throw AppError.badRequest("문서 분리 방식이 올바르지 않습니다.");
    if (
      split.mode === "pages" &&
      (!Number.isInteger(Number(split.count)) ||
        Number(split.count) < 1 ||
        Number(split.count) > 10000)
    )
      throw AppError.badRequest("문서당 페이지 수는 1~10000이어야 합니다.");

    const bytes = Buffer.from(contentBase64, "base64");
    if (!matchesFileType(ext, bytes))
      throw AppError.badRequest(
        `파일 내용이 ${ext} 형식이 아니거나 손상되었습니다. 원본 파일을 확인한 뒤 다시 올려 주세요.`,
      );
    const id = createId("job");
    const storedName = `${id}${ext}`;
    const { inputDir } = this.config.storage;
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, storedName), bytes);
    const pageSizes = await runResultTask(
      "geometry",
      { file: path.join(inputDir, storedName), pdfScale: this.config.pdfOcrScale },
      this.config.heavyResultBytes,
    );

    // 페이지가 많은 PDF 는 나눠서 엔진에 보낸다 (다시 처리할 때는 같은 크기로 나눠야 완료분을 재사용할 수 있다)
    const size = resume?.chunkPages || this.config.ocrChunkPages;
    const chunkPages =
      ext === ".pdf" && size > 0 && pageSizes.length > size ? size : null;
    if (resume && chunkPages) this._moveCompletedParts(resume.from, id);

    const now = new Date().toISOString();
    const job = await this.repo.insert({
      id,
      ...(chunkPages
        ? { chunkPages, progress: { done: 0, total: pageSizes.length } }
        : {}),
      ownerId,
      fileName: safeName,
      storedName,
      templateId: templateId || null,
      status: "pending",
      engineStatus: null,
      taskId: null,
      error: null,
      ocrResult: null,
      createdAt: now,
      updatedAt: now,
      templateSnapshot: snapshot,
      pageSizes,
      split,
      parentId,
      relation,
      events: [{ type: "created", at: now, actor }],
    });

    this.launch(id);
    return job;
  }

  /** OCR 처리를 백그라운드로 시작 */
  launch(id) {
    const p = this.run(id)
      .catch((e) => this.log.error("작업 실행 오류", id, e.message))
      .finally(() => this.running.delete(p));
    this.running.add(p);
  }

  async _patch(id, patch, event, actor = null) {
    const previous = await this.repo.get(id);
    if (!previous) return null;
    const now = new Date().toISOString();
    const type =
      event ||
      (patch.status && patch.status !== previous.status
        ? `status.${patch.status}`
        : patch.engineStatus && patch.engineStatus !== previous.engineStatus
          ? `engine.${patch.engineStatus}`
          : null);
    return this.repo.update(id, {
      updatedAt: now,
      ...patch,
      ...(type
        ? {
            events: [
              ...(previous.events || []),
              {
                type,
                at: now,
                actor,
                ...(patch.error ? { message: patch.error } : {}),
              },
            ].slice(-1000),
          }
        : {}),
    });
  }

  async assertActive(id) {
    if ((await this.get(id)).status === "cancelled")
      throw new AppError(409, "CANCELLED", "작업이 취소되었습니다.");
  }

  async cancel(id, actor) {
    const job = await this.get(id);
    if (!["pending", "processing"].includes(job.status))
      throw AppError.badRequest("진행 중인 작업만 취소할 수 있습니다.");
    const cancellation = {
      scope: "application",
      engineStopped: false,
      message:
        "앱의 후속 처리를 중단했습니다. 엔진 자체 중단 API는 설정되지 않았습니다.",
    };
    await this._patch(
      id,
      { status: "cancelled", cancellation },
      "status.cancelled",
      actor,
    );
    if (job.taskId && this.config.cancelPath) {
      try {
        const response = await this.client._call({
          path: this.config.cancelPath,
          method: "POST",
          body: { type: "OBJECT_ID", id: job.taskId },
        });
        cancellation.requestAccepted =
          response.status >= 200 && response.status < 300;
        cancellation.engineStopped =
          cancellation.requestAccepted &&
          ["CANCELLED", "CANCELED", "STOPPED"].includes(response.json?.status);
        cancellation.scope = cancellation.engineStopped
          ? "engine"
          : cancellation.requestAccepted
            ? "engine-request"
            : "application";
        cancellation.message = cancellation.engineStopped
          ? "엔진 중단 상태를 확인했습니다."
          : cancellation.requestAccepted
            ? "엔진에 중단 요청을 전달했습니다. 실제 중단 상태는 확인되지 않았습니다."
            : `엔진 중단 요청 실패 (HTTP ${response.status}). 앱의 후속 처리는 중단됐습니다.`;
      } catch (e) {
        cancellation.message = `엔진 중단 확인 실패: ${e.message}. 앱의 후속 처리는 중단됐습니다.`;
      }
      await this._patch(id, { cancellation });
    }
    return this.get(id);
  }

  /** TextSense 서버가 접속할 이 PC 의 주소. 'auto' 면 TextSense 로 나가는 경로의 주소를 매번 감지 (VPN 재접속 대응) */
  async _publicHost(configured) {
    if (configured && configured !== "auto") return configured;
    return detectLocalAddress(
      this.config.textsense.host,
      this.config.textsense.port,
    );
  }

  /** 입력 파일 URI: FORMREADER_PUBLIC_URL 이 있으면 HTTP, 없으면 ePapyrus 공유 경로(file) */
  async _inputUri(storedName, validMs) {
    const { publicUrl, storage } = this.config;
    if (!publicUrl) return `${storage.inputUri}/${storedName}`;
    const token = signInputFile(this.config, storedName, validMs);
    if (String(publicUrl).toLowerCase() !== "auto")
      return `${publicUrl}/files/input/${storedName}?token=${token}`;
    return `http://${await this._publicHost("auto")}:${this.config.httpPort || this.config.port}/files/input/${storedName}?token=${token}`;
  }

  /** 결과 파일 URI: FTP 수신기가 켜져 있으면 ftp:// (TextSense 가 이 프로그램으로 업로드), 아니면 ePapyrus 공유 경로 */
  async _outputUri(name) {
    const { ftp, storage } = this.config;
    if (!ftp.enabled) return `${storage.outputUri}/${name}`;
    const host = await this._publicHost(ftp.publicHost);
    return `ftp://${encodeURIComponent(ftp.user)}:${encodeURIComponent(ftp.password)}@${host}:${ftp.port}/${name}`;
  }

  /** OCR 처리 본체 */
  async run(id) {
    try {
      const job = await this.get(id);
      await this.assertActive(id);
      await this._patch(id, { status: "processing" });

      const outputName = `${id}.json`;
      const outputFile = path.join(this.config.storage.outputDir, outputName);
      const pageCount = job.pageSizes?.length || 1;
      const recognize = () =>
        job.chunkPages
          ? this._recognizeInChunks(job)
          : this._recognizeOnce(job, {
              inputName: job.storedName,
              outputName,
              timeoutMs: this.timeoutFor(pageCount),
              pageCount,
            });
      const applyResult = async () =>
        this._applyFile(outputFile, job.templateId, {
          pageSize: this._pageSize(job),
          pageSizes: job.pageSizes,
          template: job.templateSnapshot,
        });
      await recognize();

      let result = await applyResult();
      if (!job.templateSnapshot && result.templateId) {
        job.templateSnapshot = await this.formTemplateService.get(
          result.templateId,
        );
        job.templateId = result.templateId;
        await this._patch(id, {
          templateId: job.templateId,
          templateSnapshot: job.templateSnapshot,
        });
        const policy = job.templateSnapshot.engineRequest?.reqOption || {};
        if (
          Object.keys(policy).length ||
          job.templateSnapshot.keys.some((k) => k.searchType)
        ) {
          await this.assertActive(id);
          fs.renameSync(
            path.join(this.config.storage.outputDir, outputName),
            path.join(
              this.config.storage.outputDir,
              `${id}.classification.json`,
            ),
          );
          await this._patch(
            id,
            { engineStatus: "AWAITING" },
            "template.enginePass",
          );
          await recognize();
          result = await applyResult();
        }
      }
      await this.assertActive(id);
      await this._patch(id, { status: "done", ocrResult: result, error: null });
      if (job.chunkPages) this.removeParts(id);
      if (job.split?.mode && job.split.mode !== "none") {
        try {
          await this.autoSplit(id, job.split);
        } catch (e) {
          await this._patch(id, { splitError: e.message }, "split.failed");
        }
      }
      if (this.onComplete) {
        try {
          await this.onComplete(id);
        } catch (e) {
          await this._patch(
            id,
            { deliveryError: e.message },
            "delivery.failed",
          );
        }
      }
    } catch (err) {
      if (
        err.code === "CANCELLED" ||
        (await this.repo.get(id))?.status === "cancelled"
      ) {
        this.removeParts(id);
        return;
      }
      this.log.error("작업 실패", id, err.message);
      await this._patch(id, {
        status: "failed",
        error: err.message,
        errorCode: err.code || "PROCESSING_ERROR",
      }).catch(() => {});
    }
  }

  /** 파일 하나를 엔진에 보내고 결과 파일이 도착할 때까지 기다린다 */
  async _recognizeOnce(job, { inputName, outputName, timeoutMs, pageCount }) {
    const { id } = job;
    const res = await this.client
      .buildJob({
        inputUri: await this._inputUri(inputName, timeoutMs),
        outputUri: await this._outputUri(outputName),
        outputType: "json",
        ...this.engineOptions(job),
      })
      .catch((err) => {
        if (["TIMEOUT", "UPSTREAM_ERROR"].includes(err.code)) {
          this.log.warn("OCR 작업 접수 응답 없음", err.message);
          throw new AppError(
            err.status || 502,
            "ENGINE_CONNECTION",
            "파일은 정상 저장됐지만 OCR 서버에 작업을 요청하지 못했습니다. VPN 연결과 OCR 서버 상태를 확인한 뒤 다시 처리해 주세요.",
          );
        }
        throw err;
      });
    if (res.status < 200 || res.status >= 300) {
      throw AppError.upstream(`TextSense 작업 요청 실패 (HTTP ${res.status})`, {
        response: res.text.slice(0, 500),
      });
    }
    const taskId = res.json && res.json.id;
    if (!taskId)
      throw AppError.upstream("TextSense 응답에 작업 id 가 없습니다.", {
        response: res.text.slice(0, 500),
      });
    await this._patch(id, {
      taskId,
      engineStatus: res.json.status || "AWAITING",
    });
    await this.assertActive(id);

    await this._waitForSuccess(id, taskId, timeoutMs, pageCount);
    await this._waitForOutput(outputName, this.config.outputFileWaitMs, id);
  }

  /**
   * 페이지가 많은 PDF: 묶음으로 나눠 차례로 인식한 뒤 결과 하나로 합친다.
   * 끝난 묶음(*.done.json)은 보관해, 다시 처리하거나 서버가 재시작돼도 남은 묶음부터 진행한다.
   */
  async _recognizeInChunks(job) {
    const { id, chunkPages } = job;
    const { inputDir, outputDir } = this.config.storage;
    const total = job.pageSizes.length;
    // 엔진 요청 옵션이 다르면 이전 결과를 재사용하지 않는다
    const key = crypto
      .createHash("sha1")
      .update(JSON.stringify(this.engineOptions(job)))
      .digest("hex")
      .slice(0, 8);
    const chunks = [];
    for (let first = 1; first <= total; first += chunkPages) {
      const stem = `${id}.part-${key}-${String(chunks.length + 1).padStart(4, "0")}`;
      chunks.push({
        first,
        count: Math.min(chunkPages, total - first + 1),
        input: `${stem}.pdf`,
        output: `${stem}.json`,
        done: `${stem}.done.json`,
      });
    }
    const isDone = (c) => fs.existsSync(path.join(outputDir, c.done));
    const pending = chunks.filter((c) => !isDone(c));
    let finished = total - pending.reduce((n, c) => n + c.count, 0);
    await this._patch(id, { progress: { done: finished, total } });
    const source = path.join(inputDir, job.storedName);
    if (pending.length)
      await runResultTask(
        "split",
        {
          file: source,
          parts: pending.map((c) => ({
            first: c.first,
            count: c.count,
            target: path.join(inputDir, c.input),
          })),
        },
        this.config.heavyResultBytes,
      );

    for (const chunk of pending) {
      await this._withEngineSlot(async () => {
        for (let attempt = 0; ; attempt++) {
          await this.assertActive(id);
          removeManagedFile(outputDir, chunk.output);
          try {
            await this._recognizeOnce(job, {
              inputName: chunk.input,
              outputName: chunk.output,
              timeoutMs: this.timeoutFor(chunk.count),
              pageCount: total,
            });
            return;
          } catch (err) {
            // 시간 초과는 엔진이 아직 처리 중일 수 있으므로 같은 묶음을 겹쳐 보내지 않는다
            if (
              attempt >= this.config.ocrChunkRetries ||
              !["UPSTREAM_ERROR", "ENGINE_CONNECTION"].includes(err.code)
            ) {
              if (err.code !== "CANCELLED")
                err.message = `${chunk.first}~${chunk.first + chunk.count - 1}페이지 처리 실패: ${err.message} (완료한 ${finished}/${total}페이지는 보관했습니다. "다시 처리"하면 남은 부분부터 진행합니다.)`;
              throw err;
            }
            this.log.warn("묶음 처리 재시도", id, chunk.first, err.message);
            await sleep(this.config.ocrChunkRetryDelayMs);
          }
        }
      });
      fs.renameSync(
        path.join(outputDir, chunk.output),
        path.join(outputDir, chunk.done),
      );
      removeManagedFile(inputDir, chunk.input);
      finished += chunk.count;
      await this._patch(id, { progress: { done: finished, total } });
    }
    await this.assertActive(id);
    await runResultTask(
      "merge",
      {
        file: source,
        parts: chunks.map((c) => ({
          offset: c.first - 1,
          file: path.join(outputDir, c.done),
        })),
        target: path.join(outputDir, `${id}.json`),
      },
      this.config.heavyResultBytes,
    );
    for (const c of chunks) removeManagedFile(outputDir, c.done);
  }

  /** 분할 처리 묶음은 문서가 여러 개여도 한 번에 하나만 엔진에 보낸다 */
  _withEngineSlot(fn) {
    const run = (this.engineSlot || Promise.resolve()).then(fn);
    this.engineSlot = run.catch(() => {});
    return run;
  }

  _partFiles(dir, id) {
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => name.startsWith(`${id}.part-`))
      : [];
  }

  removeParts(id) {
    const { inputDir, outputDir } = this.config.storage;
    for (const dir of [inputDir, outputDir])
      for (const name of this._partFiles(dir, id)) removeManagedFile(dir, name);
  }

  _moveCompletedParts(from, to) {
    const { outputDir } = this.config.storage;
    for (const name of this._partFiles(outputDir, from))
      if (name.endsWith(".done.json"))
        fs.renameSync(
          path.join(outputDir, name),
          path.join(outputDir, to + name.slice(from.length)),
        );
    this.removeParts(from); // 남은 임시 분할 파일 정리
  }

  /** 서버 재시작 전에 분할 처리 중이던 문서를 이어서 진행할 수 있는지 */
  async prepareResume(job) {
    const resumes = (job.resumeCount || 0) + 1;
    if (!job.chunkPages || resumes > MAX_RESUMES) return false;
    await this._patch(job.id, { resumeCount: resumes }, "job.resumed");
    return true;
  }

  /** /job/status 를 폴링해 SUCCESS 가 될 때까지 대기. FAILURE 면 /job/errors 내용으로 실패 처리 */
  async _waitForSuccess(id, taskId, timeoutMs, pageCount = 1) {
    const started = Date.now();
    const deadline = started + timeoutMs;
    // 대용량 문서는 오래 걸리므로 VPN 이 잠시 끊겨도 포기하지 않고 더 기다린다
    const graceMs =
      pageCount > this.config.largeDocumentPages
        ? this.config.statusErrorGraceMs
        : 0;
    // 오래 걸리는 작업은 조회 간격을 늘려 엔진과 이력의 부담을 줄인다
    const pause = () =>
      sleep(
        Date.now() - started > 120000
          ? Math.max(this.config.jobPollIntervalMs, 5000)
          : this.config.jobPollIntervalMs,
      );
    let firstError = 0;
    let last = null;
    let transient = 0; // 연속된 일시적 조회 실패 횟수 (연결 끊김, 5xx). VPN 환경에서 한두 번 끊겨도 작업은 계속 진행 중일 수 있다.
    while (Date.now() < deadline) {
      await this.assertActive(id);
      let st;
      try {
        st = await this.client.getStatus(taskId);
        if (st.status >= 500)
          throw AppError.upstream(`상태 조회 실패 (HTTP ${st.status})`);
      } catch (err) {
        if (!transient) firstError = Date.now();
        if (
          ++transient > MAX_TRANSIENT_STATUS_ERRORS &&
          Date.now() - firstError >= graceMs
        )
          throw err;
        this.log.warn(
          `상태 조회 일시 오류 (${transient}/${MAX_TRANSIENT_STATUS_ERRORS}): ${err.message}`,
        );
        await pause();
        continue;
      }
      transient = 0;
      if (st.status === 404)
        throw AppError.upstream(`TextSense 에 작업이 없습니다 (id: ${taskId})`);
      if (st.status < 200 || st.status >= 300 || !st.json)
        throw AppError.upstream(`상태 조회 실패 (HTTP ${st.status})`, {
          response: st.text.slice(0, 300),
        });

      const status = st.json.status;
      if (status !== last) {
        last = status;
        await this._patch(id, { engineStatus: status });
      }
      if (status === "SUCCESS") return;
      if (status === "FAILURE")
        throw AppError.upstream(await this._describeFailure(taskId));
      await pause();
    }
    throw AppError.timeout(
      `OCR 작업 대기 시간 초과 (${timeoutMs >= 60000 ? `${Math.round(timeoutMs / 60000)}분` : `${timeoutMs}ms`}, 마지막 상태: ${last || "-"})`,
    );
  }

  /** 페이지 수에 비례한 OCR 대기 제한 */
  timeoutFor(pageCount) {
    const { jobTimeoutMs, jobTimeoutPerPageMs, jobTimeoutMaxMs } = this.config;
    return Math.max(
      jobTimeoutMs,
      Math.min(
        jobTimeoutMaxMs,
        jobTimeoutMs + Math.max(0, pageCount - 1) * jobTimeoutPerPageMs,
      ),
    );
  }

  /** 서식 적용. 큰 결과 파일은 작업 스레드에서 처리한다. */
  async _applyFile(file, templateId, options) {
    const forms = await this.formTemplateService.list();
    if (templateId && !options.template && !forms.some((f) => f.id === templateId))
      await this.formTemplateService.get(templateId); // 없는 서식이면 여기서 안내
    return runResultTask(
      "apply",
      { file, forms, templateId, options },
      this.config.heavyResultBytes,
    );
  }

  async _describeFailure(taskId) {
    try {
      const res = await this.client.getErrors(taskId);
      const list =
        res.json && Array.isArray(res.json.errors) ? res.json.errors : [];
      const msgs = list
        .map((e) =>
          [
            e.code,
            String(e.message || String(e.cause || "").split("\n")[0]).replace(
              /\s*\n\s*/g,
              " ",
            ),
          ]
            .filter(Boolean)
            .join(": "),
        )
        .filter(Boolean);
      if (msgs.length)
        return `TextSense 작업 실패 - ${msgs.join(" / ").slice(0, 500)}`;
    } catch (_) {
      /* 오류 조회 실패는 무시하고 기본 메시지 사용 */
    }
    const hint = this.config.ftp.enabled
      ? "입력 파일(http)·결과 업로드(ftp)를 TextSense 서버가 이 PC 에서 접근할 수 있는지(방화벽/주소) 확인하세요."
      : "입력/출력 경로가 TextSense 서버에서 접근 가능한지 확인하세요.";
    return `TextSense 작업 실패 (FAILURE). 오류 상세를 조회하지 못했습니다. ${hint}`;
  }

  /** 결과 JSON 파일을 읽는다. 공유 저장소 지연을 고려해 잠시 재시도(작성 중인 파일은 파싱 실패 → 재시도) */
  async _waitForOutput(outputName, waitMs, id) {
    const { outputDir } = this.config.storage;
    const file = path.join(outputDir, outputName);
    let deadline = Date.now() + waitMs;
    const limit = Date.now() + this.config.jobTimeoutMaxMs;
    let lastSize = -1;
    for (;;) {
      if (id) await this.assertActive(id);
      if (fs.existsSync(file)) {
        const { size } = fs.statSync(file);
        if (size > this.config.heavyResultBytes) {
          // 큰 파일은 여기서 해석하지 않고, 크기가 더 늘지 않으면 완료로 본다
          if (size === lastSize) return;
          lastSize = size;
          deadline = Math.max(deadline, Date.now() + waitMs);
          await sleep(2000);
          continue;
        }
        try {
          readJsonFileSync(file);
          return;
        } catch (_) {
          /* 쓰는 중 */
        }
      } else if (
        fs.existsSync(outputDir) &&
        fs.readdirSync(outputDir).some((n) => n.startsWith(`${outputName}.`) && n.endsWith(".part"))
      ) {
        // FTP 로 받는 중이면 끝날 때까지 기다린다
        deadline = Math.max(deadline, Math.min(limit, Date.now() + waitMs));
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(this.config.jobPollIntervalMs, 500));
    }
    throw AppError.timeout(
      `작업은 성공했지만 결과 파일을 찾을 수 없습니다: ${file} (LOCAL_OUTPUT_DIR 이 ePapyrus 출력 경로와 같은 저장소인지 확인하세요)`,
    );
  }

  /** 이미지 입력이면 헤더에서 픽셀 크기를 읽어 좌표 정규화에 사용 (PDF 는 null → 추정) */
  _pageSize(job) {
    try {
      const buf = fs.readFileSync(
        path.join(this.config.storage.inputDir, job.storedName),
      );
      return getImageSize(buf);
    } catch (_) {
      return null;
    }
  }

  /** 완료된 작업의 페이지별 OCR 추출값 (텍스트 / 단어 / 표 / SearchAPI fields) */
  async getOcrView(id) {
    const job = await this.get(id);
    if (job.status !== "done")
      throw AppError.badRequest(`아직 결과가 없습니다 (상태: ${job.status})`);
    const file = path.join(this.config.storage.outputDir, `${id}.json`);
    if (!fs.existsSync(file))
      throw AppError.notFound(`결과 파일이 없습니다: ${file}`);
    const pageSizes = job.pageSizes?.length
      ? job.pageSizes
      : await documentGeometry(
          path.join(this.config.storage.inputDir, job.storedName),
          this.config.pdfOcrScale,
        );
    if (pageSizes.length && !job.pageSizes?.length)
      await this._patch(id, { pageSizes });
    return this.ocrResultService.view(
      readJsonFileSync(file),
      { pageSize: this._pageSize(job), pageSizes },
    );
  }

  /** 결과 화면용: 페이지가 많은 문서는 요약만 보내고 상세는 getOcrPage 로 불러온다 */
  async getOcrScreenView(id) {
    const job = await this.get(id);
    if (
      job.status !== "done" ||
      !(job.ocrResult.pageCount > this.config.largeDocumentPages)
    )
      return this.getOcrView(id);
    const { summaries } = await this._pagesOf(job);
    return { lazy: true, pages: summaries };
  }

  async getOcrPage(id, number) {
    const job = await this.get(id);
    if (job.status !== "done")
      throw AppError.badRequest(`아직 결과가 없습니다 (상태: ${job.status})`);
    const { summaries, pages } = await this._pagesOf(job);
    const index = summaries.findIndex((p) => p.page === Number(number));
    if (index < 0) throw AppError.notFound("해당 페이지가 없습니다.");
    return JSON.parse(pages[index]);
  }

  /** 가장 최근에 연 대용량 문서 하나의 페이지 데이터를 10분간 보관 */
  async _pagesOf(job) {
    const file = path.join(this.config.storage.outputDir, `${job.id}.json`);
    if (!fs.existsSync(file))
      throw AppError.notFound("OCR 결과 파일이 없습니다.");
    const mtime = fs.statSync(file).mtimeMs;
    if (this.pageCache?.id !== job.id || this.pageCache.mtime !== mtime) {
      const data = runResultTask(
        "pages",
        { file, options: { pageSize: this._pageSize(job), pageSizes: job.pageSizes || [] } },
        this.config.heavyResultBytes,
      );
      this.pageCache = { id: job.id, mtime, data };
      data.catch(() => {
        if (this.pageCache?.data === data) this.pageCache = null;
      });
    }
    const entry = this.pageCache;
    clearTimeout(this.pageCacheTimer);
    this.pageCacheTimer = setTimeout(() => {
      this.pageCache = null;
    }, 10 * 60 * 1000);
    this.pageCacheTimer.unref();
    return entry.data;
  }

  engineOptions(job) {
    const baseline = this.config.enginePolicy || {};
    const form = job.templateSnapshot;
    const request = form?.engineRequest || {};
    const reqOption = mergeOptions(
      baseline.reqOption || {},
      request.reqOption || {},
    );
    const rules = [
      ...(baseline.reqOption?.SearchAPI || []),
      ...(request.reqOption?.SearchAPI || []),
    ];
    for (const key of form?.keys || []) {
      if (!key.searchType) continue;
      const size = job.pageSizes?.[(key.page || 1) - 1];
      if (key.searchType === "FindRegion" && !size)
        throw AppError.badRequest(
          "SearchAPI 영역을 전달할 페이지 크기를 확인할 수 없습니다. 정상 PDF 또는 이미지 원본을 사용하세요.",
        );
      if (key.searchType !== "FindRegion" && !key.searchKey?.trim())
        throw AppError.badRequest(
          `${key.name}: SearchAPI 탐색 기준 단어가 필요합니다.`,
        );
      rules.push({
        Type: key.searchType,
        Name: key.name,
        Key:
          key.searchType === "FindRegion"
            ? [
                [key.rect.x * size.width, key.rect.y * size.height],
                [
                  (key.rect.x + key.rect.w) * size.width,
                  (key.rect.y + key.rect.h) * size.height,
                ],
              ]
            : [key.searchKey],
      });
    }
    if (rules.length) {
      if (new Set(rules.map((r) => r.Name)).size !== rules.length)
        throw AppError.badRequest(
          "기존 정책과 신규 정책의 SearchAPI 이름이 중복됩니다. 이름을 변경하세요.",
        );
      reqOption.SearchAPI = rules;
    }
    return {
      reqType: request.reqType || baseline.reqType || "Document",
      reqOption,
    };
  }

  async reapply(id, templateId, actor) {
    const job = await this.get(id);
    if (job.status !== "done")
      throw AppError.badRequest("완료된 문서에만 서식을 적용할 수 있습니다.");
    const template = templateId
      ? await this.formTemplateService.get(templateId)
      : null;
    const file = path.join(this.config.storage.outputDir, `${id}.json`);
    if (!fs.existsSync(file))
      throw AppError.notFound("OCR 결과 파일이 없습니다.");
    const result = await this._applyFile(file, templateId, {
      pageSizes: job.pageSizes,
      pageSize: this._pageSize(job),
      template,
      useEngineFields: false,
    });
    const appliedTemplate =
      template ||
      (result.templateId
        ? await this.formTemplateService.get(result.templateId)
        : null);
    return this._patch(
      id,
      {
        templateId: result.templateId,
        templateSnapshot: appliedTemplate,
        ocrResult: result,
        review: null,
      },
      "template.reapplied",
      actor,
    );
  }

  raw(job) {
    const file = path.join(this.config.storage.outputDir, `${job.id}.json`);
    if (!fs.existsSync(file))
      throw AppError.notFound("OCR 결과 파일이 없습니다.");
    return readJsonFileSync(file);
  }

  async diagnostics(id) {
    const job = await this.get(id),
      sourcePresent = fs.existsSync(
        path.join(this.config.storage.inputDir, job.storedName),
      ),
      resultPresent = fs.existsSync(
        path.join(this.config.storage.outputDir, `${id}.json`),
      );
    const hints = [];
    if (!sourcePresent)
      hints.push("보관된 원본이 없습니다. 원본을 다시 업로드하세요.");
    if (job.errorCode === "ENGINE_CONNECTION")
      hints.push(
        "VPN 연결, 게이트웨이 포트, 서버 상태를 확인하세요. 원본은 보관됐으므로 다시 처리할 수 있습니다.",
      );
    if (job.errorCode === "TIMEOUT" && !resultPresent)
      hints.push(
        "서버의 작업 상태와 결과 저장 경로를 확인하세요. FTP 사용 시 앱 서버로 들어오는 연결과 패시브 포트가 허용돼야 합니다.",
      );
    if (job.errorCode === "INTERRUPTED")
      hints.push(
        "서버 재시작으로 중단됐습니다. 다시 처리하면 기존 실패 기록을 보존한 새 작업을 생성합니다.",
      );
    if (job.splitError)
      hints.push(
        "분리 기준과 원본 페이지 수를 확인하세요. OCR 결과는 보존되어 있습니다.",
      );
    if (!hints.length && job.status === "failed")
      hints.push(
        "아래 엔진 오류와 상태 전환 이력을 확인하세요. 같은 파일에서 반복되면 해당 오류 코드로 엔진 담당자에게 확인하세요.",
      );
    const events = job.events || [],
      stages = events.map((e, i) => ({
        ...e,
        elapsedMs: i
          ? Math.max(0, Date.parse(e.at) - Date.parse(events[i - 1].at))
          : 0,
      }));
    return {
      id,
      fileName: job.fileName,
      status: job.status,
      sourcePresent,
      resultPresent,
      error: job.error || job.splitError || job.deliveryError || null,
      errorCode: job.errorCode || null,
      engineStatus: job.engineStatus,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      totalElapsedMs: Math.max(
        0,
        Date.parse(job.updatedAt) - Date.parse(job.createdAt),
      ),
      hints,
      stages,
      cancellation: job.cancellation || null,
    };
  }

  async autoSplit(id, option) {
    const job = await this.get(id),
      view = await this.getOcrView(id),
      groups = [];
    if (option.mode === "pages") {
      for (let i = 0; i < view.pages.length; i += Number(option.count))
        groups.push(
          view.pages.slice(i, i + Number(option.count)).map((p) => p.page),
        );
    } else if (option.mode === "blank") {
      let current = [];
      for (const p of view.pages) {
        if (!p.content.trim() && !p.words.length) {
          if (current.length) groups.push(current);
          current = [];
        } else current.push(p.page);
      }
      if (current.length) groups.push(current);
    } else if (option.mode === "template") {
      const {
        classifyTemplate,
        normalizeOcr,
      } = require("../ocr-result/ocr-result.extractor");
      const forms = await this.formTemplateService.list(),
        raw = this.raw(job);
      let previous = null,
        current = [];
      for (const [key, p] of Object.entries(raw.document.pages).sort(
        (a, b) =>
          Number(a[0].replace(/\D/g, "")) - Number(b[0].replace(/\D/g, "")),
      )) {
        const n = Number(key.replace(/\D/g, "")),
          form = classifyTemplate(
            forms,
            normalizeOcr({ document: { pages: { [key]: p } } }),
          ),
          type = form?.id || "unclassified";
        if (current.length && type !== previous) {
          groups.push(current);
          current = [];
        }
        current.push(n);
        previous = type;
      }
      if (current.length) groups.push(current);
    }
    return this.splitDocument(id, groups);
  }

  async splitDocument(id, groups, actor) {
    const job = await this.get(id);
    if (job.status !== "done")
      throw AppError.badRequest("완료된 문서만 분리할 수 있습니다.");
    if (!Array.isArray(groups) || !groups.length || groups.length > 500)
      throw AppError.badRequest("분리할 페이지 그룹을 지정하세요.");
    const all = groups.flat();
    if (
      all.some(
        (n) => !Number.isInteger(n) || n < 1 || n > job.ocrResult.pageCount,
      ) ||
      new Set(all).size !== all.length ||
      groups.some((g) => !Array.isArray(g) || !g.length)
    )
      throw AppError.badRequest(
        "페이지 그룹은 중복 없이 원본 범위 안에서 지정하세요.",
      );
    const raw = this.raw(job),
      entries = Object.entries(raw.document.pages).sort(
        (a, b) =>
          Number(a[0].replace(/\D/g, "")) - Number(b[0].replace(/\D/g, "")),
      ),
      children = [];
    const source = path.join(this.config.storage.inputDir, job.storedName);
    for (const numbers of groups) {
      const bytes = await copyDocumentPages(source, numbers),
        childId = createId("job"),
        storedName = `${childId}.pdf`,
        now = new Date().toISOString();
      const childRaw = {
        ...raw,
        document: {
          ...raw.document,
          pages: Object.fromEntries(
            numbers.map((n, i) => [`pages_${i + 1}`, entries[n - 1][1]]),
          ),
        },
      };
      fs.writeFileSync(
        path.join(this.config.storage.inputDir, storedName),
        bytes,
      );
      fs.writeFileSync(
        path.join(this.config.storage.outputDir, `${childId}.json`),
        JSON.stringify(childRaw),
      );
      const sizes = numbers.map((n) => job.pageSizes?.[n - 1]),
        result = await this.ocrResultService.apply(childRaw, null, {
          pageSizes: sizes,
        });
      children.push(
        await this.repo.insert({
          id: childId,
          ownerId: ownerOf(job),
          fileName: `${job.fileName.replace(/\.[^.]+$/, "")}_${numbers.join("-")}.pdf`,
          storedName,
          status: "done",
          engineStatus: "SUCCESS",
          taskId: job.taskId,
          templateId: result.templateId,
          ocrResult: result,
          pageSizes: sizes,
          parentId: id,
          relation: "split",
          sourcePages: numbers,
          createdAt: now,
          updatedAt: now,
          events: [{ type: "split.created", at: now, actor }],
        }),
      );
    }
    await this._patch(
      id,
      { children: [...(job.children || []), ...children.map((c) => c.id)] },
      "document.split",
      actor,
    );
    return children;
  }

  close() {
    clearTimeout(this.pageCacheTimer);
    this.repo.close();
  }

  /** 실행 중인 작업이 모두 끝날 때까지 대기 (테스트/종료용) */
  async idle() {
    while (this.running.size) await Promise.all([...this.running]);
  }
}

module.exports = { FormJobService, matchesFileType, canAccess, ownerOf };
