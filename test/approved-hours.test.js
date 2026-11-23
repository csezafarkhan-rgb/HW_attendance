/* The hours a day was approved for, as opposed to the hours worked on it.
 *
 * The day modal has always had a box for hours worked, and the week measured
 * whatever went in it against the full shift. So a Wednesday approved as a
 * four-hour day from home, worked in full, came out five hours short: the
 * record had a way to say what somebody did and no way to say what had been
 * asked of them.
 *
 * "WFH · 4:58" against 9:00, times six people, is the "239m short" the office
 * was reading on a week where nobody had done anything wrong.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), d = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) break; }
  }
  return src.slice(i, k + 1);
}

const NAME = 'Zafar Khan';
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const WED = '2026-10-21';

const ctx = {
  todayISO_full: '2026-11-16', weeklyLeverageMin: 30,
  deskTime: {}, overrides: {}, records: {}, officialLeaves: {},
  getShift: () => '9:30-6:30',                         // nine hours
  getOfficialLeave: (d) => ctx.officialLeaves[d] || null,
  getOverride: (e, d) => ctx.overrides[e + '|' + d] || null,
  getRecord: (e, d) => ctx.records[e + '|' + d] || null,
  getLateExcuse: () => null, getEarlyExcuse: () => null,
  getMispunch: () => null, getHalfDay: () => null,
  getSatPolicy: () => ({ mode: 'OFF', hours: 4 }),
  /* Lunch and the two breaks, as the Options panel sets them: a day from
     home is owed the shift less these. */
  BREAK_ALLOW_MIN: 75,
  Date, JSON, Object, Math, String, isNaN, parseInt, parseFloat, console,
};
vm.createContext(ctx);
['pad2', 'parseShift', 'toMin', 'mondayOf', 'deskSeenMinutes', 'wfhSeenMinutes', 'approvedMinutes',
 'owedMinutes', 'computeWeeklyShortHours'].forEach(n => vm.runInContext(grab(APP, n), ctx));

/* ---- what the day asks for ---- */
check('an ordinary day asks for the whole shift',
  ctx.owedMinutes(NAME, WED) === 540, ctx.owedMinutes(NAME, WED));

ctx.overrides[NAME + '|' + WED] = { cat: 'WFH', duration: '4:00', owed: '4:00' };
check('a day approved for four hours asks for four',
  ctx.owedMinutes(NAME, WED) === 240, ctx.owedMinutes(NAME, WED));

ctx.overrides[NAME + '|' + WED] = { cat: 'WFH', duration: '', owed: '0:00' };
check('a day approved as off asks for nothing',
  ctx.owedMinutes(NAME, WED) === 0, ctx.owedMinutes(NAME, WED));

/* With nothing approved, a day from home asks for what such a day asks for:
   the working part of the shift - nine hours less the lunch and two breaks
   the office has set - and not the span of it. An ordinary day in the
   building still asks for the span, which is the check above. */
ctx.overrides[NAME + '|' + WED] = { cat: 'WFH', duration: '4:00', owed: '' };
check('a mark with no approved figure asks for the work in the shift',
  ctx.owedMinutes(NAME, WED) === 465, ctx.owedMinutes(NAME, WED));

/* A figure that does not parse must not become NaN: one NaN poisons the
   week's total and every figure built on it. */
['abc', '4', ':30', '  '].forEach(function (bad) {
  ctx.overrides[NAME + '|' + WED] = { cat: 'WFH', duration: '', owed: bad };
  check('an approved figure of "' + bad + '" falls back to what the day asks',
    ctx.owedMinutes(NAME, WED) === 465, ctx.owedMinutes(NAME, WED));
});

/* Longer than the shift would hand out credit for hours nobody worked. */
/* Clamped to the shift, which is the longest a day can be asked for; the
   working part of it is what an unapproved day asks, not a ceiling on what
   may be approved. Somebody told to work a full nine hours from home is a
   thing the office may approve. */
ctx.overrides[NAME + '|' + WED] = { cat: 'WFH', duration: '', owed: '14:00' };
check('and one longer than the shift is clamped to it',
  ctx.owedMinutes(NAME, WED) === 540, ctx.owedMinutes(NAME, WED));

/* Leave and holidays are decided before this and still win. */
ctx.officialLeaves[WED] = { name: 'Diwali' };
ctx.overrides[NAME + '|' + WED] = { cat: 'WFH', duration: '', owed: '4:00' };
check('a holiday still asks for nothing, whatever is approved on it',
  ctx.owedMinutes(NAME, WED) === 0, ctx.owedMinutes(NAME, WED));
delete ctx.officialLeaves[WED];
/* A leave day still owes its shift, as it always has - leave covers the hours
   rather than reducing them, and the week takes the day out of the reckoning
   on its own. What must not happen is leave being quietly reshaped into a
   four-hour day by a figure left in the box. */
ctx.overrides[NAME + '|' + WED] = { cat: 'LEAVE', detail: 'CL', owed: '4:00' };
check('and a day on leave is not turned into a four-hour day',
  ctx.owedMinutes(NAME, WED) === 540, ctx.owedMinutes(NAME, WED));

/* ---- the week, which is the whole point ---- */
const week = (over) => {
  ctx.records = {}; ctx.overrides = {}; ctx.deskTime = {};
  WEEK.forEach(d => {
    if (d === WED) return;
    ctx.records[NAME + '|' + d] = { d, 'in': '9:30', out: '18:30', dur: '9:00', st: 'PR' };
  });
  ctx.overrides[NAME + '|' + WED] = over;
  const wk = ctx.computeWeeklyShortHours(NAME, WEEK);
  return wk.weekTotals[Object.keys(wk.weekTotals)[0]];
};

check('four hours approved and four hours worked leaves the week level',
  week({ cat: 'WFH', duration: '4:00', owed: '4:00' }) === 0,
  week({ cat: 'WFH', duration: '4:00', owed: '4:00' }));
/* Without the approval the day asks what a day from home asks - seven hours
   forty-five - so four hours worked is three and three quarters short rather
   than five. The point stands: the approved figure is the difference between
   a short week and a level one. */
check('the same day without the approval is short by what it did not work',
  week({ cat: 'WFH', duration: '4:00', owed: '' }) === -225,
  week({ cat: 'WFH', duration: '4:00', owed: '' }));
check('working past the approved hours banks the surplus',
  week({ cat: 'WFH', duration: '5:00', owed: '4:00' }) === 60,
  week({ cat: 'WFH', duration: '5:00', owed: '4:00' }));
check('falling short of them still counts short',
  week({ cat: 'WFH', duration: '3:00', owed: '4:00' }) === -60,
  week({ cat: 'WFH', duration: '3:00', owed: '4:00' }));
check('a day approved as off costs the week nothing',
  week({ cat: 'WFH', duration: '', owed: '0:00' }) === 0,
  week({ cat: 'WFH', duration: '', owed: '0:00' }));

/* The week and the dashboard must not answer this separately - that split is
   what made the band and the figures disagree about 11 November. */
check('the week asks what a day is worth rather than working it out again',
  /owedMinutes\(empName, dateStr\)/.test(grab(APP, 'computeWeeklyShortHours'))
  && !/var required = sh\.endMin - sh\.startMin;/.test(grab(APP, 'computeWeeklyShortHours')),
  null);

/* ---- the control itself ---- */
check('the WFH block has a box for the approved hours',
  /id="ovOwed"/.test(APP), null);
/* The choices are a list in the source, built into options at render time -
   a list cannot be typed wrong, which is the point of not using a box. */
check('with the plain choices, and off among them',
  /\['0:00', *'Off/.test(APP) && /\['4:00', *'4 hours'\]/.test(APP)
  && /\['2:00', *'2 hours'\]/.test(APP), null);
check('"full day" is the one that means nothing was agreed, and comes first',
  /OWED_CHOICES = \[\s*\['', *'Full day/.test(APP), null);
check('it is saved onto the mark beside the hours worked',
  /owed: *owed/.test(APP) && /getElementById\('ovOwed'\)/.test(APP), null);
check('and it is shown and hidden with the hours-worked box',
  /ovDurationWrap/.test(APP), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
