'use strict';
/** 공통: 표준 에러 (HTTP status + 에러 코드) */

class AppError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
  static badRequest(message, detail) { return new AppError(400, 'BAD_REQUEST', message, detail); }
  static notFound(message) { return new AppError(404, 'NOT_FOUND', message); }
  static upstream(message, detail) { return new AppError(502, 'UPSTREAM_ERROR', message, detail); }
  static timeout(message) { return new AppError(504, 'TIMEOUT', message); }
}

module.exports = { AppError };
