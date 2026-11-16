'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../../src/server');
const { createConfig } = require('../../src/common/app.config');
const { signInputFile, verifyInputFile } = require('../../src/common/file-access.util');
process.env.FORMREADER_SKIP_DOTENV = '1';
process.env.FORMREADER_SILENT = '1';
const password = 'Isolated-test-password-2026';

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textsense-auth-'));
  const app = createApp(createConfig({ port: 0, dataDir: dir, ftp: { enabled: false }, storage: { inputDir: path.join(dir, 'input'), outputDir: path.join(dir, 'output') } }));
  const port = await app.start();
  const request = (method, url, body, cookie = '', origin = `http://localhost:${port}`, requestedWith = 'TextSense') => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Origin: origin, 'X-Requested-With': requestedWith, Cookie: cookie, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { let data = null; try { data = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, data, text, cookie: (res.headers['set-cookie'] || []).map((value) => value.split(';')[0]).join('; ') }); });
    });
    req.on('error', reject); req.end(payload);
  });
  const setup = async () => {
    const response = await request('POST', '/api/account/setup', { name: '관리자', email: 'admin@example.test', password });
    assert.equal(response.status, 200, response.text);
    const login = await request('POST', '/api/auth/sign-in/email', { email: 'admin@example.test', password });
    assert.equal(login.status, 200, login.text);
    return { user: response.data.data.user, cookie: login.cookie };
  };
  return { app, port, dir, request, setup, async close() { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('인증 전 문서·결과·사용자 API는 차단되고 최초 설정은 한 번만 가능하다', async () => {
  const env = await fixture();
  try {
    assert.equal((await env.request('GET', '/api/jobs')).status, 401);
    assert.equal((await env.request('GET', '/api/jobs/missing/file')).status, 401);
    assert.equal((await env.request('GET', '/api/users')).status, 401);
    assert.equal((await env.request('GET', '/')).headers.location, '/setup');
    const publicSignup = await env.request('POST', '/api/auth/sign-up/email', { name: '공개 가입', email: 'first@example.test', password });
    assert.equal(publicSignup.status, 403);
    const admin = await env.setup();
    assert.equal(admin.user.role, 'admin'); assert.equal(admin.user.status, 'active');
    assert.equal((await env.request('POST', '/api/account/setup', { name: '다른 관리자', email: 'other@example.test', password })).status, 400);
    assert.equal((await env.request('GET', '/')).headers.location, '/login');
    const me = await env.request('GET', '/api/account/me', undefined, admin.cookie);
    assert.equal(me.data.data.user.email, 'admin@example.test');
    assert.equal(JSON.stringify(me.data).includes('password'), false);
  } finally { await env.close(); }
});

test('가입은 승인 대기로 저장되며 승인 전 로그인과 사용자 권한 주입을 차단한다', async () => {
  const env = await fixture();
  try {
    const admin = await env.setup();
    const signup = await env.request('POST', '/api/auth/sign-up/email', { name: '구성원', email: 'member@example.test', password, department: '개발팀', role: 'admin', status: 'active' });
    assert.equal(signup.status, 200, signup.text);
    assert.equal(signup.data.user.role, 'user'); assert.equal(signup.data.user.status, 'pending');
    assert.equal(signup.cookie, '');
    const pendingLogin = await env.request('POST', '/api/auth/sign-in/email', { email: 'member@example.test', password });
    assert.equal(pendingLogin.status, 403, pendingLogin.text);
    assert.match(pendingLogin.data.message, /승인/);
    const users = await env.request('GET', '/api/users', undefined, admin.cookie);
    assert.equal(users.data.data.length, 2);
    assert.equal(JSON.stringify(users.data).includes('password'), false);
    const id = signup.data.user.id;
    assert.equal((await env.request('PUT', `/api/users/${id}`, { role: 'user', status: 'active' }, admin.cookie)).status, 200);
    const login = await env.request('POST', '/api/auth/sign-in/email', { email: 'member@example.test', password });
    assert.equal(login.status, 200, login.text);
    assert.ok(login.headers['set-cookie'].some((cookie) => /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie)));
    assert.equal((await env.request('GET', '/api/jobs', undefined, login.cookie)).status, 200);
    assert.equal((await env.request('GET', '/api/users', undefined, login.cookie)).status, 403);
    assert.equal((await env.request('POST', '/api/forms', {}, login.cookie)).status, 403);
    assert.equal((await env.request('PUT', `/api/users/${id}`, { role: 'admin', status: 'active' }, login.cookie)).status, 403);
    const hash = env.app.services.authService.db.prepare('SELECT password FROM account WHERE userId = ?').get(id).password;
    assert.notEqual(hash, password);
    assert.ok(hash.length > 64);
    await env.request('PUT', `/api/users/${id}`, { role: 'user', status: 'disabled' }, admin.cookie);
    assert.equal((await env.request('GET', '/api/jobs', undefined, login.cookie)).status, 401);
    assert.equal((await env.request('POST', '/api/auth/sign-in/email', { email: 'member@example.test', password })).status, 403);
    await env.request('PUT', `/api/users/${id}`, { role: 'user', status: 'active' }, admin.cookie);
    assert.equal((await env.request('GET', '/api/jobs', undefined, login.cookie)).status, 401);
  } finally { await env.close(); }
});

test('다른 출처의 변경 요청과 본인 관리자 권한 제거를 차단한다', async () => {
  const env = await fixture();
  try {
    const admin = await env.setup();
    assert.equal((await env.request('PUT', `/api/users/${admin.user.id}`, { role: 'user', status: 'active' }, admin.cookie)).status, 400);
    assert.equal((await env.request('PUT', `/api/users/${admin.user.id}`, { role: 'admin', status: 'disabled' }, admin.cookie)).status, 400);
    assert.equal((await env.request('POST', '/api/jobs', {}, admin.cookie, 'https://untrusted.example')).status, 403);
    assert.equal((await env.request('POST', '/api/jobs', {}, admin.cookie, `http://localhost:${env.port}`, '')).status, 403);
    assert.equal((await env.request('POST', '/api/auth/sign-in/email', { email: 'admin@example.test', password }, '', 'https://untrusted.example')).status, 403);
    const logout = await env.request('POST', '/api/auth/sign-out', {}, admin.cookie);
    assert.equal(logout.status, 200);
    assert.equal((await env.request('GET', '/api/jobs', undefined, admin.cookie)).status, 401);
  } finally { await env.close(); }
});

test('비밀번호 변경은 현재 비밀번호를 확인하고 다른 세션을 해제한다', async () => {
  const env = await fixture();
  try {
    const admin = await env.setup();
    const second = await env.request('POST', '/api/auth/sign-in/email', { email: 'admin@example.test', password });
    const body = { currentPassword: 'wrong-password', newPassword: 'Changed-test-password-2026', revokeOtherSessions: true };
    assert.notEqual((await env.request('POST', '/api/auth/change-password', body, admin.cookie)).status, 200);
    body.currentPassword = password;
    assert.equal((await env.request('POST', '/api/auth/change-password', body, admin.cookie)).status, 200);
    assert.equal((await env.request('GET', '/api/jobs', undefined, second.cookie)).status, 401);
    assert.equal((await env.request('POST', '/api/auth/sign-in/email', { email: 'admin@example.test', password })).status, 401);
    assert.equal((await env.request('POST', '/api/auth/sign-in/email', { email: 'admin@example.test', password: body.newPassword })).status, 200);
  } finally { await env.close(); }
});

test('OCR 입력 URL은 파일과 유효기간에 묶인 서명으로만 접근할 수 있다', () => {
  const config = { fileAccessSecret: Buffer.alloc(32, 7), jobTimeoutMs: 120000 };
  const token = signInputFile(config, 'sample.pdf');
  assert.equal(verifyInputFile(config, 'sample.pdf', token), true);
  assert.equal(verifyInputFile(config, 'other.pdf', token), false);
  assert.equal(verifyInputFile(config, 'sample.pdf', token.replace(/.$/, token.endsWith('0') ? '1' : '0')), false);
  assert.equal(verifyInputFile(config, 'sample.pdf', '1.' + '0'.repeat(64)), false);
  assert.equal(verifyInputFile(config, 'sample.pdf', null), false);
});
