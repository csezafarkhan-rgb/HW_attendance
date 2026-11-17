// Six cards across one row of an email is a hundred pixels each, and the
// lines inside them are nowrap - so they do not wrap, they overflow, and
// "1_Shyam Lal ESS (9:12 AM)" ran straight over the card beside it. No width
// estimator can fit that line into a hundred pixels; the row was the problem,
// not the sharing out of it.
'use strict';
const path = require('path');
const REPO = path.join(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

const hhmm = t => { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1]); };
const SHIFT = '9:30-6:30';
const row = (name, kind, inT, extra) => Object.assign({
  name, 'in': inT || '', out: '', state: kind, kind,
  label: kind, inMin: inT ? hhmm(inT) : null, shift: SHIFT
}, extra || {});

const build = rows => mailer.dailyEmail({
  orgName: 'AllyConnect Pvt. Ltd.', dateLabel: 'Tue, 17 Nov', rows,
  hidden: 0, attached: false, siteUrl: 'https://x',
  sections: { tally: true, table: false, shot: false, late: false,
              shifts: false, wfh: false, visits: false }
}).html;

/* The day from the message that prompted this: six kinds at once, with the
   longest line on the one card whose name is longest. */
const SIX = [
  row('Habib', 'present', '8:53'),
  row('Zafar Khan', 'present', '9:24'),
  row('Keshav Garg', 'present', '9:25'),
  row('Himanshu', 'present', '10:20', { late: 20, via: 'portal' }),
  row('karan Ahuja', 'missing'),
  row('Munish Dhamija', 'missing'),
  row('Aman Gupta', 'night', '18:56', { out: '10:21', worked: '8:00', shift: '19:00-4:00' }),
  row('Shyam Lal ESS', 'visit', '9:12', { via: 'portal' }),
  row('Aman Chandra', 'leave'),
  row('Rahul Mishra', 'wfh', '9:30')
];

const html = build(SIX);
const rowTables = html.match(/table-layout:fixed/g) || [];

/* ---- the cards are laid out over more than one row ---- */
check('six kinds are not crushed into a single row',
  rowTables.length > 1, rowTables.length);
/* Balanced rather than three-then-the-rest: a lone card on its own row reads
   as a card that belongs to something else. */
/* Counted by the card cell, which is the one that carries valign - a card
   holds a slot-rule table of its own, and its two cells are not cards. */
{
  const cellsPerRow = html.split('table-layout:fixed').slice(1)
    .map(chunk => (chunk.match(/<td width="\d+%" valign="top"/g) || []).length);
  check('and the rows are evened out, with no card left alone',
    cellsPerRow.length > 1 && Math.max.apply(null, cellsPerRow)
      - Math.min.apply(null, cellsPerRow) <= 1, cellsPerRow);
  check('with no row holding more than four',
    Math.max.apply(null, cellsPerRow) <= 4, cellsPerRow);
  check('and every card accounted for, none dropped in the splitting',
    cellsPerRow.reduce((a, b) => a + b, 0) === 6, cellsPerRow);
}
/* Each row shares out its own hundred per cent, or a short row would leave a
   gap down the side of the message. */
{
  const widths = (html.match(/<td width="(\d+)%" valign="top"/g) || [])
    .map(s => +(/(\d+)/.exec(s)[1]));
  check('every card still asks for a real share of its own row',
    widths.length === 6 && widths.every(w => w >= 20), widths);
}

/* ---- and a line that is still too long wraps instead of overflowing ---- */
check('an ordinary line may break between the name and the time',
  !/<div style="white-space:nowrap;">\d+_/.test(html), null);
check('but the name itself is never broken, so one person stays one person',
  /<span style="white-space:nowrap;">1_/.test(html), null);
check('and the time beside it is kept whole too',
  (html.match(/white-space:nowrap/g) || []).length >= 2, null);

/* ---- what was already right stays right ---- */
check('the late arrival still carries its hour and its measure',
  /20 min late/.test(html) && /10:20 AM/.test(html), null);
check('the portal mark is still explained once per card that has one',
  /marked on the portal/.test(html), null);
check('and the night span is still one unbroken reading',
  /6:56 PM/.test(html) && /10:21 AM/.test(html), null);

/* Two or three kinds were never the problem and must not grow a second row. */
{
  const small = build([row('Habib', 'present', '8:53'), row('karan Ahuja', 'missing')]);
  check('two kinds stay on one row, as they always did',
    (small.match(/table-layout:fixed/g) || []).length === 1, null);
}

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
