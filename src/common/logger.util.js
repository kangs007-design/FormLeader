'use strict';
/** 공통: 간단한 로거 (타임스탬프 + 레벨 + 모듈명) */

function format(level, scope, args) {
  const ts = new Date().toISOString();
  return [`[${ts}] [${level}] [${scope}]`, ...args];
}

function createLogger(scope, { silent = false } = {}) {
  const noop = () => {};
  if (silent || process.env.FORMREADER_SILENT === '1') {
    return { info: noop, warn: noop, error: noop, debug: noop };
  }
  return {
    info: (...a) => console.log(...format('INFO', scope, a)),
    warn: (...a) => console.warn(...format('WARN', scope, a)),
    error: (...a) => console.error(...format('ERROR', scope, a)),
    debug: (...a) => { if (process.env.DEBUG) console.log(...format('DEBUG', scope, a)); },
  };
}

module.exports = { createLogger };
