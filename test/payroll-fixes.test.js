// Pay and attendance corrections found in the audit: a mispunch day's hours,
// leave taken on a day nothing is owed, PF/ESI on what was actually earned,
// and undoing an approval without deleting marks made by hand.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

const toMin = t => { const m = /^(\d+):(\d+)/.exec(String(t || '')); return m ? (+m[1]) * 60 + (+m[2]) : NaN; };
const parseShift = () => ({ startMin: 570, endMin: 1110 });          // 9:30 - 6:30, 540 minutes

/* ---------- a flagged mispunch: hours run to the shift's edge ---------- */
{
  const recs = {
    'A|2026-09-07': { e: 'A', d: '2026-09-07', in: '9:30', out: '13:30', dur: '4:00', st: 'PR' }, // out punch missed
    'A|2026-09-08': { e: 'A', d: '2026-09-08', in: '10:30', out: '13:00', dur: '2:30', st: 'PR' }, // late, then missed
    'A|2026-09-09': { e: 'A', d: '2026-09-09', in: '', out: '18:30', dur: '', st: 'PR' },          // in punch missed
    'A|2026-09-10': { e: 'A', d: '2026-09-10', in: '9:30', out: '18:30', dur: '8:00', st: 'PR' }   // an ordinary day
  };
  const ctx = {
    console, toMin, parseShift, OV_CATS: { WFH: { countsAsWorked: true }, VISIT: { countsAsWorked: true }, LEAVE: {} },
    mispunchFlags: { 'A|2026-09-07': { n: 1 }, 'A|2026-09-08': { n: 1 }, 'A|2026-09-09': { n: 1 } },
    getOverride: () => null, getShift: () => '9:30-6:30',
    getRecord: (e, d) => recs[e + '|' + d] || null,
    owedMinutes: () => 540
  };
  vm.createContext(ctx);
  vm.runInContext('function getMispunch(e, d){ return mispunchFlags[e+"|"+d] || null; }', ctx);
  ['computeDurations', 'workedMinutes'].forEach(n => vm.runInContext(lift(src, n), ctx));

  check('a missed out punch is credited to the end of the shift, not to the stray punch',
    ctx.workedMinutes('A', '2026-09-07') === 540, ctx.workedMinutes('A', '2026-09-07'));
  check('arriving an hour late still costs that hour on a mispunch day',
    ctx.workedMinutes('A', '2026-09-08') === 480, ctx.workedMinutes('A', '2026-09-08'));
  check('a missed in punch runs from the start of the shift',
    ctx.workedMinutes('A', '2026-09-09') === 540, ctx.workedMinutes('A', '2026-09-09'));
  check('an ordinary day is unchanged',
    ctx.workedMinutes('A', '2026-09-10') === 540, ctx.workedMinutes('A', '2026-09-10'));
}

/* ---------- PF and ESI: ceiling on the salary, rate on what was earned ---------- */
{
  const ctx = { console, payRules: { pf: true, pfPct: 12, esi: true, esiPct: 0.75, esiCap: 21000, other: 0 } };
  vm.createContext(ctx);
  vm.runInContext(lift(src, 'statutory'), ctx);

  const joinedLate = ctx.statutory(24000, 8800);            // 24,000 salary, joined on the 20th
  check('ESI follows the salary, so a 24,000 salary pays none however little of the month was worked',
    joinedLate.esi === 0, joinedLate);
  check('PF is charged on what was earned, not on the whole salary',
    joinedLate.pf === 1056, joinedLate);
  const unpaidDays = ctx.statutory(30000, 30000 - 11000);   // 11 days unpaid
  check('unpaid days lower PF', unpaidDays.pf === 2280, unpaidDays);
  const inside = ctx.statutory(20000, 20000);
  check('a salary under the ceiling still pays ESI', inside.esi === 150, inside);
}

/* ---------- leave on a Sunday is still leave, and still unpaid ---------- */
{
  const overrides = {
    'A|2026-06-01': { cat: 'LEAVE', detail: 'CL' },
    'A|2026-06-02': { cat: 'LEAVE', detail: 'CL' },
    'A|2026-06-03': { cat: 'LEAVE', detail: 'CL' },
    'A|2026-06-06': { cat: 'LEAVE', detail: 'CL' },        // Saturday, off for this person
    'A|2026-06-07': { cat: 'LEAVE', detail: 'CL' }         // Sunday
  };
  const ctx = {
    console, toMin, parseShift, todayISO_full: '2026-07-01',
    payRules: { allLeaveUnpaid: true, pf: false, esi: false, other: 0, ot: false },
    getSalary: () => 30000, getShift: () => '9:30-6:30',
    getOverride: (e, d) => overrides[e + '|' + d] || null,
    getHalfDay: () => null, getRecord: () => null, getLeaveDeduction: () => null,
    getSatPolicy: () => ({ mode: 'OFF' }), hdQty: () => 0.5,
    beforeJoining: () => false, getOfficialLeave: () => null,
    workedMinutes: () => 0,
    // 5 days of leave in June (index 5), exactly what the Leave Record drained
    computeLeaveMatrix: () => ({
      clM: [0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0], slM: new Array(12).fill(0),
      ded: new Array(12).fill(0), autoDed: new Array(12).fill(0), pendM: new Array(12).fill(0),
      clAssign: 10, slAssign: 10, clTaken: 5, slTaken: 0, clRem: 5, slRem: 10,
      combinedRem: 15, afterDed: 15, totalDed: 0
    })
  };
  vm.createContext(ctx);
  vm.runInContext('function pad2(n){ return (n<10?"0":"")+n; }', ctx);
  ['eachDateInMonth', 'statutory', 'owedMinutes', 'computePay'].forEach(n => vm.runInContext(lift(src, n), ctx));

  const p = ctx.computePay('A', '2026-06');
  check('the slip counts leave taken on a Saturday or a Sunday', p.leaveDays === 5, p.leaveDays);
  check('all five days are unpaid, not the three on working days', p.lop === 5, p.lop);
  check('and the money follows: 5 days of a 30-day month', p.lopAmt === 5000, p.lopAmt);
}

/* ---------- undoing an approval leaves marks made by hand alone ---------- */
{
  const ctx = {
    console, Promise,
    overrides: {
      'A|2026-03-10': { cat: 'LEAVE', detail: 'CL' },                       // marked by hand, long before
      'A|2026-03-11': { cat: 'LEAVE', detail: 'CL', reqId: 'req_1' },       // written by this request
      'A|2026-03-12': { cat: 'LEAVE', detail: 'CL', reqId: 'req_9' }        // written by another request
    },
    halfDays: {}, manualRecords: {},
    saveOverrides: () => Promise.resolve(), saveHalfDays: () => Promise.resolve(),
    saveManualRecords: () => Promise.resolve()
  };
  vm.createContext(ctx);
  vm.runInContext('function pad2(n){ return (n<10?"0":"")+n; }', ctx);
  vm.runInContext("function isPartDay(t){ return t === 'HALF' || t === 'SHORT' || t === 'THREEQ'; }", ctx);
  ['eachDateBetween', 'revertApprovedRequest'].forEach(n => vm.runInContext(lift(src, n), ctx));

  ctx.revertApprovedRequest({ id: 'req_1', empName: 'A', leaveType: 'CL', dateFrom: '2026-03-10', dateTo: '2026-03-12' })
    .then(kept => {
      check('a day marked by hand survives the revert', !!ctx.overrides['A|2026-03-10'], ctx.overrides);
      check('this request’s own day is removed', !ctx.overrides['A|2026-03-11'], ctx.overrides);
      check('another request’s day is left alone', !!ctx.overrides['A|2026-03-12'], ctx.overrides);
      check('both are reported back as kept', kept === 2, kept);
      done();
    });
}

function done() {
  const bad = results.filter(r => !r).length;
  console.log(bad ? ('FAILED (' + bad + ' of ' + results.length + ')') : ('ALL PASS (' + results.length + ')'));
  if (bad) process.exitCode = 1;
}
