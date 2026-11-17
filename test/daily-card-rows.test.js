// Six cards across a 720px message is 120 pixels each, and the longest line
// on the day is twice that - so the lines lay across the cards beside them.
// Breaking the cards onto two rows cured the overlap and read worse: the day
// is one thing, and the office takes it in at a glance or not at all. So the
// row asks for the width it needs and the message is built to it.
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
const row = (name, kind, inT, extra) => Object.assign({
  name, 'in': inT || '', out: '', state: kind, kind,
  label: kind, inMin: inT ? hhmm(inT) : null, shift: '9:30-6:30'
}, extra || {});

const build = rows => mailer.dailyEmail({
  orgName: 'AllyConnect Pvt. Ltd.', dateLabel: 'Tue, 17 Nov', rows,
  hidden: 0, attached: false, siteUrl: 'https://x',
  sections: { tally: true, table: false, shot: false, late: false,
              shifts: false, wfh: false, visits: false }
}).html;

const widthOf = html => +(/width="(\d+)" cellpadding/.exec(html) || [])[1];
const cardsIn = html => (html.match(/<td width="\d+%" valign="top"/g) || []).length;
const rowsIn = html => (html.match(/table-layout:fixed/g) || []).length;

/* The day from the message that prompted this: six kinds at once, the longest
   line on the night card and the second longest on Present. */
const SIX = [
  row('Habib', 'present', '8:53'),
  row('Zafar Khan', 'present', '9:24'),
  row('Keshav Garg', 'present', '9:25'),
  row('Himanshu', 'present', '10:20', { late: 20, via: 'portal' }),
  row('karan Ahuja', 'missing'),
  row('Munish Dhamija', 'missing'),
  row('Aman Gupta', 'night', '18:56', { out: '5:17', worked: '10:21', shift: '19:00-4:00' }),
  row('Shyam Lal ESS', 'visit', '9:12', { via: 'portal' }),
  row('Aman Chandra', 'leave'),
  row('Rahul Mishra', 'wfh', '9:30')
];
const html = build(SIX);

/* ---- one row, however many cards ---- */
check('six kinds stay on a single row',
  rowsIn(html) === 1, rowsIn(html));
check('with every card on it',
  cardsIn(html) === 6, cardsIn(html));
check('and none of them squeezed to a sliver',
  (html.match(/<td width="(\d+)%" valign="top"/g) || [])
    .map(s => +(/(\d+)/.exec(s)[1])).every(w => w >= 10), null);

/* ---- the message is built to what the row needs ---- */
check('a day with six cards asks for more than the ordinary width',
  widthOf(html) > 720, widthOf(html));
check('and not more than a mail client will honour',
  widthOf(html) <= 1040, widthOf(html));
check('the width is declared on the attribute and the style alike, as clients read either',
  new RegExp('width="' + widthOf(html) + '"').test(html)
  && new RegExp('width:' + widthOf(html) + 'px').test(html), null);
/* A phone cannot have 940 pixels, so the message folds rather than running
   off the side of the screen. */
check('and it still gives way on a narrow screen',
  /max-width:100%/.test(html), null);

/* ---- a quiet day is left exactly as it was ---- */
{
  const small = build([row('Habib', 'present', '8:53'), row('karan Ahuja', 'missing')]);
  check('two kinds keep the ordinary width',
    widthOf(small) === 720, widthOf(small));
  check('on one row, as they always did',
    rowsIn(small) === 1 && cardsIn(small) === 2, [rowsIn(small), cardsIn(small)]);
}
/* Every other message is untouched: they carry no cards and no claim on the
   width, so they are built at the ordinary one. */
{
  const other = mailer.remindEmail({
    orgName: 'A', name: 'Rahul Mishra', day: '2026-11-17', footer: 'x',
    items: [{ job: 'late', day: '2026-11-17', mins: 18, came: '09:48' }]
  }).html;
  check('a message with no cards is still the ordinary width',
    widthOf(other) === 720, widthOf(other));
}

/* ---- and a line that is still long wraps rather than overflowing ---- */
/* An ordinary line is two held-together spans that may part if they must.
   The night line is two deliberate lines and is checked above; this names an
   ordinary person so the two cannot be confused. */
check('an ordinary line may break between the name and the time',
  /<span style="white-space:nowrap;">\d+_Habib<\/span>/.test(html)
  && !/<div style="white-space:nowrap;">\d+_Habib/.test(html), null);
check('but the name itself is never broken, so one person stays one person',
  /<span style="white-space:nowrap;">1_/.test(html), null);

/* ---- what was already right stays right ---- */
check('the late arrival still carries its hour and its measure',
  /20 min late/.test(html) && /10:20 AM/.test(html), null);
check('the portal mark is still explained on the cards that have one',
  /marked on the portal/.test(html), null);
/* The night line is the longest on the message. Put deliberately on two
   lines - the name, then the span - it reads the same at every card width
   instead of breaking wherever the card happens to end, and the card asks
   only for the longer of the two rather than for both side by side. */
check('the night span sits on its own line under the name',
  /<div style="white-space:nowrap;">\d+_Aman Gupta<\/div><div style="white-space:nowrap;[^"]*">\(6:56 PM/
    .test(html), (/1_Aman Gupta[\s\S]{0,140}/.exec(html) || [])[0]);
check('and it is still one unbroken reading',
  /\(6:56 PM → 5:17 AM\) · 10:21/.test(html), null);
{
  /* Asking for the sum of two lines that never share a row made the whole
     message wider than it had to be. */
  const widest = Math.max.apply(null, [html].map(widthOf));
  check('so the message is no wider than the parts that actually share a row',
    widest < 941, widest);
}

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
