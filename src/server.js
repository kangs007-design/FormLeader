"use strict";
/**
 * DigitalLeader 서버 진입점 (모듈 조립)
 *   common      : src/common
 *   features    : src/features/{ocr-connect, form-template, form-job, ocr-result}
 *   web(UI)     : src/web
 */
const http = require("http");
const crypto = require("crypto");
const { FtpReceiver } = require("./common/ftp-receiver.server");
const { createConfig } = require("./common/app.config");
const { createLogger } = require("./common/logger.util");
const { Router } = require("./common/router.util");
const {
  sendJson,
  serveStatic,
  serveFile,
} = require("./common/http-response.util");

const { TextSenseClient } = require("./features/ocr-connect/textsense.client");
const {
  OcrConnectService,
} = require("./features/ocr-connect/ocr-connect.service");
const {
  registerOcrConnectRoutes,
} = require("./features/ocr-connect/ocr-connect.controller");
const {
  FormTemplateService,
} = require("./features/form-template/form-template.service");
const {
  registerFormTemplateRoutes,
} = require("./features/form-template/form-template.controller");
const {
  OcrResultService,
} = require("./features/ocr-result/ocr-result.service");
const {
  FormJobService,
  canAccess,
} = require("./features/form-job/form-job.service");
const {
  registerFormJobRoutes,
} = require("./features/form-job/form-job.controller");
const {
  DocumentExportService,
} = require("./features/form-job/document-export.service");
const { WorkspaceService } = require("./features/workspace/workspace.service");
const {
  registerWorkspaceRoutes,
} = require("./features/workspace/workspace.controller");
const { AuthService } = require("./features/auth/auth.service");
const { registerAuthRoutes } = require("./features/auth/auth.controller");
const { verifyInputFile } = require("./common/file-access.util");
const { AppError } = require("./common/app.error");

/** 화면은 같은 출처의 스크립트·스타일만 사용한다 (pdf.js 는 Web Worker/wasm 사용) */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");


/** 서비스와 HTTP 서버를 조립한다. (listen 은 start 에서) */
function createApp(config = createConfig()) {
  const log = createLogger("server");
  config.fileAccessSecret = crypto.randomBytes(32);
  const authService = new AuthService(config);

  const client = new TextSenseClient(config);
  const ocrConnectService = new OcrConnectService({ config, client });
  const formTemplateService = new FormTemplateService({ config });
  const ocrResultService = new OcrResultService({ formTemplateService });
  const formJobService = new FormJobService({
    config,
    client,
    ocrResultService,
    formTemplateService,
  });
  const documentExportService = new DocumentExportService({
    config,
    formJobService,
  });
  const workspaceService = new WorkspaceService({
    config,
    formJobService,
    formTemplateService,
    documentExportService,
    authService,
  });
  formJobService.onRemove = (id) => workspaceService.removeComparisonsOf(id);
  formJobService.onComplete = async (id) => {
    const s = await workspaceService.settings.get("integration");
    if (s?.autoSend) await workspaceService.deliver(id, "automatic");
  };

  const router = new Router();
  const deps = {
    ocrConnectService,
    formTemplateService,
    formJobService,
    ocrResultService,
    authService,
    workspaceService,
    documentExportService,
  };
  registerAuthRoutes(router, deps);
  router.add("GET", "/api/health", async () => ({
    status: "UP",
    time: new Date().toISOString(),
  }));
  registerOcrConnectRoutes(router, deps);
  registerFormTemplateRoutes(router, deps);
  registerFormJobRoutes(router, deps);
  registerWorkspaceRoutes(router, deps);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", CSP);
      await authService.ready;
      if (url.pathname.startsWith("/api/auth/")) {
        res.setHeader("Cache-Control", "no-store");
        const allowed = new Set([
          "POST /api/auth/sign-in/email",
          "POST /api/auth/sign-up/email",
          "POST /api/auth/sign-out",
          "POST /api/auth/change-password",
          "GET /api/auth/get-session",
          "GET /api/auth/ok",
        ]);
        if (!allowed.has(`${req.method} ${url.pathname}`))
          throw AppError.notFound("지원하지 않는 인증 요청입니다.");
        await authService.nodeHandler(req, res);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        authService.checkWrite(req);
        const publicRoute = [
          "/api/health",
          "/api/account/status",
          "/api/account/setup",
        ].includes(url.pathname);
        if (!publicRoute) {
          const adminOnly =
            url.pathname.startsWith("/api/users") ||
            url.pathname.startsWith("/api/ocr/") ||
            url.pathname.startsWith("/api/workspace/") ||
            url.pathname.startsWith("/api/samples") ||
            url.pathname.endsWith("/deliver") ||
            (url.pathname.startsWith("/api/forms") && req.method !== "GET");
          // 임시 비밀번호 상태에서는 내 정보 확인만 허용한다 (비밀번호 변경은 /api/auth)
          req.user = await authService.requireUser(req, adminOnly, {
            allowPasswordChange: url.pathname === "/api/account/me",
          });
          // 문서 단위 API 는 한 곳에서 접근 권한을 확인한다 (권한이 없으면 존재 여부도 알리지 않는다)
          const target = /^\/api\/jobs\/([^/]+)(?:\/|$)/.exec(url.pathname);
          if (target && target[1] !== "search") {
            const job = await formJobService.get(decodeURIComponent(target[1]));
            if (!canAccess(req.user, job))
              throw AppError.notFound("작업을 찾을 수 없습니다.");
          }
        }
        // 업로드한 원본 파일(문서 확인 화면의 미리보기용). 작업 id 로만 접근하며 경로를 직접 받지 않는다.
        const fileRoute =
          req.method === "GET" &&
          /^\/api\/jobs\/([^/]+)\/file$/.exec(url.pathname);
        if (fileRoute) {
          const job = await formJobService
            .get(decodeURIComponent(fileRoute[1]))
            .catch(() => null);
          if (job && serveFile(config.storage.inputDir, job.storedName, res))
            return;
          sendJson(res, 404, {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "원본 파일을 찾을 수 없습니다.",
            },
          });
          return;
        }
        if (!(await router.handle(req, res, url))) {
          sendJson(res, 404, {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `API 없음: ${req.method} ${url.pathname}`,
            },
          });
        }
        return;
      }
      // TextSense 가 http:// 로 입력 파일을 가져갈 수 있게 한다. (FORMREADER_PUBLIC_URL 설정 시에만 활성화)
      if (
        config.publicUrl &&
        req.method === "GET" &&
        url.pathname.startsWith("/files/input/")
      ) {
        res.setHeader("Cache-Control", "no-store");
        const name = url.pathname.slice("/files/input/".length);
        if (!verifyInputFile(config, name, url.searchParams.get("token")))
          throw new AppError(
            403,
            "FORBIDDEN",
            "유효한 문서 접근 권한이 없습니다.",
          );
        if (serveFile(config.storage.inputDir, name, res)) {
          log.info(`입력 파일 전달: ${name} → ${req.socket.remoteAddress}`);
          return;
        }
        res.writeHead(404);
        res.end();
        return;
      }
      if (
        ["/login", "/signup", "/setup", "/auth.html"].includes(url.pathname) &&
        req.method === "GET"
      ) {
        res.setHeader("Cache-Control", "no-store");
        if (await authService.session(req)) {
          res.writeHead(302, { Location: "/" });
          res.end();
          return;
        }
        serveStatic(config.webDir, "/auth.html", res);
        return;
      }
      if (["/", "/index.html"].includes(url.pathname) && req.method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        if (!(await authService.session(req))) {
          res.writeHead(302, {
            Location: authService.hasAdmin() ? "/login" : "/setup",
          });
          res.end();
          return;
        }
      }
      if (req.method === "GET" && serveStatic(config.webDir, url.pathname, res))
        return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } catch (err) {
      log.error("요청 처리 오류", err);
      if (!res.headersSent)
        sendJson(res, err instanceof AppError ? err.status : 500, {
          ok: false,
          error: {
            code: err.code || "INTERNAL_ERROR",
            message:
              err instanceof AppError
                ? err.message
                : "요청을 처리하지 못했습니다.",
          },
        });
    }
  });

  const sweep = () =>
    formJobService
      .sweepDiscarded()
      .catch((e) => log.warn("결과 파일 정리 실패", e.message));
  let sweepTimer = null;

  // 내장 FTP 수신기 (TextSense 가 결과 JSON 을 업로드할 대상). 수신 폴더 = 결과를 읽는 폴더
  let ftpReceiver = null;
  if (config.ftp.enabled) {
    if (!config.ftp.publicHost)
      throw new Error(
        "FTP_ENABLED=true 이면 FORMREADER_PUBLIC_URL 또는 FTP_PUBLIC_HOST 가 필요합니다. (TextSense 서버가 접속할 이 PC 의 주소)",
      );
    if (!config.ftp.password)
      config.ftp.password = crypto.randomBytes(9).toString("hex");
    ftpReceiver = new FtpReceiver({
      ...config.ftp,
      dir: config.storage.outputDir,
      log: createLogger("ftp"),
      onStored: sweep,
    });
  }

  const start = async () => {
    const resumable = await workspaceService.recover();
    if (ftpReceiver) {
      config.ftp.port = await ftpReceiver.start();
      log.info(
        `FTP 수신기 시작: 포트 ${config.ftp.port}, 패시브 ${config.ftp.pasvMin}-${config.ftp.pasvMax}, 저장 폴더 ${config.storage.outputDir}`,
      );
    }
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, () => {
        const { port } = server.address();
        config.httpPort = port; // port=0(임의 포트)일 때도 TextSense 에 알려줄 실제 포트
        resolve(port);
      });
    });
    try {
      await authService.init(port);
    } catch (e) {
      await new Promise((resolve) => server.close(resolve));
      if (ftpReceiver) await ftpReceiver.stop();
      throw e;
    }
    log.info(`TextSense 시작: http://localhost:${port}`);
    await sweep(); // 앱이 꺼진 동안 도착한 결과 정리
    sweepTimer = setInterval(sweep, config.orphanSweepMs);
    sweepTimer.unref();
    // 결과를 받을 포트가 모두 열린 뒤에 이어서 처리한다
    for (const id of resumable) formJobService.launch(id);
    return port;
  };
  const stop = async () => {
    clearInterval(sweepTimer);
    await formJobService.idle();
    await workspaceService.close();
    if (ftpReceiver) await ftpReceiver.stop();
    await new Promise((r) => server.close(() => r()));
    formTemplateService.close();
    formJobService.close();
    authService.close();
  };

  return { config, server, start, stop, services: deps };
}

module.exports = { createApp };

if (require.main === module) {
  createApp()
    .start()
    .catch((err) => {
      console.error("시작 실패:", err.message);
      process.exit(1);
    });
}
