'use strict';
const crypto = require('crypto');

function signInputFile(config, fileName) {
  const expires = Date.now() + Math.max(15 * 60 * 1000, config.jobTimeoutMs + 60000);
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
