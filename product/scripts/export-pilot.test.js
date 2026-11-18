'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { exportPilot } = require('./export-pilot.script');

test('Pilot export preserves UTF-8 and SQL metacharacters, excludes settings, and never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formreader-product-export-'));
  try {
    const source = path.join(dir, 'workspace.sqlite'), output = path.join(dir, 'export.sql');
    const db = new Database(source);
    db.exec('CREATE TABLE records(collection TEXT,id TEXT,data TEXT)');
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?)');
    const payload = JSON.stringify({ id: "form_'\\;DROP TABLE anything;", name: '견적서 💡' });
    insert.run('form-templates', JSON.parse(payload).id, payload);
    insert.run('workspace-settings', 'integration', JSON.stringify({ id: 'integration', token: 'private-token' }));
    db.close();
    const before = fs.readFileSync(source);
    assert.equal(exportPilot(source, output), 1);
    const sql = fs.readFileSync(output, 'utf8');
    assert.match(sql, /START TRANSACTION/);
    assert.ok(sql.includes(Buffer.from(payload).toString('hex')));
    assert.ok(!sql.includes('DROP TABLE'));
    assert.ok(!sql.includes('private-token'));
    assert.deepEqual(fs.readFileSync(source), before);
    assert.throws(() => exportPilot(source, output), /이미/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
