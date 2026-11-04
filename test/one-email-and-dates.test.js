/* One request, one email - and a date that cannot be read two ways.
 *
 * A half day for 11 Mar' 2026 was raised in November. The day and the month
 * had been typed the wrong way round in a box that shows four numbers and no
 * clue which order the machine wants them in, and nothing between the box and
 * the approver's inbox said otherwise: the request carried the wrong day, the
 * record agreed with it, and the email was written about March.
 *
 * Two messages went out for it as well - the one that decides it, and a copy
 * to the person who asked and whoever the Leave tab copies in, with nothing on
 * it to press. The second reads like the first with the buttons missing.
 *
 * So: one email, to whoever may answer it. Every date box says back the day it
 * is holding, in words. And nothing from further back than a month is taken.
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
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

/* ---- one request, one email ---- */
check('only one message is built for a new request',
  (SRV.match(/mailer\.requestEmail\(Object\.assign\(\{\}, base/g) || []).length === 1, null);
check('and only one is sent',
  !/const ccMsg = \{ to: aud\.cc/.test(SRV), null);
check('the people who may answer it are in TO',
  /const toMsg = \{ to: aud\.to, cc: aud\.cc, subject: decide\.subject/.test(SRV), null);
check('and the people who are only told are on the Cc line of that same message',
  /const toMsg = \{ to: aud\.to, cc: aud\.cc/.test(SRV), null);
check('the sample shows it with its real Cc',
  /res\.json\(\{ ok: true, sample: true, to: aud\.to, cc: aud\.cc,/.test(SRV), null);
/* The person who asked still hears, once, when it is answered - and the
   answer is addressed exactly as the question was, so it lands in the same
   thread for everybody rather than starting a second one. */
check('and the decision goes back to the room the request went to',
  /const msg = \{ to: aud\.to, cc: aud\.cc, subject: mail\.subject, html: mail\.html \};/.test(SRV),
  null);
check('built from the same audience the request was built from',
  (SRV.match(/await leaveAudience\(orgId, settings, route, req\.empName, mgmt\)/g) || []).length >= 1,
  null);

/* ---- and a Cc cannot decide it, because the link is no longer the authority ---- */
check('who may press a button is worked out from the account, not the link',
  /async function decidableBy\(req, p\) \{/.test(SRV), null);
check('nobody signed out decides anything',
  /if \(!req\.session \|\| !req\.session\.userId\) return \{ how: 'signin' \};/.test(SRV), null);
check('nor anybody from another office holding the link',
  /if \(String\(req\.session\.orgId\) !== String\(p\.org\)\) return \{ how: 'no' \};/.test(SRV), null);
check('the account that is pressing it must be one the message went TO',
  /if \(aud\.to\.indexOf\(mine\) > -1\) return \{ how: 'yes', name: myName \|\| mine \};/.test(SRV), null);
/* leaveAudience keeps the person who asked out of TO whoever else they are,
   so this is also what stops somebody approving their own leave. */
check('which is the list the person who asked is never on',
  /if \(!EMAIL_RE\.test\(k\) \|\| k === own \|\| seen\[k\]\) return;/.test(SRV), null);
check('the page that asks checks first, before it says anything about the request',
  /const may = await decidableBy\(req, p\);[\s\S]{0,220}const done = await alreadySettled\(p\);/.test(SRV),
  null);
check('and the POST that acts checks again, because a POST need not have seen the page',
  (SRV.match(/const may = await decidableBy\(req, p\);/g) || []).length === 2, null);
check('a refusal offers the way in rather than only saying no',
  /mailer\.resultPage\(no\.title, no\.detail, false, no\.link\)/.test(SRV), null);
check('and tells a copied-in reader who it is actually with',
  /It is with ' \+ may\.who \+ '\. '/.test(SRV), null);

/* ---- a quarter of a day off is not a day off ---- */
const block = o => strip(mailer.leaveRecordBlock(o));
check('somebody off for the whole day is said to be off',
  /Aman Chandra is already off then/.test(
    block({ away: [{ name: 'Aman Chandra', part: false }] })), null);
check('somebody on a short leave is not',
  !/Rahul Mishra is already off then/.test(
    block({ away: [{ name: 'Rahul Mishra', part: true }] })), null);
check('they are said to have part of the day instead',
  /Rahul Mishra has part of that day off/.test(
    block({ away: [{ name: 'Rahul Mishra', part: true }] })), null);
{
  const both = block({ away: [{ name: 'Aman Chandra', part: false },
                              { name: 'Rahul Mishra', part: true }] });
  check('and the two are told apart on the day they both fall on',
    /Aman Chandra is already off then/.test(both)
    && /Rahul Mishra has part of that day off/.test(both)
    && !/Aman Chandra, Rahul Mishra are already off/.test(both), both.slice(0, 160));
}
check('two of them off for the day still read as a pair',
  /Ravi, Keshav are already off then/.test(block({
    away: [{ name: 'Ravi', part: false }, { name: 'Keshav', part: false }] })), null);
check('a plain list of names is still read, as a list of days off',
  /Ravi is already off then/.test(block({ away: ['Ravi'] })), null);

/* The server marks them by what is actually against the day. */
check('a part-day store is read as part of a day',
  /Object\.keys\(halfDays\)\.forEach\(k => \{ mark\(nameOn\(k, day\), true\); \}\);/.test(SRV), null);
check('an approved part-day request too',
  /mark\(r\.empName, PART_KINDS\.indexOf\(String\(r\.leaveType \|\| ''\)\.toUpperCase\(\)\) > -1\);/.test(SRV),
  null);
check('a day off on the record is a whole day',
  /if \(!v \|\| v\.cat !== 'LEAVE'\) return;\s*\n\s*mark\(nameOn\(k, day\), false\);/.test(SRV), null);
check('and it is handed over with the size of it, not just the name',
  /part: away\[n\] === true/.test(SRV), null);

/* ---- the date says what it is ---- */
const ctx = vm.createContext({});
vm.runInContext('var REQ_MONTHS = ' + /var REQ_MONTHS = (\[[^\]]+\])/.exec(APP)[1] + ';', ctx);
vm.runInContext(grab(APP, 'dayInWords'), ctx);
check('a date is said back in the words every message uses',
  ctx.dayInWords('2026-11-04') === '4 Nov’ 2026', ctx.dayInWords('2026-11-04'));
check('and the month is letters, so it cannot be read as a day of the month',
  ctx.dayInWords('2026-03-11') === '11 Mar’ 2026', ctx.dayInWords('2026-03-11'));
check('the two the typing confuses no longer look alike',
  ctx.dayInWords('2026-03-11') !== ctx.dayInWords('2026-11-03'), null);
check('nothing is said about an empty box',
  ctx.dayInWords('') === '' && ctx.dayInWords('rubbish') === '', null);
check('every date on the form says back what it is holding',
  /id="reqSayFrom"/.test(APP) && /id="reqSayTo"/.test(APP) && /id="reqSayReturn"/.test(APP), null);
check('and it is said as the boxes are typed into, not only when picked from',
  /box\.addEventListener\('input', sayRequestDates\)/.test(APP), null);

/* ---- and nothing from further back than a month ---- */
vm.runInContext(grab(APP, 'earliestRequestDay').replace('REQ_BACK_DAYS', '30'), ctx);
{
  const floor = ctx.earliestRequestDay();
  const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
  const today = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  const iso = today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate());
  check('the floor is thirty days back', days(iso, floor) === 30, [iso, floor]);
  check('and the day that was actually typed is below it',
    '2026-03-11' < floor, [floor]);
}
check('the box itself stops there',
  /if\(box\) box\.min = floor;/.test(APP), null);
check('and the form refuses it, because a typed date ignores the box',
  /if\(from < floor\)\{/.test(APP)
  && /which is more than '/.test(APP), null);
check('the refusal says which day it read, so the mistake is visible',
  /'You have picked ' \+ dayInWords\(from\)/.test(APP), null);
check('and tells them to look at the month',
  /Check the month/.test(APP), null);
check('the server will not take one either',
  /if \(r\.dateFrom < floor\) return;/.test(SRV), null);
check('worked out at the office’s own hour, not the server’s',
  /const floor = new Date\(Date\.now\(\) \+ IST_MS - backDaysOf\(backDays\) \* 86400000\)/.test(SRV),
  null);
/* Thirty is only what an office that has never opened the card gets. Both
   sides fall back to the same thirty, so an unset office and a page that has
   not read the setting yet agree rather than differing by a silent default. */
check('both sides fall back to the same number of days',
  /const REQ_BACK_DAYS = 30;/.test(SRV) && /var REQ_BACK_DAYS = 30;/.test(APP), null);

/* ---- and the day is picked, never typed ----
   The box still shows four numbers in whatever order the machine chose, and
   the person typing cannot tell which order that is. A calendar writes the
   month above the days, so there is nothing to get round the wrong way. */
check('the keyboard is turned away from the date boxes',
  /box\.addEventListener\('keydown', function\(e\)\{/.test(APP)
  && /e\.preventDefault\(\);/.test(APP), null);
check('but Tab and Escape still work, so nobody is trapped in one',
  /if\(e\.key === 'Tab' \|\| e\.key === 'Escape' \|\| e\.key === 'Enter'\) return;/.test(APP), null);
check('a click opens the calendar instead',
  /box\.addEventListener\('click', open\);/.test(APP)
  && /box\.showPicker\(\);/.test(APP), null);
check('and arriving by Tab opens it too',
  /box\.addEventListener\('focus', open\);/.test(APP), null);
check('where the calendar cannot be opened the box is left typeable',
  /if\(!canOpen\) return;/.test(APP), null);
check('all three date boxes on the request form are pick-only',
  /\['reqDateFrom','reqDateTo','reqReturn'\]\.forEach\(pickOnly\);/.test(APP), null);
/* The floor is still on the box, so the calendar greys out what it refuses
   rather than letting somebody pick a day the form will then turn down. */
check('and the calendar itself will not offer a day below the floor',
  /if\(box\) box\.min = floor;/.test(APP), null);

/* ---- the day-off form gets the same boxes, and keeps its old days ----
   It is the admin's form for leave already taken, so it is written by hand
   about days gone by - the same four numbers in the same unknowable order,
   and this one writes straight onto the record. What it must NOT get is the
   thirty-day floor: old days are the whole of its job. */
check('the day-off form says its dates back in words too',
  /id="pfSayFrom"/.test(APP) && /id="pfSayTo"/.test(APP) && /id="pfSayReturn"/.test(APP), null);
check('and its boxes are picked rather than typed',
  /\['pfFrom','pfTo','pfReturn'\]\.forEach\(function\(id\)\{[\s\S]{0,320}pickOnly\(id\);/.test(APP),
  null);
check('it says them as soon as it opens, not only once something is changed',
  /if\(typeof sayPastFormDates === 'function'\) sayPastFormDates\(\);/.test(APP), null);
/* The floor belongs to the request form alone. If it ever reached this one,
   the form for past leave would refuse the past. */
check('no floor is put on the day-off form',
  !/pfFrom[^\n]*\.min = floor/.test(APP) && !/\['pfFrom','pfTo'\][^\n]*\.min/.test(APP), null);
check('the floor is still set on the request form, and only there',
  (APP.match(/\.min = floor;/g) || []).length === 1
  && /\['reqDateFrom','reqDateTo'\]\.forEach\(function\(id\)\{[\s\S]{0,120}box\.min = floor;/.test(APP),
  null);
/* Both forms lean on the same two helpers rather than each having its own. */
check('both forms say the day the same way',
  (APP.match(/dayInWords\(/g) || []).length >= 4, null);

/* ---- the calendar opens once per click ----
   A click arrives twice, as focus and then as click. Opening on both shut the
   calendar the first call had just opened, and with the keyboard turned away
   there was nothing else left to do with the box. */
check('an opening is guarded, so the second event does not shut the first',
  /var opening = false, fromIcon = false;/.test(APP)
  && /if\(opening \|\| fromIcon\) return;/.test(APP)
  && /setTimeout\(function\(\)\{ opening = false; \}, 400\);/.test(APP), null);
/* The box draws its own calendar icon and the browser opens from it unasked.
   Asking again on top of that shut what it had just opened. */
check('the icon is left to do its own job',
  /var onTheIcon = function\(e\)\{/.test(APP)
  && /return \(r\.right - e\.clientX\) <= 34;/.test(APP)
  && /if\(!fromIcon\) open\(\);/.test(APP), null);
check('and where the icon is, is measured off the box rather than assumed',
  /var r = box\.getBoundingClientRect\(\);/.test(APP), null);
check('every way in is still listened for',
  /box\.addEventListener\('mousedown', function\(e\)\{/.test(APP)
  && /box\.addEventListener\('click', open\);/.test(APP)
  && /box\.addEventListener\('focus', open\);/.test(APP), null);

/* ---- how far back is the office's to set ---- */
check('the leave card carries the number',
  /id="emLvBack"/.test(APP), null);
check('and saving the card saves it',
  /backDays: parseInt\(\(document\.getElementById\('emLvBack'\) \|\| \{\}\)\.value, 10\) \|\| 30/.test(APP),
  null);
check('the server keeps it inside sane bounds',
  /function backDaysOf\(v\) \{/.test(SRV)
  && /return n > 0 \? Math\.max\(1, Math\.min\(365, n\)\) : REQ_BACK_DAYS;/.test(SRV), null);
check('it is read onto the leave settings',
  /backDays: backDaysOf\(lv\.backDays\)/.test(SRV), null);
check('the save path is handed the number rather than holding one',
  /function mergeEmployeeRequests\(storedValue, incomingValue, name, selfKinds, backDays\) \{/.test(SRV)
  && /backDaysOf\(backDays\) \* 86400000/.test(SRV), null);
check('and the call site reads it from the office\u2019s own settings',
  /\(await mailSettings\(req\.session\.orgId\)\)\.leave\.backDays\);/.test(SRV), null);
/* An employee has to obey it, so they are allowed to read it - and only it,
   because the rest of that key is addresses. */
check('an employee may read the number',
  /'leaveRequests', 'signatures', 'mailSettings'\]/.test(SRV), null);
check('and is handed that field alone, not the addresses around it',
  /return JSON\.stringify\(\{ leave: \{ backDays: backDaysOf\(lv\.backDays\) \} \}\);/.test(SRV), null);
check('the form asks for it rather than holding thirty',
  /function loadRequestWindow\(\)\{/.test(APP)
  && /loadRequestWindow\(\)\.then\(applyFloor\);/.test(APP), null);
check('and the floor is worked out again each time the form opens',
  /var applyFloor = function\(\)\{/.test(APP), null);

/* ---- and signing in puts them back where they were sent ----
   An approver is often an employee, and an employee's own page has no
   Requests list on it. The link in the email is the only way they can answer
   anything, so landing on the dashboard after signing in was not a longer
   road to the decision - it was no road at all. */
const AUTH = fs.readFileSync(path.join(REPO, 'public', 'hw-auth.js'), 'utf8');
check('the sign-in page is told where to come back to',
  /link: mailer\.baseUrl\(\) \+ '\/\?next=' \+ encodeURIComponent\('\/e\/' \+ token\)/.test(SRV),
  null);
check('and the refusal says so, rather than sending them off to look',
  /brought straight back here/.test(SRV), null);
check('both the page that asks and the POST that acts carry it',
  (SRV.match(/refusalFor\(may, req\.params\.token\)/g) || []).length === 2, null);
check('signing in goes there before the dashboard is built',
  /var back = returnTo\(\);\s*\n\s*if \(back\) \{ location\.replace\(back\); return; \}/.test(AUTH),
  null);
/* Where it will and will not go: a box that takes a destination from the URL
   is a box a stranger can point somewhere else. */
{
  const m = /return \/\^(\\\/e\\\/\[[^\]]+\]\+)\$\/\.test\(p\) \? p : '';/.exec(AUTH);
  check('only a path on this site, and only the one kind of page', !!m, AUTH.indexOf('returnTo'));
  const re = new RegExp('^\\/e\\/[A-Za-z0-9._~-]+$');
  check('a decision link is taken', re.test('/e/abc123.DEF_x-y~z'), null);
  check('another host is not', !re.test('https://evil.example/x'), null);
  check('nor a protocol-relative one', !re.test('//evil.example/x'), null);
  check('nor a different page on this site', !re.test('/admin'), null);
  check('nor one dressed up to look like a decision link', !re.test('/e/../admin'), null);
}

/* ---- how much is being asked for ----
   A range reads as two dates and nothing says how long it is; four days off
   and five are one keystroke apart. The form says it, in the words the leave
   record will use. */
vm.runInContext(grab(APP, 'isPartDay'), ctx);
vm.runInContext(grab(APP, 'hdQty'), ctx);
vm.runInContext(grab(APP, 'daysAsked'), ctx);
check('a span is counted inclusively - the 4th to the 6th is three days',
  ctx.daysAsked('CL', '2026-11-04', '2026-11-06') === '3 days',
  ctx.daysAsked('CL', '2026-11-04', '2026-11-06'));
check('one day is a day, not days',
  ctx.daysAsked('CL', '2026-11-04', '2026-11-04') === '1 day', null);
check('no To date is the From date alone',
  ctx.daysAsked('CL', '2026-11-04', '') === '1 day', null);
/* A part of a day is a part of ONE day, and what it costs is the fraction the
   balance is actually reduced by. */
check('a half day costs half a day, not one',
  ctx.daysAsked('HALF', '2026-11-04', '2026-11-04') === '0.5 day', null);
check('a short leave costs a quarter',
  ctx.daysAsked('SHORT', '2026-11-04', '2026-11-04') === '0.25 day', null);
check('a three-quarter day costs three quarters',
  ctx.daysAsked('THREEQ', '2026-11-04', '2026-11-04') === '0.75 day', null);
check('and the fractions are the ones the record counts by',
  ctx.hdQty('HALF') === 0.5 && ctx.hdQty('SHORT') === 0.25 && ctx.hdQty('THREEQ') === 0.75, null);
/* A punch correction is not leave and has no length worth saying. */
check('a punch correction says nothing', ctx.daysAsked('PUNCH', '2026-11-04', '2026-11-04') === '', null);
check('nor does an empty form', ctx.daysAsked('CL', '', '') === '', null);
check('rubbish in the boxes says nothing rather than NaN',
  ctx.daysAsked('CL', 'not-a-day', 'nor-this') === '', ctx.daysAsked('CL', 'not-a-day', 'nor-this'));
/* The server counts the same way for the email, so the form and the message
   about it cannot disagree. */
check('the email counts a span the same way',
  /let n = Math\.round\(\(b - a\) \/ 86400000\) \+ 1;/.test(
    fs.readFileSync(path.join(REPO, 'mailer.js'), 'utf8')), null);
check('the form shows it, and hides it when there is nothing to show',
  /id="reqSayDays"/.test(APP)
  && /tot\.style\.display = said \? '' : 'none';/.test(APP), null);
check('and says it again when the kind changes, because the kind sets the cost',
  /if\(typeof sayRequestDates === 'function'\) sayRequestDates\(\);/.test(APP), null);

/* ---- two active accounts under one name ----
   An employee's own address is found by their name, and where two accounts
   answer to it the lookup takes the lower id and says nothing. Their leave
   mail then goes to whichever account was made first and the person it is
   about never sees it - nothing errors, it simply arrives somewhere else.
   The Users page is where a name is typed and the only page that can see
   both accounts at once, so it says so there. */
const SHELL = fs.readFileSync(path.join(REPO, 'src', 'shell.template.html'), 'utf8');
check('the address is found by name, lowest id winning silently',
  /lower\(COALESCE\(name, ''\)\) = lower\(\$2\) ORDER BY id LIMIT 1/.test(SRV), null);
check('the users page gathers the active accounts by name',
  /var byName = \{\};/.test(SHELL)
  && /if\(u\.is_active === false\) return;/.test(SHELL), null);
check('a name on more than one active account is a clash',
  /var clashes = Object\.keys\(byName\)\.filter\(function\(k\)\{ return byName\[k\]\.length > 1; \}\);/
    .test(SHELL), null);
check('and the warning names the account the mail actually reaches',
  /var wins = who\.slice\(\)\.sort\(function\(a,b\)\{ return a\.id - b\.id; \}\)\[0\];/.test(SHELL)
  && /leave mail for them goes to ' \+ wins\.email \+ ' only\./.test(SHELL), null);
check('it says what to do about it',
  /Give one of them a different name, or switch the spare account off\./.test(SHELL), null);
check('and the rows themselves are flagged, so it can be acted on',
  /dup\.textContent='name shared';/.test(SHELL), null);
/* A disabled account is not in the running for the lookup, so sharing a name
   with one is not a clash and must not be cried over. */
check('a disabled account sharing a name is not a clash',
  /if\(u\.is_active === false\) return;/.test(SHELL)
  && /u\.is_active !== false && clashes\.indexOf/.test(SHELL), null);
check('nor is a blank name, which is not a name at all',
  /if\(!k\) return;/.test(SHELL), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
