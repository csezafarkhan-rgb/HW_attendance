// The paper day-off form says the leave was granted. It was offered on every
// request from the moment it was raised, so somebody could send a request and
// print a form for it in the same breath - before anybody had read it - and
// walk away holding what looks like a signed-off day. The comment beside the
// button said "once approved" all along; the code never checked.
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

const ctx = {};
vm.createContext(ctx);
vm.runInContext(grab('canPrintDayForm'), ctx);
const can = req => {
  vm.runInContext('__r = canPrintDayForm(' + JSON.stringify(req) + ')', ctx);
  return ctx.__r;
};
const r = (status, leaveType) => ({ id: 'r1', status, leaveType: leaveType || 'CL' });

/* ---- nothing to print until somebody has said yes ---- */
{
  ['pending', 'query', 'recommended'].forEach(st => {
    check('a ' + st + ' request offers no form', can(r(st)) === false, st);
  });
  check('a rejected one certainly not', can(r('rejected')) === false);
}

/* ---- and once they have ---- */
{
  check('an approved request prints its form', can(r('approved')) === true);
  /* A day the office put on the record without a request going through at
     all. It is settled, and the form is the one thing it might still need. */
  check('so does a day already recorded', can(r('recorded')) === true);
}

/* ---- a punch correction is not a day off ---- */
{
  ['approved', 'recorded', 'pending'].forEach(st => {
    check('a ' + st + ' punch correction has no day off to print',
      can(r(st, 'PUNCH')) === false, st);
  });
}

/* ---- rubbish in ---- */
{
  check('nothing at all prints nothing', can(null) === false);
  check('nor a request with no status', can({ id: 'x', leaveType: 'CL' }) === false);
  check('nor a made-up status', can(r('granted-ish')) === false);
}

/* ---- every door the button is behind, and the handlers behind those ---- */
{
  const buttons = (APP.match(/Print day-off form/g) || []).length;
  check('the button appears in both lists', buttons === 2, buttons);
  const guards = (APP.match(/canPrintDayForm\(/g) || []).length;
  /* One definition, two buttons, two click handlers. */
  check('and every one of them is behind the same rule', guards === 5, guards);
  check('the admin card asks before it offers',
    /if\(canPrintDayForm\(req\)\) actionsHtml \+=/.test(APP));
  check('the employee card asks before it offers',
    /\(canPrintDayForm\(req\) \?\s*\n?\s*'<div style="margin-top:10px;"><button class="btn ghost" data-print-form=/.test(APP));
  check('the admin click asks again',
    /if\(act === 'form'\)\{ if\(canPrintDayForm\(req\)\) printDayOffForm\(req\); return; \}/.test(APP));
  check('and the employee click asks again',
    /if\(canPrintDayForm\(r\)\) printDayOffForm\(r\);/.test(APP));
  /* The one that put a form in somebody's hand: pressing Send opened the
     printable page there and then, for a day nobody had agreed to. */
  check('sending a request no longer opens a form by itself',
    !/if\(!isPunch\) printDayOffForm\(req\);/.test(APP));
  /* Three calls remain: the two buttons, each behind the rule, and the
     office's own tool for printing a form for a past leave - which builds its
     own approved request rather than reading one. */
  const calls = (APP.match(/[^n] printDayOffForm\(|^\s*printDayOffForm\(/gm) || []).length;
  check('the form is printed from three places and no more', calls === 3, calls);
  check('and the office’s past-leave form still stands on its own',
    /id: 'past_' \+ from \+ '_' \+ to[\s\S]{0,400}status: 'approved'/.test(APP));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
