// Which day a press of the clock belongs to.
//
// Not the calendar day, for anybody on a night shift: at two in the morning
// the shift somebody is standing in started yesterday. The day turns over in
// the middle of the gap between shifts - for 18:00-3:00 that is half past ten
// in the morning, so a press at 10:06 is the night before's and a press at
// 10:31 is tonight's.
//
// Which is right, and was being asked of the wrong shift. The standing shift
// was the only one consulted, so somebody whose hours had moved - who had said
// so on their own card, in the box the record reads everywhere else - had a
// morning filed to the day before, pressed again, and opened two days: neither
// finished, and a week reading hours extra for an arrival nobody made.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

const IST_MS = 5.5 * 3600 * 1000;
/* A clock that stands still, so a test about what time it is can be read a
   year from now and still mean the same thing. */
function at(istDay, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.parse(istDay + 'T00:00:00Z') + h * 3600000 + m * 60000 - IST_MS;
}
function dayFor(istDay, hhmm, assignments, dayShifts) {
  const now = at(istDay, hhmm);
  const Fake = function (...a) { return a.length ? new Date(...a) : new Date(now); };
  Fake.now = () => now;
  Fake.parse = Date.parse; Fake.UTC = Date.UTC;
  Fake.prototype = Date.prototype;
  const ctx = { IST_MS, Date: Fake, Math, String, Number, isFinite, console };
  vm.createContext(ctx);
  ['parseShiftSpan', 'nightTurnsAt', 'ownDays', 'shiftFor', 'clockDay']
    .forEach(n => vm.runInContext(grab(SRV, n), ctx));
  return ctx.clockDay(assignments || {}, dayShifts || {}, 'Himanshu');
}

/* Himanshu's own arrangement, as the record holds it: a day shift until
   October, a night shift from the first of it. */
const NIGHT = { Himanshu: [{ from: '0000-01-01', shift: '8:30-5:30' },
                           { from: '2026-10-01', shift: '18:00-3:00' }] };
const DAYS = { Himanshu: [{ from: '0000-01-01', shift: '9:30-6:30' }] };

/* ---- the night shift itself, which is right and stays right ---- */
check('the small hours belong to the night before',
  dayFor('2026-11-03', '02:00', NIGHT) === '2026-11-02',
  dayFor('2026-11-03', '02:00', NIGHT));
check('and so does an hour after the shift was due to end',
  dayFor('2026-11-03', '04:00', NIGHT) === '2026-11-02');
check('arriving ten minutes early is tonight, not last night',
  dayFor('2026-11-03', '17:50', NIGHT) === '2026-11-03');
check('and the evening itself is plainly tonight',
  dayFor('2026-11-03', '19:30', NIGHT) === '2026-11-03');
/* Half past ten is where the gap between one shift and the next is halved. */
check('the day turns at half past ten, where the gap is halved',
  dayFor('2026-11-03', '10:29', NIGHT) === '2026-11-02'
  && dayFor('2026-11-03', '10:30', NIGHT) === '2026-11-03',
  [dayFor('2026-11-03', '10:29', NIGHT), dayFor('2026-11-03', '10:30', NIGHT)]);

/* ---- what actually happened ----
   Two presses twenty-five minutes apart, one either side of that line, and
   the standing shift the only thing either of them asked. */
check('a press at 10:06 against the night shift went to the day before',
  dayFor('2026-11-03', '10:06', NIGHT) === '2026-11-02');
check('and the one at 10:31 opened today as well',
  dayFor('2026-11-03', '10:31', NIGHT) === '2026-11-03');

/* ---- and what fixes it ----
   The hours he had set for the day, in the box the rest of the record already
   reads. Somebody who has set them has said which day they mean. */
const SET = { 'Himanshu|2026-11-03': '10:00-7:00' };
check('with today’s own hours set, the morning is today’s',
  dayFor('2026-11-03', '10:06', NIGHT, SET) === '2026-11-03',
  dayFor('2026-11-03', '10:06', NIGHT, SET));
check('and so is the second press, so there is one day and not two',
  dayFor('2026-11-03', '10:31', NIGHT, SET) === '2026-11-03');
check('every hour of a day worth of hours lands on that day',
  ['10:00', '13:00', '16:00', '18:45'].every(t => dayFor('2026-11-03', t, NIGHT, SET) === '2026-11-03'),
  ['10:00', '13:00', '16:00', '18:45'].map(t => dayFor('2026-11-03', t, NIGHT, SET)));

/* A one-off that is itself a night shift still turns over like one. */
const NIGHT_SET = { 'Himanshu|2026-11-03': '22:00-6:00' };
check('a one-off night shift turns over like any other night shift',
  dayFor('2026-11-03', '03:00', DAYS, NIGHT_SET) === '2026-11-02'
  && dayFor('2026-11-03', '23:00', DAYS, NIGHT_SET) === '2026-11-03',
  [dayFor('2026-11-03', '03:00', DAYS, NIGHT_SET), dayFor('2026-11-03', '23:00', DAYS, NIGHT_SET)]);

/* Hours set against yesterday are yesterday's business. The question asked
   here is what is being worked today; reading a day that has gone would let
   a stale one-off drag this morning backwards. */
check('hours set for yesterday do not move today',
  dayFor('2026-11-03', '10:06', NIGHT, { 'Himanshu|2026-11-02': '10:00-7:00' }) === '2026-11-02');
/* And somebody else's hours are somebody else's. */
check('and nor do somebody else’s',
  dayFor('2026-11-03', '10:06', NIGHT, { 'Aman Gupta|2026-11-03': '10:00-7:00' }) === '2026-11-02');

/* ---- a plain day shift, which never had the problem ---- */
check('a day shift is the calendar day, morning or evening',
  dayFor('2026-11-03', '09:20', DAYS) === '2026-11-03'
  && dayFor('2026-11-03', '20:00', DAYS) === '2026-11-03');
check('and midnight on a day shift is the new day, as the calendar says',
  dayFor('2026-11-03', '00:10', DAYS) === '2026-11-03');

/* ---- that both routes ask the same question ----
   The clock and the part-day both write a day against somebody's name, and
   two answers to "which day is it" is one answer too many. */
check('the clock asks it',
  (SRV.match(/clockDay\(parseJson\(kvShift\.shiftAssignments\) \|\| \{\}/g) || []).length === 2, null);
check('and nothing works the day out for itself any more',
  !/ownDays\(shiftFor\(parseJson\(/.test(SRV), null);
/* The browser never names the day: a page is the person's to edit. */
check('the day is still never taken from the browser',
  !/body\.day/.test(grab(SRV, 'takePartDay')), null);

const bad = results.filter(x => !x).length;
console.log(bad ? ('FAILED ' + bad + ' of ' + results.length)
                : ('ALL PASS (' + results.length + ' checks)'));
process.exit(bad ? 1 : 0);
