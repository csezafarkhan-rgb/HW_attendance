/* "3 days before a holiday" has to mean three days somebody is in.
 *
 * The window was counted in calendar days, so three days before a Monday
 * holiday landed on the Friday: one working day of notice, and whoever reads
 * their mail on Monday morning read it after the building was already shut.
 *
 * Counted Monday to Friday instead, a Monday holiday with three days set is
 * spoken for on the Wednesday - Wed, Thu, Fri being the three working days
 * before it. The weekend is stepped over rather than spent.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; k++;
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
      continue;
    }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

const workingDaysAhead = new Function(
  grab(SRV, 'workingDaysAhead') + '; return workingDaysAhead;')();

/* The holiday reminder fires on the first day whose window reaches the
   holiday, which is the same thing as counting the days back from it. */
function fires(holiday, days, from) {
  return workingDaysAhead(from, days) >= holiday;
}

/* November 2026: the 16th is a Monday. */
const MON = '2026-11-16';
check('a Monday holiday is not spoken for four working days out (Tue 10)',
  !fires(MON, 3, '2026-11-10'), workingDaysAhead('2026-11-10', 3));
check('it is spoken for three working days out (Wed 11)',
  fires(MON, 3, '2026-11-11'), workingDaysAhead('2026-11-11', 3));
check('calendar counting would have waited until the Friday',
  new Date('2026-11-13T00:00:00Z').getUTCDay() === 5
    && '2026-11-16' === new Date(Date.parse('2026-11-13T00:00:00Z') + 3 * 86400000)
        .toISOString().slice(0, 10), null);

/* A missed day is still caught the next time the service wakes, which is why
   the window is a window rather than one date. */
check('and still on the Thursday, Friday and over the weekend',
  fires(MON, 3, '2026-11-12') && fires(MON, 3, '2026-11-13')
  && fires(MON, 3, '2026-11-14') && fires(MON, 3, '2026-11-15'), null);

check('the weekend is stepped over, not counted: one day on from Friday is Monday',
  workingDaysAhead('2026-11-06', 1) === '2026-11-09', workingDaysAhead('2026-11-06', 1));
check('two days on from a Saturday is the Tuesday',
  workingDaysAhead('2026-11-07', 2) === '2026-11-10', workingDaysAhead('2026-11-07', 2));
check('none asked for leaves the window on today',
  workingDaysAhead('2026-11-05', 0) === '2026-11-05', workingDaysAhead('2026-11-05', 0));
check('a week of working days is a fortnight of calendar ones',
  workingDaysAhead('2026-11-05', 10) === '2026-11-19', workingDaysAhead('2026-11-05', 10));
check('nonsense in the box does not spin the loop',
  workingDaysAhead('2026-11-05', -5) === '2026-11-05'
  && workingDaysAhead('2026-11-05', null) === '2026-11-05'
  && workingDaysAhead('2026-11-05', 'x') === '2026-11-05', null);

/* ---- and the scheduled run actually uses it ---- */
check('the daily tick measures the holiday window in working days',
  SRV.indexOf('const until = workingDaysAhead(day, s.holiday.days);') > 0, null);
check('nothing is still adding calendar days for it',
  SRV.indexOf('s.holiday.days * 86400000') < 0, null);

/* ---- and the box says what it counts ---- */
check('the settings box says working days, not days',
  /working days before \(Mon.{1,8}Fri\), at/.test(APP), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
