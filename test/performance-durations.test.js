// The performance dashboard's duration figures and score: total, in and out
// duration, and the 45 + 15 minute break allowance. The dashboard's real functions.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

const toMin = t => { const m = /^(\d+):(\d+)/.exec(String(t || '')); return m ? (+m[1]) * 60 + (+m[2]) : NaN; };
// Mon-Thu, 9:30-6:30 shift. dur is the reader's in duration.
const recs = {
  'A|2026-09-07': { e: 'A', d: '2026-09-07', in: '9:30', out: '18:30', dur: '8:10', st: 'PR' },   // out 0:50 - within
  'A|2026-09-08': { e: 'A', d: '2026-09-08', in: '9:30', out: '18:30', dur: '8:00', st: 'PR' },   // out 1:00 - exactly the allowance
  'A|2026-09-09': { e: 'A', d: '2026-09-09', in: '9:30', out: '18:30', dur: '7:30', st: 'PR' },   // out 1:30 - 30 over
  'A|2026-09-10': { e: 'A', d: '2026-09-10', in: '9:30', out: '18:30', dur: '', st: 'PR', manual: true },  // manual: no break data
  'A|2026-09-11': { e: 'A', d: '2026-09-11', in: '9:30', out: '16:00', dur: '5:00', st: 'PR' }    // mispunch: left out
};
const ctx = {
  console, todayISO_full: '2026-09-15', lateThresholdMin: 10, earlyThresholdMin: 10, toMin,
  mispunchFlags: { 'A|2026-09-11': { note: 'x' } },
  beforeJoining: () => false, getOfficialLeave: () => null, getOverride: () => null, getHalfDay: () => null,
  getLateExcuse: () => null, getEarlyExcuse: () => null, getSatPolicy: () => ({ mode: 'OFF' }), hdQty: () => 0,
  getRecord: (e, d) => recs[e + '|' + d] || null,
  owedMinutes: () => 540, workedMinutes: () => 540,
  getLateEarly: () => ({ late: 0, early: 0 }),
  computeWeeklyShortHours: () => ({ weekTotals: {}, weekDays: {} })
};
vm.createContext(ctx);
vm.runInContext('function getMispunch(e, d){ return mispunchFlags[e+"|"+d] || null; }', ctx);
/* The share of the target that, given over, earns full marks on that part. */
vm.runInContext(/ {2}var SCORE_GIVEN_FULL = [^;]*;/.exec(src)[0], ctx);
['computeDurations', 'computeEmployeeStats', 'perfScore'].forEach(n => vm.runInContext(lift(src, n), ctx));
vm.runInContext('var LUNCH_BREAK_MIN = 45, TEA_BREAK_MIN = 15; var BREAK_ALLOW_MIN = LUNCH_BREAK_MIN + TEA_BREAK_MIN;', ctx);

const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
const s = ctx.computeEmployeeStats('A', dates);
check('only real punch days are measured (not the manual entry, not the mispunch)', s.durDays === 3, s.durDays);
check('total, in and out duration add up', s.totalDurMin === 3 * 540 && s.inDurMin === 490 + 480 + 450 && s.outDurMin === 50 + 60 + 90, s);
check('daily averages', s.avgTotalDurMin === 540 && s.avgInDurMin === 473 && s.avgOutDurMin === 67, s);
check('out time up to 1:00 (45 lunch + 15 tea) is within, beyond it is over', s.breakOkDays === 2 && s.breakOverDays === 1 && s.breakOverMin === 30, s);
check('breaks within: 2 of 3 days', s.breakOkPct === 67, s.breakOkPct);
// Per day, then averaged: 490/480 -> 100, 480/480 -> 100, 450/480 -> 93.75; a day with no break cannot hide one with a long one.
check('in-office: each day\'s in duration against its total less the allowance, averaged', s.inOfficePct === Math.round((100 + 100 + 93.75) / 3), s.inOfficePct);

/* 30 turning up, 25 keeping the day, 25 doing the hours, 15 at the desk, 5 for
   time given over. Full marks on the last is a twentieth of the target given
   back - here 2700 minutes owed, so 135 of surplus. */
const perfect = { attendancePct: 100, punctualityPct: 100, onTimePct: 100, presentDays: 5,
                  workedMin: 2700, inOfficePct: 100, owedMin: 2700, weekExtraMin: 135 };
const with_ = o => ctx.perfScore(Object.assign({}, perfect, o));
check('a month that met everything and gave time over scores 100',
  ctx.perfScore(perfect) === 100, ctx.perfScore(perfect));
check('turning up carries thirty', with_({ attendancePct: 0 }) === 70, with_({ attendancePct: 0 }));
check('keeping the day carries twenty-five', with_({ punctualityPct: 0 }) === 75,
  with_({ punctualityPct: 0 }));
/* Leaving early used to cost nothing at all: on-time counted the mornings and
   the afternoons went unread. */
check('and it reads both ends of the day, not just the morning',
  with_({ punctualityPct: 60, onTimePct: 100 }) === 90, with_({ punctualityPct: 60, onTimePct: 100 }));
check('doing the hours carries twenty-five', with_({ workedMin: 0 }) === 75, with_({ workedMin: 0 }));
/* Measured against the days attended, a day missed took its own hours out of
   the reckoning with it, and the figure never moved. */
check('measured against what the month asked for, not the days attended',
  with_({ workedMin: 1350, presentDays: 2 }) === 88, with_({ workedMin: 1350, presentDays: 2 }));
check('excused time counts towards the hours',
  with_({ workedMin: 0, excusedMin: 2700 }) === 100, with_({ workedMin: 0, excusedMin: 2700 }));
check('the desk carries fifteen', with_({ inOfficePct: 0 }) === 85, with_({ inOfficePct: 0 }));
check('time given over carries five', with_({ weekExtraMin: 0 }) === 95, with_({ weekExtraMin: 0 }));
check('half of the twentieth earns half of those five',
  with_({ weekExtraMin: 67 }) === 98, with_({ weekExtraMin: 67 }));
check('and giving more than the twentieth earns no more',
  with_({ weekExtraMin: 4000 }) === 100);
/* Minutes away from the desk are inside the desk figure already; counting them
   again marked people down twice for one lunch. */
check('breaks no longer count on their own', with_({ breakOkPct: 0 }) === 100, with_({ breakOkPct: 0 }));
check('a mispunch is not held against anybody', with_({ mispunches: 9 }) === 100);
check('older stats with no punctuality figure fall back to on-time',
  ctx.perfScore({ attendancePct: 100, onTimePct: 100, presentDays: 5, workedMin: 2700,
                  owedMin: 2700, weekExtraMin: 135 }) === 100);

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
