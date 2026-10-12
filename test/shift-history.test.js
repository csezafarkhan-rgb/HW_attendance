// A shift has a history: changing it must not rewrite months already closed.
//
// A shift used to be one value a person, used for every date there has ever
// been. Moving Habib from 9:30-6:30 to 9-6 re-worked every month he had been
// paid for, against hours he was not on at the time - his September read as
// half an hour short a day, after September had been settled.
//
// A shift is now a list of runs, each saying when it came into force. These
// checks are the promise that makes: what a past day is worth is fixed by the
// run in force on that day, whatever is set afterwards.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

const ctx = {
  console, Math, Date, String, Number, Object, Array, JSON, isNaN, parseInt, parseFloat,
  shiftAssignments: {},
  dayShifts: {},
  employeesByName: {
    'Habib': { shift: '9:30-6:30' },
    'Zafar Khan': { shift: '9:30-6:30' },
    'New Starter': { shift: '10:00-7:00' }
  },
  todayISO_full: '2026-10-12',
  monthLabelShort: ym => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+ym.slice(5,7)-1]
                         + ' ' + ym.slice(0, 4)
};
vm.createContext(ctx);
vm.runInContext(/ {2}var SHIFT_DAWN = [^;]*;/.exec(src)[0], ctx);
['shiftBaseDefault', 'shiftRuns', 'shiftOn', 'shiftFromDay', 'setShiftFrom',
 'dropShiftRun', 'shiftRunFrom', 'getShift', 'parseShift'
].forEach(n => vm.runInContext(lift(src, n), ctx));
const { shiftRuns, shiftOn, setShiftFrom, dropShiftRun, getShift, shiftFromDay, shiftRunFrom } = ctx;

/* ---- what was there before the history existed ---- */
ctx.shiftAssignments['Zafar Khan'] = '9:30-6:30';          // the old shape: a bare string
check('a shift stored the old way counts as always having been in force',
  shiftOn('Zafar Khan', '2025-03-04') === '9:30-6:30'
    && shiftOn('Zafar Khan', '2026-10-12') === '9:30-6:30',
  shiftRuns('Zafar Khan'));

/* ---- the change that started all this ---- */
ctx.shiftAssignments['Habib'] = [{ from: '0000-01-01', shift: '9:30-6:30' }];
setShiftFrom('Habib', '9:00-6:00', shiftFromDay());
check('a change made today comes into force on the 1st of this month',
  shiftFromDay() === '2026-10-01', shiftFromDay());
check('September keeps the slot September was worked out on',
  shiftOn('Habib', '2026-09-30') === '9:30-6:30', shiftRuns('Habib'));
check('and October onwards is on the new one',
  shiftOn('Habib', '2026-10-01') === '9:00-6:00'
    && shiftOn('Habib', '2026-11-15') === '9:00-6:00', shiftRuns('Habib'));
check('the month is never split across two slots',
  shiftOn('Habib', '2026-10-01') === shiftOn('Habib', '2026-10-31'),
  [shiftOn('Habib', '2026-10-01'), shiftOn('Habib', '2026-10-31')]);

/* The owed minutes are what the whole thing is for: a past day must still be
   worth what it was worth. 9:30-6:30 is nine hours, 9-6 is nine as well, so a
   slot of a different length is used to make the point visible. */
const owedOn = (emp, d) => {
  const sh = ctx.parseShift(getShift(emp, d));
  return sh.endMin - sh.startMin;
};
setShiftFrom('Habib', '10:00-6:00', '2026-11-01');         // eight hours, from November
check('a shorter slot set for November leaves October owing nine hours',
  owedOn('Habib', '2026-10-20') === 540 && owedOn('Habib', '2026-11-20') === 480,
  { oct: owedOn('Habib', '2026-10-20'), nov: owedOn('Habib', '2026-11-20') });

/* ---- somebody with nothing on file ---- */
check('and before any of it, their default slot still applies',
  shiftOn('Habib', '2020-01-01') === '9:30-6:30', shiftRuns('Habib'));
setShiftFrom('New Starter', '9:00-6:00', '2026-10-01');
check('setting a first shift writes down what they were on until then',
  shiftOn('New Starter', '2026-09-20') === '10:00-7:00'
    && shiftOn('New Starter', '2026-10-20') === '9:00-6:00',
  shiftRuns('New Starter'));

/* ---- housekeeping ---- */
setShiftFrom('New Starter', '9:00-6:00', '2026-12-01');
check('setting the same slot again does not add a run',
  shiftRuns('New Starter').length === 2, shiftRuns('New Starter'));
setShiftFrom('Habib', '8:00-5:00', '2026-11-01');
check('setting a slot for a month that already has one replaces it',
  shiftRuns('Habib').filter(r => r.from === '2026-11-01').length === 1
    && shiftOn('Habib', '2026-11-20') === '8:00-5:00', shiftRuns('Habib'));

/* ---- taking a change back ---- */
const before = shiftRuns('Habib').length;
dropShiftRun('Habib', '2026-11-01');
check('a run taken back hands those months to the slot before it',
  shiftRuns('Habib').length === before - 1 && shiftOn('Habib', '2026-11-20') === '9:00-6:00',
  shiftRuns('Habib'));
const first = shiftRuns('Habib')[0].from;
dropShiftRun('Habib', first);
check('but the first run cannot be taken back, or the past would have no slot',
  shiftRuns('Habib')[0].from === first && shiftOn('Habib', '2020-05-05') === '9:30-6:30',
  shiftRuns('Habib'));

/* ---- the things that must still hold ---- */
ctx.dayShifts['Habib|2026-10-08'] = '7:00-4:00';
check('a slot set for one day still beats the standing one',
  getShift('Habib', '2026-10-08') === '7:00-4:00'
    && getShift('Habib', '2026-10-09') === '9:00-6:00',
  [getShift('Habib', '2026-10-08'), getShift('Habib', '2026-10-09')]);
check('asked without a day, it answers with the slot in force now',
  getShift('Habib') === shiftRuns('Habib')[shiftRuns('Habib').length - 1].shift,
  getShift('Habib'));
check('somebody with nothing at all falls back to their default',
  getShift('Nobody Known', '2026-10-01') === '9:00-6:00', getShift('Nobody Known', '2026-10-01'));

/* ---- how the runs read on the panel ---- */
check('a run with no beginning says so, and the rest name their month',
  shiftRunFrom('0000-01-01') === 'from the start'
    && shiftRunFrom('2026-10-01') === 'from Oct 2026'
    && shiftRunFrom('2026-10-12') === 'from Oct 12, 2026',
  [shiftRunFrom('0000-01-01'), shiftRunFrom('2026-10-01'), shiftRunFrom('2026-10-12')]);

/* ---- and nothing writes the raw value any more ---- */
const writes = src.split('\n')
  .map((l, i) => ({ n: i + 1, l }))
  .filter(x => /shiftAssignments\[[^\]]+\]\s*=(?!=)/.test(x.l))   // an assignment, not a comparison
  .filter(x => !/SHIFT_DAWN/.test(x.l))              // seeding the run that has always been in force
  .filter(x => !/=\s*(out|runs)\b/.test(x.l));       // setShiftFrom and dropShiftRun writing back
check('every shift is set through the history, never written straight in',
  writes.length === 0, writes.map(x => x.n + ': ' + x.l.trim().slice(0, 80)));

/* Anything that speaks for a month has to ask for that month's slot. Asking
   without a day gets whatever is set now, which for a month already closed is
   the wrong answer - and the sort of wrong answer nobody notices, because it is
   only wrong for the people who were moved. */
const body = n => {
  const i = src.indexOf('function ' + n + '(');
  return i === -1 ? '' : src.slice(i, src.indexOf('\n  }\n', i));
};
[['computePay', /getShift\(emp, ym \+ '-01'\)/],
 ['gridAllSheet', /getShift\(e\.name, dates\[0\]\)/],
 ['gridPerformanceSheet', /getShift\(r\.emp\.name, dates\[0\]\)/]
].forEach(([fn, re]) => {
  check(fn + ' asks for the slot in force over the month it is reporting on',
    re.test(body(fn)), (body(fn).match(/getShift\([^)]*\)/g) || []).slice(0, 4));
});

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
