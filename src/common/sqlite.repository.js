"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/** Shared workspace database. Legacy JSON is imported once and retained as a backup. */
class SqliteRepository {
  constructor(legacyPath) {
    this.filePath = legacyPath;
    this.collection = path.basename(legacyPath, ".json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    this.db = new Database(
      path.join(path.dirname(legacyPath), "workspace.sqlite"),
    );
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    this.db.transaction(() => {
      if (
        this.db
          .prepare("SELECT name FROM migrations WHERE name=?")
          .get(this.collection)
      )
        return;
      const items = fs.existsSync(legacyPath)
        ? JSON.parse(fs.readFileSync(legacyPath, "utf8") || "[]")
        : [];
      if (!Array.isArray(items))
        throw new Error(
          `이전 저장소 형식이 올바르지 않습니다: ${this.collection}`,
        );
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO records VALUES (?,?,?)",
      );
      for (const item of items)
        insert.run(this.collection, item.id, JSON.stringify(item));
      this.db
        .prepare("INSERT INTO migrations VALUES (?,?)")
        .run(this.collection, new Date().toISOString());
    })();
  }
  async list() {
    return this.db
      .prepare("SELECT data FROM records WHERE collection=? ORDER BY rowid")
      .all(this.collection)
      .map((r) => JSON.parse(r.data));
  }
  async get(id) {
    const r = this.db
      .prepare("SELECT data FROM records WHERE collection=? AND id=?")
      .get(this.collection, id);
    return r ? JSON.parse(r.data) : null;
  }
  async insert(item) {
    this.db
      .prepare("INSERT INTO records VALUES (?,?,?)")
      .run(this.collection, item.id, JSON.stringify(item));
    return item;
  }
  async update(id, patch) {
    return this.db.transaction(() => {
      const r = this.db
        .prepare("SELECT data FROM records WHERE collection=? AND id=?")
        .get(this.collection, id);
      if (!r) return null;
      const next = { ...JSON.parse(r.data), ...patch };
      this.db
        .prepare("UPDATE records SET data=? WHERE collection=? AND id=?")
        .run(JSON.stringify(next), this.collection, id);
      return next;
    })();
  }
  async remove(id) {
    return (
      this.db
        .prepare("DELETE FROM records WHERE collection=? AND id=?")
        .run(this.collection, id).changes > 0
    );
  }
  async clear() {
    this.db
      .prepare("DELETE FROM records WHERE collection=?")
      .run(this.collection);
  }
  close() {
    if (this.db.open) this.db.close();
  }
}
module.exports = { SqliteRepository };
