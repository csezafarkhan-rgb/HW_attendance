// The employee calendar says what a day was by painting it. Two different
// facts painted the same colour is the one way that can fail, and it did: a
// day somebody took an hour out of was #EDE4F5 and a day the building was shut
// was #EAE2F8 - three points apart, and opposite facts about the same square.
'use strict';
const fs = require('fs'), path = require('path');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* The colour a rule paints, read out of the stylesheet rather than retyped
   here - a test that carries its own copy of the answer proves nothing. */
function bg(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '\\s*\\{[^}]*background:\\s*(#[0-9A-Fa-f]{6})');
  const m = re.exec(APP);
  return m ? m[1].toUpperCase() : null;
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
/* Hue, because that is what the eye sorts colours by first. Two pale tints an
   equal distance apart in channels can read as the same colour or as plainly
   different ones depending on where the hue lands. */
function hue(hex) {
  const [r, g, b] = rgb(hex).map(v => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const apart = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };

const HOLIDAY = bg('.emp-cal-cell.st-HOL');
const PART = {
  SHORT: bg('.emp-cal-cell.is-part-SHORT'),
  HALF: bg('.emp-cal-cell.is-part-HALF'),
  THREEQ: bg('.emp-cal-cell.is-part-THREEQ')
};

check('the calendar paints a holiday', !!HOLIDAY, HOLIDAY);
check('and paints each size of part-day', Object.values(PART).every(Boolean), PART);

/* The fault itself: a part-day must not read as a holiday. */
Object.keys(PART).forEach(k => {
  check('a ' + k + ' day is a different colour from a holiday, not a shade of it',
    apart(PART[k], HOLIDAY) > 25,
    { part: PART[k], holiday: HOLIDAY, degreesApart: Math.round(apart(PART[k], HOLIDAY)) });
});
check('and the one that was three points off a holiday is gone',
  PART.SHORT !== '#EDE4F5', PART.SHORT);

/* What the tint is for: the more of the day was taken, the deeper it goes.
   Losing that is how three sizes become one colour with three names. */
const light = hex => { const [r, g, b] = rgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b; };
check('a half day is deeper than a short leave',
  light(PART.HALF) < light(PART.SHORT), { half: PART.HALF, short: PART.SHORT });
check('and three quarters of a day deeper again',
  light(PART.THREEQ) < light(PART.HALF), { threeq: PART.THREEQ, half: PART.HALF });
check('the three are one family, not three unrelated colours',
  apart(PART.SHORT, PART.HALF) < 20 && apart(PART.HALF, PART.THREEQ) < 20,
  { s: Math.round(hue(PART.SHORT)), h: Math.round(hue(PART.HALF)), t: Math.round(hue(PART.THREEQ)) });

/* And not a colour this calendar already spends on something else. Amber runs
   down the edge of a late day, so a part-day painted amber would say "late"
   before it said anything else. */
{
  const lateBar = /\.emp-cal-cell\.is-late\{[^}]*#([0-9A-Fa-f]{6})/.exec(APP);
  check('a late day still carries its own mark down the edge', !!lateBar, lateBar && lateBar[0]);
  if (lateBar) {
    check('and a part-day is not painted that same colour',
      apart(PART.SHORT, '#' + lateBar[1].toUpperCase()) > 25,
      { part: PART.SHORT, late: '#' + lateBar[1] });
  }
  const sunday = bg('.emp-cal-cell.is-sunday');
  check('nor the colour the weekend is', !!sunday && apart(PART.SHORT, sunday) > 25,
    { part: PART.SHORT, sunday });
}

/* The pill keeps saying which part-day it was, and is read on top of the
   colour rather than instead of it - so it still has to show on the deepest
   of the three. */
{
  const pill = /\.ec-m\.hd\s*\{\s*background:\s*(#[0-9A-Fa-f]{6})/.exec(APP);
  check('the SD/HD/TD pill has a colour of its own', !!pill, pill && pill[0]);
  if (pill) {
    check('and stands out against the deepest part-day behind it',
      Math.abs(light(pill[1].toUpperCase()) - light(PART.THREEQ)) > 60,
      { pill: pill[1], deepest: PART.THREEQ });
  }
}

/* The words on the cell have to be readable on it. */
{
  const ink = /\.emp-cal-cell\.is-part \.d\{ color:(#[0-9A-Fa-f]{6}); \}/.exec(APP);
  check('the day number has ink chosen for the new colour', !!ink, ink && ink[0]);
  if (ink) {
    check('and it is dark enough to read on the lightest of them',
      light(ink[1].toUpperCase()) < 100 && light(PART.SHORT) > 180,
      { ink: ink[1], lightest: PART.SHORT });
  }
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
