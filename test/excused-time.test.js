// What an excuse is worth. A lateness that was excused is forgiven, not erased:
// it must not count against the on-time figure, nor against the late days or the
// late minutes, but it must still be reported as excused time of its own.
//
// computeEmployeeStats is the dashboard's own reckoning and the Performance
// sheet's; this drives the real thing over a made-up fortnight.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* Five working days. Two of them are late arrivals, one is an early leaving. */
const DAYS = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
const REC = {
  '2026-09-07': { 'in': '9:30', out: '18:30', st: 'PR', c: 2 },
  '2026-09-08': { 'in': '10:15', out: '18:30', st: 'PR', c: 2 },   // 45 min late
  '2026-09-09': { 'in': '9:30', out: '18:30', st: 'PR', c: 2 },
  '2026-09-10': { 'in': '10:05', out: '18:30', st: 'PR', c: 2 },   // 35 min late
  '2026-09-11': { 'in': '9:30', out: '17:30', st: 'PR', c: 2 }     // 60 min early
};

function statsWith(lateExcuses, earlyExcuses) {
  const ctx = {
    console, Math, Date, String, Number, Object, Array, isNaN, parseInt,
    todayISO_full: '2026-09-30',
    lateThresholdMin: 10, earlyThresholdMin: 10,
    getOfficialLeave: () => null,
    getOverride: () => null,
    getRecord: (e, d) => REC[d] || null,
    getHalfDay: () => null,
    getMispunch: () => null,
    getSatPolicy: () => ({ mode: 'OFF' }),
    beforeJoining: () => false,
    owedMinutes: () => 540,
    workedMinutes: (e, d) => REC[d] ? 540 : 0,
    getLateExcuse: (e, d) => (lateExcuses.indexOf(d) > -1 ? { note: 'in a meeting' } : null),
    getEarlyExcuse: (e, d) => (earlyExcuses.indexOf(d) > -1 ? { note: 'left for a client' } : null),
    /* The reckoning the grid uses: minutes late, minutes early. */
    getLateEarly: (e, rec) => {
      const toMin = t => { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); };
      return { late: Math.max(0, toMin(rec['in']) - toMin('9:30')),
               early: rec.out ? Math.max(0, toMin('18:30') - toMin(rec.out)) : 0 };
    },
    toMin: t => { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); },
    computeDurations: () => ({ totalMin: 540, inMin: 500, outMin: 40 }),
    hdQty: () => 0.5,
    computeWeeklyShortHours: () => ({ weekTotals: {}, weekDays: {}, weekOpen: {} })
  };
  vm.createContext(ctx);
  vm.runInContext('var LUNCH_BREAK_MIN = 45, TEA_BREAK_MIN = 15, BREAK_ALLOW_MIN = 60;', ctx);
  vm.runInContext(lift(src, 'computeEmployeeStats'), ctx);
  return ctx.computeEmployeeStats('Asha Test', DAYS.slice());
}

const plain = statsWith([], []);
check('two unexcused late arrivals are counted as late',
  plain.lateDays === 2 && plain.totalLateMin === 80, { days: plain.lateDays, mins: plain.totalLateMin });
check('and they pull the on-time figure down',
  plain.presentDays === 5 && plain.onTimePct === 60, { present: plain.presentDays, pct: plain.onTimePct });

const excused = statsWith(['2026-09-08', '2026-09-10'], []);
check('an excused lateness is not counted as a late day',
  excused.lateDays === 0, excused.lateDays);
check('nor are its minutes counted as late time',
  excused.totalLateMin === 0, excused.totalLateMin);
check('so it does not count against the on-time figure',
  excused.onTimePct === 100, excused.onTimePct);
check('but it is still reported as excused, not erased',
  excused.excusedLate === 2 && excused.excusedLateMin === 80,
  { days: excused.excusedLate, mins: excused.excusedLateMin });

const half = statsWith(['2026-09-08'], []);
check('excusing one of two leaves the other standing',
  half.lateDays === 1 && half.totalLateMin === 35 && half.onTimePct === 80,
  { days: half.lateDays, mins: half.totalLateMin, pct: half.onTimePct });

/* The same for leaving early. */
check('an unexcused early leaving is counted',
  plain.earlyDays === 1 && plain.totalEarlyMin === 60,
  { days: plain.earlyDays, mins: plain.totalEarlyMin });
const earlyOff = statsWith([], ['2026-09-11']);
check('an excused one is not, and is reported on its own',
  earlyOff.earlyDays === 0 && earlyOff.totalEarlyMin === 0
    && earlyOff.excusedEarly === 1 && earlyOff.excusedEarlyMin === 60,
  { days: earlyOff.earlyDays, mins: earlyOff.totalEarlyMin, excused: earlyOff.excusedEarly });

/* Attendance counts the days taken off, or it reads 100% for everybody. */
check('a day of leave counts against attendance',
  plain.attendancePct === 100 && plain.leaveDays === 0, plain.attendancePct);

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
