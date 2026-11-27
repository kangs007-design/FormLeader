'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function signInputFile(config, fileName, validMs = config.jobTimeoutMs) {
  const expires = Date.now() + Math.max(15 * 60 * 1000, validMs + 60000);
  const signature = crypto.createHmac('sha256', config.fileAccessSecret).update(`${fileName}:${expires}`).digest('hex');
  return `${expires}.${signature}`;
}

function verifyInputFile(config, fileName, token) {
  if (typeof token !== 'string' || !/^\d+\.[a-f0-9]{64}$/.test(token)) return false;
  const [expires, signature] = token.split('.');
  if (Number(expires) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', config.fileAccessSecret).update(`${fileName}:${expires}`).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
module.exports = { signInputFile, verifyInputFile };

/** 앱이 관리하는 저장 폴더 안의 파일 하나를 삭제 (없으면 무시, 폴더 밖 경로는 거부) */
function removeManagedFile(dir, name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name || '') || name.includes('..')) return;
  const base = path.resolve(dir);
  const target = path.resolve(base, name);
  if (!target.startsWith(base + path.sep)) throw new Error('관리 저장소 밖의 파일입니다.');
  try { fs.unlinkSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
module.exports.removeManagedFile = removeManagedFile;
