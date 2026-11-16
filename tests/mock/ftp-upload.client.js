'use strict';
/**
 * 테스트용 최소 FTP 업로드 클라이언트 (TextSense 가 ftp:// outputUri 로 업로드하는 동작 재현)
 * 순서: USER → PASS → TYPE I → EPSV/PASV → STOR → 데이터 전송 → 226 확인
 */
const net = require('net');

function createReader(sock) {
  let buf = '';
  const waiters = [];
  const lines = [];
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    flush();
  });
  const flush = () => { while (waiters.length && lines.length) waiters.shift()(lines.shift()); };
  /** 다중 라인 응답(211-...)까지 읽고 마지막 줄 반환 */
  const reply = async () => {
    for (;;) {
      const line = await new Promise((resolve, reject) => { waiters.push(resolve); sock.once('error', reject); flush(); });
      if (/^\d{3} /.test(line)) return { code: parseInt(line.slice(0, 3), 10), line };
    }
  };
  return { reply };
}

/**
 * @param uri ftp://user:pass@host:port/name.json
 * @param data Buffer
 * @param opts.mode 'pasv' | 'epsv'
 */
async function uploadViaFtp(uri, data, { mode = 'epsv' } = {}) {
  const u = new URL(uri);
  const name = decodeURIComponent(u.pathname.split('/').pop());
  const ctrl = net.connect({ host: u.hostname, port: Number(u.port || 21) });
  await new Promise((resolve, reject) => { ctrl.once('connect', resolve); ctrl.once('error', reject); });
  const { reply } = createReader(ctrl);
  const cmd = async (line, expect) => {
    ctrl.write(`${line}\r\n`);
    const r = await reply();
    if (expect && !expect.includes(r.code)) throw new Error(`FTP ${line.split(' ')[0]} 실패: ${r.line}`);
    return r;
  };
  try {
    const hello = await reply();
    if (hello.code !== 220) throw new Error(`FTP 접속 실패: ${hello.line}`);
    await cmd(`USER ${decodeURIComponent(u.username)}`, [331, 230]);
    await cmd(`PASS ${decodeURIComponent(u.password)}`, [230]);
    await cmd('TYPE I', [200]);

    let port;
    if (mode === 'epsv') {
      port = Number(/\(\|\|\|(\d+)\|\)/.exec((await cmd('EPSV', [229])).line)[1]);
    } else {
      const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec((await cmd('PASV', [227])).line);
      port = Number(m[5]) * 256 + Number(m[6]);
    }
    const data$ = net.connect({ host: u.hostname, port });
    await new Promise((resolve, reject) => { data$.once('connect', resolve); data$.once('error', reject); });

    ctrl.write(`STOR ${name}\r\n`);
    const start = await reply();
    if (start.code !== 150 && start.code !== 125) { data$.destroy(); throw new Error(`FTP STOR 실패: ${start.line}`); }
    data$.end(data);
    const done = await reply();
    if (done.code !== 226) throw new Error(`FTP 전송 실패: ${done.line}`);
    await cmd('QUIT');
  } finally { ctrl.destroy(); }
}

module.exports = { uploadViaFtp };
