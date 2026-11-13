/* People who are not on attendance.
 *
 * Some names on the roster do not mark attendance at all - managers who are
 * there because they take leave and approve it, not because anybody expects
 * them to clock in. The record had no way to say so, so it treated them as
 * people who clock in and never do: a weekly reminder seven lines long,
 * every line reading "Nothing on the record", for seven ordinary working
 * days nobody ever expected them to mark.
 *
 * This is the gap in the missing-day work of 12 November. That was built for
 * somebody who forgot to clock in. It never considered somebody for whom
 * clocking in was never the arrangement.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* ---- the switch itself ---- */
const ctx = vm.createContext({ console, JSON, Object, String, Boolean });
vm.runInContext('var offAttendance = {};' + grab(APP, 'isOffAttendance'), ctx);

ctx.offAttendance = { 'Nitish Kumar': true };
check('a name on the list is not on attendance',
  ctx.isOffAttendance('Nitish Kumar') === true, null);
check('and everybody else still is',
  ctx.isOffAttendance('Rahul Mishra') === false, null);
/* Review Focus 3: a fresh org, an old cache, a store that never loaded. */
ctx.offAttendance = {};
check('an empty store means everybody is on attendance',
  ctx.isOffAttendance('Nitish Kumar') === false, null);
vm.runInContext('offAttendance = undefined;', ctx);
check('and so does no store at all, rather than throwing',
  ctx.isOffAttendance('Nitish Kumar') === false, null);
vm.runInContext('offAttendance = { "Nitish Kumar": false };', ctx);
check('a name switched back on is on attendance again',
  ctx.isOffAttendance('Nitish Kumar') === false, null);

/* ---- it is kept and loaded like the other per-person settings ---- */
check('the store is read and written like the Saturday policy beside it',
  /function loadOffAttendance\(\)\{/.test(APP) && /function saveOffAttendance\(\)\{/.test(APP)
  && /storage\.get\('offAttendance', true\)/.test(APP)
  && /storage\.set\('offAttendance', JSON\.stringify\(offAttendance\), true\)/.test(APP), null);
check('and it loads when the page does, on both paths',
  (APP.match(/loadOffAttendance\b/g) || []).length >= 3, null);
/* Keyed by name, so the server serves an employee only their own row. */
check('the server keeps it with the other name-keyed stores',
  /EMP_KEYED_BY_NAME = \[[^\]]*'offAttendance'/.test(SRV.replace(/\n/g, ' ')), null);

/* ---- off the grid ----
   Dropped where the roster is built, not where it is drawn, so the grid, the
   performance table and everything else made from visibleEmployees lose the
   column together rather than one at a time. */
{
  const ROSTER = ['Zafar Khan', 'Rahul Mishra', 'Nitish Kumar', 'Habib'];
  const c = vm.createContext({ console, JSON, Object, String, Boolean, Array });
  vm.runInContext(
    'var offAttendance = {};'
    + 'var employeeOrder = null;'
    + 'var EMPLOYEES = ' + JSON.stringify(ROSTER.map(n => ({ name: n }))) + ';'
    + 'var employeesByName = {};'
    + 'EMPLOYEES.forEach(function(e){ employeesByName[e.name] = e; });'
    + grab(APP, 'isOffAttendance') + grab(APP, 'orderedEmployees'), c);
  const names = () => c.orderedEmployees().map(e => e.name);

  check('with nobody named, the roster is untouched',
    names().join() === ROSTER.join(), names());
  vm.runInContext('offAttendance = { "Nitish Kumar": true };', c);
  check('a person not on attendance leaves the roster',
    names().join() === 'Zafar Khan,Rahul Mishra,Habib', names());
  /* Review Focus 1: a name left behind by a rename or a leaver. */
  vm.runInContext('offAttendance = { "Somebody Who Left": true };', c);
  check('a name that is not on the roster changes nothing',
    names().join() === ROSTER.join(), names());
  /* Review Focus 2: the grid must say so rather than draw a headerless table. */
  vm.runInContext('offAttendance = { "Zafar Khan": true, "Rahul Mishra": true,'
    + ' "Nitish Kumar": true, "Habib": true };', c);
  check('everybody named leaves an empty roster, not a broken one',
    names().length === 0, names());
  check('and the grid has an empty state to fall back on',
    /Select at least one month and one employee/.test(APP), null);
}

/* ---- never chased for a day ----
   Three places did the chasing: the server's reminder, the person's own
   waiting list, and the figures. All three ask the same question now. */
check('the server skips them when it walks the roster for missing days',
  /offAttendance/.test(grab(SRV, 'pendingByEmployee')), null);
check('their own waiting list does not raise days against them either',
  /isOffAttendance\(name\)/.test(grab(APP, 'ewGather')), null);

/* ---- the switch ----
   Set where the other per-person arrangements are set - the shift panel that
   already carries the Saturday policy and the display name - so there is one
   place to go for "how does this person work". */
check('each row carries the switch',
  /data-off-emp="/.test(APP), null);
check('it says what it does, before somebody tries it',
  /Not on attendance/.test(APP)
  && /never chased for a day/i.test(APP), null);
/* Saved first, redrawn after - the column goes with them, so the grid has to
   be rebuilt, and a redraw before the save would show a change that had not
   happened. A refusal puts the tick back. */
{
  const h = /data-off-emp\]'\), function\(cb\)\{[\s\S]*?\n    \}\);/.exec(APP);
  check('and setting it saves, then redraws the grid it changes',
    !!h && /saveOffAttendance\(\)/.test(h[0])
    && h[0].indexOf('saveOffAttendance()') < h[0].indexOf('renderTable()'), null);
  check('a save that fails puts the tick back rather than lying',
    !!h && /cb\.checked = !cb\.checked;/.test(h[0]), null);
}
/* A view-only admin reads the panel; it is not theirs to change. */
check('a view-only admin gets it without the switch',
  /canEdit\(\)/.test(APP), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
