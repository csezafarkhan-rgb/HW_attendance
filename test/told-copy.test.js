/* The copy that is only telling somebody.
 *
 * A new request goes out twice: once to whoever may decide it, with the
 * buttons on it, and once to the person who asked and whoever the office has
 * copied in, with nothing on it to press. That is what makes "the people in
 * Cc cannot approve it" true rather than a convention.
 *
 * The two copies were identical apart from the gap where the buttons had
 * been, and both opened with the office's own wording - "Approve or reject it
 * from the buttons" - so the told copy told its reader to press buttons it
 * did not carry. Read on its own, in an inbox, it looks like the message, and
 * the people on it look like the only people it went to.
 *
 * So: the told copy says what it is, in place of those words, and names who
 * does have the buttons.
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
  .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

const REQ = { id: '1', empName: 'Shyam Lal ESS', dateFrom: '2026-03-11', dateTo: '2026-03-11',
              leaveType: 'HALF', half: 'AM', status: 'pending',
              message: 'Family function at home', createdAt: '2026-11-04' };
/* The office's own wording, which is written for whoever decides it. */
const INTRO = 'Dear {approver},\n\nThe leave below is waiting for a decision.'
            + ' Approve or reject it from the buttons — Kindly check';
const BASE = { orgName: 'AllyConnect Pvt. Ltd.', req: REQ, intro: INTRO, footer: '',
               siteUrl: 'https://attendance.homeweavers.net' };
const NOTE = 'For information — there is nothing to decide on this copy.'
           + ' It is with Shivani Dutt, Nitish Kumar and Munish Dhamija, who have the buttons.';

const decide = mailer.requestEmail(Object.assign({}, BASE, {
  links: { approve: 'https://a', reject: 'https://r' }, approver: 'Munish Dhamija',
  heading: 'A request is waiting for a decision' }));
const told = mailer.requestEmail(Object.assign({}, BASE, {
  links: null, approver: 'Shyam Lal ESS', note: NOTE,
  heading: 'A request has been raised' }));

/* ---- the copy that decides it is untouched ---- */
check('the deciding copy still carries the buttons',
  /Approve/.test(decide.html) && /Reject/.test(decide.html), null);
check('and still opens with the words the office typed',
  /from the buttons/.test(strip(decide.html)), null);
check('greeting whoever that copy is going to',
  /Dear Munish Dhamija,/.test(strip(decide.html)), null);

/* ---- and the copy that is only telling somebody ---- */
check('the told copy has nothing on it to press',
  !/Approve/.test(told.html) && !/>Reject</.test(told.html), null);
check('it no longer tells its reader to press buttons it does not have',
  !/from the buttons/.test(strip(told.html).replace(NOTE, '')), null);
check('it says what it is instead',
  /there is nothing to decide on this copy/.test(strip(told.html)), null);
check('and names who does have them',
  /It is with Shivani Dutt, Nitish Kumar and Munish Dhamija/.test(strip(told.html)), null);
check('the heading says the same thing',
  /A request has been raised/.test(strip(told.html)), null);
check('the request itself is still on it - the dates, the kind, the reason',
  /Shyam Lal ESS/.test(strip(told.html)) && /Half day/.test(strip(told.html))
  && /Family function at home/.test(strip(told.html)), null);

/* A note without the band is nothing: the note used to be passed in and
   dropped on the floor, which is how the two copies came to read alike. */
check('a note that is passed in reaches the message',
  strip(told.html).indexOf('For information') > -1, null);
check('and a copy with buttons ignores a note, because it is not telling anybody',
  !/there is nothing to decide/.test(strip(mailer.requestEmail(Object.assign({}, BASE, {
    links: { approve: 'https://a', reject: 'https://r' }, approver: 'Munish Dhamija',
    note: NOTE })).html)), null);
/* No note at all is the message as it was - a preview, a digest, anything
   that is not one of these two copies. */
const bare = mailer.requestEmail(Object.assign({}, BASE, { links: null, approver: 'Somebody' }));
check('and with no note the words the office typed are used, as before',
  /from the buttons/.test(strip(bare.html)), null);

/* ---- the server sends them that way ---- */
check('the told copy is built with no links on it',
  /links: null, heading: 'A request has been raised', approver: r\.empName/.test(SRV), null);
check('and its note names the people the deciding copy went to',
  /const deciders = await approverNames\(orgId, aud\.to\);/.test(SRV)
  && /It is with ' \+ deciders \+ ', who have the buttons\./.test(SRV), null);
check('the deciding copy goes to TO and the told copy to CC',
  /const toMsg = \{ to: aud\.to, cc: \[\]/.test(SRV)
  && /const ccMsg = \{ to: aud\.cc, cc: \[\]/.test(SRV), null);

/* ---- and the preview shows both, because it was showing one ---- */
check('the sample hands back both messages, not one with a Cc line under it',
  /const mails = \[\{ subject: mail\.subject, to: aud\.to, cc: \[\], html: mail\.html \}\];/.test(SRV)
  && /if \(told\) mails\.push\(\{ subject: told\.subject, to: aud\.cc, cc: \[\], html: told\.html \}\);/.test(SRV),
  null);
check('the second of them is the told copy, with no links',
  /links: null, approver: name,[\s\S]{0,400}heading: 'A request has been raised' \}\) : null;/.test(SRV),
  null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
