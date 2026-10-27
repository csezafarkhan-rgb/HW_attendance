// Two stages used to be all-or-nothing: name a first approver and every
// request in the company went through them. Some people are meant to go
// through both, and some straight to the final word, so it is set against the
// name in the shifts panel - and only the exceptions are stored, so a company
// that never opens the panel keeps the arrangement it already had.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

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
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

const ctx = { Array, String, JSON };
vm.createContext(ctx);
['needsFirstApproval', 'stageOwns', 'stageOwnsUnreq'].forEach(fn => vm.runInContext(grab(SRV, fn), ctx));
const call = (fn, ...args) => {
  vm.runInContext('__r = ' + fn + '(' + args.map(a => JSON.stringify(a)).join(', ') + ')', ctx);
  return ctx.__r;
};

const NONE = {};
const SOME = { 'Aman Gupta': 'final', 'Himanshu': 'final' };
const req = (empName, status) => ({ empName, status, id: 'r1' });

/* ---- the default is the arrangement that was already there ---- */
{
  check('with nothing set, everybody goes through the first approver',
    call('needsFirstApproval', NONE, 'Zafar Khan') === true);
  check('and a name nobody has heard of likewise',
    call('needsFirstApproval', NONE, 'Somebody Else') === true);
  check('"final" is the only thing that skips the stage',
    call('needsFirstApproval', SOME, 'Aman Gupta') === false);
  check('and it is set per person, not for the company',
    call('needsFirstApproval', SOME, 'Zafar Khan') === true);
  check('a junk value is not a skip',
    call('needsFirstApproval', { 'X': 'yes' }, 'X') === true);
  check('nor is an absent map', call('needsFirstApproval', null, 'X') === true);
}

/* ---- one stage: nothing changes for anybody ---- */
{
  ['pending', 'query', 'recommended'].forEach(st => {
    check('at one stage a ' + st + ' request is everybody’s',
      call('stageOwns', 0, SOME, req('Aman Gupta', st)) === true);
  });
  check('and an unrequested day the same',
    call('stageOwnsUnreq', 0, SOME, { empName: 'Aman Gupta' }) === true);
}

/* ---- stage 1 is the first approver's, and only for their people ---- */
{
  check('a pending request from somebody who goes through them is theirs',
    call('stageOwns', 1, SOME, req('Zafar Khan', 'pending')) === true);
  check('a query is theirs too',
    call('stageOwns', 1, SOME, req('Zafar Khan', 'query')) === true);
  check('what they have already passed on is not theirs again',
    call('stageOwns', 1, SOME, req('Zafar Khan', 'recommended')) === false);
  check('and somebody set to skip the stage never reaches them',
    call('stageOwns', 1, SOME, req('Aman Gupta', 'pending')) === false);
  check('nor does that person’s unrequested day',
    call('stageOwnsUnreq', 1, SOME, { empName: 'Himanshu' }) === false);
  check('while everybody else’s does',
    call('stageOwnsUnreq', 1, SOME, { empName: 'Zafar Khan' }) === true);
}

/* ---- stage 2 is the final word's ---- */
{
  check('a recommended request is waiting on them',
    call('stageOwns', 2, SOME, req('Zafar Khan', 'recommended')) === true);
  check('a pending one that has not been through the first stage is not',
    call('stageOwns', 2, SOME, req('Zafar Khan', 'pending')) === false);
  /* The point of the whole change: a skipper's request must show at stage 2
     while still pending, because nobody is ever going to recommend it. */
  check('but a skipper’s pending request is theirs from the moment it is raised',
    call('stageOwns', 2, SOME, req('Aman Gupta', 'pending')) === true);
  check('a skipper’s query as well',
    call('stageOwns', 2, SOME, req('Aman Gupta', 'query')) === true);
  check('and a skipper’s unrequested day goes to them',
    call('stageOwnsUnreq', 2, SOME, { empName: 'Aman Gupta' }) === true);
  check('while the two-stage people’s unrequested days do not',
    call('stageOwnsUnreq', 2, SOME, { empName: 'Zafar Khan' }) === false);
}

/* ---- nothing falls between the two stages ---- */
{
  const people = ['Zafar Khan', 'Aman Gupta'];
  const statuses = ['pending', 'query', 'recommended'];
  people.forEach(p => statuses.forEach(s => {
    const r = req(p, s);
    const seen = (call('stageOwns', 1, SOME, r) ? 1 : 0) + (call('stageOwns', 2, SOME, r) ? 1 : 0);
    check('a ' + s + ' request from ' + p + ' is seen at exactly one stage', seen === 1, seen);
  }));
  people.forEach(p => {
    const u = { empName: p };
    const seen = (call('stageOwnsUnreq', 1, SOME, u) ? 1 : 0) + (call('stageOwnsUnreq', 2, SOME, u) ? 1 : 0);
    check('an unrequested day for ' + p + ' is seen at exactly one stage', seen === 1, seen);
  });
}

/* ---- the page and the server call the same people two-stage ---- */
{
  const actx = { JSON };
  vm.createContext(actx);
  vm.runInContext('var approvalRoute = ' + JSON.stringify(SOME) + ';', actx);
  vm.runInContext(grab(APP, 'needsFirstApproval'), actx);
  const page = n => { vm.runInContext('__r = needsFirstApproval(' + JSON.stringify(n) + ')', actx); return actx.__r; };
  ['Zafar Khan', 'Aman Gupta', 'Himanshu', 'Nobody'].forEach(n => {
    check('page and server agree about ' + n,
      page(n) === call('needsFirstApproval', SOME, n), { page: page(n), server: call('needsFirstApproval', SOME, n) });
  });
}

/* ---- the portal follows the same rule the email does ----
   Any admin pressing Approve on the Requests page granted the leave outright,
   first approver or not, so the two stages existed over email and nowhere
   else. The page asks the same question: is this one waiting on the stage I
   hold? */
{
  const actx = { JSON, String };
  vm.createContext(actx);
  vm.runInContext('var MAIL_CFG = null, approvalRoute = ' + JSON.stringify(SOME) + ';', actx);
  ['needsFirstApproval', 'firstApproverInfo', 'iAmFirstApprover', 'awaitsFirstApproval']
    .forEach(fn => vm.runInContext(grab(APP, fn), actx));
  const as = (who, firstEmail) => {
    vm.runInContext('MAIL_CFG = ' + JSON.stringify(
      firstEmail ? { firstApprover: { name: 'Priya', email: firstEmail }, you: who }
                 : { firstApprover: null, you: who }) + ';', actx);
  };
  const ask = (fn, arg) => {
    vm.runInContext('__r = ' + fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')', actx);
    return actx.__r;
  };

  as('priya@allyconnect.in', 'priya@allyconnect.in');
  check('the account signing in as the first approver is recognised as them',
    ask('iAmFirstApprover') === true);
  check('a pending request from a two-stage person is waiting on that stage',
    ask('awaitsFirstApproval', req('Zafar Khan', 'pending')) === true);
  check('and a query likewise', ask('awaitsFirstApproval', req('Zafar Khan', 'query')) === true);
  check('one already passed on is not',
    ask('awaitsFirstApproval', req('Zafar Khan', 'recommended')) === false);
  check('nor is one from somebody set to skip the stage',
    ask('awaitsFirstApproval', req('Aman Gupta', 'pending')) === false);
  check('nor an approved one', ask('awaitsFirstApproval', req('Zafar Khan', 'approved')) === false);

  as('zafar@allyconnect.in', 'priya@allyconnect.in');
  check('anybody else is not the first approver',
    ask('iAmFirstApprover') === false);
  check('but the request is still waiting on that stage, whoever is looking',
    ask('awaitsFirstApproval', req('Zafar Khan', 'pending')) === true);

  /* The whole arrangement rests on somebody being named. With nobody there,
     nothing is waiting on a first stage and Approve means what it always did. */
  as('zafar@allyconnect.in', '');
  check('with no first approver named, nothing waits on a first stage',
    ask('awaitsFirstApproval', req('Zafar Khan', 'pending')) === false);
  check('and nobody is the first approver', ask('iAmFirstApprover') === false);

  /* Case and stray spaces in an address must not decide who holds a stage. */
  as('  PRIYA@AllyConnect.in ', 'priya@allyconnect.in');
  check('the address is matched without regard to case or spacing',
    ask('iAmFirstApprover') === true);

  check('the page offers a pass-on button at all', /data-act="recommend"/.test(APP));
  check('and the bulk approve passes on rather than grants, for them',
    /awaitsFirstApproval\(req\) && iAmFirstApprover\(\)[\s\S]{0,200}recommended/.test(APP));
  check('the server hears about a pass-on made from the portal',
    /newlyRecommended\(requestsBefore, value\)/.test(
      fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));
}

/* ---- the setting is the office's, and the office's alone ---- */
{
  const emp = /const EMPLOYEE_WRITABLE = \[([^\]]*)\]/.exec(SRV);
  check('an employee cannot write it', !!emp && emp[1].indexOf('approvalRoute') === -1, emp && emp[1]);
  const vis = /const EMP_READABLE = \[([\s\S]*?)\]/.exec(SRV);
  check('nor read it', !!vis && vis[1].indexOf('approvalRoute') === -1, vis && vis[1]);
  check('and it is kept in the backup like every other setting',
    /BACKUP_KEYS[\s\S]{0,600}'approvalRoute'/.test(APP));
  check('and loaded at startup', /loadSelfMark, loadApprovalRoute/.test(APP));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
