// The Present card listed everybody in arrival order and nothing else, so a
// run of 8:28, 8:53, 9:27, 9:32, 10:01 read as five degrees of lateness - when
// in fact three different shifts were in it and all five were on time. The
// card is grouped by the slot people are on, with a hairline carrying the slot.
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
const present = (name, inT, shift) => ({
  name, 'in': inT, out: '', state: 'present', kind: 'present',
  label: 'In, not out yet', inMin: hhmm(inT), shift
});
const missing = (name, shift) => ({
  name, 'in': '', out: '', state: 'missing', kind: 'missing',
  label: 'Not Reached Office', inMin: null, shift
});
const onLeave = (name, shift) => ({
  name, 'in': 'Leave', out: 'Leave', state: 'leave', kind: 'leave',
  label: 'Leave', inMin: null, shift
});

const build = rows => mailer.dailyEmail({
  orgName: 'Test Co', dateLabel: 'Wed, 28 Oct', rows,
  hidden: 0, attached: false, siteUrl: 'https://x',
  sections: { tally: true, table: false, shot: false, late: false,
              shifts: false, wfh: false, visits: false }
}).html;

/* The seven from the card that prompted this. */
const SEVEN = [
  present('karan Ahuja', '8:28', '8:30-5:30'),
  present('Habib', '8:53', '9:30-6:30'),
  present('Aman Chandra', '9:27', '9:30-6:30'),
  present('Keshav Garg', '9:32', '9:30-6:30'),
  present('Zafar Khan', '9:32', '9:30-6:30'),
  present('Rahul Mishra', '9:39', '9:30-6:30'),
  present('Shyam Lal ESS', '10:01', '10:00-7:00')
];

/* ---- the slots are named, in the order the day runs ---- */
{
  const html = build(SEVEN);
  ['8:30-5:30', '9:30-6:30', '10:00-7:00'].forEach(s => {
    check('the card names the ' + s + ' slot', html.indexOf('>' + s + '<') > -1, s);
  });
  check('earliest start first',
    html.indexOf('>8:30-5:30<') < html.indexOf('>9:30-6:30<')
      && html.indexOf('>9:30-6:30<') < html.indexOf('>10:00-7:00<'));
  /* A slot starting at ten at night sorts after one starting at ten in the
     morning, not before it on the strength of the first character. */
  const night = build(SEVEN.concat([present('Himanshu', '18:04', '18:00-3:00')]));
  check('a night slot sorts by when it starts, not by its spelling',
    night.indexOf('>10:00-7:00<') < night.indexOf('>18:00-3:00<'));
}

/* ---- each person under their own slot ---- */
{
  const html = build(SEVEN);
  const at = s => html.indexOf(s);
  check('the 8:30 person is under the 8:30 heading and above the 9:30 one',
    at('>8:30-5:30<') < at('karan Ahuja') && at('karan Ahuja') < at('>9:30-6:30<'));
  check('the five on 9:30 sit between their heading and the next',
    at('>9:30-6:30<') < at('Habib') && at('Rahul Mishra') < at('>10:00-7:00<'));
  check('and the 10:00 person is last', at('>10:00-7:00<') < at('Shyam Lal ESS'));
  check('arrival order is kept inside a slot',
    at('Habib') < at('Aman Chandra') && at('Aman Chandra') < at('Keshav Garg'));
}

/* ---- the numbering still adds up to the figure on the card ---- */
{
  const html = build(SEVEN);
  check('the count is seven', /;">7<\/div>/.test(html), html.match(/;">\d+<\/div>/g));
  check('the numbers run 1 to 7 straight through the groups',
    html.indexOf('1_karan Ahuja') > -1 && html.indexOf('2_Habib') > -1
      && html.indexOf('6_Rahul Mishra') > -1 && html.indexOf('7_Shyam Lal ESS') > -1);
}

/* ---- the hairline is a line, not just markup ----
   Left to itself the label cell took the whole row and the rule came out
   nought pixels wide: present in the HTML, invisible on the screen. */
{
  const html = build(SEVEN);
  check('the label cell shrinks to its own text', html.indexOf('<td width="1%"') > -1);
  check('and the rule takes the rest of the row',
    /<td width="99%" style="border-top:1px solid/.test(html));
}

/* ---- a card with one slot in it gets no headings ---- */
{
  const html = build([
    present('Habib', '8:53', '9:30-6:30'),
    present('Zafar Khan', '9:32', '9:30-6:30')
  ]);
  check('nothing to separate, so nothing is drawn', html.indexOf('>9:30-6:30<') === -1);
  check('but the people are still there',
    html.indexOf('1_Habib') > -1 && html.indexOf('2_Zafar Khan') > -1);
}

/* ---- and only the cards about arriving are grouped ---- */
{
  const html = build([
    missing('Nitish Kumar', '10:00-7:00'),
    missing('Himanshu', '18:00-3:00'),
    onLeave('Munish Dhamija', '10:00-7:00'),
    onLeave('karan Singh ESS', '8:30-5:30')
  ]);
  check('who has not arrived is grouped - the slot says whether they are late',
    html.indexOf('>10:00-7:00<') > -1 && html.indexOf('>18:00-3:00<') > -1);
  /* A day off is a day off whatever slot it was owed on. */
  check('a day off is not grouped by the slot it was owed on',
    html.indexOf('>8:30-5:30<') === -1, html.indexOf('>8:30-5:30<'));
  check('and both people on leave are still listed',
    html.indexOf('_Munish Dhamija') > -1 && html.indexOf('_karan Singh ESS') > -1);
}

/* ---- a row with no slot on it is still shown ---- */
{
  const html = build([
    present('Habib', '8:53', '9:30-6:30'),
    present('Nobody Knows', '9:01', '')
  ]);
  check('somebody with no shift set says so rather than vanishing',
    html.indexOf('no shift set') > -1 && html.indexOf('Nobody Knows') > -1);
  check('and they come last, after the slots that are known',
    html.indexOf('>9:30-6:30<') < html.indexOf('no shift set'));
}

/* ---- a slot is escaped like anything else off the record ---- */
{
  const html = build([
    present('A', '9:00', '<img src=x onerror=1>'),
    present('B', '9:05', '9:30-6:30')
  ]);
  check('a slot cannot carry markup into the message',
    html.indexOf('<img src=x') === -1 && html.indexOf('&lt;img') > -1);
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
