// npm test: every *.test.js here that runs without a database, one after another.
// api.test.js is left out - it needs a real Postgres and seeded accounts
// (npm run test:api).
'use strict';
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js') && f !== 'api.test.js')
  .sort();
let failed = [];
for (const f of files) {
  console.log('\n=== ' + f);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', timeout: 180000 });
  if (r.status !== 0) failed.push(f);
}
console.log('\n' + (failed.length ? ('FAILED: ' + failed.join(', ')) : ('all ' + files.length + ' test files passed')));
process.exitCode = failed.length ? 1 : 0;
