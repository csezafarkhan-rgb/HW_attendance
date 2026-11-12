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
  /* The weights live in a list now - one pair per question - because the desk
     figure is only weighed where there is something to weigh. Read from that
     list, so the printed line and the arithmetic still have to agree. */
  const score = /function perfScore[\s\S]*?\n  \}/.exec(src)[0];
  const weights = (score.match(/\[(0\.\d+), /g) || [])
    .map(w => Math.round(parseFloat(w.slice(1)) * 100));
  const said = (/ranked by score: ([^<]*)/.exec(src) || [])[1] || '';
  const printed = (said.match(/(\d+)%/g) || []).map(x => parseInt(x, 10));
  check('the weights printed over the table are the weights the score uses',
    weights.length === 5 && printed.length === 5
      && weights.slice().sort().join() === printed.slice().sort().join(),
    { inPerfScore: weights, printed: printed, said: said.trim() });
  check('and it no longer calls breaks a part of the score',
    !/ranked by score:[^<]*break/i.test(src), said.trim());
}

/* ---- a day with no row at all ----
   Attendance read 100% for somebody with one marked day in a month and
   nothing else: a day with no record left the denominator as well as the
   numerator, so the figure rose as the record emptied. Somebody who never
   clocked in all month scored full marks for attendance.

   'Gap' is nobody the fixtures above know, so every getter hands back
   nothing for every day - which is exactly the shape being tested. */
{
  const gap = ctx.computeEmployeeStats('Gap', DATES);
  /* Of the fourteen: two Sundays and two Saturdays owe nothing, one is a
     holiday. Nine working days, every one of them bare. */
  check('a working day with no record counts as an absence',
    gap.absentDays === 9, { absent: gap.absentDays, expected: 9 });
  check('so somebody with nothing on the month reads nought, not full marks',
    gap.attendancePct === 0, gap.attendancePct);
  check('and the bare days are not counted as present',
    gap.presentDays === 0 && gap.workedMin === 0, gap);
  /* The days that owe nothing still owe nothing. A Sunday is not an absence
     and neither is a holiday - which is the question the record cannot
     answer for a missing row, so owedMinutes is asked instead. */
  check('a Sunday, a Saturday off and a holiday are none of them absences',
    gap.absentDays === DATES.length - 5, { absent: gap.absentDays, of: DATES.length });
  check('the holiday is still counted as one',
    gap.holidayDays === 1, gap.holidayDays);
  /* A day still running is nobody's absence yet. */
  const ahead = ctx.computeEmployeeStats('Gap', ['2026-07-01', '2026-07-02', '2026-07-03']);
  check('today and the days after it are not absences',
    ahead.absentDays === 0, ahead.absentDays);

  /* The reported shape: one day marked, the rest of the month empty. It read
     100% off that single day. */
  const one = ctx.computeEmployeeStats('Ravi', ['2026-06-01', '2026-06-02', '2026-06-03']);
  check('a month that is genuinely all marked is unaffected',
    one.attendancePct === 100 && one.absentDays === 0, one.attendancePct);
  const mixed = ctx.computeEmployeeStats('Ravi',
    ['2026-06-01', '2026-06-15', '2026-06-16', '2026-06-17']);
  check('but one marked day beside three empty ones is not full attendance',
    mixed.attendancePct === 25 && mixed.absentDays === 3,
    { pct: mixed.attendancePct, absent: mixed.absentDays });
  /* The same question the waiting list asks of the same day, so the panel
     that calls it unanswered and the figure that counts it cannot disagree. */
  check('the question put is whether they were due in, not what the row says',
    /if\(!owedMinutes\(empName, dateStr\)\) return;/.test(src)
    && /if\(dateStr >= todayISO_full\) return;/.test(src), null);
}

/* ---- a month that is not over yet ----
   Hours owed counted every day in the range, so on the twelfth of a month the
   month had already asked for all of itself. "45:16 of 187:00 hrs" - 24% of
   the hours met, a figure that could not have passed forty whatever anybody
   did, and that rose on its own as the month ran out. A quarter of the score
   rides on it, which is most of why every name showed a drop.

   The week reckoning beside it has always left a date still to come out
   entirely. This asks the same question the same way. */
{
  /* Ravi's fixture runs 1-14 June. Pretend it is the 10th: the 10th onwards
     has not finished, and cannot have asked for its hours yet. */
  const whole = ctx.computeEmployeeStats('Ravi', DATES);     // todayISO_full is 2026-07-01
  const part = (() => {
    const saved = ctx.todayISO_full;
    vm.runInContext('todayISO_full = "2026-06-10";', ctx);
    const r = ctx.computeEmployeeStats('Ravi', DATES);
    vm.runInContext('todayISO_full = "' + saved + '";', ctx);
    return r;
  })();
  check('a finished month asks for all of its hours',
    whole.owedMin > 0 && whole.owedMin === part.owedMin + ctx.owedMinutes('Ravi', '2026-06-10')
      + ctx.owedMinutes('Ravi', '2026-06-12'),
    { whole: whole.owedMin, part: part.owedMin });
  check('a month still running asks only for the days that are over',
    part.owedMin < whole.owedMin, { part: part.owedMin, whole: whole.owedMin });
  /* The other half of it: a ratio with today on one side and not the other
     would read over a hundred per cent all afternoon and fall back at
     midnight. */
  check('the hours counted against them stop at the same day',
    part.workedDoneMin <= part.workedMin && part.workedDoneMin < whole.workedMin,
    { done: part.workedDoneMin, all: part.workedMin });
  check('while the worked total still shows today, because it is a total',
    part.workedMin === whole.workedMin, { part: part.workedMin, whole: whole.workedMin });
  check('so hours met is taken from the days that are over',
    part.hoursMetPct === Math.round(part.workedDoneMin / part.owedMin * 100),
    { pct: part.hoursMetPct });
  /* The fault's own shape: owed complete while worked had barely started. */
  check('and a part-finished month is no longer measured against the whole of it',
    part.hoursMetPct > Math.round(part.workedDoneMin / whole.owedMin * 100),
    { now: part.hoursMetPct, was: Math.round(part.workedDoneMin / whole.owedMin * 100) });
  check('a finished month is unchanged by any of it',
    whole.workedDoneMin === whole.workedMin
    && whole.hoursMetPct === Math.round(whole.workedMin / whole.owedMin * 100),
    { done: whole.workedDoneMin, all: whole.workedMin });
  /* The score reads the same pair, or it would disagree with the column. */
  check('the score measures the hours the same way the column does',
    /s\.workedDoneMin == null \? \(s\.workedMin \|\| 0\) : s\.workedDoneMin/.test(src), null);
  /* The comparison period is cut to the same number of days, or every count
     on the page reads as a drop for three weeks of every month. */
  check('last month is compared only as far as this one has got',
    /prevDates = prevDates\.filter\(function\(d\)\{ return d\.slice\(8\) <= cut; \}\);/.test(src)
    && /var running = dates\.filter\(function\(d\)\{ return d >= todayISO_full; \}\)\.length > 0;/
         .test(src), null);
  check('and it says so, rather than quietly comparing a shorter month',
    /' to the ' \+ parseInt\(cut, 10\) \+ 'th'/.test(src), null);
}

/* ---- the desk figure, where there is no desk to figure ----
   It is worked out from punch times, and somebody who works wholly from home
   has none. Scoring them 100 on it was meant to mean "not marked down", but
   100 is marked up: it is the one component a measured person can only lose
   on, so the untracked beat the tracked on a question neither was asked. */
{
  vm.runInContext('var SCORE_GIVEN_FULL = '
    + (/SCORE_GIVEN_FULL = ([\d.]+)/.exec(src) || [, '0.05'])[1] + ';', ctx);
  vm.runInContext(lift(src, 'perfScore'), ctx);
  const base = { attendancePct: 80, punctualityPct: 80, onTimePct: 80,
                 owedMin: 1000, workedDoneMin: 800, workedMin: 800, excusedMin: 0,
                 weekExtraMin: 0 };
  const tracked   = Object.assign({}, base, { durDays: 10, inOfficePct: 90 });
  const untracked = Object.assign({}, base, { durDays: 0,  inOfficePct: 100 });
  const sTracked = ctx.perfScore(tracked), sUn = ctx.perfScore(untracked);
  /* 0.30*80 + 0.25*80 + 0.25*80 + 0.05*0 = 64, over a weight of 0.85 = 75.
     Which is to say: they are scored as though the desk figure had come out
     at their own average across everything else, rather than at a hundred. */
  check('with nothing to measure, the four that remain carry the score',
    sUn === Math.round((0.30*80 + 0.25*80 + 0.25*80 + 0.05*0) / 0.85), sUn);
  /* The same person with the desk measured at 90 scores 81.5 -> 82: the
     component is now earned rather than given. */
  check('and a measured desk figure still counts for its fifteen',
    sTracked === Math.round((0.30*80 + 0.25*80 + 0.25*80 + 0.05*0 + 0.15*90)), sTracked);
  check('so being untracked is no longer worth more than being good at it',
    ctx.perfScore(Object.assign({}, base, { durDays: 10, inOfficePct: 100 })) > sUn,
    { perfectDesk: ctx.perfScore(Object.assign({}, base, { durDays: 10, inOfficePct: 100 })),
      noDesk: sUn });
  /* It used to be a straight gift of fifteen points. */
  check('the free full marks are gone',
    sUn < Math.round(0.30*80 + 0.25*80 + 0.25*80 + 0.05*0 + 0.15*100), sUn);
  /* Which is the fair line: a measured person whose desk figure lands on that
     same average scores exactly what an unmeasured one does. Above it they
     gain, below it they lose, and nobody is punished for being measured. */
  check('a desk figure equal to that average scores the same as no figure',
    ctx.perfScore(Object.assign({}, base, { durDays: 10, inOfficePct: sUn })) === sUn,
    { tracked: ctx.perfScore(Object.assign({}, base, { durDays: 10, inOfficePct: sUn })),
      untracked: sUn });
  check('and below it they lose, which is the whole point',
    ctx.perfScore(Object.assign({}, base, { durDays: 10, inOfficePct: 40 })) < sUn, null);
  check('a tracked person is weighed over the whole hundred',
    /if\(s\.durDays > 0 && s\.inOfficePct != null\) parts\.push\(\[0\.15, s\.inOfficePct\]\);/
      .test(src), null);

  /* The sheet works the score out again with its own formula. Left at a flat
     0.15 it would read the now-blank desk cell as a nought and dock fifteen
     points from exactly the people this was changed for. */
  check('the exported formula leaves the desk out when there is no figure',
    /IF\(ISNUMBER\('\s*\+\s*cell\('At desk %', rowNo\)\s*\+\s*'\),0\.15\*/.test(src), null);
  check('and divides by the weight it actually used',
    /\)\/IF\(ISNUMBER\('\s*\+\s*cell\('At desk %', rowNo\)\s*\+\s*'\),1,0\.85\)/.test(src), null);
  check('the sheet writes no figure where the page shows a dash',
    /\(st\.durDays > 0 && st\.inOfficePct != null\)/.test(src), null);
  /* The page explains its own weights above the table. It had to stop saying
     something that is no longer true for everybody on it. */
  check('and the page says what it does when there is nothing to measure',
    /the other four carry the score/.test(src), null);
}

/* ---- what the callouts call people, and how they count ---- */
{
  check('the callouts name people the way the rest of the page does',
    !/d:byScore\[0\]\.name/.test(src) && !/d:lateSum\.name/.test(src)
    && !/d:outMost\.name/.test(src) && !/d:over\.name/.test(src), null);
  check('and one day is a day, not “1 days”',
    !/\+' days over the '/.test(src) && !/lateSum\.lateDays\+' days, '/.test(src)
    && !/s\.lateDays\+' days, '/.test(src), null);
  check('the hours-worked caption says which days its percentage came from',
    /% of owed, counting to yesterday/.test(src), null);
  /* All seven read "Name — something", and one of them lost its space in the
     editing of the other six: "Aman Chandra— 4 days over the break". Checked
     as a set, because a separator is exactly the sort of thing nobody reads
     twice. */
  {
    const callouts = ['Highest score', 'Needs attention', 'Most improved', 'Biggest drop',
                      'Most extra hours', 'Most time out', 'Most lateness'];
    /* Stated as the defect rather than as the shape: a dash sitting straight
       against the closing quote, with no space to separate it from the name
       that goes before it. */
    const bad = callouts.filter(t => {
      const line = new RegExp("t:'" + t + "'[^\\n]*").exec(src);
      if (!line) return true;
      return /\+'(—|\\u2014)/.test(line[0]);
    });
    check('every callout separates the name from the figure the same way',
      bad.length === 0, bad);
  }
}

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
