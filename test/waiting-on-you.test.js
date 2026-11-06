/* What the record is waiting on one person for.
 *
 * Four things can be outstanding against somebody, and they divide in two by
 * the only question that matters to the person looking at the list: can I
 * finish this myself, or am I waiting on somebody else?
 *
 *   theirs  - leave the record holds with no form behind it, a late morning
 *             nobody has explained, and a request somebody queried;
 *   others' - a request sent and not yet answered.
 *
 * The queried one is why the split is worth drawing. It sits in the same
 * store as the other waiting requests and is the opposite of them: telling
 * somebody to go and chase a question that is waiting on their own reply is
 * telling them to chase themselves.
 *
 * None of this is new information - every piece of it was already on the
 * page. What was missing was anywhere that said so: the day card reaches
 * today and yesterday, so a late Tuesday three weeks back had nowhere to be
 * answered from at all.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

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

/* ---- the sorting of one person's outstanding days ---- */
const ctx = vm.createContext({ console, Date, Math, isNaN, String, Number, Object, Array });
['ewDaysSince', 'ewKindTag', 'ewCost'].forEach(n => vm.runInContext(grab(APP, n), ctx));
vm.runInContext('function isPartDay(t){ return t==="HALF"||t==="SHORT"||t==="THREEQ"; }', ctx);
vm.runInContext('function hdQty(k){ return k==="SHORT"?0.25:k==="THREEQ"?0.75:0.5; }', ctx);

check('a half day is named a half day, not a fraction',
  ctx.ewKindTag('HALF').txt === 'Half day', ctx.ewKindTag('HALF'));
check('a short leave is named too',
  ctx.ewKindTag('SHORT').txt === 'Short leave', ctx.ewKindTag('SHORT'));
check('a three-quarter day as well',
  ctx.ewKindTag('THREEQ').txt === 'Three-quarter', ctx.ewKindTag('THREEQ'));
check('and anything else is a full day',
  ctx.ewKindTag('CL').txt === 'Full day' && ctx.ewKindTag('Sick').txt === 'Full day', null);
/* The name alone is not checkable against the balance on the same page, so
   what it costs is said beside it in the figures the record counts by. */
check('a half day says it costs half a day',
  ctx.ewCost('HALF') === '0.5 days off your casual', ctx.ewCost('HALF'));
check('a short leave a quarter',
  ctx.ewCost('SHORT') === '0.25 days off your casual', ctx.ewCost('SHORT'));
check('a full day one, said as a day rather than days',
  ctx.ewCost('CL') === '1 day off your casual', ctx.ewCost('CL'));
check('and sick leave comes off the sick balance',
  ctx.ewCost('Sick', 'Sick') === '1 day off your sick', ctx.ewCost('Sick', 'Sick'));

/* Ageing, which is what makes one of these shout and the rest wait. */
const iso = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
check('today is nought days old', ctx.ewDaysSince(iso(0)) === 0, ctx.ewDaysSince(iso(0)));
check('a week ago is seven', ctx.ewDaysSince(iso(7)) === 7, ctx.ewDaysSince(iso(7)));
check('rubbish is not a negative age', ctx.ewDaysSince('not-a-day') === 0, null);
check('nor is nothing at all', ctx.ewDaysSince('') === 0 && ctx.ewDaysSince(null) === 0, null);

/* ---- the split, which is the whole point ---- */
const gather = grab(APP, 'ewGather');
check('leave with no form behind it is theirs to finish',
  /mine\.push\(\{ job:'form'/.test(gather), null);
check('so is a late morning nobody has explained',
  /mine\.push\(\{ job:'late'/.test(gather), null);
check('and so is a question somebody asked back',
  /if\(r\.status === 'query'\)\{[\s\S]{0,160}mine\.push\(\{ job:'reply'/.test(gather), null);
check('a request still waiting is not theirs to finish',
  /theirs\.push\(\{ job:'chase'/.test(gather), null);
check('and it is the only thing in that column',
  (gather.match(/theirs\.push\(/g) || []).length === 1, null);
/* A query must never be filed as something to chase: that is the one case
   where "ask your manager" would mean "ask yourself". */
{
  /* The whole of the query branch: it must file the thing under theirs and
     then leave, so execution never reaches the chasing code below it. */
  const branch = /if\(r\.status === 'query'\)\{([\s\S]*?)\n      \}/.exec(gather);
  check('a query is taken out before the chasing list is reached',
    !!branch && /job:'reply'/.test(branch[1]) && /\breturn;/.test(branch[1])
    && gather.indexOf("job:'reply'") < gather.indexOf("job:'chase'"),
    branch && branch[1].replace(/\s+/g, ' ').trim().slice(0, 120));
}
check('only a request actually waiting is chased',
  /if\(r\.status !== 'pending' && r\.status !== 'recommended'\) return;/.test(gather), null);
check('a request passed on is with the management, not the first approver',
  /if\(r\.status === 'recommended'\)\{ who = 'the management'; \}/.test(gather), null);
check('and otherwise it names whoever the office named against them',
  /approverLabel\(x\)/.test(gather), null);

/* ---- what it refuses to nag about ---- */
check('nothing older than the request form can reach for',
  /if\(u\.empName !== name \|\| u\.dateFrom < floor\) return;/.test(gather)
  && /if\(d < floor \|\| d > todayISO_full\) return;/.test(gather), null);
check('and the floor is the form’s own, not a second number',
  /return earliestRequestDay\(\);/.test(grab(APP, 'ewFloor')), null);
check('a day they were signed off for is not lateness',
  /if\(onApprovedLeave\(name, d\)\) return;/.test(gather), null);
check('nor a lateness already answered, by them or by the office',
  /if\(getLateExcuse\(name, d\) \|\| getLatePlea\(name, d\)\) return;/.test(gather), null);
check('an archived request is nobody’s job',
  /if\(r\.archived\) return;/.test(gather), null);
check('the oldest is put first, because that is the one being forgotten',
  /return y\.age - x\.age;/.test(gather), null);

/* ---- whose panel it is ---- */
const render = grab(APP, 'renderEmpWaiting');
check('it is drawn for the person it is about and nobody else',
  /viewRole\.role !== 'employee'/.test(render), null);
check('and not at all when there is nothing outstanding',
  /if\(!got\.mine\.length && !got\.theirs\.length\)\{/.test(render), null);
check('the column that is not theirs says so in words',
  /Nothing here is yours to finish/.test(render), null);

/* ---- the actions, which are what make it more than a list ---- */
const form = grab(APP, 'ewOpenForm');
check('the form opens on the day it is about, not on today',
  /if\(from\)\{ from\.value = day;/.test(form), null);
check('and the kind is set before the dates, because it disables the To box',
  form.indexOf('t.value = kind') < form.indexOf('from.value = day'), null);
check('a kind the form does not offer is not forced into it',
  /var has = Array\.prototype\.some\.call\(t\.options/.test(form), null);
check('and it says the form was filled in from the record',
  /Filled in from the day on your record/.test(form), null);
/* The late box writes what the day card writes, so one reason does not read
   two ways depending on where it was given. */
check('a reason given here is the same entry the day card writes',
  /var entry = \{ note: note, at: new Date\(\)\.toISOString\(\), by: 'self' \};/.test(APP)
  && (APP.match(/if\(pick === 'late'\) entry\.kind = 'late';/g) || []).length >= 1, null);
check('and it will not save an empty reason',
  /if\(!note\)\{ showUploadStatus\('Say what the reason was first\.', true\);/.test(APP), null);

/* ---- what the employee is allowed to see ---- */
check('they may read who answers for their own leave',
  /'approvalRoute'\]\);/.test(SRV), null);
check('their own row of that table and nobody else’s',
  /return JSON\.stringify\(row == null \? \{\} : \{ \[name\]: row \}\);/.test(SRV), null);
check('and a name missing from it hands back nothing rather than everything',
  /Object\.prototype\.hasOwnProperty\.call\(v, name\)/.test(SRV), null);

/* ---- it must not cost the page it sits above ---- */
check('a fault in it is caught, so the record still draws',
  /try\{ renderEmpWaiting\(\); \}catch\(e\)\{ console\.error\('what is waiting on them', e\); \}/
    .test(APP), null);
check('and it is drawn above the day card, which only reaches yesterday',
  APP.indexOf('id="empWaiting"') < APP.indexOf('id="empDayCard"'), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
