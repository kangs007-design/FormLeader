'use strict';
/**
 * 공통: JSON 파일 저장소 (컬렉션 1개 = 파일 1개)
 * - 쓰기는 임시파일 → rename 으로 원자적으로 처리
 * - 동시 쓰기는 Promise 체인으로 직렬화
 */
const fs = require('fs');
const path = require('path');

class JsonFileRepository {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  _readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    const text = fs.readFileSync(this.filePath, 'utf8');
    if (!text.trim()) return [];
    return JSON.parse(text);
  }

  _writeAll(items) {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /** 읽기-수정-쓰기를 직렬화해서 실행 */
  _mutate(fn) {
    const run = this.queue.then(() => {
      const items = this._readAll();
      const result = fn(items);
      this._writeAll(items);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async list() { await this.queue; return this._readAll(); }
  async get(id) { return (await this.list()).find((i) => i.id === id) || null; }
  insert(item) { return this._mutate((items) => { items.push(item); return item; }); }

  update(id, patch) {
    return this._mutate((items) => {
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) return null;
      items[idx] = { ...items[idx], ...patch };
      return items[idx];
    });
  }

  remove(id) {
    return this._mutate((items) => {
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) return false;
      items.splice(idx, 1);
      return true;
    });
  }
}

module.exports = { JsonFileRepository };
