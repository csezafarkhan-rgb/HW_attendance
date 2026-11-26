/* A short leave for the day it was actually taken on.
 *
 * Somebody leaves at half past four, and remembers it the next morning. The
 * control for taking a short leave was welded to today - partDayRow returned
 * nothing for any other date - so the day they left early on was the one day
 * they could never mark. Nothing asked them about it either: an early
 * departure produced a red "left 1:52 early" on the calendar and silence.
 *
 * Now the day itself carries the control, the waiting list raises the day
 * while it can still be answered, and the server takes a named day - but only
 * one that has happened and is not yet old enough to be the office's.
 */
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
function grabVar(src, name) {
  const m = new RegExp('var ' + name + ' = [\\[{][\\s\\S]*?[\\]}];').exec(src);
  if (!m) throw new Error('not found: var ' + name);
  return m[0];
}

const NAME = 'Rahul Mishra';
const TODAY = '2026-11-26';
const back = n => {
  const d = new Date(Date.parse(TODAY + 'T00:00:00Z') - n * 86400000);
  return d.toISOString().slice(0, 10);
};

function world(over) {
  const ctx = Object.assign({
    todayISO_full: TODAY,
    empWorkingDay: () => TODAY,
    /* The page's own age helper, pinned to the fixture's today. */
    ewDaysSince: iso => Math.max(0, Math.round(
      (Date.parse(TODAY + 'T00:00:00Z') - Date.parse(iso + 'T00:00:00Z')) / 86400000)),
    isMonthLocked: () => false,
    fmtDayShortish: d => 'Wed ' + String(Number(d.slice(8, 10))) + ' Nov',
    shotEsc: s => String(s == null ? '' : s),
    halfDays: {}, overrides: {}, leavePolicy: { SHORT: 'self', HALF: 'approval' },
    hdMark: k => (k === 'SHORT' ? '¼' : '½'),
    hdLabel: k => (k === 'SHORT' ? 'Short leave' : 'Half day'),
    hdQty: k => (k === 'SHORT' ? 0.25 : 0.5),
    Date, JSON, Object, Math, String, Number, isNaN, console
  }, over || {});
  vm.createContext(ctx);
  ['takenOnOwnCard', 'partOwnWords', 'partAskWords', 'partSaid',
   'canTakePartOn', 'partDayWhen', 'partDayRow'].forEach(n => vm.runInContext(grab(APP, n), ctx));
  vm.runInContext(grabVar(APP, 'PART_SELF'), ctx);
  /* A number, not an object, so it is taken from the source on its own. */
  vm.runInContext(/var PART_BACK_DAYS = \d+;/.exec(APP)[0], ctx);
  return ctx;
}
const BACK_DAYS = Number(/var PART_BACK_DAYS = (\d+);/.exec(APP)[1]);

/* ---------------- which days are still theirs ---------------- */
{
  const ctx = world();
  ctx.PART_BACK_DAYS = BACK_DAYS;
  check('today is theirs, as it always was',
    ctx.canTakePartOn(NAME, TODAY) === true, null);
  check('and so is yesterday, which is the whole point',
    ctx.canTakePartOn(NAME, back(1)) === true, back(1));
  check('a week back is the edge of it',
    ctx.canTakePartOn(NAME, back(BACK_DAYS)) === true, back(BACK_DAYS));
  check('a day past that is the office’s to settle',
    ctx.canTakePartOn(NAME, back(BACK_DAYS + 1)) === false, back(BACK_DAYS + 1));
  check('nobody takes a day that has not happened',
    ctx.canTakePartOn(NAME, '2026-11-27') === false, null);
}
{
  const ctx = world({ isMonthLocked: () => true });
  ctx.PART_BACK_DAYS = BACK_DAYS;
  check('and a month whose pay has been run is closed to it',
    ctx.canTakePartOn(NAME, back(1)) === false, null);
}

/* ---------------- the control on a day gone by ---------------- */
{
  const ctx = world();
  ctx.PART_BACK_DAYS = BACK_DAYS;
  const y = back(1);
  const html = ctx.partDayRow(NAME, y);
  check('yesterday now carries the control it never had',
    typeof html === 'string' && html.length > 0 && html.indexOf('data-pd-kind') > -1, html);
  check('and it offers the short leave the office lets people take',
    html.indexOf('Short leave') > -1, null);
  check('named by its day rather than called today',
    html.indexOf('Taking part of Wed 25 Nov off?') > -1
      && html.indexOf('Taking part of today off?') === -1, html.slice(0, 300));
  check('a day too far back still offers nothing',
    ctx.partDayRow(NAME, back(BACK_DAYS + 1)) === '', null);

  /* Two of these can be on screen at once - the day card and the cell behind
     it - so what the wiring reads has to be found inside its own control. */
  check('the control is found by its own marks, not by an id shared with the other one',
    html.indexOf('id="edPart') === -1
      && html.indexOf('data-pd-note') > -1 && html.indexOf('data-pd-save') > -1, null);

  const t = ctx.partDayRow(NAME, TODAY);
  check('today still says today',
    t.indexOf('Taking part of today off?') > -1, t.slice(0, 200));
}
{
  /* An office that asks for a short leave to be requested offers none of this. */
  const ctx = world({ leavePolicy: { SHORT: 'approval', HALF: 'approval' } });
  ctx.PART_BACK_DAYS = BACK_DAYS;
  check('an office that has people ask is not overruled by any of it',
    ctx.partDayRow(NAME, back(1)) === '', null);
}

/* ---------------- the wiring sends the day, and one control at a time ---- */
{
  const w = grab(APP, 'wirePartDay');
  check('what is sent carries the day it is for',
    /body: JSON\.stringify\(\{ kind: kind, half: half, message: note, day: day \}\)/.test(w), null);
  check('and the control is read inside the root it was drawn in',
    /root\.querySelector\('\[data-pd-kind\]'\)/.test(w)
      && /root\.querySelector\('\[data-pd-save\]'\)/.test(w)
      && !/document\.getElementById\('edPart/.test(w), null);
  check('the words follow the day rather than saying today for all of them',
    /var when = partDayWhen\(day\);/.test(w)
      && /taken for ' \+ when \+ '/.test(w), null);
  check('and a refusal about the day itself is said in words',
    /too_old/.test(w) && /not_yet/.test(w), null);
  check('the calendar cell draws it and wires it to that cell’s day',
    /wirePartDay\(modalBody, name, dateStr/.test(APP)
      && /var pdHtml = ownCard \? partDayRow\(name, dateStr\) : '';/.test(APP), null);
  check('and only on the person’s own card, never on somebody reading theirs',
    /var ownCard = !!\(viewRole && viewRole\.role === 'employee' && viewRole\.name === name\);/.test(APP), null);
}

/* ---------------- and the day is raised before they have to remember ---- */
{
  const g = grab(APP, 'ewGather');
  check('a day they left early on with nothing said is raised',
    /job:'early', day:d, mins:l\.early/.test(g), null);
  check('but not today, whose afternoon has not happened yet',
    /if\(d < mineDay\r?\n?[\s\S]{0,80}l\.early > \(earlyThresholdMin \|\| 10\)/.test(g), null);
  check('nor one already answered, by them or by the office',
    /!getEarlyExcuse\(name, d\) && !getHalfDay\(name, d\)/.test(g), null);
  check('nor one too old to answer, which would be a reproach not a reminder',
    /&& canTakePartOn\(name, d\)/.test(g), null);
  check('and a day cannot be raised as both late and early',
    /return;\s+\/\/ one day, one thing to answer/.test(g), null);
  check('the band offers the one press that settles it',
    /data-ew-part="/.test(APP) && /Take a short leave/.test(APP), null);
  check('which opens the day itself, so there is one control and not two',
    /openReadOnlyDetail\(\(viewRole && viewRole\.name\) \|\| '', b\.getAttribute\('data-ew-part'\)\)/.test(APP), null);
}

/* ---------------- the server holds the same line ---------------- */
{
  check('the server has a window of its own, the same length',
    /const SELF_PART_DAY_BACK_DAYS = (\d+);/.test(SRV)
      && Number(/const SELF_PART_DAY_BACK_DAYS = (\d+);/.exec(SRV)[1]) === BACK_DAYS,
    { page: BACK_DAYS, server: (/const SELF_PART_DAY_BACK_DAYS = (\d+);/.exec(SRV) || [])[1] });
  check('a day is still worked out from the clock when none is named',
    /let day = today;/.test(SRV) && /const asked = String\(\(body && body\.day\) \|\| ''\)\.trim\(\);/.test(SRV), null);
  check('a day ahead is refused',
    /if \(asked > today\) \{[\s\S]{0,120}error: 'not_yet'/.test(SRV), null);
  check('a day past the window is refused',
    /> SELF_PART_DAY_BACK_DAYS\) \{[\s\S]{0,120}error: 'too_old'/.test(SRV), null);
  check('anything that is not a date is refused',
    /error: 'bad_day'/.test(SRV), null);
  check('and each refusal lets the day go rather than half-writing it',
    (SRV.match(/await client\.query\('ROLLBACK'\); return \{ code: \d+, out: \{ error: '(bad_day|not_yet|too_old)'/g) || []).length === 3,
    (SRV.match(/await client\.query\('ROLLBACK'\); return \{ code: \d+, out: \{ error: '(bad_day|not_yet|too_old)'/g) || []).length);
  /* Everything that was true of today is still asked of the named day. */
  check('the month lock, the whole-day leave and the office’s own mark still answer for it',
    /if \(locked\[day\.slice\(0, 7\)\]\)/.test(SRV)
      && /const key = name \+ '\|' \+ day;/.test(SRV)
      && /if \(had && had\.by !== 'self'\)/.test(SRV), null);
}

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
