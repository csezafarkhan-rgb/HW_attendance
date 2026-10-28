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
  const reads = (SRV.match(/SELECT[^;]{0,200}?FROM employees WHERE org_id = \$1[^\n]*/g) || []);
  check('the roster handed to the page asks for active people only',
    reads.filter(r => /is_active = TRUE/.test(r)).length >= 2, reads.length);
  /* The backup is the one read that must see everybody - that is what keeping
     their data means - and it carries the flag so a restore puts back who had
     left as well as who was here. */
  const backup = reads.filter(r => /SELECT code, name, shift, is_active FROM employees/.test(r));
  check('the backup takes everybody, and carries the flag', backup.length === 1, backup);
  const unfiltered = reads.filter(r => !/is_active/.test(r));
  check('and no read of the roster is left without the filter',
    unfiltered.length === 0, unfiltered);
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
  check('and the list of leavers is asked for, not guessed',
    /function loadLeavers\(\)/.test(APP));
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
