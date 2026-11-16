'use strict';
/** 공통: ID 생성 / 파일명 정리 */
const crypto = require('crypto');

/** prefix + 시각 + 랜덤 (예: job_20250925103000_a1b2c3) */
function createId(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

/** 경로 조작(../) 및 특수문자를 막기 위한 안전한 파일명 */
function toSafeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  const cleaned = base.replace(/[^\w.\-가-힣]/g, '_').replace(/^\.+/, '');
  return cleaned || 'file';
}

module.exports = { createId, toSafeFileName };
