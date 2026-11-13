/* What the record is waiting on one person for.
 *
 * Four things can be outstanding against somebody, and they divide in two by
 * the only question that matters to the person looking at the list: can I
 * finish this myself, or am I waiting on somebody else?
 *
 *   theirs  - leave the record holds with no form behind it, a late morning
 *             nobody has explained, and a request somebody queried;
 *   others' - a request sent and not yet answered.
 *
 * The queried one is why the split is worth drawing. It sits in the same
 * store as the other waiting requests and is the opposite of them: telling
 * somebody to go and chase a question that is waiting on their own reply is
 * telling them to chase themselves.
 *
 * None of this is new information - every piece of it was already on the
 * page. What was missing was anywhere that said so: the day card reaches
 * today and yesterday, so a late Tuesday three weeks back had nowhere to be
 * answered from at all.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const MAILER = fs.readFileSync(path.join(REPO, 'mailer.js'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; k++;
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
      continue;
    }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* ---- the sorting of one person's outstanding days ---- */
const ctx = vm.createContext({ console, Date, Math, isNaN, String, Number, Object, Array });
['ewDaysSince', 'ewKindTag', 'ewCost'].forEach(n => vm.runInContext(grab(APP, n), ctx));
vm.runInContext('function isPartDay(t){ return t==="HALF"||t==="SHORT"||t==="THREEQ"; }', ctx);
vm.runInContext('function hdQty(k){ return k==="SHORT"?0.25:k==="THREEQ"?0.75:0.5; }', ctx);

check('a half day is named a half day, not a fraction',
  ctx.ewKindTag('HALF').txt === 'Half day', ctx.ewKindTag('HALF'));
check('a short leave is named too',
  ctx.ewKindTag('SHORT').txt === 'Short leave', ctx.ewKindTag('SHORT'));
check('a three-quarter day as well',
  ctx.ewKindTag('THREEQ').txt === 'Three-quarter', ctx.ewKindTag('THREEQ'));
check('and anything else is a full day',
  ctx.ewKindTag('CL').txt === 'Full day' && ctx.ewKindTag('Sick').txt === 'Full day', null);
/* The name alone is not checkable against the balance on the same page, so
   what it costs is said beside it in the figures the record counts by. */
check('a half day says it costs half a day',
  ctx.ewCost('HALF') === '0.5 days off your casual', ctx.ewCost('HALF'));
check('a short leave a quarter',
  ctx.ewCost('SHORT') === '0.25 days off your casual', ctx.ewCost('SHORT'));
check('a full day one, said as a day rather than days',
  ctx.ewCost('CL') === '1 day off your casual', ctx.ewCost('CL'));
check('and sick leave comes off the sick balance',
  ctx.ewCost('Sick', 'Sick') === '1 day off your sick', ctx.ewCost('Sick', 'Sick'));

/* Ageing, which is what makes one of these shout and the rest wait. */
const iso = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
check('today is nought days old', ctx.ewDaysSince(iso(0)) === 0, ctx.ewDaysSince(iso(0)));
check('a week ago is seven', ctx.ewDaysSince(iso(7)) === 7, ctx.ewDaysSince(iso(7)));
check('rubbish is not a negative age', ctx.ewDaysSince('not-a-day') === 0, null);
check('nor is nothing at all', ctx.ewDaysSince('') === 0 && ctx.ewDaysSince(null) === 0, null);

/* ---- the split, which is the whole point ---- */
const gather = grab(APP, 'ewGather');
check('leave with no form behind it is theirs to finish',
  /mine\.push\(\{ job:'form'/.test(gather), null);
check('so is a late morning nobody has explained',
  /mine\.push\(\{ job:'late'/.test(gather), null);
check('and so is a question somebody asked back',
  /if\(r\.status === 'query'\)\{[\s\S]{0,160}mine\.push\(\{ job:'reply'/.test(gather), null);
check('a request still waiting is not theirs to finish',
  /theirs\.push\(\{ job:'chase'/.test(gather), null);
check('and it is the only thing in that column',
  (gather.match(/theirs\.push\(/g) || []).length === 1, null);
/* A query must never be filed as something to chase: that is the one case
   where "ask your manager" would mean "ask yourself". */
{
  /* The whole of the query branch: it must file the thing under theirs and
     then leave, so execution never reaches the chasing code below it. */
  const branch = /if\(r\.status === 'query'\)\{([\s\S]*?)\n      \}/.exec(gather);
  check('a query is taken out before the chasing list is reached',
    !!branch && /job:'reply'/.test(branch[1]) && /\breturn;/.test(branch[1])
    && gather.indexOf("job:'reply'") < gather.indexOf("job:'chase'"),
    branch && branch[1].replace(/\s+/g, ' ').trim().slice(0, 120));
}
check('only a request actually waiting is chased',
  /if\(r\.status !== 'pending' && r\.status !== 'recommended'\) return;/.test(gather), null);
check('a request passed on is with the management, not the first approver',
  /if\(r\.status === 'recommended'\)\{ who = 'the management'; \}/.test(gather), null);
check('and otherwise it names whoever the office named against them',
  /approverLabel\(x\)/.test(gather), null);

/* ---- what it refuses to nag about ---- */
check('nothing older than the request form can reach for',
  /if\(u\.empName !== name \|\| u\.dateFrom < floor\) return;/.test(gather)
  && /ewDays\(floor\)\)\.forEach/.test(gather), null);
check('and the floor is the form’s own, not a second number',
  /back = earliestRequestDay\(\);/.test(grab(APP, 'ewFloor')), null);
check('a day they were signed off for is not lateness',
  /if\(onApprovedLeave\(name, d\)\) return;/.test(gather), null);
check('nor a lateness already answered, by them or by the office',
  /if\(getLateExcuse\(name, d\) \|\| getLatePlea\(name, d\)\) return;/.test(gather), null);
check('an archived request is nobody’s job',
  /if\(r\.archived\) return;/.test(gather), null);
check('the oldest is put first, because that is the one being forgotten',
  /return y\.age - x\.age;/.test(gather), null);

/* ---- this month, and no further back ----
   A reminder that opens on 26 Oct asks somebody to reopen a month already
   counted and paid, and the message's own promise - quicker now than at the
   end of the month - is about this month. The form may still reach back
   thirty days; what is worth chasing is a different question. */
{
  const floor = grab(APP, 'ewFloor');
  check('the list never opens on last month',
    /var first = String\(todayISO_full\)\.slice\(0, 8\) \+ '01';/.test(floor)
    && /return back > first \? back : first;/.test(floor), null);
  check('and the form’s own window still applies when it is the shorter one',
    /back = earliestRequestDay\(\);/.test(floor), null);
  const mf = grab(SRV, 'monthFloor');
  const mctx = vm.createContext({ String });
  vm.runInContext(mf, mctx);
  check('the message takes the same floor the page does',
    mctx.monthFloor('2026-10-07', '2026-11-06') === '2026-11-01',
    mctx.monthFloor('2026-10-07', '2026-11-06'));
  check('and a shorter back window still wins over the month',
    mctx.monthFloor('2026-11-04', '2026-11-06') === '2026-11-04',
    mctx.monthFloor('2026-11-04', '2026-11-06'));
  check('mid-month, the first of the month is where it starts',
    mctx.monthFloor('2026-11-01', '2026-11-20') === '2026-11-01', null);
  check('the reminder asks for it from that floor',
    /const since = monthFloor\(new Date\(now\.getTime\(\) - back \* 86400000\)/
      .test(SRV), null);
}

/* ---- a day with nothing on it at all ----
   The one gap this panel could not see. The loop that finds a late morning
   asks for an arrival time and leaves the moment there isn't one, so a day
   somebody never clocked in for fell straight through - while being the most
   expensive kind of gap there is, because it counts as a full day absent
   until somebody says otherwise. */
{
  check('a working day with nothing on it is raised',
    /mine\.push\(\{ job:'absent', day:d, age:ewDaysSince\(d\) \}\);/.test(gather), null);
  /* One pass over the days, so a date cannot come out both late and missing. */
  check('found in the same pass as lateness, not a second one',
    (gather.match(/ewDays\(floor\)\)\.forEach/g) || []).length === 1, null);
  /* The days are the floor to today, walked. Not the months ticked on the
     admin grid's picker, which is a different question that happens to hand
     back dates - a page whose grid sat on September searched September for
     days that can only be in November and reported nothing to settle. */
  check('the days walked are this panel\u2019s own, not the grid\u2019s month picker',
    !/allSelectedDates\(\)/.test(gather), null);
  {
    const c = vm.createContext({ Date, isNaN, Array });
    vm.runInContext('var todayISO_full = "2026-11-06";'
      + 'function isoOf(d){ return d.getFullYear() + "-" '
      + '+ ("0"+(d.getMonth()+1)).slice(-2) + "-" + ("0"+d.getDate()).slice(-2); }'
      + grab(APP, 'ewDays'), c);
    check('it walks from the floor to today, today included',
      JSON.stringify(c.ewDays('2026-11-03'))
        === JSON.stringify(['2026-11-03','2026-11-04','2026-11-05','2026-11-06']),
      c.ewDays('2026-11-03'));
    check('a floor after today walks nothing rather than backwards',
      c.ewDays('2026-11-09').length === 0, c.ewDays('2026-11-09'));
    check('and a floor that is rubbish draws a short list rather than spinning',
      c.ewDays('not-a-day').length === 0 && c.ewDays('2020-01-01').length === 400, null);
  }
  check('today is the clock-in item’s, not this one’s',
    /if\(d >= mineDay\) return;/.test(gather), null);
  check('nobody is chased for a day before they joined',
    /if\(beforeJoining\(name, d\)\) return;/.test(gather), null);
  check('nor for a weekly off',
    /var woff = weeklyOffDay\(name, d, use\);[\s\S]{0,60}woff\.weeklyOff\) return;/.test(gather),
    null);
  check('nor a holiday or a day signed off, which onApprovedLeave already asks',
    gather.indexOf('onApprovedLeave(name, d)') < gather.indexOf("job:'absent'"), null);
  check('a day the office has written against is theirs, not this list’s',
    /if\(getOverride\(name, d\)\) return;/.test(gather), null);
  check('and a day a form already covers is not asked for twice',
    /if\(ewSpokenFor\(name, d\)\) return;/.test(gather), null);
  /* A punch correction answers the same question as a leave form: both say
     what the day was. Only a refused or withdrawn one accounts for nothing. */
  {
    const spoke = grab(APP, 'ewSpokenFor');
    const c = vm.createContext({ String, Array });
    vm.runInContext('var leaveRequests = [];' + spoke, c);
    const set = rs => { c.leaveRequests = rs; };
    set([{ empName: 'M', status: 'pending', dateFrom: '2026-11-05', dateTo: '2026-11-05' }]);
    check('a request waiting on somebody still covers the day',
      c.ewSpokenFor('M', '2026-11-05') === true, null);
    set([{ empName: 'M', status: 'approved', leaveType: 'PUNCH',
           dateFrom: '2026-11-05', dateTo: '2026-11-05' }]);
    check('so does a punch correction',
      c.ewSpokenFor('M', '2026-11-05') === true, null);
    set([{ empName: 'M', status: 'rejected', dateFrom: '2026-11-05', dateTo: '2026-11-05' }]);
    check('a refused one covers nothing',
      c.ewSpokenFor('M', '2026-11-05') === false, null);
    set([{ empName: 'M', status: 'cancelled', dateFrom: '2026-11-05', dateTo: '2026-11-05' }]);
    check('nor one taken back',
      c.ewSpokenFor('M', '2026-11-05') === false, null);
    set([{ empName: 'M', status: 'approved', dateFrom: '2026-11-02', dateTo: '2026-11-06' }]);
    check('a range covers every day inside it',
      c.ewSpokenFor('M', '2026-11-05') === true
      && c.ewSpokenFor('M', '2026-11-07') === false, null);
    set([{ empName: 'Other', status: 'approved', dateFrom: '2026-11-05', dateTo: '2026-11-05' }]);
    check('and somebody else’s form covers nothing of theirs',
      c.ewSpokenFor('M', '2026-11-05') === false, null);
  }
  /* The same two answers as the morning still running, asked about a day gone
     by. Neither is picked for them. */
  const rr = grab(APP, 'renderEmpWaiting');
  check('it asks whether they were off, or here',
    /data-ew-here="/.test(rr) && /job === 'absent'/.test(rr), null);
  check('and says what it costs until one of them is given',
    /counts as a full day absent/.test(rr), null);
  check('“I was here” is a punch correction, which the form already has',
    /ewOpenForm\(d, 'PUNCH', ''/.test(grab(APP, 'ewWire')), null);
  check('and the form is filled in for that day, not for today',
    /d === todayISO_full \? 'today' : fmtDayShortish\(d\)/.test(grab(APP, 'ewWire')), null);

  /* The message about the list has to find it too, or the page says seven and
     the email says four. */
  check('the reminder walks the days rather than the rows it has',
    /if \(iso >= today\) break;/.test(SRV)
    && /add\(name, \{ job: 'absent', day \}\);/.test(SRV), null);
  check('and asks the roster who was meant to be in',
    /SELECT name FROM employees WHERE org_id = \$1 AND is_active/.test(SRV), null);
  check('Sunday is off for everybody, Saturday for whoever has it set so',
    /if \(dow === 0 \|\| \(dow === 6 && satOff\)\) return;/.test(SRV), null);
  check('a day already marked, or already filed for, is not asked for again',
    /if \(marked\[key\] \|\| filed\[key\]\) return;/.test(SRV), null);
  check('a typed time counts as marked, same as a punch',
    /Object\.keys\(manual\)\.forEach/.test(SRV), null);
  check('and nobody is chased for a day before they joined',
    /if \(join && day < join\) return;/.test(SRV), null);
  {
    const nj = grab(SRV, 'normJoinDay');
    const c = vm.createContext({ String });
    vm.runInContext(nj, c);
    check('a joining date reads the same on both sides',
      c.normJoinDay('2026-3-4') === '2026-03-04'
      && c.normJoinDay('4/3/2026') === '2026-03-04', c.normJoinDay('4/3/2026'));
    check('and something unreadable chases nobody',
      c.normJoinDay('') === '' && c.normJoinDay('rubbish') === '', null);
  }
  check('the message says what the day costs, as the page does',
    /Never clocked in, and no form for it/.test(MAILER), null);
}

/* ---- the morning happening now ----
   Every other thing on this list is about a day gone by. This one is about
   a morning still running: somebody at their desk at a quarter past twelve
   with nothing on the record, which the page could see and said nothing
   about. It is also the only item that gets worse while the page is open. */
{
  const base = {
    console, Date, Math, isNaN, String, Number, Object, Array,
    todayISO_full: '2026-11-06',
    lateThresholdMin: 10,
    toMin: s => { const m = /^(\d+):(\d+)$/.exec(String(s)); return m ? (+m[1] * 60 + +m[2]) : null; },
  };
  const run = (over) => {
    const c = vm.createContext(Object.assign({}, base, over));
    vm.runInContext(grab(APP, 'ewClockItem'), c);
    return c.ewClockItem('Munish Dhamija');
  };
  const ok = {
    empWorkingDay: () => '2026-11-06',
    marksOwn: () => true,
    onApprovedLeave: () => false,
    weeklyOffDay: () => null,
    getRecord: () => null,
    getShift: () => '10:00-19:00',
    nowHHMM: () => '12:18',
  };
  const got = run(ok);
  check('a morning past the start with nothing on the record is raised',
    !!got && got.job === 'clockin', got);
  check('and it says how far past the start it is',
    !!got && got.mins === 138, got && got.mins);
  check('on today, not on some other day',
    !!got && got.day === '2026-11-06', got && got.day);

  check('nothing before the start time',
    run(Object.assign({}, ok, { nowHHMM: () => '09:40' })) === null, null);
  /* The same threshold the record counts lateness by. Two numbers for one
     question is how a page ends up disagreeing with itself in front of
     somebody. */
  check('nor inside the grace the record itself allows',
    run(Object.assign({}, ok, { nowHHMM: () => '10:09' })) === null, null);
  check('but just outside it, yes',
    (run(Object.assign({}, ok, { nowHHMM: () => '10:11' })) || {}).mins === 11, null);
  check('not once they have clocked in',
    run(Object.assign({}, ok, { getRecord: () => ({ 'in': '10:04' }) })) === null, null);
  /* A card reader records the arrival whether anybody is told to or not, so
     this would be telling somebody to press a button they do not have. */
  check('not for somebody whose time the reader marks',
    run(Object.assign({}, ok, { marksOwn: () => false })) === null, null);
  check('not on a day they are signed off for',
    run(Object.assign({}, ok, { onApprovedLeave: () => true })) === null, null);
  check('not on a weekly off',
    run(Object.assign({}, ok, { weeklyOffDay: () => ({ weeklyOff: true }) })) === null, null);
  check('and not when nobody knows what time they start',
    run(Object.assign({}, ok, { getShift: () => '' })) === null, null);
  /* A night shift before the turn: the card's day is yesterday and the start
     was yesterday's, so now is a day further on. Wrapped modulo would read an
     hour before a six o'clock start as twenty-three hours late. */
  const night = run(Object.assign({}, ok, {
    empWorkingDay: () => '2026-11-05', getShift: () => '18:00-3:00',
    nowHHMM: () => '00:30',
  }));
  check('a night shift counts from the evening it began',
    !!night && night.mins === 390, night && night.mins);
  check('and an hour before a night shift starts is not twenty-three hours late',
    run(Object.assign({}, ok, { getShift: () => '18:00-3:00', nowHHMM: () => '17:00' }))
      === null, null);

  check('it leads the list, because it is the one still getting worse',
    /\(y\.job === 'clockin' \? 1 : 0\) - \(x\.job === 'clockin' \? 1 : 0\)/.test(gather), null);
  /* Outside the floor the rest answer to on purpose: that floor is about how
     far back is worth chasing, and on the first of a month a night shift
     begun yesterday would fall off the one list it exists for. */
  check('and the month floor does not swallow it',
    !/ewClockItem[\s\S]{0,80}floor/.test(gather), null);

  /* Two answers, because there are two reasons nothing is on the record and
     the page cannot tell them apart. Asking only the first would push
     somebody on leave to clock in to make the band go away. */
  check('it asks whether they are here, or off',
    /data-ew-clock="1"/.test(grab(APP, 'renderEmpWaiting')) && /data-ew-off="/.test(grab(APP, 'renderEmpWaiting')), null);
  check('“off today” opens the form on that day',
    /ewOpenForm\(d, '', ''/.test(grab(APP, 'ewWire')), null);
  /* Nothing is picked for them: which kind of day off it is changes what it
     costs, and the page does not know which. */
  check('with no kind chosen on their behalf',
    /if\(t && kind\)\{/.test(grab(APP, 'ewOpenForm')), null);
  check('and said as the day it is about rather than as a day off their record',
    /'Filled in for ' \+ \(d === todayISO_full \? 'today'/.test(APP), null);
  /* Clocking in writes a time only the office can correct afterwards, and the
     card is the one place that shows the time about to be written. */
  check('“clock in” goes to the button rather than pressing it',
    /querySelector\('#ckIn'\)/.test(grab(APP, 'ewGoToClock'))
    && !/#ckIn'\)[\s\S]{0,40}\.click\(\)/.test(grab(APP, 'ewGoToClock')), null);
  check('and pressing it clears the band instead of leaving the nag up',
    /renderEmpDayCard\(\);[\s\S]{0,260}renderEmpWaiting\(\);/.test(APP), null);

  /* The figure moves on its own - and in place, because the panel below it
     may have a half-typed reason in it. */
  const tick = grab(APP, 'ewClockTick');
  check('the figure is moved rather than the panel redrawn',
    /el\.textContent = minsSaid\(due\.mins\)/.test(tick)
    && /return;/.test(tick), null);
  check('and the panel is rebuilt only when it has come due or stopped being true',
    /if\(!!el !== !!due\) renderEmpWaiting\(\);/.test(tick), null);
  check('off the same clock as the card, so the two cannot drift apart',
    /ewClockTick\(\);/.test(APP), null);
  check('and never for somebody reading another person’s card',
    /viewRole\.role !== 'employee'\)\) return;/.test(tick), null);
}

/* ---- whose panel it is ---- */
const render = grab(APP, 'renderEmpWaiting');
check('it is drawn for the person it is about and nobody else',
  /viewRole\.role !== 'employee'/.test(render), null);
check('and not at all when there is nothing outstanding',
  /if\(!got\.mine\.length && !got\.theirs\.length\)\{/.test(render), null);
check('the column that is not theirs says so in words',
  /Nothing here is yours to finish/.test(render), null);

/* ---- the actions, which are what make it more than a list ---- */
const form = grab(APP, 'ewOpenForm');
check('the form opens on the day it is about, not on today',
  /if\(from\)\{ from\.value = day;/.test(form), null);
check('and the kind is set before the dates, because it disables the To box',
  form.indexOf('t.value = kind') < form.indexOf('from.value = day'), null);
check('a kind the form does not offer is not forced into it',
  /var has = Array\.prototype\.some\.call\(t\.options/.test(form), null);
check('and it says the form was filled in from the record',
  /Filled in from the day on your record/.test(form), null);
/* The late box writes what the day card writes, so one reason does not read
   two ways depending on where it was given. */
check('a reason given here is the same entry the day card writes',
  /var entry = \{ note: note, at: new Date\(\)\.toISOString\(\), by: 'self' \};/.test(APP)
  && (APP.match(/if\(pick === 'late'\) entry\.kind = 'late';/g) || []).length >= 1, null);
check('and it will not save an empty reason',
  /if\(!note\)\{ showUploadStatus\('Say what the reason was first\.', true\);/.test(APP), null);

/* ---- what the employee is allowed to see ---- */
check('they may read who answers for their own leave',
  /'approvalRoute'\]\);/.test(SRV), null);
check('their own row of that table and nobody else’s',
  /return JSON\.stringify\(row == null \? \{\} : \{ \[name\]: row \}\);/.test(SRV), null);
check('and a name missing from it hands back nothing rather than everything',
  /Object\.prototype\.hasOwnProperty\.call\(v, name\)/.test(SRV), null);

/* ---- it must not cost the page it sits above ---- */
check('a fault in it is caught, so the record still draws',
  /try\{ renderEmpWaiting\(\); \}catch\(e\)\{ console\.error\('what is waiting on them', e\); \}/
    .test(APP), null);
check('and it is drawn above the day card, which only reaches yesterday',
  APP.indexOf('id="empWaiting"') < APP.indexOf('id="empDayCard"'), null);

/* ---- which of the two answers sends mail, said before it is pressed ----
   One of these takes minutes off the record and puts an email in somebody's
   inbox within the minute. Both of those are things a person should know
   they are about to do, so the card says so while they are choosing rather
   than afterwards - and the server is the proof of which one it is. */
{
  const tell = vm.createContext({ Array, String, Object });
  vm.runInContext("var approvalRoute = { 'R': ['a@x.net','b@x.net'] };", tell);
  vm.runInContext("var N = { 'a@x.net':'Ann Approver', 'b@x.net':'Bob Boss' };"
    + "function approverLabel(e){ return N[String(e).toLowerCase()] || e; }", tell);
  vm.runInContext(grab(APP, 'ewWhyTell'), tell);

  const exc = tell.ewWhyTell('exc', 'R');
  const late = tell.ewWhyTell('late', 'R');
  check('excusing a day says it is emailed, before it is pressed',
    /emailed to the management/.test(exc), exc.slice(0, 90));
  check('and names whoever answers for that person',
    /Ann Approver, Bob Boss/.test(exc), exc.slice(0, 110));
  check('and says the minutes come off',
    /minutes come off this day/.test(exc), null);
  check('and that nobody is being asked',
    /told, not asked/.test(exc), null);
  /* Named as far as the page can honestly name them. The management list is
     the office's own and is not on an employee's page, so it is not invented. */
  check('nobody named against them is not a list made up',
    !/ and /.test(tell.ewWhyTell('exc', 'Nobody').split('straight away')[0]),
    tell.ewWhyTell('exc', 'Nobody').slice(0, 80));
  check('the personal one says plainly that nothing is emailed',
    /Nothing is emailed/.test(late), late);
  check('and that the minutes stay', /minutes stay on the day/.test(late), null);
  check('with nothing picked it asks rather than describing either',
    /Which was it\?/.test(tell.ewWhyTell('', 'R')), null);

  /* The claim rests on the server actually skipping the personal one. If that
     filter ever goes, the card would be promising silence it cannot keep. */
  check('and the server really does skip the personal one',
    /\|\| v\.kind === 'late'\) return;/.test(SRV), null);
  check('while the excused one is what it sends',
    /function newlySelfExcused\(beforeText, afterText\)/.test(SRV)
    && /notifySelfExcused\(req\.session\.orgId, fresh\.slice\(0, 10\)\)/.test(SRV), null);
}

/* ---- and neither is chosen for them ---- */
check('nothing is picked to begin with',
  /var pick = '';/.test(grab(APP, 'ewWire')), null);
check('so saving asks which it was first',
  /if\(!pick\)\{ showUploadStatus\('Say which it was first\.', true\); return; \}/.test(APP), null);
check('the choice that sends mail is marked as well as worded',
  /tell\.className = 'ew-none' \+ \(pick === 'exc' \? ' ew-warn' : ''\);/.test(APP), null);
check('and the two screens word the one question the same way',
  /Excuse the day/.test(APP) && /Late — personal/.test(APP)
  && !/Ask for it to be excused/.test(APP) && !/It was my fault/.test(APP), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
