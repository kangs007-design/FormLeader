'use strict';
/**
 * 공통: 결과 수신 전용 초소형 FTP 서버 (외부 패키지 없음)
 *
 * TextSense 는 outputUri 에 ftp://user:pass@host:port/파일.json 을 주면 결과 파일을 그 서버로 업로드한다.
 * 이 서버는 그 업로드(STOR)만 받아 지정한 폴더에 저장한다. (다운로드/삭제/목록은 허용하지 않음)
 *
 * 보안: 인증 필수(타이밍 안전 비교), 파일명은 [A-Za-z0-9_.-] 만 허용(경로 이동 불가),
 *       업로드 크기 제한, 유휴 타임아웃. 내부망에서만 사용할 것.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const SAFE_NAME = /^[A-Za-z0-9_.\-]+$/;

class FtpReceiver {
  /**
   * @param {{dir:string, user:string, password:string, port?:number, pasvMin?:number, pasvMax?:number,
   *          maxBytes?:number, idleMs?:number, log?:object}} opts  pasvMin/Max 가 0 이면 임의 포트
   */
  constructor({ dir, user, password, port = 2121, pasvMin = 0, pasvMax = 0, maxBytes = 500 * 1024 * 1024, idleMs = 120000, log = null }) {
    Object.assign(this, { dir, user, password, port, pasvMin, pasvMax, maxBytes, idleMs });
    this.log = log || { info() {}, warn() {}, error() {}, debug() {} };
    this.server = net.createServer((s) => this._onConnection(s));
    this.sockets = new Set();
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** 패시브 모드용 데이터 포트 listen (범위 안에서 빈 포트 탐색) */
  _listenPassive(server) {
    const tryPort = (p) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, () => { server.removeListener('error', reject); resolve(server.address().port); }); });
    return (async () => {
      if (!this.pasvMin || !this.pasvMax) return tryPort(0);
      const span = this.pasvMax - this.pasvMin + 1;
      const start = Math.floor(Math.random() * span);
      for (let i = 0; i < span; i++) {
        try { return await tryPort(this.pasvMin + ((start + i) % span)); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
      }
      throw new Error('사용 가능한 패시브 포트가 없습니다.');
    })();
  }

  _onConnection(sock) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    sock.setTimeout(this.idleMs, () => sock.destroy());
    sock.setEncoding('utf8');

    const st = { user: null, authed: false, pasv: null };
    const send = (code, text) => { if (!sock.destroyed) { this.log.debug && this.log.debug('->', code, text); sock.write(`${code} ${text}\r\n`); } };
    const closePasv = () => { if (st.pasv) { st.pasv.server.close(); clearTimeout(st.pasv.timer); st.pasv = null; } };
    sock.on('close', closePasv);

    const openPasv = async () => {
      closePasv();
      const server = net.createServer();
      const entry = { server, socket: null, waiters: [] };
      server.on('connection', (ds) => {
        ds.on('error', () => {});
        if (entry.socket) return ds.destroy();
        entry.socket = ds;
        entry.waiters.splice(0).forEach((w) => w(ds));
      });
      const port = await this._listenPassive(server);
      entry.port = port;
      entry.timer = setTimeout(closePasv, 60000);
      st.pasv = entry;
      return port;
    };

    /** 패시브 데이터 연결 대기 (이미 접속돼 있으면 즉시) */
    const getDataSocket = () => new Promise((resolve) => {
      const e = st.pasv;
      if (!e) return resolve(null);
      if (e.socket) return resolve(e.socket);
      const t = setTimeout(() => resolve(null), 20000);
      e.waiters.push((ds) => { clearTimeout(t); resolve(ds); });
    });

    const handlers = {
      USER: (arg) => { st.user = arg; st.authed = false; send(331, 'Password required'); },
      PASS: (arg) => {
        if (st.user !== null && safeEqual(st.user, this.user) && safeEqual(arg, this.password)) { st.authed = true; send(230, 'Logged in'); }
        else { this.log.warn('FTP 로그인 실패'); send(530, 'Login incorrect'); }
      },
      QUIT: () => { send(221, 'Bye'); sock.end(); },
      SYST: () => send(215, 'UNIX Type: L8'),
      FEAT: () => sock.write('211-Features:\r\n EPSV\r\n SIZE\r\n UTF8\r\n211 End\r\n'),
      OPTS: () => send(200, 'OK'),
      NOOP: () => send(200, 'OK'),
    };
    const authedHandlers = {
      PWD: () => send(257, '"/" is current directory'),
      XPWD: () => send(257, '"/" is current directory'),
      CWD: () => send(250, 'OK'), XCWD: () => send(250, 'OK'), CDUP: () => send(250, 'OK'),
      TYPE: () => send(200, 'Type set'), MODE: () => send(200, 'OK'), STRU: () => send(200, 'OK'), ALLO: () => send(200, 'OK'),
      MKD: (arg) => send(257, `"${String(arg).replace(/"/g, '""')}" created`), XMKD: (arg) => send(257, `"${String(arg).replace(/"/g, '""')}" created`),
      PORT: () => send(502, 'Active mode not supported'), EPRT: () => send(502, 'Active mode not supported'),
      DELE: () => send(550, 'Not permitted'), RETR: () => send(550, 'Not permitted'), RMD: () => send(550, 'Not permitted'),
      SIZE: (arg) => {
        const name = path.basename(String(arg));
        const file = SAFE_NAME.test(name) ? path.join(this.dir, name) : null;
        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) send(213, String(fs.statSync(file).size)); else send(550, 'No such file');
      },
      PASV: async () => {
        try {
          const port = await openPasv();
          const ip = String(sock.localAddress || '127.0.0.1').replace(/^::ffff:/, '');
          if (!net.isIPv4(ip)) return send(425, 'PASV requires IPv4 (use EPSV)');
          send(227, `Entering Passive Mode (${ip.split('.').join(',')},${port >> 8},${port & 255})`);
        } catch (e) { send(421, 'Cannot open passive port'); }
      },
      EPSV: async () => {
        try { send(229, `Entering Extended Passive Mode (|||${await openPasv()}|)`); } catch (e) { send(421, 'Cannot open passive port'); }
      },
      LIST: async () => listEmpty(), NLST: async () => listEmpty(), MLSD: async () => listEmpty(),
      STOR: (arg) => store(arg, false), APPE: (arg) => store(arg, true),
    };

    const listEmpty = async () => {
      if (!st.pasv) return send(425, 'Use PASV first');
      send(150, 'Opening data connection');
      const ds = await getDataSocket();
      closePasv();
      if (!ds) return send(425, 'Data connection failed');
      ds.end(); send(226, 'Done');
    };

    const store = async (arg, append) => {
      const name = path.basename(String(arg || '').replace(/\\/g, '/'));
      if (!SAFE_NAME.test(name) || name.startsWith('.')) return send(553, 'File name not allowed');
      if (!st.pasv) return send(425, 'Use PASV first');
      send(150, 'Opening data connection');
      const ds = await getDataSocket();
      closePasv();
      if (!ds) return send(425, 'Data connection failed');

      const target = path.join(this.dir, name);
      const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
      const out = fs.createWriteStream(tmp);
      let bytes = 0; let failed = false;
      const fail = (code, msg) => { if (failed) return; failed = true; ds.destroy(); out.destroy(); fs.rm(tmp, { force: true }, () => {}); send(code, msg); };
      ds.on('data', (chunk) => { bytes += chunk.length; if (bytes > this.maxBytes) return fail(552, 'Exceeded size limit'); out.write(chunk); });
      ds.on('error', () => fail(426, 'Connection closed'));
      let ended = false;
      const flushed = new Promise((resolve) => out.once('close', resolve)); // 파일 쓰기가 모두 끝나고 닫힌 시점
      await new Promise((resolve) => {
        ds.on('end', () => { ended = true; out.end(); resolve(); });
        ds.on('close', () => resolve());
      });
      if (failed) return;
      if (!ended) return fail(426, 'Connection closed before end of data'); // 중간에 끊긴 전송은 저장하지 않음
      await flushed; // 쓰기 완료 전에 rename 하면 파일이 잘린다
      try {
        if (append && fs.existsSync(target)) fs.appendFileSync(target, fs.readFileSync(tmp)); else fs.renameSync(tmp, target);
        fs.rmSync(tmp, { force: true });
        this.log.info(`FTP 수신 완료: ${name} (${bytes} bytes)`);
        send(226, 'Transfer complete');
      } catch (e) { send(451, 'Local error'); }
    };

    // 명령은 한 번에 하나씩 순서대로 처리 (STOR 가 끝나기 전에 다음 명령을 처리하지 않음)
    let queue = Promise.resolve();
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 8192) return sock.destroy(); // 비정상적으로 긴 입력
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        queue = queue.then(() => {
          this.log.debug && this.log.debug('<-', line.replace(/^(PASS)\s.*/i, '$1 ****')); // 비밀번호는 로그에 남기지 않음
          const sp = line.indexOf(' ');
          const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
          const arg = sp < 0 ? '' : line.slice(sp + 1);
          const fn = handlers[cmd] || (st.authed ? authedHandlers[cmd] : null);
          if (fn) return fn(arg);
          return send(authedHandlers[cmd] && !st.authed ? 530 : 502, authedHandlers[cmd] ? 'Please login' : 'Command not implemented');
        }).catch(() => send(451, 'Internal error'));
      }
    });
    send(220, 'DigitalLeader FTP receiver ready');
  }
}

module.exports = { FtpReceiver };
