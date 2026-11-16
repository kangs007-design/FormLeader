'use strict';
/**
 * 공통: 특정 서버로 나갈 때 사용되는 이 PC 의 주소를 알아낸다. (VPN 처럼 접속할 때마다 주소가 바뀌는 환경용)
 * UDP 소켓을 connect 만 하면 OS 라우팅 테이블이 선택한 인터페이스 주소를 알 수 있고, 실제 패킷은 전송되지 않는다.
 */
const dgram = require('dgram');

function detectLocalAddress(targetHost, targetPort = 7) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const done = (fn, v) => { try { sock.close(); } catch (_) { /* 이미 닫힘 */ } fn(v); };
    sock.once('error', (e) => done(reject, e));
    sock.connect(targetPort, targetHost, () => {
      try { done(resolve, sock.address().address); } catch (e) { done(reject, e); }
    });
  });
}

module.exports = { detectLocalAddress };
