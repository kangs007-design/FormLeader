'use strict';
// Destructive fixture creation: run ONLY against a disposable, empty product database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const origin = process.env.PRODUCT_TEST_ORIGIN;
const setupToken = process.env.FORMREADER_SETUP_TOKEN;
const password = 'Product-smoke-password-2026';

test('Nginx → Tomcat WAR → MariaDB: stage 1', { skip: !origin || !setupToken }, async (t) => {
  async function request(method, url, body, cookie = '', headers = {}) {
    const response = await fetch(new URL(url, origin), {
      method, redirect: 'manual', headers: { Origin: origin, 'X-Requested-With': 'TextSense', Cookie: cookie,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text(); let json;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, json, text,
      cookie: response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
  }
  let admin, userId, user;
  await t.test('health, DB readiness, Nginx auth gate and local assets', async () => {
    assert.equal((await request('GET', '/api/health')).json.data.status, 'UP');
    assert.equal((await request('GET', '/api/ready')).json.data.database, 'MariaDB');
    assert.equal((await request('GET', '/')).status, 302);
    assert.equal((await request('GET', '/login')).status, 200);
    assert.match((await request('GET', '/js/main.js')).headers.get('content-type'), /javascript/);
    assert.match((await request('GET', '/vendor/pdfjs/build/pdf.min.mjs')).headers.get('content-type'), /javascript/);
    assert.match((await request('GET', '/vendor/pdfjs/wasm/openjpeg.wasm')).headers.get('content-type'), /wasm/);
    assert.equal((await request('GET', '/.env')).status, 404);
    assert.equal((await request('GET', '/api/users')).status, 401);
  });
  await t.test('setup token, exact origin and one-time setup', async () => {
    assert.equal((await request('GET', '/api/account/status')).json.data.needsSetup, true, 'Use an empty disposable DB');
    const body = { name: '제품 관리자', email: 'admin@product.example.test', password };
    assert.equal((await request('POST', '/api/account/setup', body)).status, 403);
    assert.equal((await request('POST', '/api/account/setup', body, '', { 'X-Setup-Token': setupToken, Origin: 'https://untrusted.example' })).status, 403);
    const created = await request('POST', '/api/account/setup', body, '', { 'X-Setup-Token': setupToken });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.data.user.role, 'admin');
    assert.equal((await request('POST', '/api/account/setup', body, '', { 'X-Setup-Token': setupToken })).status, 400);
    admin = await request('POST', '/api/auth/sign-in/email', { email: body.email, password });
    assert.equal(admin.status, 200, admin.text);
    assert.match(admin.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await request('GET', '/', undefined, admin.cookie)).status, 200);
    const info = await request('GET', '/api/account/me', undefined, admin.cookie);
    assert.equal(info.json.data.capabilities.ocrProcessing, false);
    assert.equal((await request('POST', '/api/jobs', {}, admin.cookie)).json.error.code, 'MIGRATION_PENDING');
  });
  await t.test('approval, role injection, authorization and session revocation', async () => {
    const pending = await request('POST', '/api/auth/sign-up/email', { name: '신청자', email: 'user@product.example.test', password, role: 'admin', status: 'active' });
    assert.equal(pending.status, 200, pending.text);
    assert.equal(pending.json.data.user.role, 'user');
    assert.equal(pending.json.data.user.status, 'pending');
    userId = pending.json.data.user.id;
    assert.equal((await request('POST', '/api/auth/sign-in/email', { email: 'user@product.example.test', password })).status, 403);
    assert.equal((await request('PUT', `/api/users/${userId}`, { role: 'user', status: 'active' }, admin.cookie)).status, 200);
    user = await request('POST', '/api/auth/sign-in/email', { email: 'user@product.example.test', password });
    assert.equal(user.status, 200, user.text);
    assert.equal((await request('GET', '/api/users', undefined, user.cookie)).status, 403);
    assert.equal((await request('POST', '/api/forms', {}, user.cookie)).status, 403);
    assert.equal((await request('PUT', `/api/users/${admin.json.data.user.id}`, { role: 'user', status: 'disabled' }, admin.cookie)).status, 400);
    assert.equal((await request('PUT', `/api/users/${userId}`, { role: 'user', status: 'disabled' }, admin.cookie)).status, 200);
    assert.equal((await request('GET', '/api/account/me', undefined, user.cookie)).status, 401);
  });
  await t.test('template CRUD, transaction rollback, concurrent versions and restore', async () => {
    const input = { name: '견적서', docType: '견적', keys: [{ name: '금액', rect: { x: 0, y: 0, w: 1, h: 1 } }], sampleId: 'pilot-sample-id' };
    const created = await request('POST', '/api/forms', input, admin.cookie);
    assert.equal(created.status, 200, created.text);
    const id = created.json.data.id;
    const updates = await Promise.all(['견적서 A', '견적서 B'].map((name) => request('PUT', `/api/forms/${id}`, { ...input, name }, admin.cookie)));
    assert.deepEqual(updates.map((r) => r.json.data.version).sort(), [2, 3]);
    assert.equal((await request('PUT', `/api/forms/${id}`, { ...input, keys: [] }, admin.cookie)).status, 400);
    const history = (await request('GET', `/api/forms/${id}/history`, undefined, admin.cookie)).json.data;
    assert.equal(history.length, 3);
    const restored = await request('POST', `/api/forms/${id}/restore`, { versionId: history[0].id }, admin.cookie);
    assert.equal(restored.json.data.version, 4);
    assert.equal(restored.json.data.name, '견적서');
    assert.equal(restored.json.data.sampleId, 'pilot-sample-id');
    assert.equal((await request('DELETE', `/api/forms/${id}`, undefined, admin.cookie)).status, 200);
    assert.equal((await request('GET', `/api/forms/${id}`, undefined, admin.cookie)).status, 404);
  });
  await t.test('password change revokes other sessions, signout revokes the current session', async () => {
    const second = await request('POST', '/api/auth/sign-in/email', { email: 'admin@product.example.test', password });
    assert.equal(second.status, 200, second.text);
    assert.equal((await request('POST', '/api/auth/change-password', { currentPassword: 'wrong-password', newPassword: password + 'new' }, admin.cookie)).status, 400);
    assert.equal((await request('POST', '/api/auth/change-password', { currentPassword: password, newPassword: password + 'new' }, admin.cookie)).status, 200);
    assert.equal((await request('GET', '/api/account/me', undefined, second.cookie)).status, 401);
    assert.equal((await request('GET', '/api/account/me', undefined, admin.cookie)).status, 200);
    const signedOut = await request('POST', '/api/auth/sign-out', {}, admin.cookie);
    assert.equal(signedOut.status, 200);
    assert.match(signedOut.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request('GET', '/api/account/me', undefined, admin.cookie)).status, 401);
  });
  await t.test('database-backed login throttle', async () => {
    let response;
    for (let i = 0; i < 9; i++) {
      response = await request('POST', '/api/auth/sign-in/email', { email: 'admin@product.example.test', password: 'wrong-password' });
      if (response.status === 429) break;
    }
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
  });
});
