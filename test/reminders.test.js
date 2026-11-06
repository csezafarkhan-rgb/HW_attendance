/* Reminding one person what their own record is still waiting on them for.
 *
 * Two things here, and the first is why the second exists.
 *
 * A reason for a late morning could only be given for today. The server said
 * so - ownDays - and the panel on somebody's own page offered a month of
 * them, so every save for an older day came back 200 and was dropped in the
 * merge without a word. A day somebody had answered for went on reading
 * "nothing said about it yet", which is how the bug was found: by being told
 * it was still showing.
 *
 * And a reminder, to the person themselves, listing what they still owe -
 * for whoever has not opened that page in a fortnight, which is the only
 * person a reminder is any use to.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), d = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; k++;
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
      continue;
    }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) break; }
  }
  return src.slice(i, k + 1);
}

/* ---- the days a reason may still be given for ---- */
const ctx = vm.createContext({ Date, Math, Array, String, Number, JSON });
vm.runInContext('const IST_MS = 5.5*3600*1000; const REQ_BACK_DAYS = 30;', ctx);
['backDaysOf', 'parseShiftSpan', 'nightTurnsAt', 'ownDays', 'ownExcusableDays']
  .forEach(n => vm.runInContext(grab(SRV, n), ctx));
const ago = n => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);
{
  const d = ctx.ownExcusableDays('9:30-6:30', 30);
  check('today can still be answered for', d.indexOf(ago(0)) > -1, null);
  check('and so can a morning three weeks back',
    d.indexOf(ago(21)) > -1, null);
  check('out to the edge of the window', d.indexOf(ago(30)) > -1, null);
  check('but not past it', d.indexOf(ago(31)) === -1, null);
  check('and never a day that has not happened', d.indexOf(ago(-1)) === -1, null);
  check('no day is offered twice', new Set(d).size === d.length, d.length);
  /* The office's own number, so the page cannot offer a day this refuses. */
  const short = ctx.ownExcusableDays('9:30-6:30', 3);
  check('a shorter window set by the office is obeyed',
    short.length === 4 && short.indexOf(ago(3)) > -1 && short.indexOf(ago(4)) === -1,
    short.length);
  /* A night worker's "today" is the night just worked, and the window counts
     back from there like everybody else's. */
  check('a night shift still starts from the night it just worked',
    ctx.ownExcusableDays('19:00-4:00', 30)[0] === ctx.ownDays('19:00-4:00')[0], null);
}
/* Clocking in is a different act and keeps the old rule: nobody clocks in for
   last Tuesday, but they may well explain it. */
check('clocking in is still today only',
  (SRV.match(/const days = ownDays\(shift\);/g) || []).length === 3, null);
check('and only the excuse merge reaches further back',
  /const days = ownExcusableDays\(shift, backDays\);/.test(SRV), null);
check('from the same window the request form uses',
  /\(await mailSettings\(req\.session\.orgId\)\)\.leave\.backDays\);/.test(SRV), null);

/* What the merge still refuses, window or no window. */
const merge = grab(SRV, 'mergeEmployeeExcuses');
check('somebody else’s day is still not theirs to answer for',
  /String\(k\)\.slice\(0, i\) === name/.test(merge), null);
check('nor a mark the office wrote',
  /const byOffice = k => \{ const v = out\[k\]; return !!v && typeof v === 'object' && v\.by !== 'self'; \};/
    .test(merge), null);
check('and an excuse with no reason on it is refused',
  /if \(!note && !own\) return;/.test(merge), null);

/* ---- the reminder itself ---- */
const ITEMS = [
  { job: 'form', day: '2026-11-03', type: 'HALF', half: 'PM' },
  { job: 'late', day: '2026-11-05', mins: 48, came: '10:18' },
  { job: 'reply', day: '2026-10-31', asked: 'Which half were you away?' }
];
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const mk = items => mailer.remindEmail({ orgName: 'O', name: 'Rahul Mishra',
  day: '2026-11-06', items: items, siteUrl: 'https://x' });
{
  const m = mk(ITEMS), t = strip(m.html);
  check('it names the person it is for', /Hi Rahul Mishra/.test(t), null);
  check('leave with no form says what kind it was',
    /Half day/.test(t) && /no form behind it/.test(t), null);
  check('and that the day is already counted',
    /already counted/.test(t), null);
  check('a late morning says how late and when',
    /48 min late/.test(t) && /10:18 AM/.test(t), null);
  check('a question carries the question',
    /Which half were you away\?/.test(t), null);
  check('and the subject counts them', /3 thing/.test(m.subject), m.subject);
}
/* Nobody is sent an empty nag. */
check('nothing outstanding is no message at all', mk([]) === null, null);
check('and the sender skips anybody it gets none for',
  /if \(!mail\) continue;/.test(SRV), null);

/* ---- to them, and to nobody else ---- */
const send = grab(SRV, 'sendRemindersOnce');
check('it is addressed to the person it is about',
  /const to = await employeeAddress\(orgId, name\);/.test(send), null);
check('with nobody copied in',
  /const msg = \{ to: \[to\], cc: \[\], subject: mail\.subject, html: mail\.html \};/.test(send), null);
check('and somebody with no account is passed over rather than guessed at',
  /if \(!to\) continue;/.test(send), null);

/* ---- what it does and does not chase ---- */
const owed = grab(SRV, 'pendingByEmployee');
check('leave with no form is chased', /job: 'form'/.test(owed), null);
check('an unexplained late morning is chased', /job: 'late'/.test(owed), null);
check('an unanswered question is chased', /job: 'reply'/.test(owed), null);
/* A request sitting with an approver is not theirs to finish, and telling
   somebody to get on with a thing they cannot do teaches them to ignore the
   next message. */
check('a request waiting on somebody else is not',
  !/job: 'chase'/.test(owed) && /status !== 'query'/.test(owed), null);
check('a day signed off is not a late morning',
  /ov\.cat === 'LEAVE' \|\| ov\.cat === 'WFH' \|\| ov\.cat === 'VISIT'/.test(owed), null);
check('nor one already answered either way',
  /if \(excuses\[key\]\) return;/.test(owed), null);
check('and nothing older than the window is raked up',
  /day >= \$2 AND day <= \$3/.test(owed), null);

/* ---- when it goes ---- */
check('off until the office turns it on',
  /daily: rm\.daily === true,/.test(SRV) && /weekly: rm\.weekly === true,/.test(SRV), null);
check('Friday is the day it suggests',
  /\? Math\.floor\(Number\(rm\.weekday\)\) : 5/.test(SRV), null);
check('a weekday outside the week is not taken',
  /Number\(rm\.weekday\) >= 0 && Number\(rm\.weekday\) <= 6/.test(SRV), null);
check('daily and weekly together is still one message',
  /const job = 'remind-email:' \+ orgId \+ ':' \+ day;/.test(send)
  && /if \(dueDaily \|\| dueWeekly\) await sendRemindersOnce\(org\.id, day, s\);/.test(SRV), null);
/* A round that sent nothing gives the day back, so the hour it was due is not
   spent on an empty sweep. */
check('a round that sent nothing may be tried again',
  /if \(!sent\) await pool\.query\('DELETE FROM maintenance_done WHERE job = \$1', \[job\]\);/
    .test(send), null);

/* ---- the card ---- */
check('there is a card for it beside the others',
  /data-em-tab="rm">Reminders</.test(APP) && /data-em-pane="rm"/.test(APP), null);
check('with both hours on it',
  /id="emRmDailyAt"/.test(APP) && /id="emRmWeeklyAt"/.test(APP), null);
check('and the weekday to choose',
  /id="emRmDay"/.test(APP) && /\['5','Friday'\]/.test(APP), null);
check('saving the card saves them',
  /weekday: parseInt\(document\.getElementById\('emRmDay'\)\.value, 10\),/.test(APP), null);
check('the card says who it reaches',
  /to the person it is about, and to nobody else/.test(APP), null);
check('previewing it asks which employee',
  /onTab === 'rm' \? 'remind'/.test(APP), null);
check('and says so where there is nothing to preview',
  /has nothing outstanding/.test(SRV), null);

/* ---- three ways two pieces of code answered one question differently ----

   Found by reading what a real person would actually be sent rather than by
   reading the checks above, which all passed while every one of these was
   wrong. They share a shape: the panel on somebody's own page and the message
   about it each worked something out, and the two did not agree. */

/* A part of a day already taken is not a late morning. Somebody with the
   morning off arrives in the afternoon, and against a 9:30 start that reads
   as four hours late - which is how a half day logged "Car Accident" came out
   of this as a lecture about punctuality. Two others were short leaves the
   office had itself recorded with the note "Late". */
check('a day with a part of it already taken is not chased as lateness',
  /if \(halfDays\[key\]\) return;/.test(owed), null);
check('nor a holiday nobody was due in on',
  /if \(holidays\[day\]\) return;/.test(owed), null);
check('and the holidays are actually read to know that',
  /'manualRecords', 'officialLeaves'\]\);/.test(SRV)
  && /const holidays = parseJson\(kv\.officialLeaves\) \|\| \{\};/.test(SRV), null);
/* Their own page has never counted these - onApprovedLeave asks the same
   question - so this is also the two sides agreeing. */
check('which is the same question their own page asks',
  /if\(onApprovedLeave\(name, d\)\) return;/.test(APP)
  && /if\(getHalfDay\(empName, dateStr\)\) return true;/.test(APP), null);

/* A time typed against a day beats the punch, because a correction is the
   whole reason a typed time exists. The panel took the typed one, this took
   the punch, and a corrected morning read two ways depending on which told
   you about it. */
check('a typed time beats the punch when the reminder reckons lateness',
  /const inAt = \(m && m\['in'\]\) \? m\['in'\] : \(data\['in'\] \|\| ''\);/.test(SRV), null);
check('and the hour it reports is the one it reckoned from',
  /came: inAt \}\);/.test(SRV), null);
/* The page already had something that settles this. Asking it beats settling
   the same question a third time and getting a third answer. */
check('the panel asks the one thing that already settles it',
  /var use = getRecord\(name, d\);/.test(APP), null);
check('rather than picking between them itself',
  !/var use = \(man && man\['in'\]\) \? man : rec;/.test(APP), null);

/* How far back a request may reach is the office's to set, and the panel used
   the shipped thirty until somebody opened the request form - so an office
   that shortened the window had a page offering days the server would refuse.
   Which is the fault this whole file exists because of. */
check('the window is read when the page loads, not when a form opens',
  /loadRequestWindow, loadDeskTime/.test(APP), null);
check('so the list and the server agree about how far back it goes',
  /return earliestRequestDay\(\);/.test(grab(APP, 'ewFloor'))
  && /backDaysOf\(settings\.leave\.backDays\)/.test(owed), null);

/* ---- the day a cell opens ----
   A cell saying "14 min late · said why" opened onto a panel that showed
   nothing of what was said. It drew the office's excuse and stopped, and a
   reason somebody gives for their own lateness is deliberately not that -
   the getters keep the two apart because only one takes the minutes off. So
   the cell advertised a note the panel behind it would not show. */
const day = grab(APP, 'openReadOnlyDetail');
check('a reason they gave for themselves is shown',
  /var pl = getLatePlea\(name, dateStr\);/.test(day)
  && /they said why/.test(day), null);
check('and an excuse the office gave is still shown',
  /late \\u00b7 excused/.test(day) || /late \u00b7 excused/.test(day), null);
check('lateness with nothing said is said plainly',
  /nothing said about it/.test(day), null);
check('a part of the day taken says which half and off which balance',
  /hdLabel\(hd\.kind\)/.test(day)
  && /second half/.test(day) && /off ' \+ hd\.leave/.test(day), null);
check('leaving early is there too, excused or not',
  /if\(rec && isEarly\(name, rec\)\)\{/.test(day), null);
check('and a holiday carries its name and note',
  /if\(hol\) note\('Holiday/.test(day), null);
check('a mispunch flag is kept',
  /if\(mp\) note\('Flagged as a mispunch'/.test(day), null);
/* Each note names what it is before quoting what was written: a reason on
   its own does not say whether it excused the day or only explained it. */
check('every note says what it is before what was written',
  /\+ '<b>' \+ escapeHtml\(head\) \+ '<\/b>'/.test(day), null);
check('and a day with nothing on it says so',
  /Nothing written about this day/.test(day), null);
/* The cell and the panel read the same getters, so they cannot disagree
   about what a day holds - which was the whole fault. */
check('the panel reads the same getters the cell does',
  ['getLatePlea', 'getLateExcuse', 'getEarlyExcuse', 'getHalfDay', 'getOfficialLeave']
    .every(g => new RegExp(g + '\\(').test(day)), null);
check('and the colour follows what it means',
  /'ok'\);/.test(day) && /'wait'\);/.test(day) && /'late'\);/.test(day), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
