'use strict';
// Explicit file paths work on Windows and on supported Node versions without shell glob expansion.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const suites = process.argv.includes('--unit') ? ['unit'] : ['unit', 'connection'];
const files = suites.flatMap((suite) => fs.readdirSync(path.join(root, 'tests', suite)).filter((file) => file.endsWith('.test.js')).map((file) => path.join(root, 'tests', suite, file)));
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (run.error) { console.error(run.error.message); process.exit(1); }
process.exit(run.status === null ? 1 : run.status);
