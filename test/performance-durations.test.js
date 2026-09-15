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
['computeDurations', 'computeEmployeeStats', 'perfScore'].forEach(n => vm.runInContext(lift(src, n), ctx));
vm.runInContext('var LUNCH_BREAK_MIN = 45, TEA_BREAK_MIN = 15; var BREAK_ALLOW_MIN = LUNCH_BREAK_MIN + TEA_BREAK_MIN;', ctx);

const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
const s = ctx.computeEmployeeStats('A', dates);
check('only real punch days are measured (not the manual entry, not the mispunch)', s.durDays === 3, s.durDays);
check('total, in and out duration add up', s.totalDurMin === 3 * 540 && s.inDurMin === 490 + 480 + 450 && s.outDurMin === 50 + 60 + 90, s);
check('daily averages', s.avgTotalDurMin === 540 && s.avgInDurMin === 473 && s.avgOutDurMin === 67, s);
check('out time up to 1:00 (45 lunch + 15 tea) is within, beyond it is over', s.breakOkDays === 2 && s.breakOverDays === 1 && s.breakOverMin === 30, s);
check('breaks within: 2 of 3 days', s.breakOkPct === 67, s.breakOkPct);
check('in-office: in duration against total less the allowance', s.inOfficePct === Math.min(100, Math.round(1420 / (1620 - 180) * 100)), s.inOfficePct);

const perfect = { attendancePct: 100, onTimePct: 100, presentDays: 5, workedMin: 2700, breakOkPct: 100, inOfficePct: 100 };
check('a perfect month scores 100', ctx.perfScore(perfect) === 100, ctx.perfScore(perfect));
check('breaks count: every day over the allowance takes 15 points', ctx.perfScore(Object.assign({}, perfect, { breakOkPct: 0 })) === 85);
check('in-office time counts for 10 points', ctx.perfScore(Object.assign({}, perfect, { inOfficePct: 0 })) === 90);
check('older stats without duration figures are not marked down', ctx.perfScore({ attendancePct: 100, onTimePct: 100, presentDays: 5, workedMin: 2700 }) === 100);

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
