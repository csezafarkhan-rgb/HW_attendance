// "My Leave Requests" showed the month on screen and nothing else. Ask for a
// day in November while the page is on October - which is where it opens - and
// the request vanished on being sent: not in this month, so not in the list,
// and nothing anywhere else to say it existed.
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

/* Enough of a document for the renderer to write into, and nothing more. */
function run(month, requests) {
  const el = { textContent: '', className: '', innerHTML: '',
               querySelectorAll: () => [], querySelector: () => null };
  const ids = { myRequestsList: el, myReqMonth: { textContent: '' } };
  const ctx = {
    document: { getElementById: id => ids[id] || null },
    leaveRequests: requests,
    viewRole: { role: 'employee', name: 'Keshav Garg' },
    empCalMonth: month, defaultMonth: month, MYREQ_COMPACT: false,
    REQ_STATUS_LABEL: { pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
                        query: 'Query raised', recorded: 'Recorded' },
    String, Array, Object, JSON
  };
  vm.createContext(ctx);
  vm.runInContext([
    'function escapeHtml(s){ return String(s == null ? "" : s); }',
    'function monthLabel(ym){ return "M" + ym; }',
    'function fmtDateRange(a, b){ return a === b ? a : (a + " to " + b); }',
    'function reqTypeText(r){ return r.leaveType; }',
    'function unrequestedLeave(){ return []; }',
    'function unmarkedNoteHtml(){ return ""; }',
    'function renderEmpAlerts(){}',
    'var REQ_CANCELLABLE = ' + /var REQ_CANCELLABLE = (\[[^\]]*\])/.exec(APP)[1] + ';',
    grab('canPrintDayForm'),
    grab('canCancelRequest'),
    grab('renderMyRequests'),
    'renderMyRequests();'
  ].join('\n'), ctx);
  return el.innerHTML;
}

const mk = (id, from, to, status, who) => ({
  id, empName: who || 'Keshav Garg', dateFrom: from, dateTo: to || from,
  leaveType: 'CL', message: '', status, updatedAt: from + 'T00:00:00Z'
});

/* ---- the case that showed nothing ---- */
{
  const html = run('2026-10', [mk('nov', '2026-11-09', '2026-11-10', 'pending')]);
  check('a November request is on the page while October is on screen',
    html.indexOf('2026-11-09') > -1, html.slice(0, 200));
  check('and it is under a heading of its own, not mixed into the month',
    /Booked ahead/.test(html));
  check('the month itself says it has nothing',
    /Nothing in M2026-10/.test(html));
}

/* ---- the month on screen still comes first ---- */
{
  const html = run('2026-10', [
    mk('nov', '2026-11-09', '2026-11-09', 'pending'),
    mk('oct', '2026-10-19', '2026-10-19', 'approved')
  ]);
  check('October is above the heading and November below it',
    html.indexOf('2026-10-19') < html.indexOf('Booked ahead')
      && html.indexOf('Booked ahead') < html.indexOf('2026-11-09'),
    { oct: html.indexOf('2026-10-19'), head: html.indexOf('Booked ahead'), nov: html.indexOf('2026-11-09') });
  check('and the heading counts what is under it', /1 request\b/.test(html), html.match(/\d+ requests?/));
}

/* ---- what does not belong in it ---- */
{
  const html = run('2026-10', [
    mk('sep', '2026-09-14', '2026-09-14', 'approved'),
    mk('theirs', '2026-11-02', '2026-11-02', 'pending', 'Somebody Else')
  ]);
  check('a month gone by is not "booked ahead"', html.indexOf('2026-09-14') === -1);
  check('and somebody else’s November leave is nobody’s business',
    html.indexOf('2026-11-02') === -1);
  check('with neither of them, there is no heading', !/Booked ahead/.test(html));
}

/* ---- a request that straddles the turn of the month ---- */
{
  const html = run('2026-10', [mk('span', '2026-10-30', '2026-11-03', 'approved')]);
  check('leave running from October into November counts as October’s',
    html.indexOf('2026-10-30') > -1 && !/Booked ahead/.test(html), html.slice(0, 160));
}

/* ---- looking at a later month ---- */
{
  const html = run('2026-11', [
    mk('nov', '2026-11-09', '2026-11-09', 'pending'),
    mk('dec', '2026-12-24', '2026-12-26', 'pending')
  ]);
  check('on November, November is the month and December is ahead',
    html.indexOf('2026-11-09') < html.indexOf('Booked ahead')
      && html.indexOf('Booked ahead') < html.indexOf('2026-12-24'));
}

/* ---- ahead of the month, in the order they fall ---- */
{
  const html = run('2026-10', [
    mk('dec', '2026-12-24', '2026-12-24', 'pending'),
    mk('nov', '2026-11-09', '2026-11-09', 'pending')
  ]);
  check('the ones ahead read soonest first',
    html.indexOf('2026-11-09') < html.indexOf('2026-12-24'));
  check('and the heading says how many', /2 requests/.test(html));
}

/* ---- every status, so a rejection ahead is not hidden from them ---- */
{
  ['pending', 'approved', 'rejected', 'query', 'recommended'].forEach(st => {
    const html = run('2026-10', [mk('x', '2026-11-09', '2026-11-09', st)]);
    check('a ' + st + ' request for November is shown', html.indexOf('2026-11-09') > -1, st);
  });
}

/* ---- and nothing at all is still nothing at all ---- */
{
  const html = run('2026-10', []);
  check('an empty list says so and offers the arrows',
    /Nothing in M2026-10/.test(html) && /arrows above the calendar/.test(html), html);
  check('with no heading over an empty page', !/Booked ahead/.test(html));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
