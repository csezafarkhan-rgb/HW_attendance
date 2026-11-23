/* The performance table, now that a day from home asks for less.
 *
 * The hours a month asked for are added up on that table from the same
 * function the grid's week line asks. A day worked from home asks for the
 * working part of the shift - nine hours less the lunch and the two breaks -
 * and the table has to ask the same question, or the two pages disagree about
 * the same month in front of the same person.
 *
 * This runs the reckoning itself rather than reading the rule off the source.
 */
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

const NAME = 'Rahul Mishra';
/* A finished week: Monday to Friday, all of it in the past. */
const WEEK = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];

function run(marks) {
  const ctx = {
    todayISO_full: '2026-12-01',          // every day of the fixture has ended
    weeklyLeverageMin: 30, lateThresholdMin: 10, earlyThresholdMin: 10,
    BREAK_ALLOW_MIN: 75, BREAK1_MIN: 15, BREAK2_MIN: 15, LUNCH_BREAK_MIN: 45,
    overrides: {}, records: {}, deskTime: {}, officialLeaves: {},
    getShift: () => '9:30-6:30',                       // nine hours
    getSatPolicy: () => ({ mode: 'OFF', hours: 4 }),
    getOfficialLeave: d => ctx.officialLeaves[d] || null,
    getOverride: (e, d) => ctx.overrides[e + '|' + d] || null,
    getRecord: (e, d) => ctx.records[e + '|' + d] || null,
    getLateExcuse: () => null, getEarlyExcuse: () => null, getLatePlea: () => null,
    getMispunch: () => null, getHalfDay: () => null, getDayShift: () => null,
    beforeJoining: () => false, isShortLeave: () => false,
    onApprovedLeave: () => false, weeklyOffDay: () => null,
    getLeaveDeduction: () => null, hdQty: () => 0.5, isPartDay: () => false,
    /* What each kind of mark means for the hours: the page's own table, so a
       day from home counts as worked here exactly as it does there. */
    OV_CATS: {
      WFH:   { countsAsWorked: true },
      VISIT: { countsAsWorked: true },
      LEAVE: { countsAsWorked: false },
      OTHER: { countsAsWorked: false }
    },
    Date, JSON, Object, Math, String, Number, isNaN, parseInt, parseFloat, console
  };
  vm.createContext(ctx);
  ['pad2', 'parseShift', 'toMin', 'fmtMin', 'mondayOf', 'shiftMin', 'deskSeenMinutes', 'wfhSeenMinutes',
   'approvedMinutes', 'owedMinutes', 'wfhCellDuration', 'computeDurations', 'getLateEarly',
   'workedMinutes', 'computeWeeklyShortHours', 'computeEmployeeStats']
    .forEach(n => { try { vm.runInContext(grab(APP, n), ctx); } catch (e) { /* not needed */ } });
  marks(ctx);
  return ctx.computeEmployeeStats(NAME, WEEK);
}

/* ---- five days in the building ---- */
{
  const st = run(ctx => {
    WEEK.forEach(d => {
      ctx.records[NAME + '|' + d] = { e: NAME, d: d, 'in': '9:30', out: '18:30', dur: '9:00', st: 'PR' };
    });
  });
  check('a week in the building asks for the whole shift each day',
    st.owedMin === 5 * 540, st.owedMin);
  check('and nine hours a day meets it',
    st.hoursMetPct === 100, { met: st.hoursMetPct, worked: st.workedDoneMin });
}

/* ---- five days from home ---- */
{
  const st = run(ctx => {
    WEEK.forEach(d => {
      ctx.overrides[NAME + '|' + d] = { cat: 'WFH' };
      /* Seven forty-five at the computer: the working part of the shift. */
      ctx.deskTime[NAME + '|' + d] = { i: '09:30', o: '18:30', w: 540, d: 465 };
    });
  });
  check('a week from home asks for the shift less lunch and the breaks',
    st.owedMin === 5 * 465, st.owedMin);
  /* The whole point: the same week used to read as an hour and a quarter
     short every day, which is seven hours over a week nobody was short on. */
  check('and seven forty-five at the computer meets it',
    st.hoursMetPct === 100, { met: st.hoursMetPct, owed: st.owedMin, worked: st.workedDoneMin });
}

/* ---- and the mixture, which is what a real month is ---- */
{
  const st = run(ctx => {
    WEEK.forEach((d, i) => {
      if (i < 3) {
        ctx.records[NAME + '|' + d] = { e: NAME, d: d, 'in': '9:30', out: '18:30', dur: '9:00', st: 'PR' };
      } else {
        ctx.overrides[NAME + '|' + d] = { cat: 'WFH' };
        ctx.deskTime[NAME + '|' + d] = { i: '09:30', o: '18:30', w: 540, d: 465 };
      }
    });
  });
  check('three days in and two from home ask for the sum of the two rules',
    st.owedMin === 3 * 540 + 2 * 465, st.owedMin);
  check('and a month of both still reads as met',
    st.hoursMetPct === 100, { met: st.hoursMetPct, owed: st.owedMin, worked: st.workedDoneMin });
}

/* ---- the office's own lunch decides it ---- */
{
  /* An office with no breaks set asks for the whole shift from home as well:
     the rule is not 7:45, it is the shift less whatever the office allows. */
  const ctx = {};
  const st = run(c => {
    c.BREAK_ALLOW_MIN = 0;
    WEEK.forEach(d => {
      c.overrides[NAME + '|' + d] = { cat: 'WFH' };
      c.deskTime[NAME + '|' + d] = { i: '09:30', o: '18:30', w: 540, d: 540 };
    });
  });
  check('an office that allows no breaks asks for the whole shift from home too',
    st.owedMin === 5 * 540, st.owedMin);
}

/* ---- hours approved on the day still win ---- */
{
  const st = run(ctx => {
    WEEK.forEach(d => {
      ctx.overrides[NAME + '|' + d] = { cat: 'WFH', owed: '9:00' };
      ctx.deskTime[NAME + '|' + d] = { i: '09:30', o: '18:30', w: 540, d: 540 };
    });
  });
  check('a day from home approved for nine hours asks for nine',
    st.owedMin === 5 * 540, st.owedMin);
}

/* ---- and the table asks the same question the week line asks ---- */
check('both ask owedMinutes, so the two pages cannot disagree',
  /var req = owedMinutes\(empName, ds\);/.test(APP)
  && /var required = owedMinutes\(empName, dateStr\);/.test(APP), null);

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
