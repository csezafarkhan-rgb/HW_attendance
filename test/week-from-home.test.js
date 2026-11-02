// What a week of days from home comes to.
//
// A day from home has no punches, so unless somebody had typed hours against
// it - and almost nobody does - it left the weekly reckoning entirely. A week
// made of those days counted no days at all, and a week that counts no days
// reads "Completed - full hours": the band said the week was met because there
// was nothing in it to measure. Five days from home at three hours each read
// exactly the same as five full ones.
//
// DeskTime measured those days. The week counts them on that figure now, the
// same figure the cell above shows, so the band and the grid tell one story.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
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

/* A week in the past, so nothing is left open and every day is settled. */
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const MON = '2026-10-19';
const NAME = 'Aman Gupta';

const ctx = {
  todayISO_full: '2026-11-02',
  weeklyLeverageMin: 30,
  deskTime: {}, overrides: {}, records: {},
  getShift: () => '9:30-6:30',                      // nine hours
  getOfficialLeave: () => null,
  getOverride: (e, d) => ctx.overrides[e + '|' + d] || null,
  getRecord: (e, d) => ctx.records[e + '|' + d] || null,
  getLateExcuse: () => null, getEarlyExcuse: () => null,
  getMispunch: () => null, getHalfDay: () => null,
  Date, JSON, Object, Math, String, isNaN, parseInt, console,
};
vm.createContext(ctx);
['pad2', 'parseShift', 'toMin', 'mondayOf', 'wfhSeenMinutes', 'computeWeeklyShortHours',
 'gridWeekVerdict'].forEach(n => vm.runInContext(grab(APP, n), ctx));

/* mins: what DeskTime saw each day, or null for a day it saw nothing on. */
const fromHome = (mins, extra) => {
  ctx.overrides = {}; ctx.deskTime = {}; ctx.records = {};
  WEEK.forEach((d, i) => {
    ctx.overrides[NAME + '|' + d] = Object.assign({ cat: 'WFH' }, (extra || {})[d] || {});
    if (mins[i] != null) ctx.deskTime[NAME + '|' + d] = { i: '', o: '', d: mins[i] };
  });
  const info = ctx.computeWeeklyShortHours(NAME, WEEK);
  return { days: info.weekDays[MON], net: info.weekTotals[MON],
           said: ctx.gridWeekVerdict(info, MON) };
};

/* The week in the screenshot: a column of days from home, every one of them
   a fraction of a shift, under a band saying the week was completed. */
let r = fromHome([48, 192, 194, 94, 177]);
check('a week of short days from home is five days, not none',
  r.days === 5, r);
check('and comes to what the shift asked for less what was worked',
  r.net === (48 + 192 + 194 + 94 + 177) - 5 * 540, r.net);
check('so the band no longer says the week was completed',
  r.said.s === 'bad' && /^Not completed/.test(r.said.v), r.said);
check('it says how far short, in the words it uses for everybody else',
  / 1995m short$/.test(r.said.v), r.said.v);

/* The other half of the same screenshot: days from home that were full ones. */
r = fromHome([534, 535, 518, 582, 547]);
check('a week of full days from home is still a full week',
  r.days === 5 && r.said.s === 'ok', r);

/* Nothing measured is not nothing worked. A day DeskTime has no record of
   stays out of the reckoning exactly as it did before, rather than being
   counted as a day of no hours - that would invent a shortfall out of a
   missing measurement. */
r = fromHome([null, null, null, null, null]);
check('a week DeskTime saw nothing of is left alone as it always was',
  (r.days || 0) === 0 && r.said.s === 'ok' && /full hours$/.test(r.said.v), r);
r = fromHome([534, null, 518, null, 547]);
check('and the days it did see are the only ones counted',
  r.days === 3 && r.net === (534 + 518 + 547) - 3 * 540, r);

/* Hours somebody typed against the day still win: a measurement is better
   than an assumption, and a person who was there beats both. */
r = fromHome([48, 48, 48, 48, 48], {
  '2026-10-19': { duration: '9:00' }, '2026-10-20': { duration: '9:00' },
  '2026-10-21': { duration: '9:00' }, '2026-10-22': { duration: '9:00' },
  '2026-10-23': { duration: '9:00' } });
check('hours typed against the day are still what the day is worth',
  r.days === 5 && r.net === 0, r);

/* A day out on a visit is a day away from the computer by definition. Asking
   DeskTime what it was worth answers nothing, and counting that nothing would
   charge somebody for being where they were sent. */
ctx.overrides = {}; ctx.deskTime = {}; ctx.records = {};
WEEK.forEach(d => { ctx.overrides[NAME + '|' + d] = { cat: 'VISIT', detail: 'Factory' }; });
let info = ctx.computeWeeklyShortHours(NAME, WEEK);
check('a week spent out on visits is not weighed against the computer',
  (info.weekDays[MON] || 0) === 0, info);
/* Even where the machine happened to be on for an hour of it. */
WEEK.forEach(d => { ctx.deskTime[NAME + '|' + d] = { i: '', o: '', d: 60 }; });
info = ctx.computeWeeklyShortHours(NAME, WEEK);
check('nor when the computer was on for an hour of each of them',
  (info.weekDays[MON] || 0) === 0, info);

/* Leave is leave. */
ctx.overrides = {}; ctx.deskTime = {};
WEEK.forEach(d => {
  ctx.overrides[NAME + '|' + d] = { cat: 'LEAVE', detail: 'CL' };
  ctx.deskTime[NAME + '|' + d] = { i: '', o: '', d: 120 };
});
info = ctx.computeWeeklyShortHours(NAME, WEEK);
check('a week of leave is not a week of two-hour days',
  (info.weekDays[MON] || 0) === 0, info);

/* One figure, asked for in one place: what the cell says the day was worth
   and what the week counts it as cannot be allowed to disagree. */
check('the cell and the week ask the same function',
  (APP.match(/wfhSeenMinutes\(/g) || []).length >= 4, null);
check('and the totals ask it too, so the meter agrees with both',
  /function workedMinutes\(emp, dateStr\)[\s\S]{0,2200}wfhSeenMinutes\(emp, dateStr\)/.test(APP), null);

const bad = results.filter(x => !x).length;
console.log(bad ? ('FAILED ' + bad + ' of ' + results.length)
                : ('ALL PASS (' + results.length + ' checks)'));
process.exit(bad ? 1 : 0);
