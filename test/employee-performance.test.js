// The employee's own performance alerts: this month against last, drops and
// rises, thresholds, and nothing said on too little data. The page's real code.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

// computeEmployeeStats is stubbed by month: the month is the first date passed.
const base = { presentDays: 12, absentDays: 0, attendancePct: 100, onTimePct: 90, totalLateMin: 24, earlyDays: 1,
  workedMin: 12 * 540, durDays: 12, avgInDurMin: 490, avgOutDurMin: 50, breakOkPct: 90, inOfficePct: 100 };
let stats = {};
const ctx = {
  console, todayISO_full: '2026-09-15',
  pad2: n => (n < 10 ? '0' : '') + n,
  fmtMin: m => (m < 0 ? '-' : '') + Math.floor(Math.abs(m) / 60) + ':' + String(Math.abs(m) % 60).padStart(2, '0'),
  monthLabel: ym => ({ '2026-08': 'August 2026', '2026-09': 'September 2026', '2025-12': 'December 2025' })[ym] || ym,
  eachDateInMonth: ym => Array.from({ length: 28 }, (_, i) => ym + '-' + String(i + 1).padStart(2, '0')),
  computeEmployeeStats: (name, dates) => stats[dates[0].slice(0, 7)]
};
vm.createContext(ctx);
vm.runInContext('var LUNCH_BREAK_MIN = 45, TEA_BREAK_MIN = 15; var BREAK_ALLOW_MIN = 60;', ctx);
vm.runInContext(lift(src, 'perfScore'), ctx);
vm.runInContext(/var PERF_METRICS = \[[\s\S]*?\n  \];/.exec(src)[0], ctx);
vm.runInContext('var EMP_PERF_CACHE = null, overrides = {}, halfDays = {}, RECORDS = []; function todayIsoNow(){ return todayISO_full; }', ctx);
vm.runInContext(lift(src, 'empPerfCompute'), ctx);
vm.runInContext(lift(src, 'empPerfChanges'), ctx);
let seenDates = [];
const baseStats = ctx.computeEmployeeStats;
ctx.computeEmployeeStats = (name, dates) => { seenDates.push(dates); return baseStats(name, dates); };
const run = () => { vm.runInContext('EMP_PERF_CACHE = null;', ctx); return ctx.empPerfChanges('A'); };
const keys = r => r.items.map(i => i.key + (i.good ? '+' : '-'));

stats = { '2026-08': Object.assign({}, base), '2026-09': Object.assign({}, base) };
let r = run();
check('the same month twice: nothing to say', r.ready && r.items.length === 0, keys(r));

stats['2026-09'] = Object.assign({}, base, { onTimePct: 70, avgOutDurMin: 75, breakOkPct: 60, earlyDays: 4 });
r = run();
check('drops are reported: on-time, time out, breaks, early days',
  ['ontime-', 'outdur-', 'breaks-', 'early-'].every(k => keys(r).indexOf(k) > -1), keys(r));
check('a drop says what it was and is', /On-time arrivals down by 20 points/.test(r.items.find(i => i.key === 'ontime').title)
  && /70% this month, 90% in August/.test(r.items.find(i => i.key === 'ontime').detail), r.items.find(i => i.key === 'ontime'));
check('the score drop is caught too', keys(r).indexOf('score-') > -1, keys(r));
check('drops come before rises', r.items.every((it, i, a) => i === 0 || !(it.good === false && a[i - 1].good === true)));

stats['2026-08'] = Object.assign({}, base, { totalLateMin: 120 });                 // 10 min late a day in August
stats['2026-09'] = Object.assign({}, base, { onTimePct: 100, totalLateMin: 0, avgInDurMin: 520, breakOkPct: 100 });
r = run();
check('rises are reported as good news', ['ontime+', 'latemin+', 'indur+', 'breaks+'].every(k => keys(r).indexOf(k) > -1) && r.items.every(i => i.good), keys(r));
check('a rise reads as up', /On-time arrivals up by 10 points/.test(r.items.find(i => i.key === 'ontime').title));

stats['2026-08'] = Object.assign({}, base);
stats['2026-09'] = Object.assign({}, base, { onTimePct: 87, avgOutDurMin: 55 });
check('small moves under the threshold are not flagged', run().items.length === 0, keys(run()));

stats['2026-08'] = Object.assign({}, base, { avgOutDurMin: 66 });
stats['2026-09'] = Object.assign({}, base, { avgOutDurMin: 70 });
r = run();
check('time out over the 1:00 allowance is flagged even without a big change', keys(r).indexOf('outallow-') > -1, keys(r));

stats['2026-09'] = Object.assign({}, base, { presentDays: 2, onTimePct: 0 });
check('too few days this month: says nothing yet', run().ready === false && run().items.length === 0);

stats = { '2025-12': Object.assign({}, base, { onTimePct: 60 }), '2026-01': Object.assign({}, base) };
ctx.todayISO_full = '2026-01-10';
r = run();
check('January compares with the December before', r.prevYm === '2025-12' && keys(r).indexOf('ontime+') > -1, { prev: r.prevYm, k: keys(r) });
check('each change has a stable signature for "seen"', r.items.every(i => /^2026-01\|[a-z]+\|(up|down)$/.test(i.sig)), r.items.map(i => i.sig));

seenDates = []; ctx.todayISO_full = '2026-09-15'; stats = { '2026-08': Object.assign({}, base), '2026-09': Object.assign({}, base) }; run();
const curDates = seenDates.find(ds => ds[0].startsWith('2026-09'));
check('this month counts only days already over - not today, not later dates', curDates.length === 14 && curDates[curDates.length - 1] === '2026-09-14', curDates.slice(-2));

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
