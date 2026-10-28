// Somebody who resigned could only be deleted, and deleting did two wrong
// things at once: it threw away the attendance rows that are the whole reason
// to keep a record, and it did not stick - the roster is rebuilt from the
// server on the next page load, and every dataset save set is_active = TRUE on
// everybody in the payload, so the next save put them straight back.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* ---- the flag is never set back on by an ordinary save ---- */
{
  /* The upsert the dataset save runs, as it stands. */
  const m = /INSERT INTO employees \(org_id, code, name, shift, is_active\)[\s\S]{0,400}?`/.exec(SRV);
  check('the dataset save still upserts employees', !!m);
  const sql = m ? m[0] : '';
  check('and no longer forces everybody active on the way through',
    !/is_active = TRUE/.test(sql), sql.slice(0, 200));
  check('it leaves the flag alone unless the payload carries one',
    /is_active = COALESCE\(\$6, employees\.is_active\)/.test(sql), sql.slice(0, 260));

  /* The other two upserts must not undo it either. */
  const all = SRV.match(/INSERT INTO employees[\s\S]{0,320}?`/g) || [];
  check('no employee upsert anywhere turns the flag back on',
    all.every(s => !/is_active = TRUE/.test(s)), all.filter(s => /is_active = TRUE/.test(s)));
  check('and the auto-import still only adds people it has never seen',
    all.some(s => /ON CONFLICT \(org_id, name\) DO NOTHING/.test(s)));
}

/* ---- what the flag is read by ----
   Every read of the roster already asked for the active ones, which is why a
   flag is all this needs: the person comes off every screen at once. */
{
  /* Whole SELECTs, so the column list is in view as well as the WHERE. */
  const reads = (SRV.match(/SELECT[^;]{0,220}?FROM employees WHERE org_id = \$1[^\n]*/g) || []);
  check('there are several reads of the roster', reads.length >= 5, reads.length);
  /* Everything that acts on today - who to write about, who to count - takes
     the active ones. This is what makes a flag enough. */
  const filtered = reads.filter(r => /is_active = TRUE|AND is_active\b/.test(r));
  check('the daily message asks for the active ones',
    reads.some(r => /SELECT name FROM employees WHERE org_id = \$1 AND is_active ORDER BY/.test(r)));
  check('and so does the count of how many people there are',
    reads.some(r => /count\(\*\) FROM employees WHERE org_id = \$1 AND is_active/.test(r)));
  /* The three that take everybody, each for a stated reason: the backup, so
     nothing is lost; the office's dataset, so the page can write back a roster
     that still names a leaver; and the list of who has left. */
  const everybody = reads.filter(r => !/is_active = TRUE|AND is_active\b/.test(r));
  check('the backup takes everybody, and carries the flag',
    everybody.some(r => /SELECT code, name, shift, is_active FROM employees WHERE org_id = \$1'/.test(r)));
  check('the office’s dataset takes everybody, and carries the flag',
    everybody.some(r => /SELECT code, name, shift, is_active FROM employees WHERE org_id = \$1 ORDER BY id/.test(r)));
  check('and the leavers list asks for the other side of the flag',
    /WHERE org_id = \$1 AND is_active = FALSE/.test(SRV));
  check('no read takes everybody without saying so in its columns',
    everybody.every(r => /is_active/.test(r)), everybody.filter(r => !/is_active/.test(r)));
  check('and every read is one or the other',
    filtered.length + everybody.length === reads.length);
}

/* ---- marking somebody as left, and the way back ---- */
{
  check('there is a way to set it', /app\.post\('\/api\/employees\/left'/.test(SRV));
  check('and a way to see who it was set on', /app\.get\('\/api\/employees\/left'/.test(SRV));
  check('only a full admin may set it',
    /app\.post\('\/api\/employees\/left', requireRole\('admin'\)/.test(SRV));
  check('a view admin may still read the list',
    /app\.get\('\/api\/employees\/left', requireRole\('admin', 'admin_view'\)/.test(SRV));
  check('the list asks for the inactive ones',
    /WHERE org_id = \$1 AND is_active = FALSE/.test(SRV));
  /* It is a flag, not a deletion: nothing in the route touches a row. */
  const route = /app\.post\('\/api\/employees\/left'[\s\S]*?\n\}\);/.exec(SRV)[0];
  check('marking somebody as left deletes nothing',
    !/DELETE/i.test(route), route.match(/DELETE[^\n]*/i));
  check('it only moves the flag',
    /UPDATE employees SET is_active = \$1 WHERE org_id = \$2 AND name = \$3/.test(route));
  check('a name that is not on the roster is refused rather than silently ignored',
    /no_such_employee/.test(route));
  check('and the change is written to the history like any other',
    /addHistory\(/.test(route) && /'employees'/.test(route));
}

/* ---- the page offers the right thing ---- */
{
  check('the picker can mark somebody as having left',
    /function markEmployeeLeft\(name\)/.test(APP));
  check('and it asks the server rather than editing the page',
    /\/api\/employees\/left/.test(APP));
  /* The old behaviour, kept for the case it was right for: a bad import adds
     people who were never employees, and those have no attendance at all. */
  check('deleting outright is still there for somebody with no attendance',
    /if\(mine\) markEmployeeLeft\(name\); else deleteEmployee\(name\);/.test(APP));
  check('and the button says which of the two it is about to do',
    /btn\.textContent = mine \? 'Has left\?' : 'Delete\?';/.test(APP));
  check('"Delete + N rows?" is no longer offered for somebody with a record',
    !/'Delete \+ ' \+ mine \+ ' rows\?'/.test(APP));
  check('there is a way back', /data-back-emp=/.test(APP) && /Bring back/.test(APP));
  /* The page holds everybody and a flag, so who has left is read off what it
     already has rather than kept as a second list that can drift from it. */
  check('who has left is read off the roster the page holds',
    /function leavers\(\)/.test(APP) && /ALL_EMPLOYEES\|\|\[\]\)\.filter\(function\(e\)\{ return !stillHere\(e\); \}\)/.test(APP));
}

/* ---- the page keeps everybody, and shows those still here ----
   Handing the page only the active ones meant a browser backup carried a
   leaver's attendance rows with no row on the roster to say whose they were. */
{
  check('the dataset route hands the office everybody now',
    /SELECT code, name, shift, is_active FROM employees WHERE org_id = \$1 ORDER BY id/.test(SRV));
  check('and still hands an employee only themselves, and only while they are here',
    /AND is_active = TRUE\s+AND name = \(SELECT name FROM users WHERE id = \$2\)/.test(SRV));
  check('the page keeps the whole roster', /var ALL_EMPLOYEES =/.test(APP));
  check('and builds its screens from those still here',
    /var EMPLOYEES = ALL_EMPLOYEES\.filter\(stillHere\)/.test(APP));
  check('a row with no flag on it counts as still here',
    /function stillHere\(e\)\{ return !!e && e\.is_active !== false; \}/.test(APP));
  /* The trap: writing the dataset back from the filtered list would drop the
     leaver's row for good, on the next save after they left. */
  check('what the page writes back is everybody',
    /var dataset = \{employees:ALL_EMPLOYEES, records:RECORDS\}/.test(APP));
  check('and nothing round-trips the filtered list into the dataset',
    !/applyDataset\(\{employees:EMPLOYEES,/.test(APP));
  check('a name is looked up against everybody, so a leaver’s shift still resolves',
    /ALL_EMPLOYEES\.forEach\(function\(e\)\{ employeesByName\[e\.name\] = e; \}\)/.test(APP));
  /* A real delete is still a real delete. */
  check('deleting outright takes them off the whole roster',
    /ALL_EMPLOYEES = \(ALL_EMPLOYEES\|\|\[\]\)\.filter\(function\(e\)\{ return e\.name !== name; \}\)/.test(APP));
}

/* ---- the rule the whole thing rests on ----
   A leaver's attendance is never touched, so the figures for the months they
   worked are unchanged and every backup still holds them. */
{
  const mark = /function markEmployeeLeft\(name\)[\s\S]*?\n  \}/.exec(APP)[0];
  check('marking somebody as left drops no records on the page either',
    !/RECORDS\s*=/.test(mark), mark.match(/RECORDS[^\n]*/));
  const del = /function deleteEmployee\(name\)[\s\S]*?\n  \}/.exec(APP)[0];
  check('whereas deleting still does, which is why it is kept for the other case',
    /RECORDS\s*=\s*\(RECORDS\|\|\[\]\)\.filter/.test(del));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
