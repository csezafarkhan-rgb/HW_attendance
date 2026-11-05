/* The message about a late arrival somebody answered for themselves.
 *
 * Four things it got wrong, all of them about who wrote what.
 *
 * It said "Somebody". The office's own opening had no way to name the person
 * - {who} reached the subject line and nowhere else, though the other two
 * messages of this family offered it to the opening as well - so the word
 * stood in for a name that was sitting right there in the card below.
 *
 * It drew the reason they gave as a line of ordinary text, where a leave
 * request gives the same thing a band of its own. The reason is the only part
 * of either message a person wrote rather than the system.
 *
 * It went to the management and stopped there, over the head of whoever the
 * office named to answer for that person's leave - who is the one most likely
 * to know what was agreed about their hours.
 *
 * And it signed off "Best regards, <the org>", because every tab carries a
 * footer box of its own and the office had changed one of them.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, "'").replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

const AMAN = { name: 'Aman Chandra', day: '2026-11-05', late: 48, came: '10:18',
               shift: '9:30-6:30', note: 'meeting with carson, walmart ads account' };
const RAHUL = { name: 'Rahul Mishra', day: '2026-11-05', late: 12, came: '9:42',
                shift: '9:30-6:30', note: 'traffic' };
const build = (o, items) => mailer.excusedEmail(Object.assign(
  { orgName: 'AllyConnect Pvt. Ltd.', items: items || [AMAN] }, o));

/* ---- it can name the person ---- */
const OFFICE = "Hello Shivani ma'am / Nitish Sir,\n\n{who} has marked their own late arrival as excused.";
check('the office’s own opening can name who it is about',
  /Aman Chandra has marked their own late arrival/.test(strip(build({ intro: OFFICE }).html)),
  strip(build({ intro: OFFICE }).html).slice(0, 120));
check('and the day, as the other two messages of this kind already could',
  /5 Nov/.test(strip(build({ intro: 'On {date}, {who} was late.' }).html)), null);
check('several of them are all named, not just the first',
  /Aman Chandra and Rahul Mishra/.test(strip(build({ intro: OFFICE }, [AMAN, RAHUL]).html)), null);
/* This goes in subject lines too, and a subject listing nine people is a
   subject nobody reads in a list of mail. */
{
  const many = [1,2,3,4,5,6,7].map(i => ({ name: 'Person ' + i, day: '2026-11-05', note: 'x' }));
  const subj = build({ subject: 'Late excused · {who} · {date}' }, many).subject;
  check('past three it counts the rest rather than listing them',
    /Person 1, Person 2, Person 3 and 4 more/.test(subj), subj);
  check('and three or fewer are still named',
    /Person 1, Person 2 and Person 3/.test(
      build({ subject: '{who}' }, many.slice(0, 3)).subject), null);
}
check('the words it ships with name the person rather than saying Somebody',
  /\{who\} has marked their own late arrival/.test(mailer.DEFAULT_TEXT.excused.intro)
  && !/Somebody/.test(mailer.DEFAULT_TEXT.excused.intro), mailer.DEFAULT_TEXT.excused.intro);
/* Left alone, the message still reads for itself - an office that has written
   no opening is not shown a stray token. */
check('no opening of their own still reads as a sentence',
  /Somebody has marked their own late arrival as excused/.test(strip(build({ intro: '' }).html)),
  null);
check('and nothing is left showing a brace',
  !/\{who\}|\{date\}/.test(strip(build({ intro: OFFICE }).html)), null);

/* ---- what they wrote is drawn as what they wrote ---- */
check('the reason they gave has a band of its own',
  /background:#FFF7DF;border-left:3px solid #E8B931/.test(build({}).html), null);
check('and it is the reason, not the heading, inside it',
  /meeting with carson/.test(strip(build({}).html)), null);
check('a mark with nothing written on it draws no empty band',
  !/background:#FFF7DF/.test(build({}, [{ name: 'A', day: '2026-11-05', note: '' }]).html), null);
/* The same band a leave request gives the reason somebody typed. */
check('the same band a leave request uses for the same thing',
  /background:#FFF7DF;border-left:3px solid #E8B931/.test(mailer.requestCard(
    { empName: 'A', dateFrom: '2026-11-05', dateTo: '2026-11-05', leaveType: 'CL',
      message: 'because' }, null, 'Raised today')), null);

/* ---- it reaches the people who answer for them ---- */
check('whoever is named against them is on the message as well',
  /async function alsoTheirApprovers\(orgId, into, names, already\) \{/.test(SRV)
  && /who\.forEach\(n => approversOf\(route, n\)\.forEach\(a => \{/.test(SRV), null);
check('each person’s own approvers, not one list for a whole batch',
  /const who = Array\.from\(new Set\(\(names \|\| \[\]\)\.filter\(Boolean\)\)\);/.test(SRV), null);
check('and nobody is added for news about their own day',
  /if \(!own\[a\] && !taken\[a\] && into\.indexOf\(a\) < 0\) into\.push\(a\);/.test(SRV), null);
/* Nor twice, where somebody is already on the line the office typed. */
check('nor again where they are already addressed',
  /\(already \|\| \[\]\)\.forEach\(a => \{ taken\[String\(a \|\| ''\)\.trim\(\)\.toLowerCase\(\)\] = true; \}\);/
    .test(SRV), null);
/* The three messages off the self-marked card are the same kind of news about
   the same person, so they are addressed out of one piece of code rather than
   three kept in step by hand. Which of them asks for what is checked further
   down, where the card itself is. */
check('written once, asked for by both audiences',
  (SRV.match(/async function alsoTheirApprovers\(/g) || []).length === 1
  && (SRV.match(/await alsoTheirApprovers\(/g) || []).length === 2, null);
check('they are copied in instead, where the people whose days these are go',
  /cc\.push\.apply\(cc, await ownersOf\(orgId, marks\.map\(m => m\.empName\), to, cc\)\);/.test(SRV),
  null);

/* ---- and every message signs off the same way ---- */
check('a tab with no sign-off of its own uses the one on the Leave tab',
  /const signOff = String\(s\.leave\.footer \|\| ''\)\.trim\(\) \|\| SHIPPED_FOOT;/.test(SRV), null);
check('as does one still carrying the words it shipped with',
  /return \(!t \|\| t === SHIPPED_FOOT\) \? signOff : f;/.test(SRV), null);
check('every message is covered, not only the excused one',
  ['s.footer', 's.holiday.footer', 's.month.footer', 's.tasks.footer',
   's.excused.footer', 's.excused.shift.footer', 's.excused.part.footer']
    .every(k => SRV.indexOf(k + ' = theirs(' + k + ');') > -1), null);
/* A tab the office HAS written its own words on keeps them: this fills a
   blank and replaces a default, never anything somebody chose. */
check('and a sign-off somebody actually wrote is left alone',
  /never anything somebody actually wrote/.test(SRV), null);

/* ---- the words a person typed, in every message that carries any ----
   Each message is mostly bookkeeping - a name, a date, a kind, a span of
   hours - with one line somewhere in it that somebody actually wrote. Set as
   another grey line among grey lines it reads as more of the same, and it is
   the only part worth stopping on.

   Two of the six had a band for it and four did not, because it had been
   written out longhand in each of them rather than once. */
const D = '2026-11-05';
const REQ = { id: '1', empName: 'Zafar Khan', dateFrom: D, dateTo: D, leaveType: 'HALF',
              half: 'AM', status: 'approved', message: 'urgent work at home', createdAt: D };
const banded = h => /background:#FFF7DF;border-left:3px solid #E8B931/.test(String(h || ''));
const EVERY = {
  'a leave request': () => mailer.requestEmail({ orgName: 'O', req: REQ, intro: '', footer: '' }).html,
  'a late arrival excused': () => mailer.excusedEmail({ orgName: 'O', intro: '', footer: '',
    items: [{ name: 'A', day: D, note: 'meeting with carson' }] }).html,
  'a shift somebody set': () => mailer.shiftEmail({ orgName: 'O', intro: '', footer: '',
    items: [{ name: 'A', day: D, from: '9:30-6:30', to: '11-8', note: 'school run' }] }).html,
  'part of a day taken': () => mailer.partDayEmail({ orgName: 'O', intro: '', footer: '',
    items: [{ name: 'A', day: D, kindName: 'Half day', qty: 'half a day', half: 'PM',
              leave: 'CL', note: 'dentist' }] }).html,
  'the answer to a request': () => mailer.decisionEmail({ orgName: 'O', req: REQ,
    decision: 'approved' }).html,
  'a holiday reminder': () => mailer.holidayEmail({ orgName: 'O',
    holidays: [{ name: 'Diwali', when: '9 Nov', away: 4, note: 'factory open, office closed' }] }).html
};
Object.keys(EVERY).forEach(k => check('what somebody typed stands out in ' + k,
  banded(EVERY[k]()), null));
/* And it really is their words inside it, not the heading above them. */
check('the band holds the words, not the label around them',
  /dentist/.test(strip(EVERY['part of a day taken']())), null);
/* Nothing written is nothing shown - an empty band is a box drawn round air. */
const nothing = note => mailer.excusedEmail({ orgName: 'O', intro: '', footer: '',
  items: [{ name: 'A', day: D, note: note }] }).html;
check('nothing written draws no band', !banded(nothing('')), null);
check('nor does a line of spaces', !banded(nothing('   ')), null);
check('nor a note that is not there at all', !banded(nothing(undefined)), null);
/* Written once. It had drifted already - some quoted it, some did not, and
   only two of the six tinted it. */
const MAILER = fs.readFileSync(path.join(REPO, 'mailer.js'), 'utf8');
check('there is one definition of it',
  (MAILER.match(/function saidBand\(/g) || []).length === 1, null);
check('and every message asks that one for it',
  (MAILER.match(/saidBand\(/g) || []).length === 7, (MAILER.match(/saidBand\(/g) || []).length);
check('the tint is written down once, not six times',
  (MAILER.match(/background:#FFF7DF;border-left:3px solid #E8B931/g) || []).length === 1, null);
/* A holiday note is the office describing a day rather than somebody
   speaking, so it is not put in quotation marks. */
check('a holiday note is not quoted, because nobody is being quoted',
  !/\u201cfactory open/.test(EVERY['a holiday reminder']())
  && /factory open/.test(strip(EVERY['a holiday reminder']())), null);

/* ---- three settings on one card, three messages to read ----
   The self-marked card holds three: a late arrival answered for, the hours
   somebody set for today, and a part of the day taken. Its preview showed one
   of them - the third, which is the one with addresses of its own - so the
   two that follow the Leave tab could not be looked at until somebody was
   actually late. */
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
check('the sample builds all three, not just the one',
  /mailer\.excusedEmail\(\{[\s\S]{0,400}note: sampleNote/.test(SRV)
  && /mailer\.shiftEmail\(\{[\s\S]{0,400}note: sampleNote/.test(SRV)
  && /mailer\.partDayEmail\(\{[\s\S]{0,400}note: sampleNote/.test(SRV), null);
check('and hands them back as a set the window can page through',
  /return res\.json\(\{ ok: true, sample: true, mails: built,/.test(SRV), null);
check('the button says there are three of them',
  /if\(tab === 'lt'\) return '\\ud83d\\udc41 Preview all three for an employee';/.test(APP), null);
check('and a test send sends all three, not the first',
  /for \(const b of built\) \{/.test(SRV)
  && /return res\.json\(\{ ok: true, sentTo: box, count: built\.length \}\);/.test(SRV), null);

/* ---- addressed alike, because they are the same kind of news ---- */
check('who hears about somebody\u2019s own day is worked out in one place',
  /async function selfMarkedAudience\(orgId, settings, names\) \{/.test(SRV), null);
check('and the part-day one, which has addresses of its own, in another',
  /async function partTakenAudience\(orgId, settings, names\) \{/.test(SRV), null);
/* On the Cc. The addresses the office typed are the ones it addressed, and a
   message with no buttons on it gives its TO line no authority anyway. */
check('all three carry the approvers, copied in rather than addressed',
  (SRV.match(/await alsoTheirApprovers\(orgId, cc, names, to\);/g) || []).length === 2, null);
check('and never added to the addresses the office typed',
  !/alsoTheirApprovers\(orgId, to,/.test(SRV), null);
check('the late mark asks for its audience rather than working one out',
  /const \{ to, cc \} = await selfMarkedAudience\(orgId, settings, marks\.map\(m => m\.empName\)\);/
    .test(SRV), null);
check('so does the shift change',
  /const \{ to, cc \} = await selfMarkedAudience\(orgId, settings, moves\.map\(m => m\.empName\)\);/
    .test(SRV), null);
check('and so does a part of a day taken',
  /const \{ to, cc \} = await partTakenAudience\(orgId, settings, items\.map\(m => m\.empName\)\);/
    .test(SRV), null);
/* The point of doing it once: the preview and the real thing cannot disagree
   about who a message goes to. */
check('the preview asks the same two functions the senders ask',
  /const selfAud = await selfMarkedAudience\(orgId, settings, \[name\]\);/.test(SRV)
  && /add\(await partTakenAudience\(orgId, settings, \[name\]\), mailer\.partDayEmail/.test(SRV),
  null);
check('and the person whose day it is is copied in, as the senders copy them',
  /if \(own && aud\.to\.indexOf\(own\) < 0 && cc\.indexOf\(own\) < 0\) cc\.push\(own\);/.test(SRV),
  null);
check('the card says the approvers are on these too',
  /and whoever is named against/.test(APP), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
