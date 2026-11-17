'use strict';
/** 공통: JSON 파일 동기 읽기 (UTF-8). 형식이 잘못되면 JSON.parse 오류를 그대로 던진다 */
const fs = require('fs');

function readJsonFileSync(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 파일이 없거나 읽기/파싱에 실패하면 fallback 반환 */
function readJsonFileOr(file, fallback = null) {
  try { return readJsonFileSync(file); } catch (_) { return fallback; }
}

module.exports = { readJsonFileSync, readJsonFileOr };
