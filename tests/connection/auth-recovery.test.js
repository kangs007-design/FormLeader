"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { createApp } = require("../../src/server");
const { createConfig } = require("../../src/common/app.config");
const {
  restoreRecentCredential,
} = require("../../src/features/auth/auth-recovery.service");
process.env.FORMREADER_SKIP_DOTENV = "1";
process.env.FORMREADER_SILENT = "1";
test("모드 전환으로 갈라진 동일 계정은 최신 비밀번호로 복구하고 기존 ID·권한을 보존한다", async () => {
  const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "formreader-auth-repair-"),
    ),
    apps = [];
  const email = "owner@recovery.example.test",
    older = "Older-test-password-2026!",
    recent = "Recent-test-password-2026!";
  async function setup(name, password) {
    const dir = path.join(root, name),
      app = createApp(
        createConfig({
          port: 0,
          dataDir: dir,
          storage: {
            inputDir: path.join(dir, "input"),
            outputDir: path.join(dir, "output"),
          },
          ftp: { enabled: false },
        }),
      );
    apps.push(app);
    const port = await app.start();
    const req = async (url, body, cookie = "") => {
      const response = await fetch(`http://localhost:${port}${url}`, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: `http://localhost:${port}`,
          "X-Requested-With": "TextSense",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        body: await response.json(),
        cookie: response.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; "),
      };
    };
    const created = await req("/api/account/setup", {
      name: "계정 소유자",
      email,
      password,
    });
    assert.equal(created.status, 200);
    return { dir, req, id: created.body.data.user.id, app };
  }
  try {
    const live = await setup("live", older),
      mock = await setup("mock", recent);
    const oldSession = await live.req("/api/auth/sign-in/email", {
      email,
      password: older,
    });
    assert.equal(oldSession.status, 200);
    assert.equal(
      (await live.req("/api/auth/sign-in/email", { email, password: recent }))
        .status,
      401,
    );
    const options = {
      sourcePath: path.join(mock.dir, "auth.sqlite"),
      targetPath: path.join(live.dir, "auth.sqlite"),
      email,
      backupPath: path.join(root, "auth-before-repair.sqlite"),
    };
    const repaired = await restoreRecentCredential(options);
    assert.equal(repaired.restored, true);
    assert.equal(repaired.userId, live.id);
    assert.ok(fs.existsSync(options.backupPath));
    assert.equal(
      (await live.req("/api/account/me", undefined, oldSession.cookie)).status,
      401,
    );
    const login = await live.req("/api/auth/sign-in/email", {
      email,
      password: recent,
    });
    assert.equal(login.status, 200);
    const me = await live.req("/api/account/me", undefined, login.cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.id, live.id);
    assert.equal(me.body.data.user.role, "admin");
    assert.equal(
      (await live.req("/api/auth/sign-in/email", { email, password: older }))
        .status,
      401,
    );
    assert.equal(
      (await mock.req("/api/auth/sign-in/email", { email, password: recent }))
        .status,
      200,
    );
    assert.equal((await restoreRecentCredential(options)).alreadyCurrent, true);
    await assert.rejects(
      restoreRecentCredential({ ...options, email: "missing@example.test" }),
      /동일한 이메일/,
    );
  } finally {
    for (const app of apps) await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
