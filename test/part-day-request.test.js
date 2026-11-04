/* A half day is asked for again, so the road a request travels has to carry
   one - and it had been closed for long enough that nothing was watching it.

   This runs the merge itself rather than reading it: what an employee's page
   sends lands here, and here is where it is decided whether it becomes a
   request. Both sides of the one rule are checked, because the fault that
   would hurt is a kind that is neither taken nor asked for - a person with
   nowhere to put their morning. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(what, cond, saw) {
  if (cond) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(saw)); }
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

const ctx = { Date, JSON, Object, Array, String, Number, Boolean, Math, console };
vm.createContext(ctx);
['parseJson', 'clip', 'leavePolicyOf', 'selfKindsOf'].forEach(n => vm.runInContext(grab(SRV, n), ctx));
[/const DAY_RE = [^\n]*/, /const EMP_CANCELLABLE = [^\n]*/,
 /const SELF_ABLE_KINDS = \[[^\]]*\];/, /const LEAVE_POLICY_DEFAULT = \{[^}]*\};/,
 /* How far back a request may reach, and the hour the office counts it from. */
 /const IST_MS = [^\n]*/, /const REQ_BACK_DAYS = [^\n]*/]
  .forEach(re => { const m = re.exec(SRV); if (!m) throw new Error('not found: ' + re); vm.runInContext(m[0], ctx); });
vm.runInContext(grab(SRV, 'isPlainObject'), ctx);
/* The save path asks this how far back a request may reach. */
vm.runInContext(grab(SRV, 'backDaysOf'), ctx);
vm.runInContext(grab(SRV, 'mergeEmployeeRequests'), ctx);

const NAME = 'Keshav Garg';
let n = 0;
function ask(over) {
  return Object.assign({
    id: 'req_test' + (++n), empName: NAME, dateFrom: '2026-11-10', dateTo: '2026-11-10',
    leaveType: 'HALF', half: 'PM', message: 'dentist'
  }, over || {});
}
/* What the office has set today: a short leave taken, a half day asked for. */
const TODAY_POLICY = ctx.selfKindsOf(ctx.leavePolicyOf(undefined));
function merge(req, selfKinds) {
  const out = ctx.mergeEmployeeRequests('[]', JSON.stringify([req]), NAME,
                                        selfKinds || TODAY_POLICY);
  return out === null ? null : JSON.parse(out);
}

check('as it stands, only a short leave is taken', TODAY_POLICY.join() === 'SHORT', TODAY_POLICY);

/* ---- the kind that is asked for gets through ---- */
let got = merge(ask());
check('a half day becomes a request', got.length === 1, got);
check('and keeps which half it is', got[0] && got[0].half === 'PM', got);
check('and waits for a word', got[0] && got[0].status === 'pending', got);
check('and the reason travels with it', got[0] && got[0].message === 'dentist', got);

/* ---- the kind that is taken does not ---- */
got = merge(ask({ leaveType: 'SHORT', half: '' }));
check('a short leave is not asked for while it is taken', got.length === 0, got);
check('and it is refused however it is spelled',
  merge(ask({ leaveType: 'short', half: '' })).length === 0, null);

/* ---- a part of a day is a part of ONE day ---- */
got = merge(ask({ dateTo: '2026-11-12' }));
check('a half day across three days is refused', got.length === 0, got);
got = merge(ask({ leaveType: 'THREEQ', dateTo: '2026-11-11' }));
check('and so is a three-quarter day across two', got.length === 0, got);
got = merge(ask({ leaveType: 'CL', dateTo: '2026-11-12' }));
check('a whole day of leave still spans as many days as it likes',
  got.length === 1 && got[0].dateTo === '2026-11-12', got);

/* ---- turn the setting round and both sides turn with it ---- */
const FLIPPED = ctx.selfKindsOf(ctx.leavePolicyOf('{"SHORT":"approval","HALF":"self"}'));
check('flipped, only a half day is taken', FLIPPED.join() === 'HALF', FLIPPED);
check('a short leave can then be asked for',
  merge(ask({ leaveType: 'SHORT', half: '' }), FLIPPED).length === 1, null);
check('and a half day cannot',
  merge(ask(), FLIPPED).length === 0, null);

/* With neither taken, both are asked for - which is the arrangement the whole
   office had before any of this, and it has to still work. */
const NONE = ctx.selfKindsOf(ctx.leavePolicyOf('{"SHORT":"approval","HALF":"approval"}'));
check('with neither taken, both are asked for',
  merge(ask({ leaveType: 'SHORT', half: '' }), NONE).length === 1
  && merge(ask(), NONE).length === 1, null);

/* ---- and one already asked for is untouched by any of it ----
   The rule is about new requests. A half day asked for last week does not
   vanish because the office decided this morning that half days are taken. */
{
  const standing = [{
    id: 'req_old', empName: NAME, dateFrom: '2026-11-03', dateTo: '2026-11-03',
    leaveType: 'HALF', half: 'AM', message: 'dentist', status: 'pending',
    adminNote: '', employeeReply: '', createdAt: '2026-11-03T04:00:00.000Z',
    updatedAt: '2026-11-03T04:00:00.000Z'
  }];
  const after = JSON.parse(ctx.mergeEmployeeRequests(
    JSON.stringify(standing), JSON.stringify(standing), NAME, FLIPPED));
  check('a half day already asked for survives the office changing its mind',
    after.length === 1 && after[0].id === 'req_old' && after[0].status === 'pending', after);
}

/* ---- and what a granted one leaves on the day ----
   A half day names which half. A short leave has no half to name, and saying
   "First half" on one was a sentence that only ever read as a mistake - it
   was unreachable while a short leave could not be asked for, and the moment
   the office can ask for one it is on the record. */
{
  vm.runInContext(/const PART_KINDS = \[[^\]]*\];/.exec(SRV)[0], ctx);
  vm.runInContext(grab(SRV, 'markForRequest'), ctx);
  const half = ctx.markForRequest({ id: 'r1', leaveType: 'HALF', half: 'PM', message: 'dentist' });
  check('a granted half day says which half', /^Second half/.test(half.value.note), half.value);
  check('and keeps it against the day', half.value.half === 'PM', half.value);
  const short = ctx.markForRequest({ id: 'r2', leaveType: 'SHORT', half: 'AM', message: 'bank' });
  check('a granted short leave says what it is instead',
    short.value.note === 'Short leave · bank', short.value);
  check('and carries no half at all', short.value.half === '', short.value);
}

console.log(fail ? ('FAILED (' + fail + ' of ' + (pass + fail) + ')')
                 : ('ALL PASS (' + pass + ' checks)'));
process.exit(fail ? 1 : 0);
