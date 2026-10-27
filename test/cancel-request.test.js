// Somebody who asked for a day and then did not need it had no way to take the
// request back. The only route was to ask an admin to reject it, which puts a
// refusal on the record for a day they were no longer asking for. Their own
// withdrawal says what actually happened - and only while nobody has acted on
// it, because a granted day is on the record and taking it off is the office's.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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

/* ---- the server, which is where it is actually decided ---- */
const sctx = { JSON, Array, Date, String, Object };
vm.createContext(sctx);
vm.runInContext([
  'const DAY_RE = /^\\d{4}-\\d{2}-\\d{2}$/;',
  'function parseJson(s){ try { return JSON.parse(s); } catch (e) { return undefined; } }',
  'function clip(s, n){ return String(s == null ? "" : s).slice(0, n); }',
  'const EMP_CANCELLABLE = ' + /const EMP_CANCELLABLE = (\[[^\]]*\])/.exec(SRV)[1] + ';',
  grab(SRV, 'mergeEmployeeRequests')
].join('\n'), sctx);

const ME = 'Keshav Garg';
const stored = reqs => JSON.stringify(reqs);
const req = (status, who) => ({
  id: 'req_abc123', empName: who || ME, dateFrom: '2026-11-09', dateTo: '2026-11-09',
  leaveType: 'CL', message: 'Diwali', status, adminNote: '', employeeReply: '',
  createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z'
});
const merge = (before, incoming, who) => {
  vm.runInContext('__r = mergeEmployeeRequests(' + JSON.stringify(stored(before)) + ', '
    + JSON.stringify(stored(incoming)) + ', ' + JSON.stringify(who || ME) + ')', sctx);
  return JSON.parse(sctx.__r);
};
const cancelOf = (fromStatus, who) => {
  const was = req(fromStatus, who);
  const asks = Object.assign({}, was, { status: 'cancelled' });
  return merge([was], [asks])[0];
};

/* ---- what may be taken back ---- */
{
  ['pending', 'query', 'recommended'].forEach(st => {
    const after = cancelOf(st);
    check('a ' + st + ' request can be taken back', after.status === 'cancelled', after.status);
    check('and the moment is written down', !!after.cancelledAt, after);
  });
}

/* ---- and what may not ---- */
{
  ['approved', 'rejected', 'recorded', 'cancelled'].forEach(st => {
    const after = cancelOf(st);
    check('a ' + st + ' request is not theirs to take back', after.status === st, after.status);
  });
  /* The one that matters: a granted day is on the record. */
  check('cancelling an approved request leaves it approved, stamp and all',
    cancelOf('approved').cancelledAt === undefined);
}

/* ---- and never somebody else's ---- */
{
  const theirs = req('pending', 'Somebody Else');
  const after = merge([theirs], [Object.assign({}, theirs, { status: 'cancelled' })])[0];
  check('one person cannot cancel another person’s leave', after.status === 'pending', after.status);
}

/* ---- a cancellation does not open any other door ---- */
{
  const was = req('pending');
  const after = merge([was], [Object.assign({}, was, {
    status: 'cancelled', dateFrom: '2026-12-01', dateTo: '2026-12-31',
    leaveType: 'SL', adminNote: 'granted by me', approvedBy: 'me'
  })])[0];
  check('the dates it was for do not change with it', after.dateFrom === '2026-11-09', after.dateFrom);
  check('nor the kind of leave', after.leaveType === 'CL', after.leaveType);
  check('nor can an admin note be put in their own mouth', !after.adminNote, after.adminNote);
  check('nor an approver', !after.approvedBy, after.approvedBy);
}

/* ---- approving yourself is still refused, cancelled or not ---- */
{
  const was = req('pending');
  ['approved', 'recommended', 'recorded'].forEach(st => {
    const after = merge([was], [Object.assign({}, was, { status: st })])[0];
    check('a request cannot be moved to ' + st + ' by the person who made it',
      after.status === 'pending', after.status);
  });
}

/* ---- cancelling one that has a query on it cancels, not replies ---- */
{
  const was = req('query');
  const after = merge([was], [Object.assign({}, was, {
    status: 'cancelled', employeeReply: 'never mind'
  })])[0];
  check('a query answered and cancelled at once is cancelled',
    after.status === 'cancelled', after.status);
  /* And answering one without cancelling still works, which is the branch
     this had to be ordered in front of. */
  const replied = merge([req('query')], [Object.assign({}, req('query'), {
    employeeReply: 'Tuesday would do'
  })])[0];
  check('and answering it without cancelling still sends it back to waiting',
    replied.status === 'pending' && replied.employeeReply === 'Tuesday would do', replied);
}

/* ---- the page offers the button on the same set and no other ---- */
{
  const actx = {};
  vm.createContext(actx);
  vm.runInContext('var REQ_CANCELLABLE = ' + /var REQ_CANCELLABLE = (\[[^\]]*\])/.exec(APP)[1] + ';', actx);
  vm.runInContext(grab(APP, 'canCancelRequest'), actx);
  const can = r => { vm.runInContext('__r = canCancelRequest(' + JSON.stringify(r) + ')', actx); return actx.__r; };

  ['pending', 'query', 'recommended'].forEach(st =>
    check('the button is there on a ' + st + ' request', can(req(st)) === true, st));
  ['approved', 'rejected', 'recorded', 'cancelled'].forEach(st =>
    check('and not on a ' + st + ' one', can(req(st)) === false, st));
  check('nor on a day taken without a request at all',
    can({ id: 'unreq_x', status: 'recorded', _unrequested: true }) === false);
  check('nor on nothing', can(null) === false);

  /* Two lists of statuses, one rule. If they ever part, the button appears on
     something the server will refuse, or hides on something it would allow. */
  check('the page and the server agree on what may be taken back',
    /var REQ_CANCELLABLE = (\[[^\]]*\])/.exec(APP)[1].replace(/['\s]/g, '')
      === /const EMP_CANCELLABLE = (\[[^\]]*\])/.exec(SRV)[1].replace(/['\s]/g, ''),
    { page: /var REQ_CANCELLABLE = (\[[^\]]*\])/.exec(APP)[1],
      server: /const EMP_CANCELLABLE = (\[[^\]]*\])/.exec(SRV)[1] });
}

/* ---- a cancelled request accounts for no day ----
   A day marked as leave with only a cancelled request behind it has been
   agreed by nobody, and has to show up as leave nobody agreed to. */
{
  check('the page does not let it cover a day',
    /r\.status === 'rejected' \|\| r\.status === 'cancelled' \|\| r\.leaveType === 'PUNCH'/.test(APP));
  check('nor does the server',
    /r\.status === 'rejected' \|\| r\.status === 'cancelled' \|\| r\.leaveType === 'PUNCH'/.test(SRV));
  check('and the notice about newly marked days agrees',
    /r\.status !== 'rejected'\s*\n?\s*&& r\.status !== 'cancelled'/.test(SRV));
}

/* ---- and it is out of the way, without being lost ---- */
{
  check('"cancelled" is a status the page knows',
    /REQ_STATUSES = \[[^\]]*'cancelled'/.test(APP));
  check('it has a label rather than showing the raw word',
    /cancelled:'Cancelled'/.test(APP));
  check('and a badge of its own', /\.req-status\.cancelled\{/.test(APP));
  /* The waiting list is what the office works from; a request nobody is
     waiting on does not belong in it. */
  const live = /if\(REQ_VIEW === 'live'\)\s*return ([^;]+);/.exec(APP)[1];
  check('it is not in the office’s waiting list', live.indexOf('cancelled') === -1, live);
  const waiting = /waiting:\s*live\.filter\(function\(r\)\{ return ([^;]+); \}\)/.exec(APP)[1];
  check('nor counted as waiting', waiting.indexOf('cancelled') === -1, waiting);
  check('but it can be archived with the rest of what is settled',
    /r\.status === 'approved' \|\| r\.status === 'rejected'\s*\n?\s*\|\| r\.status === 'cancelled'/.test(APP));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
