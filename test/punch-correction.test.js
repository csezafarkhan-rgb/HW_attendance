/* A punch correction is not leave, and the message about it said it was.
 *
 * Somebody forgot to punch, asked for the time on their record to be put
 * right, and the office was sent "The leave below is waiting for a decision"
 * with the year's casual and sick balances printed underneath it and a
 * month-by-month strip below that. None of it bore on the decision. A
 * correction takes no day and moves no balance.
 *
 * And the one thing that did bear on it - the times being asked for - was
 * nowhere on the message at all. Whoever opened it was shown a name, a date,
 * a sentence of apology and a column of leave figures, and had to go to the
 * dashboard to find out what was actually being claimed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}

const REQ = {
  id: 'r1', empName: 'Shyam Lal ESS', dateFrom: '2026-11-07', dateTo: '2026-11-07',
  leaveType: 'PUNCH', punchIn: '09:41', punchOut: '18:30', status: 'pending',
  message: 'I was busy preparing sample and forgot to mark my attendance on time.',
  createdAt: '2026-11-12T05:00:00Z',
  /* Attached on purpose: the card is drawn from several places and the point
     is that it refuses to print this one, not that nobody ever passes it.
     Shaped the way leaveRecordFor really hands it over - a fixture of my own
     invention would have rendered nothing and proved nothing. */
  leaveRecord: {
    record: { casual: { left: 1.75, of: 5, used: 3.25 }, sick: { left: 5, of: 5, used: 0 },
              all: { left: 6.75, of: 10, used: 3.25 }, year: 2026 },
    asOf: '2026-11-12', away: [], alsoWaiting: []
  }
};
const build = over => mailer.requestEmail(Object.assign({
  orgName: 'AllyConnect Pvt. Ltd.', req: REQ, approver: 'Munish Dhamija',
  links: { approve: '#', reject: '#' }
}, over || {}));

const mail = build();

/* ---- what it must not say ---- */
check('it does not call a correction a leave request',
  !/leave below is waiting/i.test(mail.html), null);
check('no leave balances under it - it cannot touch one',
  !/CASUAL|SICK LEAVE|ALL LEAVE/i.test(mail.html), null);
check('and no year at a glance',
  !/year at a glance/i.test(mail.html), null);
/* "1 day" beside a correction reads as a day of leave, which is the one
   thing it is not. */
check('it does not count the day as a day taken',
  !/\b1 day\b/.test(mail.html), null);

/* ---- what it must say ---- */
check('the time they are asking to be put right is on it',
  mail.html.indexOf('9:41') > -1, null);
check('and the other end of the day too',
  mail.html.indexOf('6:30') > -1, null);
check('said as what it is, rather than left for the reader to work out',
  /asking for/i.test(mail.html), null);
/* What is being asked comes before why: the times are the request, the
   sentence underneath is the reason for it. */
check('the times come before the reason they gave',
  mail.html.indexOf('9:41') < mail.html.indexOf('forgot to mark'), null);
check('the reason they typed is still there',
  mail.html.indexOf('forgot to mark') > -1, null);
check('approving it is said to write the times, not to grant leave',
  /writes the times shown onto that day/.test(mail.html)
  && /no leave is taken and no balance changes/.test(mail.html), null);
check('the subject names it a punch correction',
  /^Punch correction/.test(mail.subject), mail.subject);

/* One end of a day is often all that is wrong - somebody punched in and
   forgot to punch out. The end that stands is said to stand. */
{
  const one = build({ req: Object.assign({}, REQ, { punchOut: '' }) });
  check('with only one end corrected, the other says it is unchanged',
    /unchanged/.test(one.html) && one.html.indexOf('9:41') > -1, null);
  const other = build({ req: Object.assign({}, REQ, { punchIn: '' }) });
  check('either end, not just the morning',
    /unchanged/.test(other.html) && other.html.indexOf('6:30') > -1, null);
}

/* ---- leave is untouched by any of it ---- */
{
  const lv = build({
    req: Object.assign({}, REQ, { leaveType: 'CL', punchIn: '', punchOut: '' }),
    intro: 'The leave below is waiting for a decision.'
  });
  /* The block itself, by its own heading - not by a figure inside it, which
     is a detail of a fixture rather than of the thing being tested. */
  check('a real leave request still carries its leave record',
    /leave record/i.test(lv.html) && !/leave record/i.test(mail.html),
    { leave: /leave record/i.test(lv.html), punch: /leave record/i.test(mail.html) });
  check('and still counts its days',
    /\b1 day\b/.test(lv.html), null);
  check('and no times block, because none were asked for',
    !/asking for/i.test(lv.html), null);
}

/* ---- the office's own words, where it has written any ---- */
{
  const said = build({ subjectText: 'Time fix · {name} · {dates}' });
  check('a subject typed on the tab is used, with its placeholders filled',
    said.subject === 'Time fix · Shyam Lal ESS · 7 Nov’ 2026', said.subject);
  check('and left blank it falls back to the one this comes with',
    build({ subjectText: '' }).subject.indexOf('Punch correction') === 0, null);
  check('there is wording it comes with, so no box is empty',
    !!mailer.DEFAULT_TEXT.punch && !!mailer.DEFAULT_TEXT.punch.intro
    && !!mailer.DEFAULT_TEXT.punch.subject, mailer.DEFAULT_TEXT.punch);
  check('the greeting names whoever it is going to',
    mail.html.indexOf('Munish Dhamija') > -1, null);
}

/* ---- the answer to it is not the answer to leave ----
   The same fault arriving a second time, and to the person it is about:
   "Your leave has been approved" for a man who forgot to punch, with no word
   of what times went onto his record. */
{
  const base = { id: 'r', empName: 'Shyam Lal ESS', dateFrom: '2026-11-07',
                 dateTo: '2026-11-07', leaveType: 'PUNCH',
                 punchIn: '09:41', punchOut: '18:30', approvedBy: 'Munish Dhamija' };
  const yes = mailer.decisionEmail({ orgName: 'O', req: base, decision: 'approved' });
  const no = mailer.decisionEmail({ orgName: 'O', req: base, decision: 'rejected' });
  check('an approved correction does not say leave was approved',
    !/your leave/i.test(yes.html), null);
  check('nor does a refused one',
    !/your leave/i.test(no.html), null);
  check('and it says what went onto the record',
    yes.html.indexOf('9:41') > -1 && yes.html.indexOf('6:30') > -1, null);
  check('a refusal says the day stands as it was',
    /the day stands as it was/.test(no.html), null);
  check('the heading says which of the two happened',
    /Your time has been corrected/.test(yes.html)
    && /Your correction was not approved/.test(no.html), null);
  /* And the answer to real leave is untouched by any of it. */
  const lv = mailer.decisionEmail({ orgName: 'O', decision: 'approved',
    req: { id: 'r', empName: 'X', dateFrom: '2026-11-07', dateTo: '2026-11-07', leaveType: 'CL' } });
  check('a leave decision still reads as a leave decision',
    /your leave/i.test(lv.html) && !/asking for/i.test(lv.html), null);
}

/* ---- the server sends it as its own thing ---- */
check('a correction gets its own audience, not the leave one',
  /async function punchAudience\(/.test(SRV)
  && /\? await punchAudience\(orgId, settings, route, r\.empName, mgmt\)/.test(SRV), null);
check('typed addresses on the tab are who it goes to',
  /if \(!named\.length\) return await leaveAudience\(/.test(SRV), null);
/* Their own time being put right: a correction decided behind somebody is one
   they cannot query. */
check('and the person who asked is copied either way',
  /if \(own\) addCc\(own\);/.test(SRV), null);
check('no leave record is even fetched for one',
  /const withRecord = punch \? r/.test(SRV), null);
check('and its own wording is used',
  /intro: punch \? settings\.punch\.intro : settings\.leave\.intro/.test(SRV), null);
check('with a heading that is not about leave',
  /A time correction is waiting for a decision/.test(SRV), null);
check('the settings are kept and cleaned like every other tab',
  /s\.punch = \{/.test(SRV) && /s\.punch\.footer = theirs\(s\.punch\.footer\);/.test(SRV), null);

/* ---- the tab itself ---- */
check('there is a tab for it in the panel',
  /data-em-tab="pn"/.test(APP) && /data-em-pane="pn"/.test(APP), null);
check('with boxes for the addresses and the words',
  ['emPnTo', 'emPnCc', 'emPnSubject', 'emPnIntro', 'emPnFooter']
    .every(id => new RegExp('id="' + id + '"').test(APP)), null);
check('and saving the panel keeps all five',
  /punch: \{[\s\S]{0,220}list\('emPnTo'\)[\s\S]{0,220}emPnFooter/.test(APP), null);
check('the preview on that tab previews this message',
  /onTab === 'pn' \? 'punch'/.test(APP)
  && /=== 'punch'\) \{/.test(SRV), null);
/* A server that has not restarted sends no wording for a tab it does not
   know about, and a box reading "undefined" is worse than an empty one. */
check('a tab opened against an older server shows empty boxes, not undefined',
  /if\(!W\.punch\) W\.punch = \{subject:'', intro:'', footer:''\};/.test(APP), null);

/* ---- and the answer goes where the question went ----
   The decision was built from the leave audience whatever the request was,
   so the moment corrections got a tab of their own an office that pointed
   them elsewhere would have had the question in one inbox and the answer in
   another. The comment above it had been promising the opposite for months. */
check('a correction’s decision goes to the correction’s audience',
  /req\.leaveType === 'PUNCH'\s*\n?\s*\? await punchAudience\(orgId, settings, route, req\.empName, mgmt\)/
    .test(SRV), null);
check('and leave’s decision still goes to leave’s',
  /: await leaveAudience\(orgId, settings, route, req\.empName, mgmt\);/.test(SRV), null);
/* One sign-off, on every message - and this was the message it never reached,
   which is the one the person who asked actually waits for. */
check('the decision carries the office’s own sign-off',
  /footer: req\.leaveType === 'PUNCH' \? settings\.punch\.footer : settings\.leave\.footer/
    .test(SRV), null);

/* ---- one name, two accounts ----
   The only thread tying a person on the record to an account is the name. Two
   active accounts carried one name and the lower id won, so a man's leave was
   copied to a colleague's address - quietly, because picking one of two looks
   exactly like finding the one. */
check('an address two accounts answer to is not guessed at',
  /if \(hits\.length > 1\) \{/.test(SRV)
  && /return '';/.test(SRV), null);
check('and the office is told, rather than left to notice the silence',
  /async function duplicateAccountNames\(orgId\)/.test(SRV)
  && /sharedNames: await duplicateAccountNames\(req\.session\.orgId\)/.test(SRV), null);
/* Said in one place - the Users page, where the name is typed and where both
   accounts can be seen at once. A second warning elsewhere would be a second
   thing to keep true, which is the fault this whole audit kept finding. */
/* ---- and a message going nowhere says why ----
   "To nobody" is true and useless: it tells the office the reminder will not
   arrive and nothing about what to do, while both reasons are a minute's
   work on the Users page. One man had six unanswered days and no way to be
   told about any of them. */
check('the preview says why there is no address',
  /async function whyNoAddress\(orgId, empName\)/.test(SRV)
  && /two accounts are named/.test(SRV)
  && /no active account on this portal is named/.test(SRV), null);
check('and hands that reason to the preview window',
  /toNote: to \? '' : await whyNoAddress\(orgId, name\)/.test(SRV)
  && /pv\.toNote/.test(APP), null);
/* The real sender skipped them without a word, week after week. */
check('the sender says it too, rather than skipping in silence',
  /no reminder sent to/.test(SRV)
  && !/if \(!to\) continue;/.test(SRV), null);

check('said on the page where it can be put right, and only there',
  /so nobody is copied as them on their own requests/
    .test(fs.readFileSync(path.join(REPO, 'src', 'shell.template.html'), 'utf8'))
  && !/is on two accounts/.test(APP), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
