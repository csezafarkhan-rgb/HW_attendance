/* An approver who is not an admin.
 *
 * Karan answers for seven people and has no Requests tab, because that tab is
 * the office's. The only way he could answer anything was to find the right
 * email and press the button in it - so a decision waited on him finding a
 * message, and the page he does open every day said nothing about it.
 *
 * His own page carries it now. The thing worth testing is that it is not a
 * second way of deciding: the same gate says who may answer, the same
 * function writes the answer, and what the page is handed about somebody
 * else's request is the bare line and no more.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

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

const KARAN = 'karan@homeweavers.net';
const SHIVANI = 'shivani@homeweavers.net';
const NITISH = 'nitish@homeweavers.net';
const MUNISH = 'munish@homeweavers.net';

/* ------------------------------------------------------------------ *
 * what the server hands an approver                                    *
 * ------------------------------------------------------------------ */
const REQS = [
  { id: 'a', empName: 'Keshav Garg', leaveType: 'Sick', dateFrom: '2026-11-12',
    dateTo: '2026-11-13', status: 'pending', createdAt: '2026-11-13T03:36:00Z',
    message: 'Fever since Wednesday night.' },
  { id: 'b', empName: 'Rahul Mishra', leaveType: 'PUNCH', dateFrom: '2026-11-14',
    dateTo: '2026-11-14', status: 'pending', createdAt: '2026-11-14T04:00:00Z',
    punchIn: '09:41', punchOut: '' },
  /* Waiting, but waiting on the person who asked. */
  { id: 'c', empName: 'Himanshu', leaveType: 'CL', dateFrom: '2026-11-20',
    dateTo: '2026-11-20', status: 'query', createdAt: '2026-11-10T04:00:00Z' },
  /* Somebody else's people: Karan is copied, never addressed. */
  { id: 'd', empName: 'Shyam Lal ESS', leaveType: 'CL', dateFrom: '2026-11-18',
    dateTo: '2026-11-18', status: 'pending', createdAt: '2026-11-09T04:00:00Z' },
  { id: 'e', empName: 'Aman Gupta', leaveType: 'CL', dateFrom: '2026-11-05',
    dateTo: '2026-11-05', status: 'approved', createdAt: '2026-11-04T04:00:00Z' },
  { id: 'f', empName: 'Zafar Khan', leaveType: 'HALF', dateFrom: '2026-11-19',
    dateTo: '2026-11-19', half: 'PM', status: 'pending', archived: true,
    createdAt: '2026-11-08T04:00:00Z' }
];
/* Who each kind of request is sent TO, which is the whole of who may answer
   it. A correction has a list of its own, and that is the point of asking
   twice: an office that fills in the corrections tab must not have its
   corrections shown to the leave approvers. */
const LEAVE_TO = {
  'Keshav Garg': [KARAN, SHIVANI, NITISH],
  'Rahul Mishra': [KARAN, SHIVANI, NITISH],
  'Himanshu': [KARAN, SHIVANI, NITISH],
  'Zafar Khan': [KARAN, SHIVANI, NITISH],
  'Aman Gupta': [KARAN, SHIVANI, NITISH],
  'Shyam Lal ESS': [MUNISH, SHIVANI, NITISH]
};
const PUNCH_TO = { 'Rahul Mishra': [SHIVANI, NITISH] };     // not Karan

let punchAsked = 0, leaveAsked = 0;
const srvCtx = {
  JSON, Object, Array, String, console, Promise,
  parseJson: s => { try { return JSON.parse(s); } catch (e) { return undefined; } },
  clip: (v, n) => String(v == null ? '' : v).slice(0, n),
  sharedKeys: async () => ({
    leaveRequests: JSON.stringify(REQS),
    empNames: JSON.stringify({ 'Keshav Garg': 'Keshav G', 'Shyam Lal ESS': 'Shyam Lal' })
  }),
  mailSettings: async () => ({ leave: {}, punch: {} }),
  approvalRouteOf: async () => ({}),
  mailRecipients: async () => [SHIVANI, NITISH],
  leaveAudience: async (org, s, route, emp) => {
    leaveAsked++;
    return { to: (LEAVE_TO[emp] || []).slice(), cc: [], own: '' };
  },
  punchAudience: async (org, s, route, emp) => {
    punchAsked++;
    return { to: (PUNCH_TO[emp] || LEAVE_TO[emp] || []).slice(), cc: [], own: '' };
  },
  approverNames: async (org, addrs) => (addrs || []).join(' and '),
  daysBetween: (from, to) => {
    const out = [];
    for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z');
         d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
    return out;
  },
  mailer: { kindName: t => ({ Sick: 'Sick leave', CL: 'Casual leave', HALF: 'Half day',
                              PUNCH: 'Punch correction' })[t] || 'Leave' },
  Date
};
vm.createContext(srvCtx);
vm.runInContext('async ' + grab(SRV, 'approvalsFor'), srvCtx);

(async () => {
  const mine = await srvCtx.approvalsFor(1, KARAN);
  const ids = mine.map(x => x.id);

  check('what he is sent is what he is handed', ids.indexOf('a') > -1, ids);
  /* The three that look like his and are not. */
  check('a question put back to the person who asked is not his to decide',
    ids.indexOf('c') === -1, ids);
  check('somebody else’s people are not on his list', ids.indexOf('d') === -1, ids);
  check('nor is one already answered', ids.indexOf('e') === -1, ids);
  check('nor one taken off the board', ids.indexOf('f') === -1, ids);
  /* A correction asks the corrections list. Karan is on the leave list for
     Rahul and not on the corrections list, so this is the case that tells the
     two questions apart. */
  check('a correction asks the list corrections are sent to', punchAsked === 1, punchAsked);
  check('and he is not handed one he would not have been sent',
    ids.indexOf('b') === -1, ids);

  const keshav = mine.filter(x => x.id === 'a')[0] || {};
  check('the line carries the name the office shows', keshav.who === 'Keshav G', keshav.who);
  check('and what kind of request it is, in words',
    keshav.kind === 'Sick leave', keshav.kind);
  check('and how many days it is', keshav.days === 2, keshav.days);
  check('the reason travels with it, for the press that asks for it',
    /Fever/.test(keshav.said || ''), keshav.said);
  check('and whoever else could answer it is named',
    keshav.alsoWith === SHIVANI + ' and ' + NITISH, keshav.alsoWith);

  /* Oldest first: the one being forgotten is the one worth leading with. */
  const two = await srvCtx.approvalsFor(1, SHIVANI);
  const order = two.map(x => x.id);
  check('the oldest leads, whoever is looking',
    order.join(',') === 'd,c,a,b'.split(',').filter(x => order.indexOf(x) > -1).join(','),
    order);
  check('and a request on the corrections list reaches the people on it',
    order.indexOf('b') > -1, order);

  /* ---------------------------------------------------------------- *
   * and the gate, which is the one the emailed buttons go through     *
   * ---------------------------------------------------------------- */
  const gateCtx = {
    JSON, Object, Array, String, console, Promise, Date,
    EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    parseJson: srvCtx.parseJson,
    mailSettings: srvCtx.mailSettings,
    approvalRouteOf: srvCtx.approvalRouteOf,
    mailRecipients: srvCtx.mailRecipients,
    leaveAudience: srvCtx.leaveAudience,
    punchAudience: srvCtx.punchAudience,
    approverNames: srvCtx.approverNames,
    pool: { query: async (sql, args) => {
      if (/FROM users/.test(sql)) {
        const by = { 1: { email: KARAN, name: 'karan Ahuja' },
                     2: { email: SHIVANI, name: 'Shivani Dutt' } }[args[0]];
        return { rows: by ? [by] : [] };
      }
      return { rows: [{ value: JSON.stringify(REQS) }] };
    } }
  };
  vm.createContext(gateCtx);
  vm.runInContext('async ' + grab(SRV, 'decidableBy'), gateCtx);
  const asKaran = { session: { userId: 1, orgId: 1 } };
  const asShivani = { session: { userId: 2, orgId: 1 } };

  const leave = await gateCtx.decidableBy(asKaran, { k: 'req', org: 1, id: 'a', act: 'approve' });
  check('the leave he is sent is his to decide', leave.how === 'yes', leave);
  check('and the record is told whose word it was',
    leave.name === 'karan Ahuja', leave.name);
  /* The defect this fixes: the gate asked the leave list about every request,
     so an office that filled in the corrections tab sent a correction to one
     set of people and then refused those same people the buttons on it. */
  const hisPunch = await gateCtx.decidableBy(asKaran, { k: 'req', org: 1, id: 'b', act: 'approve' });
  check('a correction he was not sent is not his, though the leave is',
    hisPunch.how === 'no', hisPunch);
  const herPunch = await gateCtx.decidableBy(asShivani, { k: 'req', org: 1, id: 'b', act: 'approve' });
  check('and the people it was sent to may press the button on it',
    herPunch.how === 'yes', herPunch);
  check('signed in as nobody decides nothing',
    (await gateCtx.decidableBy({ session: {} }, { k: 'req', org: 1, id: 'a' })).how === 'signin',
    null);

  /* ---------------------------------------------------------------- *
   * the two ends of the press                                         *
   * ---------------------------------------------------------------- */
  const post = SRV.slice(SRV.indexOf("app.post('/api/my/approvals'"),
                         SRV.indexOf("app.post('/api/my/approvals'") + 1400);
  check('the press goes through the same gate the email goes through',
    /decidableBy\(req, p\)/.test(post), null);
  check('and is written by the same function the email calls',
    /applyEmailDecision\(p,/.test(post), null);
  check('a request already settled is said so, not decided twice',
    /alreadySettled\(p\)/.test(post), null);
  check('only the two words are accepted',
    /act !== 'approve' && act !== 'reject'/.test(post), null);
  /* The link's own stage, so a note written from the page is written to the
     same person a note from the email would be. */
  check('it stands where the request email stands', /s: 0/.test(post), null);
  check('and the list behind it is only ever read, never a list of everybody',
    /app\.get\('\/api\/my\/approvals', requireAuth/.test(SRV), null);

  /* ---------------------------------------------------------------- *
   * and what the page makes of it                                     *
   * ---------------------------------------------------------------- */
  const appCtx = {
    Date, String, Math, console, JSON,
    dayInWords: iso => ({ '2026-11-12': '12 Nov’ 2026', '2026-11-13': '13 Nov’ 2026',
                          '2026-11-14': '14 Nov’ 2026' })[iso] || iso,
    whenShort: () => '9:06 am, 13 Nov',
    pad2: n => ('0' + n).slice(-2)
  };
  vm.createContext(appCtx);
  ['shotEsc', 'fmtTime', 'fmtDayShortish', 'ewSpan', 'ewDaysSince', 'ewDecideTag',
   'ewDecideSub', 'ewSeeBox', 'ewAskBox'].forEach(n => vm.runInContext(grab(APP, n), appCtx));

  const CARD = { id: 'a', who: 'Keshav Garg', type: 'Sick', kind: 'Sick leave',
                 from: '2026-11-12', to: '2026-11-13', days: 2, half: '', status: 'pending',
                 passedBy: '', asked: '2026-11-13T03:36:00Z', said: 'Fever since Wednesday.',
                 punchIn: '', punchOut: '', alsoWith: 'Shivani Dutt and Nitish Kumar' };
  const PUNCH = { id: 'b', who: 'Rahul Mishra', type: 'PUNCH', kind: 'Punch correction',
                  from: '2026-11-14', to: '2026-11-14', days: 1, half: '', status: 'pending',
                  passedBy: '', asked: '2026-11-14T04:00:00Z', said: '',
                  punchIn: '09:41', punchOut: '', alsoWith: '' };

  check('a correction is coloured as itself, not as a day off',
    appCtx.ewDecideTag(PUNCH).cls === 'punch', appCtx.ewDecideTag(PUNCH));
  /* A missing end of the day means leave it alone, and says so - a blank
     there reads as midnight to anybody who does not already know. */
  check('a correction with one end open says the other is unchanged',
    /in 9:41 AM, out unchanged/.test(appCtx.ewDecideSub(PUNCH)), appCtx.ewDecideSub(PUNCH));
  check('a leave line says how long it is',
    /2 days/.test(appCtx.ewDecideSub(CARD)), appCtx.ewDecideSub(CARD));
  check('and how long it has been waiting',
    /^Asked /.test(appCtx.ewDecideSub(CARD)), appCtx.ewDecideSub(CARD));
  check('one passed on names who passed it',
    /passed on by Shivani Dutt/.test(appCtx.ewDecideSub(
      Object.assign({}, CARD, { passedBy: 'Shivani Dutt' }))), null);

  const see = appCtx.ewSeeBox(CARD);
  check('the reason is behind the press, and is there when pressed',
    /Fever since Wednesday\./.test(see), null);
  check('and who else could answer it',
    /Shivani Dutt and Nitish Kumar/.test(see), null);
  check('a queue of one says so rather than leaving the line blank',
    /waiting on you alone/.test(appCtx.ewSeeBox(PUNCH)), null);
  check('a request with no reason says that too, rather than nothing',
    /No reason was given/.test(appCtx.ewSeeBox(PUNCH)), null);

  const ask = appCtx.ewAskBox(CARD, 'approve');
  check('the press asks before it decides, naming what it will do',
    /Approve Keshav Garg’s sick leave/.test(ask), ask.slice(0, 120));
  check('and says what the yes actually does',
    /Marks the days and emails Keshav Garg/.test(ask), null);
  check('a refusal marks nothing, and says that instead',
    /Nothing is marked\./.test(appCtx.ewAskBox(CARD, 'reject')), null);
  check('the word travels with the decision',
    /textarea id="ewSay"/.test(ask), null);

  /* The buttons come off the row while its question is on screen: a second
     Approve beside the box would be a second way to do the one thing on this
     card that cannot be undone from it. */
  const renderAt = APP.indexOf('var decideRows = decide.map');
  const render = APP.slice(renderAt, APP.indexOf('box.style.display = \'\';', renderAt));
  check('while the question is up, the row does not also offer the answer',
    /asking \? ''/.test(render), null);
  check('the detail opens under the line it belongs to',
    /open \? ewSeeBox\(it\) : ''/.test(render), null);
  const wire = APP.slice(APP.indexOf('data-ew-go]'), APP.indexOf('data-ew-go]') + 1600);
  check('and the press is sent to the one place that may decide it',
    /'\/api\/my\/approvals'/.test(wire) && /method:'POST'/.test(wire), null);
  check('the page never writes the decision itself',
    !/leaveRequests\s*=/.test(wire), null);

  /* Nobody else's page changes. An admin has the Requests tab; this card is
     for somebody who has not. */
  check('the card is still only drawn for an employee’s own page',
    /viewRole\.role !== 'employee'/.test(APP), null);
  /* A day of their own still outranks nothing: the card appears for an
     approver with a clean record of their own, which it did not before. */
  check('a clean record with a decision waiting still draws the card',
    /!got\.mine\.length && !got\.theirs\.length && !decide\.length/.test(APP), null);

  console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
