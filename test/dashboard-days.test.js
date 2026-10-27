// The days behind a figure must be the same days the figure counted.
//
// The comparison table says "8 (11:27)" against Late. Hovering it now reads out
// which eight days and by how much. Those are two pieces of code looking at the
// same month, and the rules are fussy: an excused lateness is not a late day, a
// holiday is not a working day, an override settles a day whatever the punch
// file says. If the two ever drift the table will say one thing and the card
// another, in front of the person being talked about.
//
// So the counts are checked against each other rather than against figures
// written down here.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* ---- a stand-in month with one of everything ---- */
const DATES = [];
for (let d = 1; d <= 14; d++) DATES.push('2026-06-' + String(d).padStart(2, '0'));
// 2026-06-07 and -14 are Sundays; -06 and -13 are Saturdays.
const HOLS = { '2026-06-11': { name: 'Eid', note: '' } };
const RECS = {
  'Ravi|2026-06-01': { 'in': '9:30', out: '18:30', dur: '9:00', st: 'PR' },
  'Ravi|2026-06-02': { 'in': '10:05', out: '18:35', dur: '8:30', st: 'PR' },   // 35 late
  'Ravi|2026-06-03': { 'in': '10:20', out: '18:30', dur: '8:10', st: 'PR' },   // 50 late, excused
  'Ravi|2026-06-04': { 'in': '9:28', out: '17:10', dur: '7:42', st: 'PR' },    // 80 early
  'Ravi|2026-06-05': { 'in': '9:31', out: '16:30', dur: '6:59', st: 'HD' },    // half day
  'Ravi|2026-06-07': { 'in': '10:00', out: '15:00', dur: '5:00', st: 'PR' },   // a Sunday worked
  'Ravi|2026-06-08': { 'in': '9:33', out: '18:30', dur: '8:57', st: 'PR' },
  'Ravi|2026-06-09': { 'in': '9:29', out: '18:31', dur: '9:02', st: 'PR' },    // mispunch
  'Ravi|2026-06-11': { 'in': '11:00', out: '15:00', dur: '4:00', st: 'PR' },   // a holiday worked
  'Ravi|2026-06-12': { 'in': '9:30', out: '18:30', dur: '9:00', st: 'PR' }
};
const OVER = {
  'Ravi|2026-06-10': { cat: 'LEAVE', detail: 'Sick' },
  'Ravi|2026-06-08': null
};
const WFH_VISIT = { 'Ravi|2026-06-01': null };
const HALF = { 'Ravi|2026-06-05': { kind: 'HALF', leave: 'CL', note: 'dentist' } };
const LATE_EXC = { 'Ravi|2026-06-03': { note: 'client meeting ran over' } };
const EARLY_EXC = {};
const MISPUNCH = { 'Ravi|2026-06-09': { note: 'reader down' } };

const toMin = t => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : 0;
};
const ctx = {
  console, Math, Date, String, Number, Object, Array, JSON, isNaN, parseInt, parseFloat,
  lateThresholdMin: 10, earlyThresholdMin: 10, BREAK_ALLOW_MIN: 60,
  todayISO_full: '2026-07-01',
  OV_CATS: { LEAVE: { label: 'Leave', countsAsWorked: false },
             WFH: { label: 'From home', countsAsWorked: true },
             VISIT: { label: 'Visit', countsAsWorked: true },
             OTHER: { label: 'Other', countsAsWorked: true } },
  toMin,
  getOfficialLeave: d => HOLS[d] || null,
  getRecord: (e, d) => RECS[e + '|' + d] || null,
  getOverride: (e, d) => OVER[e + '|' + d] || WFH_VISIT[e + '|' + d] || null,
  getHalfDay: (e, d) => HALF[e + '|' + d] || null,
  getLateExcuse: (e, d) => LATE_EXC[e + '|' + d] || null,
  getEarlyExcuse: (e, d) => EARLY_EXC[e + '|' + d] || null,
  getMispunch: (e, d) => MISPUNCH[e + '|' + d] || null,
  getSatPolicy: () => ({ mode: 'OFF', hours: 4 }),
  getShift: () => '9:30-6:30',
  getJoinDate: () => '',
  beforeJoining: () => false,
  computeDurations: r => ({ totalMin: toMin(r.out) - toMin(r['in']), inMin: toMin(r.dur),
                            outMin: Math.max(0, (toMin(r.out) - toMin(r['in'])) - toMin(r.dur)) }),
  computeWeeklyShortHours: () => ({ weekTotals: {}, weekDays: {}, weekOpen: {} }),
  weekdayName: d => ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(d + 'T00:00:00').getDay()],
  monthLabelShort: ym => 'Jun ' + ym.slice(0, 4),
  fmtTime: t => t || '',
  fmtMin: m => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0')
};
vm.createContext(ctx);
['parseShift', 'shiftMin', 'getLateEarly', 'owedMinutes', 'workedMinutes', 'hdQty', 'hdLabel',
 'minsSaid', 'dashDayLabel', 'dashCellDays', 'computeEmployeeStats'
].forEach(n => vm.runInContext(lift(src, n), ctx));

const stats = ctx.computeEmployeeStats('Ravi', DATES);
const days = k => ctx.dashCellDays('Ravi', k, DATES);

/* ---- the card and the number have to agree ---- */
check('the late days listed are the late days counted',
  days('late').length === stats.lateDays && stats.lateDays > 0,
  { card: days('late').map(x => x.d), count: stats.lateDays });
check('and an excused lateness is in neither',
  !days('late').some(x => x.d === '2026-06-03'), days('late'));
/* Worth knowing, and not something these two disagree about: a day that owed
   nothing is still measured against the shift, so coming in at ten on a Sunday
   nobody asked you to work counts as a late arrival - and against the score.
   The card says the same as the number, which is what is being checked here;
   whether the number is right is a separate question for the office. */
check('a day given over is still judged against the shift, by the card and the count alike',
  days('late').some(x => x.d === '2026-06-07')
    && days('extra').some(x => x.d === '2026-06-07')
    && days('late').length === stats.lateDays,
  { late: days('late').map(x => x.d), extra: days('extra').map(x => x.d) });
check('the early departures listed are the ones counted',
  days('early').length === stats.earlyDays && stats.earlyDays > 0,
  { card: days('early').map(x => x.d), count: stats.earlyDays });
check('the excused days listed are the ones counted',
  days('excused').length === stats.excusedTotal && stats.excusedTotal > 0,
  { card: days('excused'), count: stats.excusedTotal });
check('the mispunches listed are the ones counted',
  days('mispunch').length === stats.mispunches && stats.mispunches > 0,
  { card: days('mispunch'), count: stats.mispunches });
check('the days visiting listed are the ones counted',
  days('visit').length === stats.visitDays, { card: days('visit'), count: stats.visitDays });

/* A day given over is a day that asked for nothing and was worked anyway - a
   Sunday, a Saturday that is theirs, or a holiday. The holiday used to be
   counted out before the question was even asked. */
check('a day worked when nothing was owed is listed, and counted',
  days('extra').length === stats.extraDays && stats.extraDays === 2,
  { card: days('extra'), count: stats.extraDays });
check('and a holiday worked is one of them',
  days('extra').some(x => x.d === '2026-06-11')
    && days('extra').some(x => x.d === '2026-06-07'), days('extra'));
check('the holiday says which holiday it was',
  /Eid/.test((days('extra').find(x => x.d === '2026-06-11') || {}).t || ''), days('extra'));

/* ---- what each line says ---- */
check('a late day says when they came and by how much',
  /10:05/.test(days('late')[0].t) && /35 min late/.test(days('late')[0].t), days('late')[0]);
/* Under an hour in minutes, an hour or more in hours: a drill-down read
   "256 min early", which is four hours and a quarter and reads as neither. */
check('minutes past the hour are said as hours',
  ctx.minsSaid(256) === '4:16' && ctx.minsSaid(35) === '35 min' && ctx.minsSaid(60) === '1:00',
  [ctx.minsSaid(256), ctx.minsSaid(35), ctx.minsSaid(60)]);
check('and a bar for a figure of nothing is drawn as nothing',
  /var pct = r\.v > 0 \? Math\.max\(2,/.test(src) && /var w = pct > 0 \? Math\.max\(2,/.test(src),
  'the 2% floor still applies to a zero');
check('an excused day gives the reason that was written',
  /client meeting ran over/.test(days('excused')[0].t), days('excused')[0]);
check('a part day names what sort it was, and its note',
  days('part').length === 1 && /Half day/.test(days('part')[0].t)
    && /dentist/.test(days('part')[0].t), days('part'));
check('a date reads as a day and a month, not as a number',
  ctx.dashDayLabel('2026-06-02') === 'Tue 2 Jun', ctx.dashDayLabel('2026-06-02'));

/* ---- and nothing is listed for a day nobody was there ---- */
check('a holiday is not a late day, however late the punch',
  !days('late').some(x => x.d === '2026-06-11'), days('late'));
check('a day on leave is not a part day',
  !days('part').some(x => x.d === '2026-06-10'), days('part'));

/* ---- the table's own list ---- */
const page = /function renderDashboardPage\(\)[\s\S]*?\n  \}/.exec(src)[0];
check('the Absent column is gone, Leave having said it',
  page.indexOf("{t:'Absent'") === -1 && page.indexOf("{t:'Leave'") > -1);
/* And the card above it, for the same reason: nobody here is marked absent, so
   it read nought every month and the drill behind it listed nothing. */
check('the Absences card is gone too, along with the drill behind it',
  src.indexOf("'Absences'") === -1 && src.indexOf("absent:  {t:") === -1
    && src.indexOf('sumAbsent') === -1,
  [src.indexOf("'Absences'"), src.indexOf('sumAbsent')]);
check('the ranking is drawn from its own list, not from everybody',
  /var tableStats = DASH_HIDE_WFH/.test(page) && /var rows = tableStats\.map/.test(page),
  (/var rows = \w+\.map/.exec(page) || [])[0]);
check('while the figures above it still count everybody',
  page.indexOf('var kpi') < page.indexOf('var tableStats'));
check('people working wholly from home are folded away to begin with',
  /var DASH_HIDE_WFH = true;/.test(src));
check('and the switch remembers what you chose',
  /hw_dash_hide_wfh/.test(src));
check('a cell with nothing in it is not made to look hoverable',
  /var has = String\(inner\) !== '\\u2014'/.test(page), 'the dash guard');

/* ---- the table explains itself, and explains itself correctly ---- */
{
  const cols = /var cols = \[[\s\S]*?\];/.exec(page)[0];
  const named = (cols.match(/\{t:/g) || []).length;
  const helped = (cols.match(/h:'/g) || []).length;
  check('every column says what it means', named === helped && named > 15,
    { columns: named, explained: helped });
  check('Part-day is gone, its leave already counted in Leave',
    cols.indexOf("{t:'Part-day'") === -1 && cols.indexOf("{t:'Leave'") > -1);
  check('and the Part-day card went with it',
    src.indexOf("'Part-day Leave'") === -1 && src.indexOf('partday') === -1,
    [src.indexOf("'Part-day Leave'"), src.indexOf('partday')]);

  /* The line over the table described a score the page had stopped using: it
     said 35 / 25 / 15 / 15 / 10 and named breaks as part of it, which they are
     not, while leaving out the time given, which is. A page that explains
     itself wrongly is worse than one that does not explain itself, so the
     weights it prints are held to the ones perfScore actually uses. */
  const score = /function perfScore[\s\S]*?return[^;]*;/.exec(src)[0];
  const weights = (score.match(/0\.\d+\*/g) || []).map(w => Math.round(parseFloat(w) * 100));
  const said = (/ranked by score: ([^<]*)/.exec(src) || [])[1] || '';
  const printed = (said.match(/(\d+)%/g) || []).map(x => parseInt(x, 10));
  check('the weights printed over the table are the weights the score uses',
    weights.length === 5 && printed.length === 5
      && weights.every((w, i) => w === printed[i]),
    { inPerfScore: weights, printed: printed, said: said.trim() });
  check('and it no longer calls breaks a part of the score',
    !/ranked by score:[^<]*break/i.test(src), said.trim());
}

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
