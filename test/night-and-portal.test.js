/* Two things the evening message never said.
 *
 * One: somebody on nights had not failed to arrive at half past seven in the
 * evening - their day had not started. Counted as absent, the message said
 * something false about a man who worked nine hours and went home at four.
 *
 * Two: a thumb on the reader, the office typing a time in, and a person
 * pressing Clock in on their own page all came out looking the same.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}

const hhmm = t => { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1]); };
const present = (name, inT, shift, via) => ({
  name, emp: name, 'in': inT, out: '', state: 'present', kind: 'present',
  label: 'In, not out yet', inMin: hhmm(inT), shift, via: via || ''
});
const missing = (name, shift) => ({
  name, emp: name, 'in': '', out: '', state: 'missing', kind: 'missing',
  label: 'Not Reached Office', inMin: null, shift, via: ''
});
/* What the pass in server.js turns a missing night worker into. */
const onNights = (name, inT, outT, worked, shift, via) => ({
  name, emp: name, 'in': inT, out: outT, state: 'night', kind: 'night',
  label: 'On Night Shift', inMin: hhmm(inT), worked,
  shift: shift + ' · last night', via: via || ''
});

const build = rows => mailer.dailyEmail({
  orgName: 'Test Co', dateLabel: 'Tue, 4 Nov', rows,
  hidden: 0, attached: false, siteUrl: 'https://x',
  sections: { tally: true, table: false, shot: false, late: false,
              shifts: false, wfh: false, visits: false }
}).html;

const DAY = [
  present('Habib', '9:02', '9:30-6:30'),
  present('Keshav Garg', '9:08', '9:30-6:30'),
  present('Aman Chandra', '9:21', '9:30-6:30'),
  present('Zafar Khan', '9:26', '9:30-6:30'),
  missing('karan Ahuja', '8:30-5:30')
];

/* ---- the card of his own ------------------------------------------------ */
{
  const html = build(DAY.concat([onNights('Aman Gupta', '19:04', '4:04', '9:00', '19:00-4:00')]));
  check('there is a card for people on nights', html.indexOf('On Night Shift') > -1, null);
  {
    /* A portal mark sits with the time it marks, so a wrap takes it to the
       second line with the span rather than stranding it after the name. */
    const p = build([onNights('Aman Gupta', '19:04', '4:04', '9:00', '19:00-4:00', 'portal')]);
    check('a portal mark travels with the span, not the name',
      /9:00<sup[^>]*>P<\/sup><\/span>/.test(p), null);
  }
  check('and he is on it', html.indexOf('1_Aman Gupta') > -1, null);
  /* The whole night, because a night is a span and not a moment: when it
     began, when it ended, and how long it was. */
  check('it carries the night he worked, end to end',
    html.indexOf('(7:04 PM → 4:04 AM)') > -1, null);
  check('and how long it was', /\(7:04 PM → 4:04 AM\) · 9:00/.test(html), null);
  /* The line is longer than a narrow card, so it is allowed to wrap - in one
     place only, the gap between the name and the span. Left to itself the
     card broke the name instead, and 1_Aman / Gupta reads as two people. */
  check('the name is held together',
    /<span style="white-space:nowrap;">1_Aman Gupta<\/span>/.test(html), null);
  check('and so is the span',
    /white-space:nowrap[^"]*"> \(7:04 PM → 4:04 AM\) · 9:00/.test(html), null);
  check('so the only place the line can break is between the two',
    /<\/span><span style="white-space:nowrap;color:/.test(html), null);
  check('the slot says which night it was',
    html.indexOf('19:00-4:00 · last night') > -1, null);

  /* The count is the part people read, and he is not in it. */
  const red = html.slice(html.indexOf('Not Reached Office') - 200, html.indexOf('Not Reached Office'));
  check('the absent count is the one man who really has not arrived',
    />1<\/div>/.test(red), red.slice(-80));
  check('and he is not in that card',
    html.indexOf('Aman Gupta') > html.indexOf('Not Reached Office'), null);
}

/* ---- and the room it is given ----
   The night card carries a name, two times and the hours between them where
   every other card carries a name and one time. An equal share each and its
   line ran out past its own border. */
{
  const widths = function (html) {
    const out = {};
    const re = /<td width="(\d+)%"[\s\S]{0,400}?padding-bottom:4px;">([^<]+)</g;
    let m;
    while ((m = re.exec(html))) out[m[2]] = +m[1];
    return out;
  };
  const w = widths(build(DAY.concat([onNights('Aman Gupta', '19:04', '4:04', '9:00', '19:00-4:00')])));
  check('the night card is given more room than the others',
    w['On Night Shift'] > w['Present'] && w['On Night Shift'] > w['Not Reached Office'], w);
  check('and the row still adds up to a row',
    Object.keys(w).reduce(function (a, k) { return a + w[k]; }, 0) <= 100, w);
  /* Taken from the others in proportion, not from one of them. */
  check('the other cards keep an equal share of what is left',
    w['Present'] === w['Not Reached Office'], w);
  const even = widths(build(DAY));
  check('and with no night card the shares are equal again',
    even['Present'] === even['Not Reached Office'], even);
}

/* A night nobody was on puts no empty card on the message. */
{
  const html = build(DAY);
  check('nobody on nights, no card for it', html.indexOf('On Night Shift') === -1, null);
}

/* Still in: the night has a start and no end yet, so there is nothing to
   measure and the card says only when it began. */
{
  const html = build(DAY.concat([onNights('Aman Gupta', '19:04', '', '', '19:00-4:00')]));
  check('a night still being worked shows its start and no span',
    html.indexOf('(7:04 PM)') > -1 && html.indexOf('→') === -1, null);
}

/* ---- the mark for a time somebody put there themselves ------------------ */
{
  const html = build([
    present('Habib', '9:02', '9:30-6:30'),
    present('Aman Chandra', '9:21', '9:30-6:30', 'portal'),
    present('Zafar Khan', '9:26', '9:30-6:30')
  ]);
  check('a portal mark is one character', /<sup[^>]*>P<\/sup>/.test(html), null);
  check('and it is on the right name',
    /2_Aman Chandra[\s\S]{0,220}?<sup[^>]*>P<\/sup>/.test(html), null);
  check('it says what it means, once, under the card',
    html.indexOf('marked on the portal, not the reader') > -1, null);
  check('and says it once rather than once a person',
    html.split('marked on the portal').length - 1 === 1, null);
  /* It cannot push a name onto a second line: it lives inside the same
     nowrap line as the name and the time. */
  check('the name, the time and the mark are one unbroken line',
    /white-space:nowrap;">2_Aman Chandra[\s\S]{0,220}?<\/sup><\/div>/.test(html), null);
}
{
  const html = build(DAY);
  check('a day nobody used the portal says nothing about the portal',
    html.indexOf('marked on the portal') === -1 && !/<sup[^>]*>P<\/sup>/.test(html), null);
}

/* ---- and the rule the server sorts them by ------------------------------ */
{
  /* Only a shift that crosses midnight, only where the day would otherwise
     read as an absence, and only where there is an hour to show. Each of those
     is the difference between a card that helps and one that lies. */
  check('a night worker is one whose shift crosses midnight',
    /return r\.kind === 'missing' && !!span && span\.overnight;/.test(SRV), null);
  check('nothing last night either is a real absence, and stays one',
    /if \(!inAt\) return;/.test(SRV), null);
  check('the row carries the name the record keeps, to look yesterday up by',
    /return \{ name, emp: e\.name, via,/.test(SRV), null);
  /* An out time on the far side of midnight reads as earlier than the in
     time, so a plain subtraction came out fifteen hours short. */
  check('a night that crosses midnight is measured across it',
    /b <= a \? \(b \+ 24 \* 60 - a\) : \(b - a\)/.test(SRV), null);
  check('and the portal mark is only set where that is the time being shown',
    /const via = \(rec\.manual === true && typed && typed\.by === 'self'\) \? 'portal' : '';/
      .test(SRV), null);
}

console.log(fail ? ('FAILED (' + fail + ' of ' + (pass + fail) + ')')
                 : ('ALL PASS (' + pass + ' checks)'));
process.exit(fail ? 1 : 0);
