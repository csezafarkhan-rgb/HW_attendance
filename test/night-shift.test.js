// A shift is written the way it is spoken - "9:30-6:30" is morning to evening -
// so the end hour was pushed into the afternoon whenever it was under twelve.
// Right for every day shift, wrong for every night one: "22:00-6:00" became ten
// at night to six in the evening, a day of minus four hours. The 3-to-12-hour
// check then refused it, which is why a night shift could not be typed in at
// all, and why anyone who tried got a red box and no explanation.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

function grab(name) {
  const i = APP.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = APP.indexOf('{', i), depth = 0;
  for (; k < APP.length; k++) {
    const c = APP[k];
    if (c === '/' && APP[k + 1] === '/') { k = APP.indexOf('\n', k); continue; }
    if (c === '/' && APP[k + 1] === '*') { k = APP.indexOf('*/', k) + 1; continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return APP.slice(i, k + 1);
}

const ctx = { isFinite, isNaN, Number, String, Math };
vm.createContext(ctx);
vm.runInContext('function toMin(t){ var p = String(t).split(":"); return (+p[0]) * 60 + (+p[1]); }', ctx);
[grab('parseShift'), grab('shiftMin'), grab('validShift')].forEach(fn => vm.runInContext(fn, ctx));
const parse = s => { vm.runInContext('__r = parseShift(' + JSON.stringify(s) + ')', ctx); return ctx.__r; };
const span = s => { const t = parse(s); return t.endMin - t.startMin; };
const ok = s => { vm.runInContext('__v = validShift(' + JSON.stringify(s) + ')', ctx); return ctx.__v; };

/* ---- every shift already in use reads exactly as it did ---- */
{
  [['8:30-5:30', 540], ['9:30-6:30', 540], ['10:00-7:00', 540], ['11:00-8:00', 540],
   ['9:00-6:00', 540], ['12:00-9:00', 540], ['9:00-17:00', 480]].forEach(([s, mins]) => {
    check('"' + s + '" is still ' + (mins / 60) + ' hours', span(s) === mins, parse(s));
    check('and still accepted', ok(s) === true);
  });
  check('none of them is called an overnight one', !parse('8:30-5:30').overnight
    && !parse('11:00-8:00').overnight && !parse('12:00-9:00').overnight);
}

/* ---- and a night one can now be written at all ---- */
{
  [['22:00-6:00', 480], ['21:00-5:30', 510], ['20:00-4:00', 480],
   ['23:00-7:00', 480], ['19:30-4:30', 540]].forEach(([s, mins]) => {
    check('"' + s + '" is ' + (mins / 60) + ' hours, not a negative day',
      span(s) === mins, parse(s));
    check('and the 3-to-12-hour check lets it through', ok(s) === true, s);
    check('and it knows it crosses midnight', parse(s).overnight === true);
  });
}

/* ---- a punch is read against the shift it belongs to ----
   The clock goes back to zero partway through a night shift, so read plainly a
   finish at six in the morning is a smaller number than a start at ten at
   night - and somebody who worked the whole shift looks sixteen hours early. */
{
  const n = parse('22:00-6:00');
  const at = t => { vm.runInContext('__m = shiftMin(' + JSON.stringify(n) + ', ' + JSON.stringify(t) + ')', ctx); return ctx.__m; };
  check('four minutes late is four minutes late', at('22:04') - n.startMin === 4, at('22:04'));
  check('a finish at six is on time, not sixteen hours early',
    n.endMin - at('06:00') === 0, { end: n.endMin, out: at('06:00') });
  check('and half past five is half an hour early',
    n.endMin - at('05:30') === 30, at('05:30'));
  check('a day shift is left exactly alone',
    at('22:04') === 1324 && (function () {
      const d = parse('9:30-6:30');
      vm.runInContext('__m = shiftMin(' + JSON.stringify(d) + ', "18:30")', ctx);
      return ctx.__m === 1110;
    })());

  /* Turning up early is not turning up a day late. Anything before the start
     used to be pushed over midnight, which is right for a finish and wrong
     for an arrival: five minutes early came out as twenty-four hours late,
     enough to mark the day late and the week short. */
  const e = parse('18:00-3:00');
  const eat = t => { vm.runInContext('__m = shiftMin(' + JSON.stringify(e) + ', ' + JSON.stringify(t) + ')', ctx); return ctx.__m; };
  check('five minutes early is five minutes early, not a day late',
    eat('17:55') - e.startMin === -5, eat('17:55'));
  check('half an hour early likewise', eat('17:30') - e.startMin === -30, eat('17:30'));
  check('and twenty past six is still twenty minutes late',
    eat('18:20') - e.startMin === 20, eat('18:20'));
  check('half past two in the morning is still inside the night',
    e.endMin - eat('02:30') === 30, eat('02:30'));
  check('and five, two hours past the end, is two hours past it',
    eat('05:00') - e.endMin === 120, eat('05:00'));
}

/* ---- rubbish is still rubbish ---- */
{
  check('a one-hour shift is refused', ok('9:00-10:00') === false);
  check('and a fourteen-hour one', ok('6:00-20:00') === false);
}

/* ---- the server reads a shift the same way the page does ----
   There are two copies of this rule, because the page is theirs to edit and
   the server cannot take its word for which day it is writing. Two copies
   drift, so they are checked against the same table. */
{
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sctx = { isFinite, Number, String };
  vm.createContext(sctx);
  const lift = re => { const m = re.exec(SRV); if (!m) throw new Error('not found: ' + re); return m[0]; };
  vm.runInContext(lift(/function parseShiftSpan\(str\) \{[\s\S]*?\n\}/), sctx);
  vm.runInContext(lift(/function shiftFor\(assignments, name, day\) \{[\s\S]*?\n\}/), sctx);
  const srv = s => { vm.runInContext('__r = parseShiftSpan(' + JSON.stringify(s) + ')', sctx); return sctx.__r; };

  ['8:30-5:30', '9:30-6:30', '10:00-7:00', '11:00-8:00', '12:00-9:00', '9:00-17:00',
   '22:00-6:00', '21:00-5:30', '20:00-4:00', '23:00-7:00', '19:30-4:30'].forEach(slot => {
    const a = parse(slot), b = srv(slot);
    check('the two readings of "' + slot + '" agree',
      a.startMin === b.startMin && a.endMin === b.endMin && !!a.overnight === !!b.overnight,
      { page: a, server: b });
  });

  /* Whichever standing shift was in force on the day, not whichever is in
     force now - a shift changed in October must not re-judge September. */
  const runs = { Himanshu: [{ from: '2026-01-01', shift: '8:30-5:30' },
                            { from: '2026-10-01', shift: '22:00-6:00' }] };
  const at = d => { vm.runInContext('__s = shiftFor(' + JSON.stringify(runs) + ', "Himanshu", ' + JSON.stringify(d) + ')', sctx); return sctx.__s; };
  check('the shift in force in September is September’s', at('2026-09-20') === '8:30-5:30', at('2026-09-20'));
  check('and October’s is the night one', at('2026-10-20') === '22:00-6:00', at('2026-10-20'));
  check('a day before any of them has none', at('2025-12-31') === '', at('2025-12-31'));
  check('and somebody with no shift set has none', (function () {
    vm.runInContext('__s = shiftFor({}, "Nobody", "2026-10-20")', sctx); return sctx.__s === '';
  })());
}

/* ---- and the day turns over at the shift start, not at midnight ---- */
{
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  /* ownDays reads the real clock, so rather than pretend otherwise this checks
     the rule it applies: before the shift's start, the working day is
     yesterday's date. */
  check('the server turns the day over at the shift start',
    /if \(mins < sh\.startMin\) \{[\s\S]{0,160}- 86400000/.test(SRV));
  check('and only for a shift that crosses midnight',
    /if \(sh && sh\.overnight\) \{/.test(SRV));
  check('the page does the same, from the same reading',
    /function empWorkingDay\(\)\{[\s\S]{0,420}if\(toMin\(nowHHMM\(\)\) >= sh\.startMin\) return todayISO_full;/.test(APP));
  check('and says so, the date not being today’s',
    /your shift started this day/.test(APP));
  /* The merges all judge it the same way, from one read of the shifts. */
  check('every merge is given the shift to judge it by',
    (SRV.match(/const days = ownDays\(shift\);/g) || []).length === 3);
  check('and the route reads it once for all of them',
    /let empShift = '';/.test(SRV)
      && /\['manualRecords', 'overrides', 'lateExcuses'\]\.indexOf\(key\) > -1/.test(SRV));
}

const bad = results.filter(r => !r).length;
console.log(bad ? ('SOME FAILED (' + bad + ')') : ('ALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
