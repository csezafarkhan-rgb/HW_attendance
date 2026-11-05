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
check('whoever is named against them is written to as well',
  /async function alsoTheirApprovers\(orgId, to, names\) \{/.test(SRV)
  && /who\.forEach\(n => approversOf\(route, n\)\.forEach\(a => \{/.test(SRV), null);
check('each person’s own approvers, not one list for a whole batch',
  /const who = Array\.from\(new Set\(\(names \|\| \[\]\)\.filter\(Boolean\)\)\);/.test(SRV), null);
check('and nobody is written to about their own day',
  /if \(!own\[a\] && to\.indexOf\(a\) < 0\) to\.push\(a\);/.test(SRV), null);
/* An excused late mark and a shift somebody set for themselves are the same
   kind of news about the same person, so they are addressed the same way -
   out of one piece of code rather than two kept in step by hand. */
check('the excused mark asks for them',
  /await alsoTheirApprovers\(orgId, to, marks\.map\(m => m\.empName\)\);/.test(SRV), null);
check('and so does a shift somebody set for themselves',
  /await alsoTheirApprovers\(orgId, to, moves\.map\(m => m\.empName\)\);/.test(SRV), null);
check('written once, asked for twice',
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
