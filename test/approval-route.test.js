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

const ctx = { Array, String, JSON, Object };
vm.createContext(ctx);
vm.runInContext('const EMAIL_RE = ' + /const EMAIL_RE = (\/.*\/);/.exec(SRV)[1] + ';', ctx);
['needsFirstApproval', 'approverFor', 'stageOwns', 'stageOwnsUnreq', 'firstApprovers', 'legFor']
  .forEach(fn => vm.runInContext(grab(SRV, fn), ctx));
const call = (fn, ...args) => {
  vm.runInContext('__r = ' + fn + '(' + args.map(a => JSON.stringify(a)).join(', ') + ')', ctx);
  return ctx.__r;
};

/* The office's own first approver, where nothing is said against a name. */
const USUAL = 'priya@allyconnect.in';
const OTHER = 'dutt@essessexports.net';
const NONE = {};
const SOME = { 'Aman Gupta': 'final', 'Himanshu': 'final' };
/* Shyam Lal works somewhere else and answers to somebody else. */
const MIXED = { 'Aman Gupta': 'final', 'Shyam Lal ESS': OTHER };
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
      call('stageOwns', 0, SOME, req('Aman Gupta', st), USUAL, USUAL) === true);
  });
  check('and an unrequested day the same',
    call('stageOwnsUnreq', 0, SOME, { empName: 'Aman Gupta' }, USUAL, USUAL) === true);
}

/* ---- stage 1 is the first approver's, and only for their people ---- */
{
  check('a pending request from somebody who goes through them is theirs',
    call('stageOwns', 1, SOME, req('Zafar Khan', 'pending'), USUAL, USUAL) === true);
  check('a query is theirs too',
    call('stageOwns', 1, SOME, req('Zafar Khan', 'query'), USUAL, USUAL) === true);
  check('what they have already passed on is not theirs again',
    call('stageOwns', 1, SOME, req('Zafar Khan', 'recommended'), USUAL, USUAL) === false);
  check('and somebody set to skip the stage never reaches them',
    call('stageOwns', 1, SOME, req('Aman Gupta', 'pending'), USUAL, USUAL) === false);
  check('nor does that person’s unrequested day',
    call('stageOwnsUnreq', 1, SOME, { empName: 'Himanshu' }, USUAL, USUAL) === false);
  check('while everybody else’s does',
    call('stageOwnsUnreq', 1, SOME, { empName: 'Zafar Khan' }, USUAL, USUAL) === true);
}

/* ---- stage 2 is the final word's ---- */
{
  check('a recommended request is waiting on them',
    call('stageOwns', 2, SOME, req('Zafar Khan', 'recommended'), USUAL, USUAL) === true);
  check('a pending one that has not been through the first stage is not',
    call('stageOwns', 2, SOME, req('Zafar Khan', 'pending'), USUAL, USUAL) === false);
  /* The point of the whole change: a skipper's request must show at stage 2
     while still pending, because nobody is ever going to recommend it. */
  check('but a skipper’s pending request is theirs from the moment it is raised',
    call('stageOwns', 2, SOME, req('Aman Gupta', 'pending'), USUAL, USUAL) === true);
  check('a skipper’s query as well',
    call('stageOwns', 2, SOME, req('Aman Gupta', 'query'), USUAL, USUAL) === true);
  check('and a skipper’s unrequested day goes to them',
    call('stageOwnsUnreq', 2, SOME, { empName: 'Aman Gupta' }, USUAL, USUAL) === true);
  check('while the two-stage people’s unrequested days do not',
    call('stageOwnsUnreq', 2, SOME, { empName: 'Zafar Khan' }, USUAL, USUAL) === false);
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
  /* The panel's box, and the page reading it the way the server does. */
  check('the panel has a box for a per-person approver', /data-appr-emp=/.test(APP));
  check('and the page reads one out of the map the same way',
    /function ownApprover\(name\)/.test(APP));
  check('an address is never mistaken for the word that skips the stage',
    /v !== 'final' && v\.indexOf\('@'\) > -1/.test(APP));
  check('and the bulk approve passes on rather than grants, for them',
    /awaitsFirstApproval\(req\) && iAmFirstApprover\(\)[\s\S]{0,200}recommended/.test(APP));
  check('the server hears about a pass-on made from the portal',
    /newlyRecommended\(requestsBefore, value\)/.test(
      fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));
}

/* ---- one person, somebody else's first approval ----
   Shyam Lal works from another location and answers to somebody outside the
   usual line. Routing the whole company through that person to serve one of
   them is not an answer, so the address is named against the name. */
{
  check('with nothing named, the office’s own approver holds the stage',
    call('approverFor', MIXED, 'Zafar Khan', USUAL) === USUAL);
  check('an address named against somebody holds it for them instead',
    call('approverFor', MIXED, 'Shyam Lal ESS', USUAL) === OTHER);
  check('and "final" still means nobody holds it',
    call('approverFor', MIXED, 'Aman Gupta', USUAL) === null);
  check('with no office approver either, nobody holds it',
    call('approverFor', NONE, 'Zafar Khan', '') === null);
  /* But one named against a person stands on its own: their leave goes
     through them whether or not the office has named anybody. */
  check('an address named against somebody works with no office approver at all',
    call('approverFor', MIXED, 'Shyam Lal ESS', '') === OTHER);
  check('rubbish in the box is not an address, so the usual one holds',
    call('approverFor', { 'X': 'not an address' }, 'X', USUAL) === USUAL);
  check('and the address is matched without regard to case',
    call('approverFor', { 'X': 'DUTT@EssessExports.net' }, 'X', USUAL) === OTHER);
}

/* ---- each approver is told about their own people and nobody else's ---- */
{
  const theirs = r => call('stageOwns', 1, MIXED, r, USUAL, OTHER);
  const usual  = r => call('stageOwns', 1, MIXED, r, USUAL, USUAL);
  check('Shyam Lal’s request reaches the approver named for him',
    theirs(req('Shyam Lal ESS', 'pending')) === true);
  check('and not the office’s own first approver',
    usual(req('Shyam Lal ESS', 'pending')) === false);
  check('everybody else reaches the office’s own',
    usual(req('Zafar Khan', 'pending')) === true);
  check('and not somebody else’s approver',
    theirs(req('Zafar Khan', 'pending')) === false);
  check('a skipper reaches neither of them',
    theirs(req('Aman Gupta', 'pending')) === false
      && usual(req('Aman Gupta', 'pending')) === false);
  check('and once passed on, it is nobody’s first stage again',
    theirs(req('Shyam Lal ESS', 'recommended')) === false);
  check('but it is the final word’s',
    call('stageOwns', 2, MIXED, req('Shyam Lal ESS', 'recommended'), USUAL, USUAL) === true);
  check('and their pending one is not the final word’s yet',
    call('stageOwns', 2, MIXED, req('Shyam Lal ESS', 'pending'), USUAL, USUAL) === false);

  /* Days marked with no request behind them follow the same roads. */
  check('an unrequested day of theirs goes to their approver',
    call('stageOwnsUnreq', 1, MIXED, { empName: 'Shyam Lal ESS' }, USUAL, OTHER) === true);
  check('and not to the office’s own',
    call('stageOwnsUnreq', 1, MIXED, { empName: 'Shyam Lal ESS' }, USUAL, USUAL) === false);
}

/* ---- who gets a message at all ---- */
{
  const who = (route, fb) => call('firstApprovers', route, fb);
  check('with nobody named on a row, one approver: the office’s own',
    JSON.stringify(who(SOME, USUAL)) === JSON.stringify([USUAL]), who(SOME, USUAL));
  check('with one named, two - and the office’s own comes first',
    JSON.stringify(who(MIXED, USUAL)) === JSON.stringify([USUAL, OTHER]), who(MIXED, USUAL));
  check('"final" is never an approver',
    who(MIXED, USUAL).indexOf('final') === -1);
  check('the same address named against two people is still one message',
    who({ a: OTHER, b: OTHER }, USUAL).length === 2, who({ a: OTHER, b: OTHER }, USUAL));
  check('and with no office approver, only the named ones',
    JSON.stringify(who(MIXED, '')) === JSON.stringify([OTHER]), who(MIXED, ''));
  check('nobody anywhere means no first stage at all',
    who(SOME, '').length === 0, who(SOME, ''));
}

/* ---- and where each message is addressed ---- */
{
  const S = { leave: { firstTo: [USUAL, 'hr@allyconnect.in'], firstCc: ['cc@allyconnect.in', USUAL] } };
  const mine = call('legFor', S, USUAL, USUAL);
  check('the office’s own stage keeps the line it was configured with',
    JSON.stringify(mine.to) === JSON.stringify([USUAL, 'hr@allyconnect.in']), mine);
  check('and its cc, minus anybody already on the to line',
    JSON.stringify(mine.cc) === JSON.stringify(['cc@allyconnect.in']), mine);
  const other = call('legFor', S, OTHER, USUAL);
  check('an approver named against one person is that one address',
    JSON.stringify(other.to) === JSON.stringify([OTHER]), other);
  check('and nobody is copied on it',
    other.cc.length === 0, other);
  check('both are stage one, and say whose stage they are',
    mine.stage === 1 && other.stage === 1 && other.approver === OTHER, { mine, other });
}

/* ---- a per-person approver stands on its own ----
   Whether leave is granted in two stages is a question of whether anybody
   holds the first one, not of the office having named a default. */
{
  const who = (route, fb) => call('firstApprovers', route, fb);
  check('with no default named, the one named against somebody still holds a stage',
    JSON.stringify(who(MIXED, '')) === JSON.stringify([OTHER]), who(MIXED, ''));
  check('and that person’s request is that approver’s at stage one',
    call('stageOwns', 1, MIXED, req('Shyam Lal ESS', 'pending'), '', OTHER) === true);
  check('while everybody else goes straight to the final word',
    call('stageOwns', 2, MIXED, req('Zafar Khan', 'pending'), '', OTHER) === true);
  check('with nobody named anywhere there is no first stage at all',
    who(SOME, '').length === 0);
  /* The summary used to gate the whole arrangement on the default alone, so
     this is checked on the sender itself and not only on the helper. */
  /* It takes options now, for the preview that builds a message and holds it
     rather than sending it. */
  const sender = /async function sendLeaveEmail\(orgId[^)]*\)[\s\S]*?\n\}/.exec(SRV)[0];
  check('the nightly summary asks whether anybody holds a first stage',
    /const approvers = firstApprovers\(route, fallback\);/.test(sender)
      && /if \(approvers\.length\) \{/.test(sender), sender.slice(0, 200));
  check('and no longer asks only whether a default was named',
    !/^\s*if \(fallback\) \{/m.test(sender));
  /* An address named against one person is that one address, with nobody
     copied; the office's own stage keeps the line it was configured with. */
  const S0 = { leave: { firstTo: [], firstCc: ['cc@x.com'] } };
  const only = call('legFor', S0, OTHER, '');
  check('with no default line, their approver is simply the address',
    JSON.stringify(only.to) === JSON.stringify([OTHER]) && only.cc.length === 0, only);
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
