// A day flagged as a mispunch ends at the shift's out time: the weekly hours and
// the early mark use that, not the punch on file. The dashboard's real functions.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

const recs = {
  'Habib|2026-09-14': { e: 'Habib', d: '2026-09-14', in: '9:12', out: '16:12', st: 'PR' },   // swipe-out missed
  'Habib|2026-09-15': { e: 'Habib', d: '2026-09-15', in: '8:25', out: '17:40', st: 'PR' }
};
const ctx = {
  console, mispunchFlags: {}, lateExcuses: {}, todayISO_full: '2026-09-20', earlyThresholdMin: 10, lateThresholdMin: 10,
  getShift: () => '8:30-5:30',
  parseShift: () => ({ startMin: 8 * 60 + 30, endMin: 17 * 60 + 30 }),
  toMin: t => { const m = /^(\d+):(\d+)/.exec(String(t || '')); return m ? (+m[1]) * 60 + (+m[2]) : 0; },
  getOfficialLeave: () => null, getOverride: () => null, getHalfDay: () => null, getEarlyExcuse: () => null,
  getRecord: (e, d) => recs[e + '|' + d] || null
};
vm.createContext(ctx);
vm.runInContext('function getLateExcuse(e, d){ return lateExcuses[e+"|"+d] || null; }', ctx);
['pad2', 'mondayOf', 'getMispunch', 'getLateEarly', 'isEarly', 'computeWeeklyShortHours'].forEach(n => vm.runInContext(lift(src, n), ctx));

const dates = ['2026-09-14', '2026-09-15'];
const before = ctx.computeWeeklyShortHours('Habib', dates).weekTotals['2026-09-14'];
check('unflagged: 7:00 on a 9:00 shift is 120m short, plus 15m extra the next day', before === -120 + 15, before);
check('unflagged: marked as leaving early', ctx.isEarly('Habib', recs['Habib|2026-09-14']) === true);

vm.runInContext("mispunchFlags['Habib|2026-09-14'] = {note:'forgot to swipe out'};", ctx);
const after = ctx.computeWeeklyShortHours('Habib', dates);
check('mispunch: the day ends at 5:30, so only the 42m late arrival counts', after.weekTotals['2026-09-14'] === -42 + 15, after.weekTotals);
check('mispunch: the day still counts toward the leverage', after.weekDays['2026-09-14'] === 2, after.weekDays);
check('mispunch: not marked as leaving early', ctx.isEarly('Habib', recs['Habib|2026-09-14']) === false);
check('mispunch: late arrival still marked', ctx.getLateEarly('Habib', recs['Habib|2026-09-14']).late === 42);

vm.runInContext("lateExcuses['Habib|2026-09-14'] = {note:'traffic'};", ctx);
check('mispunch + excused late: the day is met', ctx.computeWeeklyShortHours('Habib', dates).weekTotals['2026-09-14'] === 15);

recs['Habib|2026-09-14'].out = '';
vm.runInContext("delete lateExcuses['Habib|2026-09-14'];", ctx);
check('mispunch with no out punch at all still counts, from the shift out time', ctx.computeWeeklyShortHours('Habib', dates).weekTotals['2026-09-14'] === -42 + 15);

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
