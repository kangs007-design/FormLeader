'use strict';
/**
 * 공통: JSON HTTP 클라이언트 (타임아웃 포함)
 * textsense.py 의 http.client 호출과 동일한 방식 (POST + Content-Type: application/json)
 */
const http = require('http');
const { AppError } = require('./app.error');

function requestJson({ host, port, path, method = 'GET', body, timeoutMs = 15000, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host, port, path, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) { /* JSON 아님 */ }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(AppError.timeout(`요청 시간 초과 (${timeoutMs}ms): ${host}:${port}${path}`)));
    req.on('error', (err) => {
      if (err instanceof AppError) return reject(err);
      reject(AppError.upstream(`연결 실패: ${host}:${port} (${err.code || err.message})`, { code: err.code }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { requestJson };
