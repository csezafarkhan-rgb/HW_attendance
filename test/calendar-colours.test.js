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
   here - a test that carries its own copy of the answer proves nothing. A
   rule may name a colour outright or point at one by name, so a pointer is
   followed to what it points at. */
function named(v) {
  const m = new RegExp('--' + v + ':\\s*(#[0-9A-Fa-f]{6})').exec(APP);
  return m ? m[1].toUpperCase() : null;
}
function bg(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '\\s*\\{[^}]*background:\\s*(#[0-9A-Fa-f]{6}|var\\(--[a-z-]+\\))');
  const m = re.exec(APP);
  if (!m) return null;
  return m[1][0] === '#' ? m[1].toUpperCase() : named(m[1].slice(6, -1));
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
  const ink = named('part-ink');
  check('the day number has ink chosen for the new colour', !!ink, ink);
  if (ink) {
    check('and it is dark enough to read on the lightest of them',
      light(ink) < 100 && light(PART.SHORT) > 180,
      { ink, lightest: PART.SHORT });
    check('it is read by name wherever a part-day is written',
      /\.emp-cal-cell\.is-part \.d\{ color:var\(--part-ink\); \}/.test(APP));
  }
}

/* ---- the same fact, however it was recorded ----
   The calendar reaches a half day by two roads: a day whose own status is
   half, and an ordinary present day with half of it marked against it. They
   were painted apart, and the status one wore the yellow a late arrival
   wears - so on one calendar a half day was yellow in August and blue in
   October, and the yellow one read as lateness. */
{
  const statusHalf = bg('.emp-cal-cell.st-HD');
  check('a day whose own status is half is painted', !!statusHalf, statusHalf);
  check('and it is the same colour as half a day marked on a present one',
    statusHalf === PART.HALF, { status: statusHalf, marked: PART.HALF });
  check('which is no longer the colour a late arrival wears',
    statusHalf !== named('late'), { status: statusHalf, late: named('late') });
  /* Written once, so the two cannot drift apart again. */
  check('both read the one name rather than each carrying a copy',
    /\.emp-cal-cell\.st-HD\{background:var\(--part-half\)/.test(APP)
    && /\.emp-cal-cell\.is-part-HALF\{ background:var\(--part-half\)/.test(APP));
  check('and the other two sizes are named the same way',
    /\.emp-cal-cell\.is-part-SHORT\{ background:var\(--part-short\)/.test(APP)
    && /\.emp-cal-cell\.is-part-THREEQ\{ background:var\(--part-threeq\)/.test(APP));
  check('a status half day has ink chosen for what is behind it',
    /\.emp-cal-cell\.st-HD\{background:var\(--part-half\);color:var\(--part-ink\);\}/.test(APP));
}

/* ---- what a day says, and what it keeps back ----
   Four lines of figures on thirty squares is a wall of numbers to read past,
   so the times are off unless asked for. What they must not take with them is
   the line they share with things said in its place. */
{
  check('there is a gear on the calendar, with a panel behind it',
    APP.indexOf('id="empCalOptsBtn"') > -1 && APP.indexOf('id="empCalOptsDropdown"') > -1);
  check('and one setting on it, about the times',
    APP.indexOf('id="empOptTimes"') > -1
    && APP.indexOf('In, out and hours on every day') > -1);
  const decl = APP.slice(APP.indexOf('var EMP_CAL_TIMES'), APP.indexOf('var EMP_CAL_TIMES') + 240);
  check('off unless it has been turned on',
    decl.indexOf("localStorage.getItem('hw_emp_cal_times') === '1'") > -1
    && decl.indexOf('return false;') > -1, decl.slice(0, 160));
  check('it is remembered between visits, the way the density is',
    APP.indexOf("localStorage.setItem('hw_emp_cal_times'") > -1);
  check('and the month is redrawn the moment it is changed',
    /EMP_CAL_TIMES = chk\.checked;[\s\S]{0,200}renderEmployeeCalendar\(\);/.test(APP));
  /* The panel is a panel like the others, so it closes like the others - and
     carries the rule that a click on a choice is not a dismissal. */
  check('the panel closes the way every other one does',
    /if\(dd\.contains\(e\.target\) \|\| e\.target === btn\) return;/.test(
      APP.slice(APP.indexOf("getElementById('empCalOptsBtn')"),
                APP.indexOf("getElementById('empCalOptsBtn')") + 3200)));

  /* The gate itself: both ways of writing the times go, and nothing else. */
  check('turning it off takes away the stacked figures and the packed line',
    APP.indexOf("if(!EMP_CAL_TIMES){ detail = ''; if(timeIsClock) timeStr = ''; }") > -1);
  check('and only takes the packed line when it was a clock time',
    APP.indexOf('var timeIsClock = false;') > -1
    && (APP.match(/timeIsClock = true;/g) || []).length === 2,
    (APP.match(/timeIsClock = true;/g) || []).length);
  /* These three live in that line and nowhere else - hiding it for every day
     would take them off the calendar, which is the fault this guards. */
  const lines = APP.split(/\r?\n/);
  const keeps = [
    ['a holiday keeps its name', "timeStr = holiday.name"],
    ['a day worked from home keeps what was logged', "timeStr = ov.duration + ' logged'"],
    ['and a credited day keeps its hours', "timeStr = fmtMin(owedOv) + ' credited'"]
  ];
  keeps.forEach(([what, written]) => {
    const line = lines.filter(l => l.indexOf(written) > -1);
    check(what, line.length === 1 && line[0].indexOf('timeIsClock') === -1, line);
  });
  /* And the flag is raised only where a clock time is written, so nothing
     else is put away with them. */
  const clockLines = lines.filter(l => l.indexOf('timeIsClock = true') > -1);
  check('only the two lines that write a clock time raise the flag',
    clockLines.length === 2 && clockLines.every(l => l.indexOf('fmtTime(') > -1), clockLines);
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
