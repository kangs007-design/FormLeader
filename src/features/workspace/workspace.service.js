"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { diffArrays } = require("diff");
const { SqliteRepository } = require("../../common/sqlite.repository");
const { createId, toSafeFileName } = require("../../common/id.util");
const { documentGeometry } = require("../../common/document.util");
const { AppError } = require("../../common/app.error");
const { validateOptions } = require("../ocr-connect/engine-policy.util");
const { removeManagedFile } = require("../../common/file-access.util");

const ALLOWED = [".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"];
function validUrl(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw AppError.badRequest("URL 형식이 올바르지 않습니다.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw AppError.badRequest(
      "인증 정보를 제외한 HTTP/HTTPS 주소를 입력하세요.",
    );
  return url.href;
}

class WorkspaceService {
  constructor({
    config,
    formJobService,
    formTemplateService,
    documentExportService,
    authService,
  }) {
    Object.assign(this, {
      config,
      jobs: formJobService,
      forms: formTemplateService,
      exports: documentExportService,
      auth: authService,
    });
    this.settings = new SqliteRepository(
      path.join(config.dataDir, "workspace-settings.json"),
    );
    this.samples = new SqliteRepository(
      path.join(config.dataDir, "form-samples.json"),
    );
    this.comparisons = new SqliteRepository(
      path.join(config.dataDir, "document-comparisons.json"),
    );
    this.deliveries = new SqliteRepository(
      path.join(config.dataDir, "deliveries.json"),
    );
    this.outgoing = new Set();
    this.lastCpu = this.cpuTimes();
    const policy = this.settings.db
      .prepare("SELECT data FROM records WHERE collection=? AND id=?")
      .get("workspace-settings", "engine");
    if (policy) config.enginePolicy = JSON.parse(policy.data).policy;
  }
  async getSettings() {
    const engine = await this.settings.get("engine"),
      integration = await this.settings.get("integration");
    return {
      engine: engine?.policy || { reqType: "Document", reqOption: {} },
      integration: {
        url: integration?.url || "",
        tokenConfigured: !!integration?.token,
        autoSend: !!integration?.autoSend,
        monitorUrl: integration?.monitorUrl || "",
      },
      capabilities: {
        requestPolicy: true,
        persistentEnginePolicy: false,
        cancelConfigured: !!this.config.cancelPath,
        pdfOcrScale: this.config.pdfOcrScale,
      },
    };
  }
  /** @returns 서버 시작 후 이어서 진행할 분할 처리 작업 id */
  async recover() {
    const resumable = [];
    for (const j of await this.jobs.repo.list())
      if (["pending", "processing"].includes(j.status)) {
        if (await this.jobs.prepareResume(j)) {
          resumable.push(j.id);
          continue;
        }
        await this.jobs._patch(
          j.id,
          {
            status: "failed",
            error:
              "서버 재시작으로 처리가 중단되었습니다. 보관된 원본으로 다시 처리하세요.",
            errorCode: "INTERRUPTED",
          },
          "status.failed",
        );
      }
    for (const d of await this.deliveries.list())
      if (["pending", "sending"].includes(d.status))
        await this.deliveries.update(d.id, {
          status: "failed",
          error:
            "서버 재시작으로 전송 완료를 확인하지 못했습니다. 같은 전송 키로 다시 시도할 수 있습니다.",
        });
    return resumable;
  }
  async saveSettings(input) {
    if (input.engine !== undefined) {
      const p = input.engine;
      if (
        !p ||
        typeof p !== "object" ||
        Array.isArray(p) ||
        !p.reqOption ||
        typeof p.reqOption !== "object" ||
        Array.isArray(p.reqOption) ||
        JSON.stringify(p).length > 100000
      )
        throw AppError.badRequest(
          "엔진 정책은 reqOption 객체를 포함해야 합니다.",
        );
      if (p.reqType && p.reqType !== "Document")
        throw AppError.badRequest("이 버전의 엔진 요청 유형은 Document입니다.");
      validateOptions(p.reqOption);
      if (
        p.reqOption.SearchAPI &&
        (!Array.isArray(p.reqOption.SearchAPI) ||
          p.reqOption.SearchAPI.some(
            (r) => !r || !r.Type || !r.Name || !Array.isArray(r.Key),
          ))
      )
        throw AppError.badRequest(
          "SearchAPI는 Type, Name, Key 배열을 포함해야 합니다.",
        );
      const item = {
        id: "engine",
        policy: p,
        updatedAt: new Date().toISOString(),
      };
      if (await this.settings.get("engine"))
        await this.settings.update("engine", item);
      else await this.settings.insert(item);
      this.config.enginePolicy = p;
    }
    if (input.integration !== undefined) {
      const previous = await this.settings.get("integration"),
        i = input.integration;
      if (!i || typeof i !== "object" || Array.isArray(i))
        throw AppError.badRequest("업무 연동 설정이 올바르지 않습니다.");
      const item = {
        id: "integration",
        url: validUrl(i.url),
        monitorUrl: validUrl(i.monitorUrl),
        token: i.token === undefined ? previous?.token || "" : String(i.token),
        autoSend: !!i.autoSend,
      };
      if (item.token.length > 5000 || /[\r\n]/.test(item.token))
        throw AppError.badRequest("인증 토큰이 올바르지 않습니다.");
      if (item.autoSend && !item.url)
        throw AppError.badRequest(
          "자동 전송을 사용하려면 업무 서버 URL이 필요합니다.",
        );
      if (previous) await this.settings.update("integration", item);
      else await this.settings.insert(item);
    }
    return this.getSettings();
  }
  async sample(input) {
    const fileName = toSafeFileName(input.fileName),
      ext = path.extname(fileName).toLowerCase();
    if (
      !ALLOWED.includes(ext) ||
      !input.contentBase64 ||
      typeof input.contentBase64 !== "string"
    )
      throw AppError.badRequest("PDF 또는 이미지 샘플을 선택하세요.");
    const id = createId("sample"),
      storedName = id + ext,
      bytes = Buffer.from(input.contentBase64, "base64");
    if (!bytes.length || bytes.length > 40 * 1024 * 1024)
      throw AppError.badRequest("샘플 파일은 40MB 이내여야 합니다.");
    fs.mkdirSync(this.config.storage.inputDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.config.storage.inputDir, storedName),
      bytes,
    );
    const pageSizes = await documentGeometry(
      path.join(this.config.storage.inputDir, storedName),
      this.config.pdfOcrScale,
    );
    return this.samples.insert({
      id,
      fileName,
      storedName,
      pageSizes,
      createdAt: new Date().toISOString(),
    });
  }
  async getSample(id) {
    const s = await this.samples.get(id);
    if (!s) throw AppError.notFound("샘플을 찾을 수 없습니다.");
    return s;
  }
  async preview(input, actor) {
    const sample = await this.getSample(input.sampleId);
    return this.jobs.create({
      fileName: sample.fileName,
      contentBase64: fs
        .readFileSync(
          path.join(this.config.storage.inputDir, sample.storedName),
        )
        .toString("base64"),
      templateSnapshot: input.template,
      actor,
    });
  }
  cpuTimes() {
    return os.cpus().reduce(
      (a, c) => {
        a.idle += c.times.idle;
        a.total += Object.values(c.times).reduce((n, v) => n + v, 0);
        return a;
      },
      { idle: 0, total: 0 },
    );
  }
  async monitor() {
    const next = this.cpuTimes(),
      delta = next.total - this.lastCpu.total,
      cpu = delta ? 100 * (1 - (next.idle - this.lastCpu.idle) / delta) : 0;
    this.lastCpu = next;
    const total = os.totalmem(),
      free = os.freemem(),
      disk = fs.statfsSync(this.config.dataDir);
    const gateway = await new Promise((resolve) => {
      const s = net.createConnection({
        host: this.config.textsense.host,
        port: this.config.textsense.port,
      });
      const done = (v) => {
        s.destroy();
        resolve(v);
      };
      s.setTimeout(1500);
      s.once("connect", () => done({ reachable: true }));
      s.once("error", (e) => done({ reachable: false, error: e.code }));
      s.once("timeout", () => done({ reachable: false, error: "TIMEOUT" }));
    });
    const integration = await this.settings.get("integration");
    let remote = { configured: false };
    if (integration?.monitorUrl) {
      try {
        const r = await fetch(integration.monitorUrl, {
          headers: integration.token
            ? { Authorization: `Bearer ${integration.token}` }
            : {},
          signal: AbortSignal.timeout(4000),
          redirect: "error",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        remote = { configured: true, metrics: await r.json() };
      } catch (e) {
        remote = { configured: true, error: e.message };
      }
    }
    const jobs = await this.jobs.list(),
      events = jobs
        .flatMap((j) =>
          (j.events || []).map((e) => ({
            ...e,
            jobId: j.id,
            fileName: j.fileName,
          })),
        )
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 500);
    const names = new Map(
      (this.auth?.listUsers() || []).map((u) => [u.id, u.name]),
    );
    return {
      at: new Date().toISOString(),
      local: {
        host: os.hostname(),
        cpuPercent: Math.max(0, Math.min(100, cpu)),
        memory: { total, used: total - free },
        storage: {
          total: Number(disk.blocks) * Number(disk.bsize),
          free: Number(disk.bavail) * Number(disk.bsize),
        },
        processMemory: process.memoryUsage().rss,
        uptime: process.uptime(),
      },
      services: { application: "UP", gateway },
      remote,
      jobs: {
        total: jobs.length,
        processing: jobs.filter((j) =>
          ["pending", "processing"].includes(j.status),
        ).length,
        failed: jobs.filter((j) => j.status === "failed").length,
        cancelled: jobs.filter((j) => j.status === "cancelled").length,
      },
      events: events.map((e) => ({
        ...e,
        actorName:
          names.get(e.actor) ||
          (e.actor === "automatic"
            ? "자동 전송"
            : e.actor
              ? "사용자"
              : "시스템"),
      })),
      failures: jobs
        .filter((j) => j.error || j.splitError || j.deliveryError)
        .map((j) => ({
          id: j.id,
          fileName: j.fileName,
          error: j.error || j.splitError || j.deliveryError,
          code: j.errorCode,
          at: j.updatedAt,
        })),
      deliveries: await this.deliveries.list(),
    };
  }
  async compare(input, actor) {
    if (!input.leftId || !input.rightId || input.leftId === input.rightId)
      throw AppError.badRequest("서로 다른 두 문서를 선택하세요.");
    // 큰 문서는 결과를 읽기 전에 먼저 거절한다
    const words = async (id) => (await this.jobs.get(id)).ocrResult?.wordCount || 0;
    if ((await words(input.leftId)) + (await words(input.rightId)) > 100000)
      throw AppError.badRequest(
        "비교할 문서가 너무 큽니다. 문서를 분리한 뒤 비교하세요.",
      );
    const left = await this.jobs.getOcrView(input.leftId),
      right = await this.jobs.getOcrView(input.rightId);
    const tokens = (view) =>
      view.pages.flatMap((p) =>
        p.words.length
          ? p.words
              .slice()
              .sort((a, b) =>
                Math.abs(a.y1 - b.y1) < Math.max(a.y2 - a.y1, b.y2 - b.y1) / 2
                  ? a.x1 - b.x1
                  : a.y1 - b.y1,
              )
              .map((w) => ({
                text: w.text,
                page: p.page,
                rect: {
                  x: w.x1 / p.width,
                  y: w.y1 / p.height,
                  w: (w.x2 - w.x1) / p.width,
                  h: (w.y2 - w.y1) / p.height,
                },
              }))
          : p.content
              .split(/\s+/)
              .filter(Boolean)
              .map((text) => ({ text, page: p.page, rect: null })),
      );
    const a = tokens(left),
      b = tokens(right);
    if (a.length + b.length > 100000)
      throw AppError.badRequest(
        "비교할 문서가 너무 큽니다. 문서를 분리한 뒤 비교하세요.",
      );
    const changes = diffArrays(
      a.map((t) =>
        input.ignoreWhitespace ? t.text.replace(/\s/g, "") : t.text,
      ),
      b.map((t) =>
        input.ignoreWhitespace ? t.text.replace(/\s/g, "") : t.text,
      ),
      { timeout: 5000, maxEditLength: 20000 },
    );
    if (!changes)
      throw AppError.badRequest(
        "비교량이 제한을 초과했습니다. 문서를 분리해 다시 비교하세요.",
      );
    let ai = 0,
      bi = 0;
    const differences = [];
    for (const c of changes) {
      if (c.added) {
        differences.push({
          type: "added",
          left: a[ai] || a[ai - 1] || null,
          right: b[bi] || null,
          leftWords: [],
          rightWords: b.slice(bi, bi + c.count),
          text: c.value.join(" "),
        });
        bi += c.count;
      } else if (c.removed) {
        differences.push({
          type: "removed",
          left: a[ai] || null,
          right: b[bi] || b[bi - 1] || null,
          leftWords: a.slice(ai, ai + c.count),
          rightWords: [],
          text: c.value.join(" "),
        });
        ai += c.count;
      } else {
        if (input.compareLayout)
          for (let k = 0; k < c.count; k++) {
            const x = a[ai + k],
              y = b[bi + k];
            if (
              x.rect &&
              y.rect &&
              (x.page !== y.page ||
                Math.abs(x.rect.x - y.rect.x) > 0.02 ||
                Math.abs(x.rect.y - y.rect.y) > 0.02 ||
                Math.abs(x.rect.w - y.rect.w) > 0.02 ||
                Math.abs(x.rect.h - y.rect.h) > 0.02)
            )
              differences.push({
                type: "moved",
                left: x,
                right: y,
                leftWords: [x],
                rightWords: [y],
                text: x.text,
              });
          }
        ai += c.count;
        bi += c.count;
      }
    }
    if (left.pages.length !== right.pages.length)
      differences.unshift({
        type: "pages",
        left: { page: 1, rect: null },
        right: { page: 1, rect: null },
        text: `페이지 수: ${left.pages.length} → ${right.pages.length}`,
      });
    const paired = [];
    for (let i = 0; i < differences.length; i++) {
      const d = differences[i],
        next = differences[i + 1];
      if (d.type === "removed" && next?.type === "added") {
        paired.push({
          type: "changed",
          left: d.left,
          right: next.right,
          leftWords: d.leftWords,
          rightWords: next.rightWords,
          text: `${d.text} → ${next.text}`,
        });
        i++;
      } else paired.push(d);
    }
    return this.comparisons.insert({
      id: createId("compare"),
      leftId: input.leftId,
      rightId: input.rightId,
      differences: paired,
      ignoreWhitespace: !!input.ignoreWhitespace,
      compareLayout: !!input.compareLayout,
      createdAt: new Date().toISOString(),
      actor,
    });
  }
  async deliver(id, actor) {
    const settings = await this.settings.get("integration");
    if (!settings?.url)
      throw AppError.badRequest(
        "관리자 연결 설정에서 업무 서버 수신 URL을 설정하세요.",
      );
    const d = await this.exports.data(id),
      payload = {
        event: "document.completed",
        jobId: id,
        fileName: d.fileName,
        templateId: d.job.ocrResult.templateId,
        values: d.values,
        groups: d.groups,
        text: d.text,
        review: d.review,
      };
    const key = crypto
      .createHash("sha256")
      .update(settings.url + JSON.stringify(payload))
      .digest("hex");
    let record = await this.deliveries.get(key);
    if (record?.status === "sent") return record;
    if (record?.status === "sending") return record;
    if (!record) {
      record = {
        id: key,
        jobId: id,
        url: settings.url,
        status: "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
        actor,
      };
      await this.deliveries.insert(record);
    }
    const promise = this.send(record, payload, settings).finally(() =>
      this.outgoing.delete(promise),
    );
    this.outgoing.add(promise);
    return promise;
  }
  async send(record, payload, settings) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.deliveries.update(record.id, {
        status: "sending",
        attempts: (record.attempts || 0) + attempt,
        updatedAt: new Date().toISOString(),
      });
      try {
        const response = await fetch(record.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": record.id,
            ...(settings.token
              ? { Authorization: `Bearer ${settings.token}` }
              : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (response.ok) {
          await this.deliveries.update(record.id, {
            status: "sent",
            httpStatus: response.status,
            error: null,
            updatedAt: new Date().toISOString(),
          });
          return this.deliveries.get(record.id);
        }
        const retry = response.status >= 500 || response.status === 429;
        await response.body?.cancel();
        if (!retry || attempt === 3) throw new Error(`HTTP ${response.status}`);
      } catch (e) {
        if (attempt === 3 || /^HTTP 4(?!29)/.test(e.message)) {
          await this.deliveries.update(record.id, {
            status: "failed",
            error: e.message,
            updatedAt: new Date().toISOString(),
          });
          return this.deliveries.get(record.id);
        }
      }
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  /** 삭제한 문서의 본문이 비교 결과에 남지 않게 지운다 */
  async removeComparisonsOf(jobId) {
    for (const c of await this.comparisons.list())
      if (c.leftId === jobId || c.rightId === jobId)
        await this.comparisons.remove(c.id);
  }
  async reset(input, actor) {
    if (input.confirm !== "문서 초기화")
      throw AppError.badRequest("확인 문구 “문서 초기화”를 정확히 입력하세요.");
    if (this.jobs.resetting) throw AppError.badRequest("이미 초기화 중입니다.");
    this.jobs.resetting = true;
    try {
      const jobs = await this.jobs.repo.list();
      for (const j of jobs)
        if (["pending", "processing"].includes(j.status))
          await this.jobs.cancel(j.id, actor);
      await this.jobs.idle();
      await Promise.all([...this.outgoing]);
      const samples = await this.samples.list();
      for (const j of jobs) {
        await this.jobs.discard(j.id);
        this.jobs.removeParts(j.id);
        this.unlinkManaged(this.config.storage.inputDir, j.storedName);
        this.unlinkManaged(this.config.storage.outputDir, `${j.id}.json`);
        this.unlinkManaged(
          this.config.storage.outputDir,
          `${j.id}.classification.json`,
        );
      }
      await this.jobs.repo.clear();
      await this.comparisons.clear();
      await this.deliveries.clear();
      if (input.includeTemplates) {
        for (const s of samples)
          this.unlinkManaged(this.config.storage.inputDir, s.storedName);
        await this.samples.clear();
        await this.forms.repo.clear();
        await this.forms.versions.clear();
      }
      return {
        removedJobs: jobs.length,
        templatesRemoved: !!input.includeTemplates,
        accountsPreserved: true,
      };
    } finally {
      this.jobs.resetting = false;
    }
  }
  unlinkManaged(dir, name) {
    removeManagedFile(dir, name);
  }
  async close() {
    await Promise.all([...this.outgoing]);
    for (const r of [
      this.settings,
      this.samples,
      this.comparisons,
      this.deliveries,
    ])
      r.close();
  }
}
module.exports = { WorkspaceService };
