"use strict";
/**
 * 공통: 초소형 라우터 (/api/forms/:id 형태 지원)
 * handler({ req, res, params, query, body }) 의 반환값을 { ok: true, data } 로 응답한다.
 */
const { AppError } = require("./app.error");
const { sendJson, readJsonBody } = require("./http-response.util");

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      "^" +
        pattern.replace(/:([A-Za-z_]\w*)/g, (_, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "/?$",
    );
    this.routes.push({ method, regex, keys, handler });
  }

  /** 라우트가 처리했으면 true */
  async handle(req, res, url) {
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      try {
        const body = ["POST", "PUT", "PATCH"].includes(req.method)
          ? await readJsonBody(req)
          : {};
        const data = await r.handler({
          req,
          res,
          params,
          query: Object.fromEntries(url.searchParams),
          body,
        });
        if (!res.writableEnded) sendJson(res, 200, { ok: true, data });
      } catch (err) {
        const status = err instanceof AppError ? err.status : 500;
        if (!res.headersSent)
          sendJson(res, status, {
            ok: false,
            error: {
              code: err.code || "INTERNAL_ERROR",
              message: err.message,
              detail: err.detail,
            },
          });
      }
      return true;
    }
    return false;
  }
}

module.exports = { Router };
