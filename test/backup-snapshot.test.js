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
  /* DeskTime's own key is deliberately not among them. The backup is a file
     the office downloads and keeps, and a key that opens somebody else's
     account does not belong in it: losing it to a restore costs one paste,
     and the alternative costs rather more. */
  const NOT_BACKED = ['deviceStatus', 'notifSeenAt', 'perfAlertsSeen', 'alertsCleared', 'deskTimeKey'];
  check('every setting the dashboard stores is in the backup (except server status, read receipts and the DeskTime key)',
    notBacked.every(k => NOT_BACKED.indexOf(k) > -1), notBacked);
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

  /* ---- a backup holds everything the office has ----
   The list of keys to back up was written out by hand, so every feature added
   since - the mail settings among them - was quietly left out of every backup
   taken, and a restore came back without them. The list is a floor now: what
   actually goes in is every key the store holds, which cannot fall behind the
   app. These checks are that it stays that way. */
{
  const fs = require('fs');
  const app = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

  const listed = name => {
    const m = new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];').exec(app);
    return m ? (m[1].match(/'([^']+)'/g) || []).map(x => x.slice(1, -1)) : null;
  };
  const raw = { keys: listed('BACKUP_KEYS'), skip: listed('BACKUP_SKIP_KEYS'),
                mine: listed('BACKUP_PERSONAL_KEYS') };
  check('the three lists are all there', !!raw.keys && !!raw.skip && !!raw.mine,
    Object.keys(raw).filter(k => !raw[k]));
  /* A missing list is one failure, not a cascade: the rest still report. */
  const keys = raw.keys || [], skip = raw.skip || [], mine = raw.mine || [];

  /* Every key the page saves to the store has to be one the backup takes. */
  const saved = new Set();
  const re = /storage\.set\(\s*'([A-Za-z0-9_]+)'/g;
  let m; while ((m = re.exec(app))) saved.add(m[1]);
  const missed = [...saved].filter(k => keys.indexOf(k) === -1
    && mine.indexOf(k) === -1 && skip.indexOf(k) === -1
    && k !== 'deskTimeKey');
  check('every setting the page saves is one the backup takes, bar the one secret',
    missed.length === 0, missed);
  check('and that one is a secret, kept out on purpose',
    keys.indexOf('deskTimeKey') === -1 && /storage\.set\('deskTimeKey'/.test(app));
  check('the mail settings among them, which it used to leave behind',
    keys.indexOf('mailSettings') > -1);

  /* And the list is not the whole of it: the backup asks the store what it
     actually holds, so a key added tomorrow is carried without anybody
     remembering to come back here. */
  const fn = /function backupKeyList\(\)\{[\s\S]*?\n  \}/.exec(app);
  check('the backup asks the store what it holds', !!fn
    && /HWSync\.cached/.test(fn[0]) && /BACKUP_KEYS\.slice\(\)/.test(fn[0]),
    fn && fn[0].slice(0, 90));
  check('and leaves out the restore points, which are backups of backups',
    !!fn && /BACKUP_SKIP_KEYS\.indexOf/.test(fn[0]));
  check('both the file and the workbook are built from that one list',
    (app.match(/backupKeyList\(\)/g) || []).length >= 3,
    (app.match(/backupKeyList\(\)/g) || []).length);

  /* What belongs to one account goes back to that account. Written shared, a
     restore would hand everybody one person's dismissed alerts. */
  check('the file says which keys were one person’s own',
    /personal:mine/.test(app.replace(/\s/g, '')) , null);
  check('and the restore puts those back as personal, not shared',
    /storage\.set\(key, text, personal\.indexOf\(key\) === -1\)/.test(app));
}

/* ---- a line is saved as it is written ----
   The card said "saved as you type" while saving only when a box was left, so
   a line typed and the tab closed was gone. And a refused save was swallowed,
   so the page said saved either way. */
{
  const fs = require('fs');
  const app = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const card = app.slice(app.indexOf('function renderEmpTasks()'),
                         app.indexOf('The two folded notes on the Leave Record'));

  check('a line saves as it is typed, not only when the box is left',
    /addEventListener\('input', soon\)/.test(card) && /setTimeout\(function\(\)\{ landed\(read\(\), false\); \}/.test(card),
    card.slice(0, 80));
  check('and the page is not redrawn mid-word, which would take the cursor away',
    /landed\(read\(\), false\)/.test(card));
  check('the notification bar says so once the server has it',
    /showUploadStatus\([^;]*saved to your work log/.test(card));
  check('a refused save is said, not swallowed',
    /did not reach the server/.test(card)
      && !/storage\.set\('dailyTasks'[\s\S]{0,120}catch\(function\(e\)\{ console\.error/.test(app),
    (/\.catch\(function\(e\)\{[^}]*\}/.exec(card) || [])[0]);
}

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
