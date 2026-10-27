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
 /function ownDays\(\) \{[\s\S]*?\n\}/,
 /const TIME_RE = [^\n]*/,
 /const EXCUSE_MAX = [^\n]*/,
 /function mergeEmployeeManual\(storedValue, incomingValue, name, selfMarkValue\) \{[\s\S]*?\n\}/,
 /function mergeEmployeeExcuses\(storedValue, incomingValue, name\) \{[\s\S]*?\n\}/,
 /const VISIT_DETAIL_MAX = [^\n]*/,
 /const VISIT_REASON_MAX = [^\n]*/,
 /function mergeEmployeeVisit\(storedValue, incomingValue, name, selfMarkValue\) \{[\s\S]*?\n\}/
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
    /function empDayWindow\(\)\{[\s\S]{0,400}?return \[todayISO_full\];/.test(
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

  check('only those the office marked may write one',
    ctx.mergeEmployeeVisit('{}', JSON.stringify({ ['Rahul Mishra|' + TODAY]:
      { cat: 'VISIT', detail: 'Factory' } }), 'Rahul Mishra', '{}') === false);
}

/* ---- why they were late ----
   An excuse cancels the lateness, so one written by the person it is about
   waits for the office. Otherwise the minutes mean nothing. */
{
  const mine = {}; mine['karan Ahuja|' + TODAY] = { note: 'Train was held at Gurgaon' };
  const out = parse(ctx.mergeEmployeeExcuses('{}', JSON.stringify(mine), 'karan Ahuja'));
  const e = out['karan Ahuja|' + TODAY];
  check('anybody may give a reason for being late, marked or not', !!e, out);
  check('it waits for the office rather than excusing the day itself',
    e.pending === true && e.by === 'self', e);
  check('and the words are kept', /Train was held/.test(e.note), e);

  /* The page could claim it was already accepted. It is not believed. */
  const sneaky = {};
  sneaky['karan Ahuja|' + TODAY] = { note: 'Traffic', pending: false, by: 'admin' };
  const out2 = parse(ctx.mergeEmployeeExcuses('{}', JSON.stringify(sneaky), 'karan Ahuja'));
  check('a page claiming its own excuse is already accepted is not believed',
    out2['karan Ahuja|' + TODAY].pending === true && out2['karan Ahuja|' + TODAY].by === 'self',
    out2['karan Ahuja|' + TODAY]);

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
  check('an employee may write those five things, and still nothing else',
    /EMPLOYEE_WRITABLE = \['leaveRequests', 'dailyTasks', 'manualRecords', 'lateExcuses', 'overrides'\]/.test(SRC));
  check('they read only their own row of who marks their own attendance',
    /EMP_KEYED_BY_NAME = \[[\s\S]{0,120}'selfMark'\]/.test(SRC));
  check('and a waiting excuse does not count as excused in the daily message',
    /if \(v && typeof v === 'object' && v\.pending === true\) return;/.test(SRC));
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
  check('a waiting excuse is not an excuse',
    /function getLateExcuse\(emp, d\)\{[\s\S]{0,200}?pending === true\) \? null/.test(APP),
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
    /var mine = marksOwn\(name\);/.test(card) && /if\(!mine && !isLate\)/.test(card), card.slice(0, 80));
  check('and only for today',
    /function empDayWindow\(\)\{[\s\S]{0,400}?return \[todayISO_full\];/.test(APP)
      && !/setDate\(back\.getDate\(\) - 1\)/.test(card));
  /* One day to choose from is no choice, and the date is written beside the
     title already - so no lone dead chip where the pair used to be. */
  check('and the day picker goes with it, there being one day',
    /days\.length > 1 \? days\.map/.test(card));
  check('a day typed in counts for lateness the same as one punched',
    /forLate = \(man && man\['in'\]\)/.test(card));
  check('the reason box tells them plainly that it is not granted yet',
    /the minutes count until they accept it/.test(card));
  check('and anybody late may give one, marked or not',
    /} else if\(rec\['in'\]\)\{/.test(card) && /if\(isLate\)\{/.test(card));
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
  /* Picking 2:49 PM out of a spinner is a dozen taps for a time the machine
     already knows, and punching in is when somebody is most in a hurry. */
  check('each box can take the time now in one press',
    /: nowBtn\(which\)\)/.test(card) && /f\.set\(nowHHMM\(\)\);/.test(card));
  /* Two numbers took the height of the card stacked. They read across now,
     with a hairline saying where the one ends and the other begins. */
  check('the two times read across, divided by a rule',
    /html \+= '<div class="ed-two">'/.test(card)
      && /<div class="ed-split" aria-hidden="true"><\/div>/.test(card)
      && /\.ed-two \.ed-split\{[^}]*width:1px/.test(APP));
  check('and Save sits at the end of that row',
    /<div class="ed-acts">[\s\S]{0,160}id="edSave"/.test(card));

  /* ---- a time already saved is settled ----
     An open box with a time in it invites a nudge. Once it is saved it reads
     back instead, and opening it again is a press and an answer. */
  check('a saved time reads back rather than sitting in an open box',
    /var settled = function\(which\)\{[\s\S]{0,120}man\[which\] && !EMP_EDIT\[which\]/.test(card)
      && /\(shut \? ' readonly tabindex="-1"' : ''\)/.test(card));
  check('its half-of-the-day buttons are shut too, and its chips put away',
    /\(shut \? ' disabled' : ''\)/.test(card)
      && /\(\(chips && !shut\) \?/.test(card));
  check('and it offers a way to change it',
    /class="ed-now ed-edit" data-unlock="/.test(card));
  check('which asks first, and says what the office will see',
    /hwConfirm\(\{[\s\S]{0,320}Change the ' \+ lbl \+ ' time you already saved\?/.test(card)
      && /moment you change it/.test(card));
  check('and only the one field asked for is opened',
    /renderEmpDayCard\(which\);/.test(card)
      && /EMP_EDIT = \{ 'in': openFor === 'in', out: openFor === 'out' \};/.test(APP));
  /* Saving draws the card again with nothing opened, so a save shuts the box
     it came from. */
  check('a save settles it again',
    /function renderEmpDayCard\(openFor\)\{/.test(APP));

  /* ---- a time well behind the clock says so, before the office does ---- */
  check('typing a time long past warns about the gap being recorded',
    /var warnBack = function\(\)\{/.test(card)
      && /if\(gap > selfFlagMin\(\)\)\{/.test(card)
      && /The office is shown the time you typed it/.test(card));
  check('and the warning rides along with everything that reads the pair',
    /tell = function\(\)\{ var r = tellTimes\(\); warnBack\(\); return r; \};/.test(card));

  /* ---- the mark the office sees is shown here too ----
     Nobody should learn from a meeting that their day carries a flag on
     somebody else's screen. Seeing it is what makes it fair to have. */
  check('a flagged entry is marked on the person’s own card',
    /var flagged = selfEntryFlagged\(name, day\);/.test(card)
      && /⚠ late entry/.test(card));
  check('and says the same thing the office is told',
    /⚠ Marked late\./.test(card) && /after the time claimed\./.test(card)
      && /The office sees the same thing/.test(card));
  check('still as a gap, not a verdict',
    /it is the gap that is on the record, not a verdict/.test(card));
  /* The live warning is about the time being typed; the settled one has its
     own line above and says more. Two amber boxes saying the same thing is
     one too many. */
  check('and a settled field is left to its own line',
    /if\(f\.wrap\.classList\.contains\('shut'\)\) return;/.test(card));
  /* Clear used to wipe the whole day, settled time and all, on one press with
     nothing asked - straight through the lock it is sitting next to. */
  check('Clear empties the boxes still open and leaves a settled one alone',
    /if\(!f \|\| f\.wrap\.classList\.contains\('shut'\)\) return;   \/\/ settled stays settled/.test(card)
      && /if\(f\.input\.value\)\{ f\.input\.value = ''; emptied\+\+; \}/.test(card));
  check('and it writes nothing — a settled time is only reachable through Edit',
    !/id="edClear"[\s\S]{0,900}saveManualRecords/.test(card));
  check('it is not offered when there is nothing open to empty',
    /\(!settled\('in'\) \|\| !settled\('out'\)\)/.test(card));
  check('and says so rather than doing nothing silently',
    /Nothing to clear — a saved time is changed with Edit\./.test(card));
  check('and it is offered only on today, "now" being no time yesterday',
    /var nowBtn = function\(which\)\{[\s\S]{0,200}return ceiling/.test(card),
    (/var nowBtn[\s\S]{0,140}/.exec(card) || [])[0]);
  check('today\u2019s boxes stop at the clock',
    /var ceiling = \(day === todayISO_full\) \? nowHHMM\(\) : '';/.test(card)
      && /has not happened yet \u2014 it is ' \+ fmtTime\(now\)/.test(card));
  /* The digits are typed, not spun: a time can be written any of the ways a
     person writes one, and the half of the day is picked rather than typed. */
  check('what was typed is read generously',
    /function parseEntry\(raw, mer\)/.test(APP)
      && /if\(h > 12 && h <= 23 && !said\)\{ mer = 'PM'; h -= 12; \}/.test(APP));
  check('and A or P picks the half of the day without leaving the keys',
    /\/\^\[apAP\]\$\/\.test\(ev\.key\)/.test(card));
  /* Offering 9:30 because that is when they always arrive beats offering a
     round number nobody uses. */
  check('the times this person actually uses are a tap away',
    /function usualTimes\(name, which\)/.test(APP)
      && /data-chip="' \+ which \+ '"/.test(card));
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
  check('an excused one says so, and one still waiting says that instead',
    /lxN \? ' \u00b7 excused' : \(plN \? ' \u00b7 sent' : ''\)/.test(cal));
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
  check('their own in and out says so, and their reason for being late',
    /Saved\. The office sees it on the record/.test(APP)
      && /Sent to the office\. The minutes count until they accept it/.test(APP));
}

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
