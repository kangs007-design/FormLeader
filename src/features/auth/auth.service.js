'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { AppError } = require('../../common/app.error');

const PUBLIC_COLUMNS = 'id, name, email, department, role, status, createdAt, updatedAt';
/** 임시 비밀번호: 헷갈리는 글자(0/O, 1/l/I)를 뺀 14자 */
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const createTempPassword = () => Array.from({ length: 14 }, () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)]).join('');
const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

class AuthService {
  constructor(config) {
    this.config = config;
    this.setupQueue = Promise.resolve();
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Startup reports failures; also consume this promise if no request is waiting yet.
    this.ready.catch(() => {});
  }

  async init(port) {
    try {
      const [{ betterAuth }, { createAuthMiddleware, APIError }, { getMigrations }, node] = await Promise.all([
        import('better-auth'), import('better-auth/api'), import('better-auth/db/migration'), import('better-auth/node'),
      ]);
      this.fromNodeHeaders = node.fromNodeHeaders;
      this.hashPassword = (await import('better-auth/crypto')).hashPassword;
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      const secretPath = path.join(this.config.dataDir, '.auth-secret');
      let secret = this.config.auth.secret;
      if (!secret) {
        try { fs.writeFileSync(secretPath, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
        secret = fs.readFileSync(secretPath, 'utf8').trim();
      }
      if (secret.length < 32) throw new Error('AUTH_SECRET은 32자 이상이어야 합니다.');
      this.db = new Database(path.join(this.config.dataDir, 'auth.sqlite'));
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      const baseURL = this.config.auth.baseURL || `http://localhost:${port}`;
      this.origins = new Set([baseURL, `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
      for (const entries of Object.values(os.networkInterfaces())) for (const network of entries || []) {
        if (network.family === 'IPv4' && !network.internal) this.origins.add(`http://${network.address}:${port}`);
      }
      this.auth = betterAuth({
        appName: 'TextSense', baseURL, secret, database: this.db, trustedOrigins: [...this.origins], logger: { disabled: true },
        emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 128 },
        session: { expiresIn: 8 * 60 * 60, updateAge: 30 * 60, cookieCache: { enabled: false } },
        user: { additionalFields: {
          role: { type: 'string', defaultValue: 'user', input: false },
          status: { type: 'string', defaultValue: 'pending', input: false },
          department: { type: 'string', defaultValue: '', input: true },
        } },
        rateLimit: { enabled: true, storage: 'database', window: 60, max: 30, customRules: { '/sign-in/email': { window: 60, max: 8 }, '/sign-up/email': { window: 60, max: 5 } } },
        advanced: { cookiePrefix: 'textsense', useSecureCookies: new URL(baseURL).protocol === 'https:' },
        hooks: { before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === '/change-password' && ctx.body?.newPassword === ctx.body?.currentPassword) {
            throw new APIError('BAD_REQUEST', { code: 'SAME_PASSWORD', message: '새 비밀번호는 현재 비밀번호와 달라야 합니다.' });
          }
          if (ctx.path === '/sign-up/email') {
            if (!this.hasAdmin() && ctx.request) throw new APIError('FORBIDDEN', { message: '먼저 서버 PC에서 최초 관리자 계정을 설정해 주세요.' });
            // 라이브러리는 이미 있는 이메일에도 성공처럼 응답하므로 여기서 먼저 알려 준다 (사내망 전용 서비스)
            if (typeof ctx.body?.email === 'string' && this.findByEmail(ctx.body.email.trim())) throw new APIError('UNPROCESSABLE_ENTITY', { code: 'USER_ALREADY_EXISTS', message: '이미 가입했거나 가입 신청한 이메일입니다.' });
            if (typeof ctx.body?.name !== 'string' || !ctx.body.name.trim() || ctx.body.name.length > 80) throw new APIError('BAD_REQUEST', { message: '이름은 1~80자로 입력해 주세요.' });
            if (ctx.body.department && (typeof ctx.body.department !== 'string' || ctx.body.department.length > 100)) throw new APIError('BAD_REQUEST', { message: '소속은 100자 이내로 입력해 주세요.' });
          }
        }) },
        databaseHooks: {
          user: { create: { before: async (user) => ({ data: { ...user, name: user.name.trim(), department: (user.department || '').trim(), role: 'user', status: 'pending' } }) } },
          session: { create: { before: async (session) => {
            const user = this.db.prepare('SELECT status FROM user WHERE id = ?').get(session.userId);
            if (!user || user.status !== 'active') throw new APIError('FORBIDDEN', { message: user?.status === 'pending' ? '관리자 승인을 기다리고 있습니다. 승인 후 다시 로그인해 주세요.' : '비활성화된 계정입니다. 관리자에게 문의해 주세요.' });
            return { data: session };
          } } },
        },
      });
      const { runMigrations } = await getMigrations(this.auth.options);
      await runMigrations();
      // 비밀번호 초기화 기록. 현재 비밀번호가 tempHash 와 같으면 아직 바꾸지 않은 상태다.
      this.db.exec('CREATE TABLE IF NOT EXISTS password_reset (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, actorId TEXT NOT NULL, tempHash TEXT NOT NULL, createdAt TEXT NOT NULL)');
      this.nodeHandler = node.toNodeHandler(this.auth);
      this.resolveReady();
    } catch (e) { this.rejectReady(e); if (this.db?.open) this.db.close(); throw e; }
  }

  hasAdmin() { return !!this.db.prepare("SELECT id FROM user WHERE role = 'admin' AND status = 'active' LIMIT 1").get(); }
  publicUser(id) { return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM user WHERE id = ?`).get(id) || null; }

  checkWrite(req) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    if (!this.origins.has(req.headers.origin) || req.headers['x-requested-with'] !== 'TextSense') throw new AppError(403, 'INVALID_ORIGIN', '허용되지 않은 요청입니다. 페이지를 새로 열어 다시 시도해 주세요.');
  }

  async session(req) {
    await this.ready;
    const session = await this.auth.api.getSession({ headers: this.fromNodeHeaders(req.headers) });
    if (!session) return null;
    const user = this.publicUser(session.user.id);
    return user && user.status === 'active' ? { user, session: session.session } : null;
  }

  async requireUser(req, adminOnly = false, { allowPasswordChange = false } = {}) {
    const session = await this.session(req);
    if (!session) throw new AppError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    if (!allowPasswordChange && this.mustChangePassword(session.user.id)) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '임시 비밀번호를 새 비밀번호로 바꾼 뒤 이용해 주세요.');
    if (adminOnly && session.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '관리자만 이용할 수 있습니다.');
    return session.user;
  }

  async setup(req, input) {
    this.checkWrite(req);
    let hostname;
    try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch (_) { hostname = ''; }
    if (!isLoopback(req.socket.remoteAddress) || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new AppError(403, 'LOCAL_SETUP_ONLY', '최초 관리자 설정은 서버 PC의 localhost에서 진행해 주세요.');
    const run = this.setupQueue.then(async () => {
      if (this.hasAdmin()) throw AppError.badRequest('최초 관리자 설정이 이미 완료되었습니다.');
      const response = await this.auth.api.signUpEmail({ body: { name: input?.name, email: input?.email, password: input?.password, department: input?.department || '' } });
      if (!response.user?.id) throw AppError.badRequest('관리자 계정을 만들지 못했습니다. 입력 정보를 확인해 주세요.');
      this.db.prepare("UPDATE user SET role = 'admin', status = 'active' WHERE id = ?").run(response.user.id);
      return { user: this.publicUser(response.user.id) };
    });
    this.setupQueue = run.catch(() => {});
    return run.catch((e) => { if (e instanceof AppError) throw e; throw new AppError(e.statusCode || 400, e.body?.code || 'SETUP_FAILED', e.body?.message || e.message || '관리자 계정 생성에 실패했습니다.'); });
  }

  listUsers() { return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM user ORDER BY createdAt DESC`).all(); }

  updateUser(actor, id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw AppError.badRequest('사용자 변경 요청이 올바르지 않습니다.');
    if (!['user', 'admin'].includes(input.role) || !['pending', 'active', 'disabled'].includes(input.status)) throw AppError.badRequest('권한 또는 계정 상태가 올바르지 않습니다.');
    return this.db.transaction(() => {
      const target = this.publicUser(id);
      if (!target) throw AppError.notFound('사용자를 찾을 수 없습니다.');
      if (actor.id === id && (input.role !== target.role || input.status !== target.status)) throw AppError.badRequest('본인 계정의 권한이나 상태는 변경할 수 없습니다.');
      if (target.role === 'admin' && target.status === 'active' && (input.role !== 'admin' || input.status !== 'active')) {
        const count = this.db.prepare("SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND status = 'active'").get().count;
        if (count <= 1) throw AppError.badRequest('최소 한 명의 활성 관리자가 필요합니다.');
      }
      this.db.prepare('UPDATE user SET role = ?, status = ?, updatedAt = ? WHERE id = ?').run(input.role, input.status, Date.now(), id);
      if (target.role !== input.role || target.status !== input.status) this.db.prepare('DELETE FROM session WHERE userId = ?').run(id);
      return this.publicUser(id);
    })();
  }

  mustChangePassword(userId) {
    return !!this.db.prepare("SELECT 1 FROM password_reset r JOIN account a ON a.userId = r.userId AND a.providerId = 'credential' WHERE r.userId = ? AND a.password = r.tempHash").get(userId);
  }

  /** 임시 비밀번호로 바꾸고 그 사용자의 로그인을 모두 끊는다. 임시 비밀번호는 반환값으로 한 번만 알 수 있다. */
  async resetPassword(actorId, userId) {
    if (actorId === userId) throw AppError.badRequest('본인 비밀번호는 "내 계정"에서 변경해 주세요.');
    const target = this.publicUser(userId);
    if (!target) throw AppError.notFound('사용자를 찾을 수 없습니다.');
    const temporaryPassword = createTempPassword();
    const hash = await this.hashPassword(temporaryPassword);
    this.db.transaction(() => {
      const now = new Date().toISOString();
      const changed = this.db.prepare("UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'").run(hash, now, userId).changes;
      if (!changed) throw AppError.badRequest('비밀번호 로그인 계정이 아닙니다.');
      this.db.prepare('DELETE FROM session WHERE userId = ?').run(userId);
      this.db.prepare('INSERT INTO password_reset (userId, actorId, tempHash, createdAt) VALUES (?, ?, ?, ?)').run(userId, actorId, hash, now);
    })();
    return { id: userId, email: target.email, name: target.name, temporaryPassword };
  }

  findByEmail(email) { return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM user WHERE lower(email) = lower(?)`).get(String(email || '')) || null; }

  close() { if (this.db?.open) this.db.close(); }
}
module.exports = { AuthService };
