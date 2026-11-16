"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/** Explicit, local operator repair only. Never imports accounts automatically on login/startup. */
async function restoreRecentCredential({
  sourcePath,
  targetPath,
  email,
  backupPath,
}) {
  if (path.resolve(sourcePath) === path.resolve(targetPath))
    throw new Error("서로 다른 계정 저장소를 지정하세요.");
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  let target;
  try {
    target = new Database(targetPath, { fileMustExist: true });
    target.pragma("busy_timeout = 5000");
    const lookup = (db) =>
      db
        .prepare(
          "SELECT u.id AS userId,u.email,u.role,u.status,a.id AS accountId,a.password,a.updatedAt FROM user u JOIN account a ON a.userId=u.id WHERE lower(u.email)=lower(?) AND a.providerId='credential'",
        )
        .get(email);
    const from = lookup(source),
      to = lookup(target);
    if (!from || !to || from.email.toLowerCase() !== to.email.toLowerCase())
      throw new Error("두 저장소에 동일한 이메일의 기존 계정이 있어야 합니다.");
    if ([from, to].some((u) => u.role !== "admin" || u.status !== "active"))
      throw new Error(
        "활성 관리자 계정 사이에서만 명시적으로 복구할 수 있습니다.",
      );
    if (!from.password || !to.password)
      throw new Error("비밀번호 로그인 정보가 없습니다.");
    if (from.password === to.password)
      return { restored: false, alreadyCurrent: true, userId: to.userId };
    const time = (v) => (typeof v === "number" ? v : new Date(v).getTime());
    if (!(time(from.updatedAt) > time(to.updatedAt)))
      throw new Error(
        "최근 로그인 정보로 확인되지 않아 기존 비밀번호를 덮어쓰지 않았습니다.",
      );
    if (!backupPath || fs.existsSync(backupPath))
      throw new Error("기존 파일을 덮어쓰지 않는 새 백업 경로가 필요합니다.");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    await target.backup(backupPath);
    const now = new Date().toISOString();
    const result = target.transaction(() => {
      const changed = target
        .prepare(
          "UPDATE account SET password=?,updatedAt=? WHERE id=? AND password=?",
        )
        .run(from.password, now, to.accountId, to.password);
      if (changed.changes !== 1)
        throw new Error("복구 중 로그인 정보가 변경되어 중단했습니다.");
      target
        .prepare("UPDATE user SET updatedAt=? WHERE id=?")
        .run(now, to.userId);
      const revoked = target
        .prepare("DELETE FROM session WHERE userId=?")
        .run(to.userId).changes;
      return {
        restored: true,
        userId: to.userId,
        sessionsRevoked: revoked,
        backupPath,
      };
    })();
    return result;
  } finally {
    target?.close();
    source.close();
  }
}
module.exports = { restoreRecentCredential };
