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

const ctx = { isFinite, isNaN, Number, String };
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
}

/* ---- rubbish is still rubbish ---- */
{
  check('a one-hour shift is refused', ok('9:00-10:00') === false);
  check('and a fourteen-hour one', ok('6:00-20:00') === false);
}

const bad = results.filter(r => !r).length;
console.log(bad ? ('SOME FAILED (' + bad + ')') : ('ALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
