// The watched folder brings the punch file in by itself: no Import button, a
// restore point either way, and anything that is not the punch file still asks.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

function makeCtx(opts) {
  const ls = Object.assign({}, opts.ls || {});
  const ctx = {
    console, Promise, Date,
    imported: [], offered: [], said: [],
    IMPORT_DIR: { name: '1_Daily Attendace file' },
    IMPORT_DIR_PERM: 'granted',
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = v; }, removeItem: k => { delete ls[k]; } },
    document: { getElementById: () => ({ style: {}, classList: { contains: () => false } }) },
    ensureDirPerm: () => Promise.resolve(true),
    renderImportFolder: () => {},
    newestImportFile: () => Promise.resolve(opts.found ? { file: opts.found } : null),
    handleUploadFile: f => ctx.imported.push(f.name),
    offerImportFile: (f, stamp) => ctx.offered.push(f.name + '|' + stamp),
    showUploadStatus: m => ctx.said.push(m),
    bkStatus: m => ctx.said.push('bk:' + m),
    ls
  };
  vm.createContext(ctx);
  vm.runInContext("var PUNCH_FILE_BASENAME = 'dailyattendancelogsdetails', IMPDIR_KEY = 'hw_impdir_seen', AUTOSYNC_KEY = 'hw_auto_sync';", ctx);
  ['autoSyncOn', 'isPunchFileName', 'checkImportFolder'].forEach(n => vm.runInContext(lift(src, n), ctx));
  return ctx;
}

const punch = { name: 'DailyAttendanceLogsDetails.csv', lastModified: 1770000000000 };
(async () => {
  let c = makeCtx({ found: punch });
  await c.checkImportFolder(true);
  check('a new punch file is imported without anyone pressing Import', c.imported.length === 1 && c.offered.length === 0, { imported: c.imported, offered: c.offered });
  check('and it is not offered again next time', c.ls['hw_impdir_seen'] === punch.name + '|' + punch.lastModified, c.ls);
  check('the person is told what came in', c.said.some(m => /DailyAttendanceLogsDetails\.csv/.test(m)), c.said);

  c = makeCtx({ found: punch, ls: { hw_impdir_seen: punch.name + '|' + punch.lastModified } });
  await c.checkImportFolder(true);
  check('the same file is not imported twice', c.imported.length === 0 && c.offered.length === 0);

  c = makeCtx({ found: { name: 'Some other export.xlsx', lastModified: 1770000000000 } });
  await c.checkImportFolder(true);
  check('any other file in the folder still asks first', c.imported.length === 0 && c.offered.length === 1, { offered: c.offered });

  c = makeCtx({ found: punch, ls: { hw_auto_sync: '0' } });
  await c.checkImportFolder(true);
  check('with automatic updates off it asks, as before', c.imported.length === 0 && c.offered.length === 1);

  c = makeCtx({ found: punch });
  c.ensureDirPerm = () => Promise.resolve(false);
  await c.checkImportFolder(true);
  check('nothing is imported while the folder permission has lapsed', c.imported.length === 0 && c.offered.length === 0);

  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
