'use strict';
/** 공통: HTTP 요청/응답 유틸 (JSON 응답, 본문 파싱, 정적 파일) */
const fs = require('fs');
const path = require('path');
const { AppError } = require('./app.error');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mjs': 'text/javascript; charset=utf-8', // pdf.js (ES module / worker) - 모듈은 JavaScript MIME 이어야 로드된다
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

/** 원본 파일 미리보기용 Content-Type (브라우저가 그대로 표시할 수 있는 형식) */
const FILE_MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readJsonBody(req, limitBytes = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return;
      size += c.length;
      if (size > limitBytes) {
        rejected = true;
        reject(AppError.badRequest('요청 본문이 너무 큽니다.'));
        return; // 소켓은 끊지 않고 나머지 데이터를 버려서 에러 응답이 전달되게 한다
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(AppError.badRequest('JSON 형식이 올바르지 않습니다.')); }
    });
    req.on('error', reject);
  });
}

/** webDir 하위 정적 파일 서빙. 처리했으면 true */
function serveStatic(webDir, urlPath, res) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (_) { return false; }
  const file = path.normalize(path.join(webDir, decoded));
  if (!file.startsWith(webDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
  res.end(data);
  return true;
}

/** dir 안의 단일 파일 전송 (파일명은 영문/숫자/_.- 만 허용, 하위경로 불가). 처리했으면 true */
function serveFile(dir, fileName, res) {
  if (!/^[A-Za-z0-9_.\-]+$/.test(fileName) || fileName.includes('..')) return false;
  const file = path.join(dir, fileName);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': FILE_MIME[path.extname(fileName).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
  return true;
}

module.exports = { sendJson, readJsonBody, serveStatic, serveFile };
