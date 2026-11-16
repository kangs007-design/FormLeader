'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { FtpReceiver } = require('../../src/common/ftp-receiver.server');
const { uploadViaFtp } = require('../mock/ftp-upload.client');

async function withReceiver(opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-'));
  const sub = path.join(dir, 'out');
  const rx = new FtpReceiver({ dir: sub, user: 'formreader', password: 'p@ss:w/rd#1', port: 0, ...opts });
  const port = await rx.start();
  try { await fn({ rx, port, dir: sub, root: dir, uri: (name) => `ftp://formreader:${encodeURIComponent('p@ss:w/rd#1')}@127.0.0.1:${port}/${name}` }); }
  finally { await rx.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('EPSV / PASV 두 방식으로 업로드되고 내용이 그대로 저장된다 (특수문자 비밀번호 포함)', async () => {
  await withReceiver({}, async ({ uri, dir }) => {
    const data = Buffer.from(JSON.stringify({ 한글: '결과', n: 1 }));
    await uploadViaFtp(uri('a.json'), data, { mode: 'epsv' });
    await uploadViaFtp(uri('b.json'), data, { mode: 'pasv' });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'a.json')), data);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'b.json')), data);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.json', 'b.json']); // 임시(.part) 파일이 남지 않음
  });
});

test('큰 파일(5MB)도 손실 없이 저장', async () => {
  await withReceiver({}, async ({ uri, dir }) => {
    const data = Buffer.alloc(5 * 1024 * 1024, 'x');
    await uploadViaFtp(uri('big.json'), data);
    assert.equal(fs.statSync(path.join(dir, 'big.json')).size, data.length);
  });
});

test('패시브 포트 범위를 지정하면 그 범위 안의 포트를 사용', async () => {
  const base = 45000 + Math.floor(Math.random() * 1000);
  await withReceiver({ pasvMin: base, pasvMax: base + 5 }, async ({ port, dir }) => {
    const sock = net.connect(port, '127.0.0.1');
    const lines = [];
    sock.setEncoding('utf8').on('data', (d) => lines.push(d));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(100);
    sock.write('USER formreader\r\nPASS p@ss:w/rd#1\r\nEPSV\r\n');
    await wait(300);
    const m = /\(\|\|\|(\d+)\|\)/.exec(lines.join(''));
    sock.destroy();
    assert.ok(m, lines.join(''));
    assert.ok(Number(m[1]) >= base && Number(m[1]) <= base + 5);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('잘못된 비밀번호/사용자는 거부', async () => {
  await withReceiver({}, async ({ port, dir }) => {
    await assert.rejects(uploadViaFtp(`ftp://formreader:wrong@127.0.0.1:${port}/x.json`, Buffer.from('{}')), /PASS 실패.*530/);
    await assert.rejects(uploadViaFtp(`ftp://admin:${encodeURIComponent('p@ss:w/rd#1')}@127.0.0.1:${port}/x.json`, Buffer.from('{}')), /PASS 실패.*530/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('경로 이동(../)·숨김 파일명은 폴더 밖에 쓰이지 않는다', async () => {
  await withReceiver({}, async ({ uri, dir, root }) => {
    await uploadViaFtp(uri('..%2F..%2Fevil.json'), Buffer.from('{}')); // basename 으로만 저장
    assert.deepEqual(fs.readdirSync(dir), ['evil.json']);
    assert.deepEqual(fs.readdirSync(root), ['out']);
    await assert.rejects(uploadViaFtp(uri('.hidden'), Buffer.from('{}')), /STOR 실패.*553/);
    await assert.rejects(uploadViaFtp(uri('a%20b.json'), Buffer.from('{}')), /STOR 실패.*553/);
  });
});

test('로그인 전에는 업로드/조회 명령이 거부된다', async () => {
  await withReceiver({}, async ({ port }) => {
    const sock = net.connect(port, '127.0.0.1');
    let out = '';
    sock.setEncoding('utf8').on('data', (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 100));
    sock.write('STOR a.json\r\nPASV\r\nPWD\r\n');
    await new Promise((r) => setTimeout(r, 200));
    sock.destroy();
    assert.equal((out.match(/^530 /gm) || []).length, 3);
  });
});

test('크기 제한 초과 시 업로드 실패하고 파일이 남지 않는다', async () => {
  await withReceiver({ maxBytes: 1024 }, async ({ uri, dir }) => {
    await assert.rejects(uploadViaFtp(uri('big.json'), Buffer.alloc(100 * 1024, 'x')), /전송 실패|STOR|ECONNRESET|EPIPE|이미|read|write/i);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('덮어쓰기: 같은 이름 재업로드 시 최신 내용', async () => {
  await withReceiver({}, async ({ uri, dir }) => {
    await uploadViaFtp(uri('r.json'), Buffer.from('{"v":1}'));
    await uploadViaFtp(uri('r.json'), Buffer.from('{"v":2}'));
    assert.equal(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'), '{"v":2}');
  });
});

// 참고: FTP 스트림 모드는 데이터 연결의 정상 종료(FIN)가 곧 "전송 끝" 이므로 FIN 절단은 구분할 수 없다.
// 네트워크 단절처럼 비정상(RST) 종료된 전송만 감지해 부분 파일을 버린다.
test('전송이 비정상(RST) 종료되면 부분 파일을 저장하지 않는다', async () => {
  await withReceiver({}, async ({ port, dir }) => {
    const ctrl = net.connect(port, '127.0.0.1');
    let out = '';
    ctrl.setEncoding('utf8').on('data', (d) => { out += d; });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(100);
    ctrl.write('USER formreader\r\nPASS p@ss:w/rd#1\r\nEPSV\r\n');
    await wait(300);
    const dport = Number(/\(\|\|\|(\d+)\|\)/.exec(out)[1]);
    const data = net.connect(dport, '127.0.0.1');
    await new Promise((r) => data.once('connect', r));
    ctrl.write('STOR cut.json\r\n');
    await wait(200);
    data.write(Buffer.alloc(100000, 'x'));
    await wait(100);
    data.resetAndDestroy(); // RST 로 끊김 (네트워크 단절)
    await wait(300);
    ctrl.destroy();
    assert.match(out, /426 /);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
