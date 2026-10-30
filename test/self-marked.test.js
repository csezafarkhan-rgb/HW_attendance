// Three of the office work away from the card readers, so their day was typed
// in for them. They type it themselves now - and these are the checks that the
// page they type it on cannot reach anybody else's day, or an older one of
// their own, and cannot quietly excuse its own lateness.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* The real functions, lifted out of the server. */
const ctx = { Date, String, Number, Object, Array, JSON, IST_MS: 5.5 * 3600 * 1000 };
vm.createContext(ctx);
const lift = re => { const m = re.exec(SRC); if (!m) throw new Error('not found: ' + re); return m[0]; };
[/function parseJson\(s\) \{[\s\S]*?\n\}/,
 /function parseShiftSpan\(str\) \{[\s\S]*?\n\}/,
 /function ownDays\(shift\) \{[\s\S]*?\n\}/,
 /const TIME_RE = [^\n]*/,
 /const EXCUSE_MAX = [^\n]*/,
 /function mergeEmployeeManual\(storedValue, incomingValue, name, selfMarkValue, shift\) \{[\s\S]*?\n\}/,
 /function mergeEmployeeExcuses\(storedValue, incomingValue, name, shift\) \{[\s\S]*?\n\}/,
 /const VISIT_DETAIL_MAX = [^\n]*/,
 /const VISIT_REASON_MAX = [^\n]*/,
 /function mergeEmployeeVisit\(storedValue, incomingValue, name, selfMarkValue, shift\) \{[\s\S]*?\n\}/
].forEach(re => vm.runInContext(lift(re), ctx));

const [TODAY] = ctx.ownDays();
const YESTERDAY = new Date(Date.now() + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10);
/* Two times that have already gone today, whenever the suite happens to run -
   a fixed evening time is refused by the clock check as the day wears on. */
const IST_NOW = new Date(Date.now() + 5.5 * 3600000);
const NOW_MIN = IST_NOW.getUTCHours() * 60 + IST_NOW.getUTCMinutes();
const hhmm = m => String(Math.floor(Math.max(0, m) / 60)).padStart(2, '0')
                + ':' + String(Math.max(0, m) % 60).padStart(2, '0');
const GONE_IN = hhmm(Math.max(0, NOW_MIN - 120));
const GONE_OUT = hhmm(Math.max(1, NOW_MIN - 10));
const OLD = '2026-01-05';
const MARKED = JSON.stringify({ 'Shyam Lal ESS': true, 'Aman Gupta': true });
const parse = v => (v === null || v === false) ? v : JSON.parse(v);

/* ---- their own day, and only theirs ---- */
{
  const mine = {}; mine['Shyam Lal ESS|' + TODAY] = { 'in': GONE_IN, out: GONE_OUT };
  const out = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(mine), 'Shyam Lal ESS', MARKED));
  check('somebody marked as marking their own can write their day',
    !!out && !!out['Shyam Lal ESS|' + TODAY], out);
  check('and it is stamped as theirs rather than passed off as a punch',
    out['Shyam Lal ESS|' + TODAY].by === 'self' && !!out['Shyam Lal ESS|' + TODAY].at,
    out['Shyam Lal ESS|' + TODAY]);
  check('an in and an out together count as present',
    out['Shyam Lal ESS|' + TODAY].st === 'PR');

  /* The page is theirs to edit, so the name in the key proves nothing. */
  const theirs = {}; theirs['Rahul Mishra|' + TODAY] = { 'in': GONE_IN, out: GONE_OUT };
  const out2 = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(theirs), 'Shyam Lal ESS', MARKED));
  check('but not somebody else’s day, whatever the page sends',
    Object.keys(out2).length === 0, out2);

  const old = {}; old['Shyam Lal ESS|' + OLD] = { 'in': '09:00', out: '18:00' };
  const out3 = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(old), 'Shyam Lal ESS', MARKED));
  check('nor a day last January', Object.keys(out3).length === 0, out3);

  /* Yesterday was open, for somebody who did not get to it until the morning.
     It is shut: a day you can still go back and fill in is a day that can be
     written to suit the week it turned out to be. A missed day goes through
     the office now. */
  const back = {}; back['Shyam Lal ESS|' + YESTERDAY] = { 'in': '09:35', out: '18:05' };
  const out4 = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(back), 'Shyam Lal ESS', MARKED));
  check('nor yesterday, which is the office’s to enter now',
    Object.keys(out4).length === 0, out4);
  check('and the window the page offers is the same one day',
    /function empDayWindow\(\)\{\s*\n\s*return \[empWorkingDay\(\)\];/.test(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8')));
}

/* ---- only those the office has marked ---- */
{
  const mine = {}; mine['Rahul Mishra|' + TODAY] = { 'in': GONE_IN, out: GONE_OUT };
  const out = ctx.mergeEmployeeManual('{}', JSON.stringify(mine), 'Rahul Mishra', MARKED);
  check('somebody who punches a card cannot type their day instead',
    out === false, out);
  check('and nobody can when the office has marked no one',
    ctx.mergeEmployeeManual('{}', JSON.stringify(mine), 'Rahul Mishra', '{}') === false);
}

/* ---- what is already on the record ---- */
{
  const stored = {};
  stored['Aman Gupta|' + OLD] = { 'in': '09:00', out: '18:00' };     // an older day of theirs
  stored['Rahul Mishra|' + TODAY] = { 'in': '09:28', out: '18:31' }; // somebody else's today
  const mine = {}; mine['Aman Gupta|' + TODAY] = { 'in': GONE_IN, out: GONE_OUT };
  const out = parse(ctx.mergeEmployeeManual(JSON.stringify(stored), JSON.stringify(mine), 'Aman Gupta', MARKED));
  check('a save leaves every other day of the record alone',
    out['Aman Gupta|' + OLD]['in'] === '09:00'
      && out['Rahul Mishra|' + TODAY]['in'] === '09:28', out);

  /* Sending nothing for a day they had filled in clears it. */
  const had = {}; had['Aman Gupta|' + TODAY] = { 'in': GONE_IN, out: GONE_OUT };
  const cleared = parse(ctx.mergeEmployeeManual(JSON.stringify(had), '{}', 'Aman Gupta', MARKED));
  check('clearing their own day clears it', !cleared['Aman Gupta|' + TODAY], cleared);
}

/* ---- a time has to be a time ---- */
{
  ['25:00', '9.30', 'half nine', '09:70', '<script>'].forEach(bad => {
    const o = {}; o['Aman Gupta|' + TODAY] = { 'in': bad, out: GONE_OUT };
    const got = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(o), 'Aman Gupta', MARKED));
    check('"' + bad + '" is not a time and is refused', Object.keys(got).length === 0, got);
  });
  const ok = {}; ok['Aman Gupta|' + TODAY] = { 'in': GONE_IN, out: '' };
  const got = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(ok), 'Aman Gupta', MARKED));
  /* This used to insist the day was not "present" until both times were in.
     What that meant in practice was somebody marking their arrival at ten to
     ten and then reading "Absent", in red, on their own calendar and on the
     office's, until the evening. Arrived is present; the duration is what
     waits for the other half. */
  check('an in with no out yet is kept, and counts as present',
    got['Aman Gupta|' + TODAY].st === 'PR' && got['Aman Gupta|' + TODAY]['in'] === GONE_IN, got);
}

/* ---- a time that has not come round yet ----
   A day is marked as it happens, so an hour still ahead is a slip or a guess.
   The page caps its own boxes; the page is theirs to edit, so it is checked
   here as well. */
{
  const now = new Date(Date.now() + 5.5 * 3600000);
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

  if (mins < 23 * 60) {                      // not in the last hour of the day
    const ahead = {}; ahead['Aman Gupta|' + TODAY] = { 'in': '09:00', out: hhmm(mins + 45) };
    const got = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(ahead), 'Aman Gupta', MARKED));
    check('an out time still ahead of the clock is refused',
      Object.keys(got).length === 0, got);
  }
  if (mins > 90) {
    const past = {}; past['Aman Gupta|' + TODAY] = { 'in': hhmm(mins - 60), out: hhmm(mins - 5) };
    const got2 = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(past), 'Aman Gupta', MARKED));
    check('a time already gone is taken', !!got2['Aman Gupta|' + TODAY], got2);
  }
  /* And an evening that has not come round yet is still refused, which is the
     one thing the clock check was always for. */
  {
    const soon = {}; soon['Aman Gupta|' + TODAY] = { 'in': '09:30', out: '23:59' };
    const got3 = parse(ctx.mergeEmployeeManual('{}', JSON.stringify(soon), 'Aman Gupta', MARKED));
    const nowMin = new Date(Date.now() + 5.5 * 3600000).getUTCHours() * 60
                 + new Date(Date.now() + 5.5 * 3600000).getUTCMinutes();
    check('a finish still ahead is refused', nowMin >= 23 * 60 + 57
      ? true : Object.keys(got3).length === 0, got3);
  }
}

/* ---- a day spent out on a visit ----
   This is the one thing somebody can write for themselves that pays: a visit
   credits a whole working day. So it is fenced harder than the rest. */
{
  const V = (stored, obj, who) =>
    ctx.mergeEmployeeVisit(stored, JSON.stringify(obj), who || 'Aman Gupta', MARKED);
  const K = 'Aman Gupta|' + TODAY;

  const ok = parse(V('{}', { [K]: { cat: 'VISIT', detail: 'Factory', reason: 'new dye lot' } }));
  check('a visit of their own, today, is written',
    ok[K].cat === 'VISIT' && ok[K].detail === 'Factory'
      && ok[K].reason === 'new dye lot' && ok[K].by === 'self', ok);
  const bare = parse(V('{}', { [K]: { cat: 'VISIT', detail: 'Factory' } }));
  check('and the purpose is optional', bare[K].reason === '', bare[K]);
  const nowhere = parse(V('{}', { [K]: { cat: 'VISIT', detail: '   ' } }));
  check('but a visit to nowhere is not a visit', Object.keys(nowhere).length === 0, nowhere);

  /* Leave and WFH decide money and time off. They stay the office's. */
  ['LEAVE', 'WFH', 'OTHER'].forEach(cat => {
    const got = parse(V('{}', { [K]: { cat: cat, detail: 'x' } }));
    check(cat + ' is not theirs to write', Object.keys(got).length === 0, got);
  });

  const theirs = parse(V('{}', { ['Rahul Mishra|' + TODAY]: { cat: 'VISIT', detail: 'Factory' } }));
  check('nor anybody else’s day', Object.keys(theirs).length === 0, theirs);
  const older = parse(V('{}', { ['Aman Gupta|' + OLD]: { cat: 'VISIT', detail: 'Factory' } }));
  check('nor a day last January', Object.keys(older).length === 0, older);
  const back = parse(V('{}', { ['Aman Gupta|' + YESTERDAY]: { cat: 'VISIT', detail: 'Factory' } }));
  check('nor yesterday', Object.keys(back).length === 0, back);

  /* A day the office has already settled is not theirs to overwrite - nor to
     quietly drop by saving a day that leaves it out. */
  const office = JSON.stringify({ [K]: { cat: 'LEAVE', detail: 'CL', by: 'office' } });
  const over = parse(V(office, { [K]: { cat: 'VISIT', detail: 'Factory' } }));
  check('a day the office settled is left exactly as it was',
    over[K].cat === 'LEAVE' && over[K].detail === 'CL', over);
  check('and saving around it does not delete it', !!parse(V(office, {}))[K]);

  /* Their own, though, they may take back. */
  const mineSet = JSON.stringify({ [K]: { cat: 'VISIT', detail: 'Factory', by: 'self' } });
  check('a visit of their own can be removed', Object.keys(parse(V(mineSet, {}))).length === 0);

  const others = JSON.stringify({ ['Rahul Mishra|' + TODAY]: { cat: 'WFH', by: 'office' } });
  const kept = parse(V(others, { [K]: { cat: 'VISIT', detail: 'Factory' } }));
  check('and everybody else’s day is still there',
    !!kept['Rahul Mishra|' + TODAY] && !!kept[K], kept);

  /* Where somebody is today is not the same question as who types their in
     time. Somebody who punches a card still goes out on a visit, and the
     office cannot know they have until it is told - so this is not behind the
     self-marking gate. It stays as narrow as it was: VISIT, on days of their
     own, and nothing else. */
  check('anybody may say where they are, marked for their own times or not',
    (() => {
      const out = parse(ctx.mergeEmployeeVisit('{}', JSON.stringify({ ['Rahul Mishra|' + TODAY]:
        { cat: 'VISIT', detail: 'Factory' } }), 'Rahul Mishra', '{}'));
      return !!out['Rahul Mishra|' + TODAY]
        && out['Rahul Mishra|' + TODAY].by === 'self';
    })());
  check('and it is still a visit or nothing',
    (() => {
      const out = parse(ctx.mergeEmployeeVisit('{}', JSON.stringify({ ['Rahul Mishra|' + TODAY]:
        { cat: 'LEAVE', detail: 'CL' } }), 'Rahul Mishra', '{}'));
      return !out['Rahul Mishra|' + TODAY];
    })());
}

/* ---- why they were late ----
   This used to wait for the office: an excuse cancels the lateness, so one
   written by the person it is about counted for nothing until it was ticked.
   In practice the office was never told there was anything to tick, and not
   one person ever used it. The office chose the other way - the mark stands
   on its own and a message goes out for reading - so what is guarded here is
   no longer "whose word counts" but "whose entry is it". */
{
  const mine = {}; mine['karan Ahuja|' + TODAY] = { note: 'Train was held at Gurgaon' };
  const out = parse(ctx.mergeEmployeeExcuses('{}', JSON.stringify(mine), 'karan Ahuja'));
  const e = out['karan Ahuja|' + TODAY];
  check('anybody may give a reason for being late, marked or not', !!e, out);
  check('it excuses the day from the moment it is given',
    e.pending !== true && e.by === 'self', e);
  check('and the words are kept', /Train was held/.test(e.note), e);

  /* The page could claim the office wrote it, which would put it beyond
     their own reach to change and make it read as the office's decision in
     every message. Who wrote it is decided here, not there. */
  const sneaky = {};
  sneaky['karan Ahuja|' + TODAY] = { note: 'Traffic', by: 'admin' };
  const out2 = parse(ctx.mergeEmployeeExcuses('{}', JSON.stringify(sneaky), 'karan Ahuja'));
  check('a page claiming the office wrote it is not believed',
    out2['karan Ahuja|' + TODAY].by === 'self', out2['karan Ahuja|' + TODAY]);
  check('and the time it was given is the server’s, not the page’s',
    out2['karan Ahuja|' + TODAY].at !== '2000-01-01T00:00:00Z'
    && !isNaN(Date.parse(out2['karan Ahuja|' + TODAY].at)));

  /* Their own mark is theirs to lift: ticking it by mistake has a way back. */
  const own = {};
  own['karan Ahuja|' + TODAY] = { note: 'Traffic', at: '2026-10-28T04:00:00Z', by: 'self' };
  const gone = parse(ctx.mergeEmployeeExcuses(JSON.stringify(own), '{}', 'karan Ahuja'));
  check('a mark they made themselves can be taken back',
    !gone['karan Ahuja|' + TODAY], gone);

  /* What the office has accepted stays accepted. */
  const settled = {};
  settled['karan Ahuja|' + TODAY] = { note: 'Allowed - power cut', at: '2026-10-26T04:00:00Z' };
  const out3 = parse(ctx.mergeEmployeeExcuses(JSON.stringify(settled),
    JSON.stringify({ ['karan Ahuja|' + TODAY]: { note: 'something else' } }), 'karan Ahuja'));
  check('an excuse the office already accepted cannot be written over',
    out3['karan Ahuja|' + TODAY].note === 'Allowed - power cut'
      && out3['karan Ahuja|' + TODAY].pending !== true, out3);

  const theirs = {}; theirs['Rahul Mishra|' + TODAY] = { note: 'not mine to give' };
  const out4 = parse(ctx.mergeEmployeeExcuses('{}', JSON.stringify(theirs), 'karan Ahuja'));
  check('and nobody gives a reason on somebody else’s behalf',
    Object.keys(out4).length === 0, out4);

  const long = {}; long['karan Ahuja|' + TODAY] = { note: 'x'.repeat(5000) };
  const out5 = parse(ctx.mergeEmployeeExcuses('{}', JSON.stringify(long), 'karan Ahuja'));
  check('a very long reason is cut to a sensible length',
    out5['karan Ahuja|' + TODAY].note.length === 300, out5['karan Ahuja|' + TODAY].note.length);
}

/* ---- the server's own reckoning ---- */
{
  /* Their times, their reason for being late, their tasks, their leave
     requests - and a day out on a visit, which is merged under guard. */
  check('an employee may write those six things, and still nothing else',
    /EMPLOYEE_WRITABLE = \['leaveRequests', 'dailyTasks', 'manualRecords', 'lateExcuses',\s*'overrides', 'dayShifts'\]/.test(SRC));
  check('they read only their own row of who marks their own attendance',
    /EMP_KEYED_BY_NAME = \[[\s\S]{0,120}'selfMark'\]/.test(SRC));
  check('and a day they marked late themselves does not count as excused in the daily message',
    /if \(v && typeof v === 'object' && \(v\.pending === true \|\| v\.kind === 'late'\)\) return;/.test(SRC));
  /* Both merges are reached from the write, and only for an employee. */
  check('the guards are wired into the save, for employees only',
    /key === 'manualRecords' && req\.session\.role === 'employee'/.test(SRC)
      && /key === 'lateExcuses' && req\.session\.role === 'employee'/.test(SRC));
  check('somebody not marked is refused rather than silently ignored',
    /not_self_marked/.test(SRC));
}

/* ---- and the page the office and the employee actually see ---- */
{
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

  /* The one rule the whole feature rests on: an excuse somebody wrote about
     themselves does not cancel their own lateness until the office says so.
     Everything that reckons lateness goes through getLateExcuse. */
  /* Two answers, one of which excuses nothing: their own lateness written
     down, and the older shape that waited on the office. */
  check('a day they marked late themselves is not an excuse',
    /function lateIsOwned\(v\)\{ return !!v && \(v\.pending === true \|\| v\.kind === 'late'\); \}/.test(APP)
    && /function getLateExcuse\(emp, d\)\{[\s\S]{0,160}?lateIsOwned\(v\) \? null/.test(APP),
    (/function getLateExcuse[\s\S]{0,160}/.exec(APP) || [])[0]);
  check('but it can still be read, to be shown and decided on',
    /function getLatePlea\(emp, d\)\{/.test(APP));
  check('the office ticking it writes no pending flag, which is what grants it',
    /if\(checked\)\{ lateExcuses\[key\] = \{note:note, at:new Date\(\)\.toISOString\(\)\}; \}/.test(APP));
  check('and the dialog shows the office what was actually said',
    /plea-wait/.test(APP) && /says:/.test(APP));

  /* Who marks their own: set on the row that sets everything else about them. */
  check('the office can mark who types their own day',
    /data-self-emp=/.test(APP) && /Marks own/.test(APP));
  check('and the tick saves itself, with no separate Save to miss',
    /cb\.addEventListener\('change'[\s\S]{0,320}saveSelfMark\(\)/.test(APP));
  check('the list is loaded with the rest at boot',
    /loadManualRecords, loadLateExcuses, loadSelfMark,/.test(APP));

  /* The employee's own card. */
  const card = APP.slice(APP.indexOf('function renderEmpDayCard('),
                         APP.indexOf('function renderEmployeeCalendar()'));
  check('their page offers in and out only to those marked for it',
    /var mine = marksOwn\(name\);/.test(card)
    && /if\(mine\)\{/.test(card), card.slice(0, 80));
  /* The visit and the day's hours are not that question, and were only behind
     that gate because they happened to be drawn on the same card. */
  check('but where they are and what hours they work are everybody’s to say',
    /var ownDay = visitRow\(name, day\) \+ shiftRow\(name, day\);/.test(card)
    && /if\(!mine && !isLate && !ownDay\)/.test(card)
    && (card.match(/ownDay/g) || []).length >= 4);
  /* One day, and it is the working day: on a night shift that is the day the
     shift started, not the date on the calendar, or a shift worked through
     midnight would be filed under the morning it happened to end in. */
  check('and only for the one working day',
    /function empDayWindow\(\)\{\s*\n\s*return \[empWorkingDay\(\)\];/.test(APP)
      && /function empWorkingDay\(\)\{/.test(APP)
      && !/setDate\(back\.getDate\(\) - 1\)/.test(card));
  /* One day to choose from is no choice, and the date is written beside the
     title already - so no lone dead chip where the pair used to be. */
  check('and the day picker goes with it, there being one day',
    /days\.length > 1 \? days\.map/.test(card));
  check('a day typed in counts for lateness the same as one punched',
    /forLate = \(man && man\['in'\]\)/.test(card));
  check('the card says what each choice does, and that nobody has to agree to it',
    /Nobody has to approve either one\./.test(card)
    && /The minutes come off, and the office is told why/.test(card)
    && /The minutes stand\. A note is optional/.test(card));
  check('and the box for the words only appears once one of them is chosen',
    /id="edExcRow"/.test(card) && /\(chose \? '' : ' style="display:none;"'\)/.test(card));
  check('and anybody late may give one, marked or not',
    /if\(rec\['in'\]\)\{/.test(card) && /if\(isLate\)\{/.test(card));
}

/* ---- what the card adds up, and where it sits ---- */
{
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const card = APP.slice(APP.indexOf('function renderEmpDayCard('),
                         APP.indexOf('function renderEmployeeCalendar()'));
  check('the two boxes add themselves up as they are typed',
    /fmtMin\(mins\) \+ ' on the day/.test(card) && /addEventListener\('input', tell\)/.test(card));
  check('and an out before an in is said so, not saved',
    /Out is before in \u2014 /.test(card) && /wrong === 'backwards'/.test(card));
  /* With the half of the day a button, the wrong half is the mistake this will
     usually be - so the box at fault is outlined and the hint names it. */
  check('and the box at fault is marked, not just the sentence',
    /if\(F\.out\) F\.out\.mark\(true\);/.test(card)
      && /Did you mean PM\?/.test(card));
  /* ---- clocking in, clocking out ----
     Two boxes, four buttons for the half of the day, a row of suggested times,
     Save and Clear: nine things to work to record one arrival. And a typed
     time is a claim - the server took any time up to the present moment, so
     arriving at ten to twelve one could write half past nine and the record
     kept it. The answer was to show the office how long after the fact it had
     been typed, which reports backdating rather than preventing it.

     One button now, and it is the only thing on the card. */
  check('the card is one button, in the state the day is in',
    /id="ckIn">Clock in</.test(card) && /id="ckOut"/.test(card)
    && /if\(!inAt\)\{/.test(card) && /else if\(!outAt\)\{/.test(card));
  /* Clocking in starts a day, and a day started by mistake is put right by
     clocking out. Clocking out ENDS one, and a day ended by a stray tap has
     to be put right by somebody else - so that one is held, not tapped. */
  check('clocking in is a tap; clocking out is a two-second hold',
    /ckInBtn\.addEventListener\('click'/.test(card)
    && /var HOLD = 2000/.test(card)
    && /b\.addEventListener\('touchstart', start, \{ passive: false \}\)/.test(card));
  check('the bar is the whole of the feedback, and letting go empties it',
    /id="ckFill"/.test(card) && /paint\(0\);/.test(card)
    && /Keep holding/.test(card) && /Hold to clock out/.test(card));
  check('and only a full hold sends anything',
    /if\(p >= 1\)\{\s*\r?\n\s*sent = true;/.test(card));
  /* A keyboard cannot press and hold. */
  check('a keyboard is asked the same question in words',
    /e\.key !== 'Enter' && e\.key !== ' '/.test(card)
    && /Clock out now\?/.test(card));
  /* A figure that does not move is one nobody believes is live. */
  check('the time they have been in runs, by the second',
    /function ckRunning\(markedIn\)/.test(APP)
    && /CK_TIMER = setInterval\(ckTick, 1000\);/.test(card)
    && /id="ckRun"/.test(card));
  check('and it is a clock, hours minutes and seconds, that does not jiggle',
    /return h \+ ':' \+ \('0' \+ m\)\.slice\(-2\) \+ ':' \+ \('0' \+ sx\)\.slice\(-2\);/.test(APP)
    && /\.ck-run b\{[\s\S]{0,160}tabular-nums/.test(APP));
  check('a shift through midnight still counts forward',
    /if\(secs < 0\) secs \+= 24 \* 3600;/.test(APP));
  check('and nothing is typed: the boxes, the halves of the day and Save are gone',
    card.indexOf('id="edIn"') === -1 && card.indexOf('data-ap="AM"') === -1
    && card.indexOf('id="edSave"') === -1 && card.indexOf('data-chip=') === -1);
  /* The whole point of the change: the time cannot be older than the press. */
  check('the time is the server\u2019s own, not a number the browser sent',
    (() => {
      const route = SRC.slice(SRC.indexOf("app.post('/api/clock'"),
                              SRC.indexOf("app.post('/api/clock'") + 3000);
      /* One thing is read from the request, and it is not a time. */
      const reads = (route.match(/req\.body[^;]*/g) || []);
      return /const nowIst = new Date\(Date\.now\(\) \+ IST_MS\);/.test(route)
        && reads.length === 1 && /which/.test(reads[0])
        && !/TIME_RE/.test(route);
    })());
  check('and the card asks for nothing but which button was pressed',
    /JSON\.stringify\(\{ which: which \}\)/.test(card));
  /* The gap the office was shown exists to catch a backdated claim. Clocked,
     the mark and the moment it was written are the same moment. */
  check('the moment it happened is the moment it was written',
    /inAt: which === 'in' \? nowIso :/.test(SRC)
    && /outAt: which === 'out' \? nowIso :/.test(SRC));
  /* The same gate the typed card had, and the same day rule: a night shift
     started yesterday is still yesterday's day. */
  check('only those the office marked may clock at all',
    /if \(marked\[name\] !== true\)[\s\S]{0,80}not_self_marked/.test(SRC));
  check('and the day is the shift\u2019s question, not the calendar\u2019s',
    /const day = ownDays\(shiftFor\(/.test(SRC));
  /* Pressing twice is a slip. Letting the second press through would move an
     arrival later, which is the one direction a mistake must not go. */
  check('a second press on the same button is refused, not taken',
    /if \(which === 'in' && had && had\['in'\]\)[\s\S]{0,120}already_in/.test(SRC)
    && /if \(!had \|\| !had\['in'\]\)[\s\S]{0,80}not_in_yet/.test(SRC)
    && /if \(had\.out\)[\s\S]{0,80}already_out/.test(SRC));
  check('and the card says which of those happened, in words',
    /already_in/.test(card) && /You are already clocked in/.test(card)
    && /Clock in first\./.test(card));
  /* Read in one query and written in the same transaction, or two presses
     landing together would each write over the other's half of the day. */
  check('the day is read and written under one lock',
    (() => {
      const route = SRC.slice(SRC.indexOf("app.post('/api/clock'"),
                              SRC.indexOf("app.post('/api/clock'") + 6200);
      return /await client\.query\('BEGIN'\)/.test(route)
        && /FOR UPDATE/.test(route)
        && /INSERT INTO kv/.test(route)
        && /await client\.query\('COMMIT'\)/.test(route);
    })());
  /* ---- a press must not undo the card reader ----
     A mark made on the portal has always sat over the reader's row for the
     same day. That was safe while a day had to be typed, because nobody typed
     a day the reader already had. One button is a different thing: a single
     press on a day already read off the card wrote the moment of the press
     over a real arrival, and the hours of the day with it - 11:52 to 13:08
     became 15:22 to 15:22, which is nought hours. */
  check('the readers\u2019 row for the day is read in the same transaction as the write',
    /SELECT data FROM records WHERE org_id = \$1 AND employee = \$2 AND day = \$3/.test(SRC));
  check('and a press never moves an arrival later',
    /'in': which === 'in' \? keepEarlier\(inRaw, seen\['in'\]\) : inRaw,/.test(SRC)
    && /const keepEarlier = \(a, b\) =>/.test(SRC));
  check('nor a departure earlier',
    /out: which === 'out' \? keepLater\(outRaw, seen\.out\) : outRaw,/.test(SRC)
    && /const keepLater = \(a, b\) =>/.test(SRC));
  /* Folding the reader's leaving time in while somebody is clocking IN would
     hand them a day that was over before it started. */
  check('only the half being marked is weighed against the reader',
    /Only the half being marked is weighed against the reader/.test(SRC));
  check('and the card says when the reader\u2019s time stood instead of the press',
    /kept:/.test(SRC) && /The reader already had you in at/.test(card));

  /* It writes what the card wrote, so nothing downstream has to know. */
  check('what it writes is the entry the typed card wrote',
    /st: 'PR', by: 'self', at: nowIso,/.test(SRC));
  /* A day the office entered is theirs, and a correction is a request - which
     is the path the office already had. */
  check('a day the office entered is shown, not added to',
    /var theirs = !man \|\| man\.by === 'self';/.test(card)
    && /Entered by the office\./.test(card));
  check('and a mistake goes where corrections already went',
    /id="ckFix"/.test(card) && /requestLeaveBtn/.test(card));
  /* A page left open all day should hold one clock, not a hundred. */
  check('the clock on the card moves, and only one of it runs',
    /if\(CK_TIMER\) clearInterval\(CK_TIMER\);/.test(card)
    && /CK_TIMER = setInterval\(ckTick, 20000\);/.test(card));
  check('and a shift through midnight is still one day\u2019s work',
    /if\(d < 0\) d \+= 24 \* 60;/.test(APP.slice(APP.indexOf('function ckRan('),
                                               APP.indexOf('function ckRan(') + 400)));

  /* The chips offered the times this person actually used, which beat offering
     a tidy round number nobody uses - but there is nothing to offer a time to
     any more, so the function that worked them out went with them. */
  check('and the chip-maker went with the chips it fed',
    APP.indexOf('function usualTimes(') === -1);
  check('and a time still ahead is refused on the way out too',
    /wrong === 'future'/.test(card));
  /* The page caps its own boxes; the page is theirs to edit. */
  check('the server checks the clock as well, with a little slack for theirs',
    /const cap = now\.getUTCHours\(\) \* 60 \+ now\.getUTCMinutes\(\) \+ 2;/.test(SRC));

  /* Both cards fill the space the month leaves, rather than the dead band
     under the whole page. */
  check('their day and their work log sit under the calendar',
    /<div class="emp-split-main">[\s\S]{0,400}id="empCalGrid"[\s\S]{0,400}id="empDayCard"[\s\S]{0,200}id="empTasksCard"/.test(APP),
    (/<div class="emp-split-main">[\s\S]{0,200}/.exec(APP) || [])[0]);
}

/* ---- what a day cell says ----
   In, out and what the day came to were only on hover, which is no use on a
   phone and easy to miss anywhere else. The corner letter said "L" and left
   you to guess by how much. */
{
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const cal = APP.slice(APP.indexOf('function renderEmployeeCalendar()'),
                        APP.indexOf('grid.className = '));
  check('a day shows its in, its out and what they come to',
    /<i>In<\/i>/.test(cal) && /<i>Out<\/i>/.test(cal) && /ecd-dur/.test(cal));
  check('the total is worked out from the two times, not stored twice',
    /var dur = rec\.out \? \(toMin\(rec\.out\) - toMin\(rec\['in'\]\)\) : 0;/.test(cal));
  check('and the corner letter is spelled out beneath it',
    /minsSaid\(leN\.late\|\|0\)\) \+ ' late'/.test(cal));
  check('an excused one says so, and one they answered for says that instead',
    /lxN \? ' \u00b7 excused' : \(plN \? ' \u00b7 said why' : ''\)/.test(cal));
  /* The words sit beside the letter they explain, not somewhere else. */
  check('and the note rides in the badge row, left of the letter',
    /ec-marks[\s\S]{0,140}ec-notes[\s\S]{0,120}\+ marks/.test(cal),
    cal.slice(cal.indexOf('ec-marks'), cal.indexOf('ec-marks') + 160));

  const styles = (APP.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n');
  check('only one of the two time lines is ever shown',
    /\.emp-cal-grid:not\(\.compact\) \.emp-cal-cell\.has-det \.t,/.test(styles)
      && /\.emp-cal-grid\.compact \.emp-cal-cell \.ec-det/.test(styles));
  /* A WFH day's hours and a holiday's name live in the packed line and nowhere
     else; hiding it for every day took them off the calendar. */
  check('a day with no in and out keeps the one line it has',
    /if\(detail\) cls \+= ' has-det';/.test(APP));
  check('the cell grows to what it carries rather than cropping it',
    /\.emp-cal-grid \.emp-cal-cell\{ min-height:\d+px; overflow:visible/.test(styles));
  /* The times rest on the floor of the cell, so a week of them lines up along
     one edge instead of each starting wherever its own label happened to end.
     The cell still grows to what it carries, so that floor is never a crop. */
  check('the times rest on the floor of the cell',
    /\.ec-det\{[^}]*margin-top:auto/.test(styles)
      && /\.emp-cal-grid:not\(\.compact\) \.emp-cal-cell \.t\{ margin-top:auto/.test(styles),
    (/\.ec-det\{[^}]*/.exec(styles)||[])[0]);
  /* The word for the day is the bold thing in the cell. The figures were set
     at the same weight and shouted over it. */
  check('and read as figures, not as a second heading',
    /\.emp-cal-cell \.ecd b\{[^}]*font-weight:500/.test(styles)
      && /\.emp-cal-cell \.ecd-dur b\{[^}]*font-weight:500/.test(styles)
      && /\.emp-cal-cell \.t\{[^}]*font-weight:500/.test(styles));
  check('and the compact one keeps its old height',
    /\.emp-cal-grid\.compact \.emp-cal-cell,[\s\S]{0,60}height:96px/.test(styles));
}

/* ---- a notice belongs to the page, not to one view ----
   The corner the notices stack in sat inside the office's own view, which is
   hidden while an employee is signed in - so every "saved" an employee earned
   was drawn into a container nobody could see. */
{
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const at = t => APP.indexOf(t);
  check('the notice corner sits outside both views',
    at('id="hwToasts"') > at('id="employeeView"') && at('id="hwToasts"') > at('id="adminView"'),
    { toasts: at('id="hwToasts"'), employee: at('id="employeeView"'), admin: at('id="adminView"') });
  /* And the employee's own cards do say something when they save. */
  const card = APP.slice(APP.indexOf('function renderEmpTasks()'),
                         APP.indexOf('The two folded notes on the Leave Record'));
  check('writing a line says so, where the notices are',
    /showUploadStatus\([^;]*saved to your work log/.test(card));

  /* The other things an employee does from their own page say so too. The
     modal closing is not an answer - it closes whether the save landed or
     not, and what somebody wants to know after pressing Send is whether the
     office has it. */
  check('sending a leave request says it has gone',
    /showUploadStatus\(\(isPunch \? 'Punch correction' : 'Request'\)/.test(APP)
      && /waiting on the office/.test(APP));
  check('and says plainly when it did not',
    /That request did not reach the office/.test(APP));
  check('a reply to the office says it has gone too',
    /Your reply has gone to the office/.test(APP));
  check('their own in and out says so, and so does marking a late day excused',
    /Saved\. The office sees it on the record/.test(APP)
      && /Marked excused\. The office has been told\./.test(APP));
  check('and taking that mark off says what it costs them',
    /Taken off\. The day counts as late, with nothing said about it\./.test(APP));
}

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
