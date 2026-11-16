"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { SqliteRepository } = require("../../src/common/sqlite.repository");
test("이전 JSON은 최초 한 번만 이관하고 수정·버전은 재시작 후 유지된다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "formreader-migration-")),
    file = path.join(dir, "form-jobs.json");
  let repo;
  try {
    fs.writeFileSync(file, JSON.stringify([{ id: "legacy", status: "done" }]));
    repo = new SqliteRepository(file);
    assert.equal((await repo.list()).length, 1);
    await repo.update("legacy", { status: "reviewed" });
    repo.close();
    repo = new SqliteRepository(file);
    assert.equal((await repo.get("legacy")).status, "reviewed");
    assert.equal(JSON.parse(fs.readFileSync(file))[0].status, "done");
    await repo.remove("legacy");
    repo.close();
    repo = new SqliteRepository(file);
    assert.equal((await repo.list()).length, 0);
  } finally {
    repo?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
