// The employee's page was drawn once, from what the server had when it was
// opened, and then stood still. A day the office marked, a request decided, a
// punch read off the reader an hour later - none of it arrived until somebody
// thought to reload, and nobody thinks to reload.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'") { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* ---- what counts as "something changed" ----
   The signature is the whole point: a page that redraws every minute whether
   or not anything happened is a page that moves under the hand of whoever is
   typing into it. */
{
  const ctx = { console, JSON, Object,
    viewRole: { role: 'employee', name: 'Asha' },
    RECORDS: [{ e: 'Asha', d: '2026-10-29', in: '09:52', st: 'PR' },
              { e: 'Ravi', d: '2026-10-29', in: '09:10', st: 'PR' }],
    overrides: {}, manualRecords: {}, halfDays: {}, lateExcuses: {}, earlyExcuses: {},
    leaveRequests: [{ id: 'r1', empName: 'Asha', status: 'pending', updatedAt: 'x' }] };
  vm.createContext(ctx);
  vm.runInContext(grab(APP, 'empSyncSig'), ctx);

  const first = ctx.empSyncSig();
  check('the same data twice reads the same',
    ctx.empSyncSig() === first);

  /* Somebody else's day changing is not news to this page. */
  vm.runInContext("RECORDS[1].in = '10:30';", ctx);
  check('another person’s row is not a change to their page',
    ctx.empSyncSig() === first);

  vm.runInContext("RECORDS[0].out = '18:30';", ctx);
  check('but their own row is', ctx.empSyncSig() !== first);

  const second = ctx.empSyncSig();
  vm.runInContext("lateExcuses['Asha|2026-10-29'] = { note: 'client call', by: 'self' };", ctx);
  check('a mark the office or they made against their own day is a change',
    ctx.empSyncSig() !== second);

  const third = ctx.empSyncSig();
  vm.runInContext("lateExcuses['Ravi|2026-10-29'] = { note: 'x' };", ctx);
  check('and a mark against somebody else is not',
    ctx.empSyncSig() === third);

  const fourth = ctx.empSyncSig();
  vm.runInContext("leaveRequests[0].status = 'approved';", ctx);
  check('a decision on what they asked for is a change',
    ctx.empSyncSig() !== fourth);
}

/* ---- when it asks, and when it does not ---- */
{
  const fn = grab(APP, 'empSync');
  check('it is the employee’s page only',
    /if\(!\(viewRole && viewRole\.role === 'employee'\)\) return Promise\.resolve\(false\);/.test(fn));
  check('and never two at once',
    /if\(EMP_SYNC_BUSY\) return Promise\.resolve\(false\);/.test(fn));
  /* A browser holding edits of its own keeps them: adopting the server's copy
     over the top is a different path, with its own merge. */
  check('a copy with edits of its own is not overwritten',
    fn.indexOf("DATASET_SOURCE === 'server'") > -1);
  check('the marks their page is drawn from are read again, not only the dataset',
    ['loadOverrides', 'loadManualRecords', 'loadHalfDays', 'loadLateExcuses',
     'loadLeaveRequests', 'loadOfficialLeaves'].every(n => fn.indexOf(n) > -1));
  check('one loader failing does not stop the rest',
    /var safe = function\(fn\)\{[\s\S]{0,200}catch\(function\(\)\{\}\)/.test(fn));
  check('the screen is redrawn only when something changed',
    /var changed = empSyncSig\(\) !== before;\s*if\(changed\)\{/.test(fn));
  check('and a quiet check says nothing either way',
    fn.indexOf('if(!quiet) showUploadStatus') > -1);
  check('a server that cannot be reached says so rather than looking up to date',
    fn.indexOf('Could not reach the server just now.') > -1);

  const wire = APP.slice(APP.indexOf("var b = document.getElementById('empSyncBtn');"),
                         APP.indexOf("var btn = document.getElementById('empCalOptsBtn');"));
  check('there is a button to check at once',
    APP.indexOf('id="empSyncBtn"') > -1 && wire.indexOf('empSync(false)') > -1);
  check('it checks on its own every minute',
    /setInterval\(function\(\)\{[\s\S]{0,200}empSync\(true\);\s*\}, 60000\)/.test(wire));
  /* A page nobody is looking at does not need to ask, and a phone in a pocket
     should not spend its battery on it. */
  check('but only while the tab is in front',
    wire.indexOf("document.visibilityState !== 'visible'") > -1);
  check('and it checks again on coming back to the tab',
    /visibilitychange[\s\S]{0,220}Date\.now\(\) - EMP_SYNC_AT > 60000/.test(wire));
  check('the button says how long ago it last asked',
    /function empSyncLabel\(\)[\s\S]{0,320}min ago/.test(APP));
}

/* ---- the switch ---- */
{
  check('it can be turned off, and is on until it is',
    /localStorage\.getItem\('hw_emp_live'\) !== '0'/.test(APP));
  check('the switch is on the same gear as the rest of the day settings',
    APP.indexOf('id="empOptLive"') > -1
    && APP.indexOf('Check for anything new on its own') > -1);
  check('and is remembered between visits',
    APP.indexOf("localStorage.setItem('hw_emp_live'") > -1);
  check('turning it on checks at once rather than waiting a minute',
    /EMP_LIVE = live\.checked;[\s\S]{0,200}if\(EMP_LIVE\) empSync\(true\);/.test(APP));
  check('and the panel says what it will and will not do',
    APP.indexOf('redrawn only when something has actually changed') > -1);
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
