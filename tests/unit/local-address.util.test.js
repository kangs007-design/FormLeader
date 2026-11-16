'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { detectLocalAddress } = require('../../src/common/local-address.util');

test('loopback 대상이면 127.0.0.1', async () => {
  assert.equal(await detectLocalAddress('127.0.0.1', 7777), '127.0.0.1');
});

test('외부 대상이면 이 PC 의 실제 인터페이스 주소 중 하나를 돌려준다 (패킷 전송 없음)', async () => {
  const mine = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4').map((i) => i.address);
  let addr;
  try { addr = await detectLocalAddress('192.0.2.1', 7777); } catch (e) { return; } // 경로가 전혀 없는 환경(네트워크 미연결)은 건너뜀
  assert.ok(mine.includes(addr), `${addr} 가 인터페이스 목록(${mine.join(',')})에 없음`);
});
