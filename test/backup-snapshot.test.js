// The daily JSON snapshot: it holds the data itself (not the previous backup
// as a string), an older nested snapshot still restores, and the wrapper keys
// never come back as settings. The dashboard's real functions.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

// The key lists, read from the page so the test follows them.
const listOf = name => {
  const m = new RegExp('var ' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\]);').exec(src);
  return m ? vm.runInNewContext(m[1]) : null;
};

(async () => {
  const BACKUP_KEYS = listOf('BACKUP_KEYS');
  const SKIP = listOf('BACKUP_SKIP_KEYS');
  // Every shared setting the page reads through storage.get should be in the backup.
  const read = new Set([...src.matchAll(/storage\.get\('([A-Za-z_]+)'/g)].map(m => m[1]));
  const notBacked = [...read].filter(k => BACKUP_KEYS.indexOf(k) === -1);
  check('every setting the dashboard stores is in the backup (except server status and read receipts)',
    notBacked.every(k => k === 'deviceStatus' || k === 'notifSeenAt'), notBacked);
  check('the wrapper keys of an old snapshot are never restored', ['json', 'fname', 'n'].every(k => SKIP.indexOf(k) > -1), SKIP);

  const ls = { hw_leave_hidden: '["2026-01"]', hw_side_w: '260' };
  const ctx = {
    console, JSON, Promise, RECORDS: [{ e: 'A', d: '2026-09-01' }], EMPLOYEES: [{ name: 'A' }], ALL_MONTHS: ['2026-09'],
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = v; }, removeItem: k => { delete ls[k]; } },
    buildFullBackup: () => Promise.resolve({
      json: JSON.stringify({ _type: 'ally-attendance-full-backup', data: {
        attDashboard_overrides: '{"A|2026-09-02":{"cat":"LEAVE"}}',
        attDashboard_lockedMonths: '{"2026-08":{"by":"x"}}',
        attDashboard_customDataset: '{"employees":[],"records":[]}' } }, null, 2),
      fname: 'attendance_FULL_backup.json', n: 3 })
  };
  vm.createContext(ctx);
  vm.runInContext('var BACKUP_LOCAL_KEYS = ' + JSON.stringify(listOf('BACKUP_LOCAL_KEYS')) + ';', ctx);
  vm.runInContext(lift(src, 'buildRestoreSnapshot'), ctx);
  const snap = await ctx.buildRestoreSnapshot();
  check('the snapshot holds the data keys themselves', snap.attDashboard_overrides && snap.attDashboard_lockedMonths && snap.attDashboard_customDataset, Object.keys(snap));
  check('not the previous backup wrapped as text', !('json' in snap) && !('fname' in snap) && !('n' in snap), Object.keys(snap));
  check('browser settings ride along', snap.hw_leave_hidden === '["2026-01"]' && snap.hw_side_w === '260');
  check('it is marked as a snapshot', snap._type === 'homeweavers-attendance-backup' && snap._counts.records === 1);

  // An older, nested snapshot: its data restores, the wrapper does not.
  vm.runInContext(lift(src, 'unwrapLegacySnapshot'), ctx);
  const old = {
    json: JSON.stringify({ _type: 'ally-attendance-full-backup', data: {
      attDashboard_overrides: '{"A|2026-09-03":{"cat":"LEAVE"}}',
      attDashboard_json: '"an even older backup"' } }),
    fname: 'x.json', n: 2, hw_leave_hidden: '[]', _type: 'homeweavers-attendance-backup'
  };
  const opened = ctx.unwrapLegacySnapshot(old);
  check('an old snapshot opens up to its data', opened.attDashboard_overrides && opened.hw_leave_hidden === '[]' && !('json' in opened) && !('fname' in opened), Object.keys(opened));
  check('a current snapshot is left as it is', ctx.unwrapLegacySnapshot(snap) === snap);

  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
