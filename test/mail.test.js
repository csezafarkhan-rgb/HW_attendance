// Email: the signed buttons in a message, and what pressing one does to the
// record. The real server.js runs against an in-memory stand-in for Postgres.
'use strict';
const path = require('path');
const Module = require('module');
const REPO = path.resolve(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

/* ---------------- the token on a button ---------------- */
const SECRET = 'test-secret-for-signing-links';
{
  const t = mailer.actionToken({ k: 'req', org: 1, id: 'req_1', act: 'approve' }, SECRET);
  const p = mailer.verifyAction(t, SECRET);
  check('a signed link reads back as it was written', p && p.id === 'req_1' && p.act === 'approve', p);
  check('another secret cannot open it', mailer.verifyAction(t, 'other-secret') === null);
  check('a changed token is refused', mailer.verifyAction(t.slice(0, -2) + 'aa', SECRET) === null);
  check('nonsense is refused', mailer.verifyAction('not-a-token', SECRET) === null
    && mailer.verifyAction('', SECRET) === null);
  const stale = mailer.signAction({ k: 'req', org: 1, id: 'x', act: 'approve', exp: Date.now() - 1000 }, SECRET);
  check('an expired link is refused', mailer.verifyAction(stale, SECRET) === null);
}

/* ---------------- what the messages say ---------------- */
{
  const mail = mailer.dailyEmail({
    orgName: 'Test Co', dateLabel: 'Tue, 22 Sep',
    rows: [
      { name: 'Asha Test', 'in': '9:28', out: '18:31', state: 'present', label: 'Present' },
      { name: 'Ravi <b>Test</b>', 'in': '', out: '', state: 'missing', label: 'No punch' }
    ],
    pending: [{ req: { empName: 'Asha Test', leaveType: 'CL', dateFrom: '2026-09-25', dateTo: '2026-09-25', message: 'Family' },
                links: { approve: 'https://x/e/aaa', reject: 'https://x/e/bbb' } }],
    unrequested: [], siteUrl: 'https://x'
  });
  check('the subject counts who has no punch', /1 with no punch/.test(mail.subject), mail.subject);
  check('both buttons are in the message', /https:\/\/x\/e\/aaa/.test(mail.html) && /https:\/\/x\/e\/bbb/.test(mail.html));
  check('a name with markup in it is escaped', /Ravi &lt;b&gt;Test&lt;\/b&gt;/.test(mail.html));
  const page = mailer.confirmPage({ action: 'reject', unrequested: true, summary: 'Asha · 10 Sep', postTo: '/e/tok' });
  check('the page a link opens asks before it acts', /<form method="POST" action="\/e\/tok">/.test(page));
  check('and says a rejection removes the day', /removes the day/.test(page));
  const off = { RESEND_API_KEY: process.env.RESEND_API_KEY, RESEND_FROM: process.env.RESEND_FROM };
  delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM;
  check('nothing is sent when Resend is not configured', mailer.ready() === false);
  if (off.RESEND_API_KEY) process.env.RESEND_API_KEY = off.RESEND_API_KEY;
  if (off.RESEND_FROM) process.env.RESEND_FROM = off.RESEND_FROM;
}

/* ---------------- pressing a button ---------------- */
const db = {
  kv: [],
  users: [{ id: 1, org_id: 1, email: 'boss@x.com', name: 'Boss', role: 'admin', is_active: true }],
  history: [], changes: []
};
function kvFind(org, key) { return db.kv.find(r => r.org_id === org && r.key === key && r.user_id === null); }
function kvSet(org, key, value) {
  const r = kvFind(org, key);
  if (r) { r.value = value; r.version = String(Number(r.version) + 1); }
  else db.kv.push({ org_id: org, user_id: null, key, value, version: '1' });
}
function query(sql, p) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  const rows = x => Promise.resolve({ rows: x, rowCount: x.length });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return rows([]);
  if (s.startsWith("SELECT value FROM kv WHERE org_id = $1 AND key = 'lockedMonths'")) {
    const r = kvFind(p[0], 'lockedMonths'); return rows(r ? [{ value: r.value }] : []);
  }
  if (s.startsWith('SELECT value FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL')) {
    const r = kvFind(p[0], p[1]); return rows(r ? [{ value: r.value }] : []);
  }
  if (s.startsWith('INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, $2, $3, NULL)')) {
    kvSet(p[0], p[1], p[2]); return rows([]);
  }
  if (s.startsWith('INSERT INTO change_log')) { db.changes.push(p); return rows([]); }
  if (s.startsWith('INSERT INTO history')) { db.history.push({ area: p[3], item: p[4] }); return rows([]); }
  if (s.startsWith('SELECT id FROM orgs')) return rows([{ id: 1 }]);
  throw new Error('fake db: unhandled SQL: ' + s.slice(0, 120));
}
const fakeClient = { query, release() {} };
class FakePool {
  query(sql, p) { return query(sql, p); }
  connect() { return Promise.resolve(fakeClient); }
  on() {}
}
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') return { Pool: FakePool };
  if (request === 'connect-pg-simple') {
    return function (session) { return class extends session.MemoryStore {}; };
  }
  return origLoad.apply(this, arguments);
};
process.env.SESSION_SECRET = SECRET;

(async function run() {
  const { app } = require(path.join(REPO, 'server.js'));
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const hit = async (method, url) => {
    const r = await fetch(base + url, { method, redirect: 'manual' });
    return { status: r.status, body: await r.text() };
  };

  kvSet(1, 'leaveRequests', JSON.stringify([
    { id: 'req_1', empName: 'Asha Test', dateFrom: '2026-09-25', dateTo: '2026-09-26', leaveType: 'CL',
      status: 'pending', message: 'Family', createdAt: '2026-09-22T05:00:00Z', updatedAt: '2026-09-22T05:00:00Z' },
    { id: 'req_2', empName: 'Ravi Test', dateFrom: '2026-09-25', dateTo: '2026-09-25', leaveType: 'Sick',
      status: 'approved', createdAt: '2026-09-20T05:00:00Z', updatedAt: '2026-09-21T05:00:00Z' }
  ]));
  kvSet(1, 'overrides', JSON.stringify({
    'Ravi Test|2026-09-18': { cat: 'LEAVE', detail: 'CL', reason: 'marked by hand' },
    'Asha Test|2026-09-26': { cat: 'VISIT', detail: 'Panipat' }          // already spoken for
  }));
  kvSet(1, 'lockedMonths', JSON.stringify({ '2026-08': true }));

  const tok = payload => mailer.actionToken(payload, SECRET);

  // --- the page a button opens ---
  const approveTok = tok({ k: 'req', org: 1, id: 'req_1', act: 'approve' });
  const shown = await hit('GET', '/e/' + approveTok);
  check('the link opens a page that asks first', shown.status === 200 && /<form method="POST"/.test(shown.body), shown.status);
  const reqsStill = JSON.parse(kvFind(1, 'leaveRequests').value);
  check('opening the link decides nothing', reqsStill[0].status === 'pending', reqsStill[0]);

  // --- approving ---
  const done = await hit('POST', '/e/' + approveTok);
  const reqs = JSON.parse(kvFind(1, 'leaveRequests').value);
  const ovs = JSON.parse(kvFind(1, 'overrides').value);
  check('pressing the button approves the request', done.status === 200 && reqs[0].status === 'approved', reqs[0]);
  check('the approval is marked as made by email', reqs[0].approvedBy === 'email', reqs[0]);
  check('the day is marked on the record, stamped with the request',
    ovs['Asha Test|2026-09-25'] && ovs['Asha Test|2026-09-25'].reqId === 'req_1', ovs);
  check('a day already carrying another mark is left alone',
    ovs['Asha Test|2026-09-26'].cat === 'VISIT', ovs);
  check('and the page says so', /already carried another mark/.test(done.body), done.body.slice(0, 300));

  // --- the same link a second time ---
  const again = await hit('POST', '/e/' + approveTok);
  check('the same link cannot decide twice', again.status === 409 && /Already decided/.test(again.body), again.status);

  // --- a decision on something already settled ---
  const settled = await hit('POST', '/e/' + tok({ k: 'req', org: 1, id: 'req_2', act: 'reject' }));
  check('a request decided in the dashboard is refused', settled.status === 409, settled.status);

  // --- leave taken without a request ---
  const unreqTok = tok({ k: 'unreq', org: 1, e: 'Ravi Test', d: '2026-09-18', t: 'CL', h: '', act: 'reject' });
  const rejected = await hit('POST', '/e/' + unreqTok);
  const ovs2 = JSON.parse(kvFind(1, 'overrides').value);
  const reqs2 = JSON.parse(kvFind(1, 'leaveRequests').value);
  check('rejecting leave nobody requested removes the day',
    rejected.status === 200 && !ovs2['Ravi Test|2026-09-18'], ovs2);
  check('and it is written down as rejected',
    reqs2.some(r => r.empName === 'Ravi Test' && r.dateFrom === '2026-09-18' && r.status === 'rejected'), reqs2);

  // --- a locked month is not touched ---
  kvSet(1, 'overrides', JSON.stringify({ 'Ravi Test|2026-08-10': { cat: 'LEAVE', detail: 'CL' } }));
  const locked = await hit('POST', '/e/' + tok({ k: 'unreq', org: 1, e: 'Ravi Test', d: '2026-08-10', t: 'CL', h: '', act: 'reject' }));
  const ovs3 = JSON.parse(kvFind(1, 'overrides').value);
  check('a locked month keeps its day', !!ovs3['Ravi Test|2026-08-10'] && /locked month/.test(locked.body), locked.body.slice(0, 300));

  // --- bad links ---
  const bad = await hit('POST', '/e/' + approveTok.slice(0, -3) + 'zzz');
  check('a tampered link does nothing', bad.status === 400 && /expired/.test(bad.body), bad.status);

  srv.close();
  const failed = results.filter(r => !r).length;
  console.log(failed ? ('FAILED (' + failed + ' of ' + results.length + ')') : ('ALL PASS (' + results.length + ')'));
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
