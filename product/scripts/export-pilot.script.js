'use strict';
// Run on the Pilot/build workstation; the closed-network runtime needs no Node.js.
// Export templates and versions only. Credentials, settings and files are excluded.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function exportPilot(source, output) {
  const sourcePath = path.resolve(source);
  const outputPath = path.resolve(output);
  if (!fs.existsSync(sourcePath)) throw new Error('Pilot workspace.sqlite 파일을 찾을 수 없습니다.');
  if (fs.existsSync(outputPath)) throw new Error('출력 파일이 이미 있습니다. 새 경로를 지정하세요.');
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare("SELECT collection,id,data FROM records WHERE collection IN ('form-templates','form-versions') ORDER BY rowid").all();
    const hex = (value) => `CONVERT(0x${Buffer.from(value, 'utf8').toString('hex')} USING utf8mb4)`;
    const sql = ['-- Pilot templates and versions. Import into an EMPTY product database after V001.',
      '-- No accounts, settings, jobs, sessions, samples or document files are included.',
      '-- Stop the product WAS during import. Any duplicate key must abort the import.',
      'SET NAMES utf8mb4;', 'START TRANSACTION;'];
    for (const row of rows) {
      const item = JSON.parse(row.data);
      if (!row.collection || !row.id || item.id !== row.id) throw new Error('Pilot 레코드의 ID가 일치하지 않습니다.');
      sql.push(`INSERT INTO fr_records(collection,id,payload) VALUES(${hex(row.collection)},${hex(row.id)},${hex(row.data)});`);
    }
    sql.push('COMMIT;', '');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, sql.join('\n'), { flag: 'wx', mode: 0o600 });
    return rows.length;
  } finally { database.close(); }
}
if (require.main === module) {
  try {
    const [, , source, output] = process.argv;
    if (!source || !output) throw new Error('사용법: node product/scripts/export-pilot.script.js <workspace.sqlite> <새 export.sql>');
    console.log(`${exportPilot(source, output)}개 레코드를 내보냈습니다. 계정·세션·원본 파일은 별도 이전 대상입니다.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { exportPilot };
