// Email: the signed buttons in a message, and what pressing one does to the
// record. The real server.js runs against an in-memory stand-in for Postgres.
'use strict';
const path = require('path');
const Module = require('module');
const REPO = path.resolve(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));
const bcrypt = require(path.join(REPO, 'node_modules', 'bcryptjs'));

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
  check('times carry am and pm', mailer.clock('9:33') === '9:33 AM' && mailer.clock('16:17') === '4:17 PM'
    && mailer.clock('12:04') === '12:04 PM' && mailer.clock('0:20') === '12:20 AM', mailer.clock('16:17'));
  const mail = mailer.dailyEmail({
    orgName: 'Test Co', dateLabel: 'Tue, 22 Sep',
    rows: [
      { name: 'Asha Test', 'in': '9:28', out: '18:31', state: 'present', label: 'Present' },
      { name: 'Ravi <b>Test</b>', 'in': '', out: '', state: 'missing', label: 'No punch' }
    ],
    hidden: 4, attached: true, siteUrl: 'https://x'
  });
  check('the subject counts who has no punch', /1 with no punch/.test(mail.subject), mail.subject);
  check('the daily message writes its times as am and pm',
    /9:28 AM/.test(mail.html) && /6:31 PM/.test(mail.html), mail.html.slice(0, 40));
  check('it says how many are hidden on the portal', /4 more on the roster are hidden/.test(mail.html));
  check('and that the record is attached', /attached as a picture/.test(mail.html));
  check('leave is not in the daily message', !/Waiting for a decision/.test(mail.html));
  check('a name with markup in it is escaped', /Ravi &lt;b&gt;Test&lt;\/b&gt;/.test(mail.html));

  const leave = mailer.leaveEmail({
    orgName: 'Test Co',
    pending: [{ req: { empName: 'Asha Test', leaveType: 'CL', dateFrom: '2026-09-25', dateTo: '2026-09-25', message: 'Family' },
                links: { approve: 'https://x/e/aaa', reject: 'https://x/e/bbb' } }],
    unrequested: [{ req: { empName: 'Ravi Test', leaveType: 'CL', dateFrom: '2026-09-18', dateTo: '2026-09-18' },
                    links: { approve: 'https://x/e/ccc', reject: 'https://x/e/ddd' } }],
    siteUrl: 'https://x'
  });
  check('the leave message counts what needs a decision', /2 need a decision/.test(leave.subject), leave.subject);
  check('every button is in it', ['aaa', 'bbb', 'ccc', 'ddd'].every(t => leave.html.indexOf('https://x/e/' + t) > -1));
  check('nothing waiting means no leave message',
    mailer.leaveEmail({ orgName: 'Test Co', pending: [], unrequested: [] }) === null);
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
  users: [{ id: 1, org_id: 1, email: 'boss@x.com', name: 'Boss', role: 'admin', is_active: true,
             password_hash: bcrypt.hashSync('password123', 4) }],
  employees: [{ name: 'Asha Test' }, { name: 'Ravi Test' }, { name: 'Hidden Person' }],
  records: [{ employee: 'Asha Test', data: { 'in': '9:33', out: '16:17', st: 'PR' } }],
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
  const literal = /^SELECT value FROM kv WHERE org_id = \$1 AND key = '([a-zA-Z]+)'/.exec(s);
  if (literal) { const r = kvFind(p[0], literal[1]); return rows(r ? [{ value: r.value }] : []); }
  if (s.startsWith('SELECT key, value FROM kv WHERE org_id = $1 AND user_id IS NULL AND key = ANY($2)')) {
    return rows(db.kv.filter(x => x.org_id === p[0] && x.user_id === null && p[1].indexOf(x.key) > -1)
                  .map(x => ({ key: x.key, value: x.value })));
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
  if (s.startsWith('SELECT id, org_id, email, password_hash, name, role, is_active FROM users')) {
    return rows(db.users.filter(u => u.email === p[0]));
  }
  if (s.startsWith('UPDATE users SET last_login_at')) return rows([]);
  if (s.startsWith('SELECT totp_enabled, totp_secret')) return rows([{ totp_enabled: false }]);
  if (s.startsWith('SELECT role, is_active, org_id, name, email FROM users WHERE id = $1')) {
    return rows(db.users.filter(u => u.id === p[0])
      .map(u => ({ role: u.role, is_active: u.is_active, org_id: u.org_id, name: u.name, email: u.email })));
  }
  if (s.startsWith('SELECT name FROM employees')) return rows(db.employees.slice());
  if (s.startsWith('SELECT employee, data FROM records')) return rows(db.records.slice());
  if (s.startsWith('SELECT kv.value FROM kv JOIN users u')) {
    const r = db.kv.find(x => x.key === 'visibleEmployees' && x.user_id === 1);
    return rows(r ? [{ value: r.value }] : []);
  }
  if (s.startsWith('SELECT email FROM users')) {
    return rows(db.users.filter(u => u.org_id === p[0] && u.is_active && u.role === 'admin').map(u => ({ email: u.email })));
  }
  if (s.startsWith('SELECT value FROM kv WHERE org_id = $1 AND key = $2 AND user_id = $3')) {
    const r = db.kv.find(x => x.key === p[1] && x.user_id === p[2]);
    return rows(r ? [{ value: r.value }] : []);
  }
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
  let adminCookie = '';
  {
    const r = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'boss@x.com', password: 'password123' })
    });
    adminCookie = String(r.headers.get('set-cookie') || '').split(';')[0];
  }
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

  // --- what the dashboard's Email button sends ---
  db.kv.push({ org_id: 1, user_id: 1, key: 'visibleEmployees', version: '1',
               value: JSON.stringify({ 'Asha Test': true, 'Ravi Test': true, 'Hidden Person': false }) });
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'Attendance <a@b.test>';
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = function (url, opts) {
    if (String(url).indexOf('api.resend.com') > -1) {
      sent.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'mail_1' }) });
    }
    return realFetch(url, opts);
  };
  const asAdmin = async (method, url, body) => {
    const r = await realFetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const onePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const dayOut = await asAdmin('POST', '/api/mail/daily', { png: 'data:image/png;base64,' + onePng });
  const daily = sent[sent.length - 1];
  check('the daily message goes out', dayOut.status === 200 && !!daily, dayOut);
  check('only the employees shown on the portal are in it',
    daily && /Asha Test/.test(daily.html) && /Ravi Test/.test(daily.html) && !/Hidden Person/.test(daily.html));
  check('with their times as am and pm', daily && /9:33 AM/.test(daily.html) && /4:17 PM/.test(daily.html));
  check('and the screenshot attached',
    daily && daily.attachments && daily.attachments.length === 1 && daily.attachments[0].content === onePng, daily && daily.attachments);
  /* A day worked from home has no punches: the times say so rather than
     showing two dashes. */
  const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const ovNow = JSON.parse(kvFind(1, 'overrides').value);
  ovNow['Ravi Test|' + todayIst] = { cat: 'WFH' };
  kvSet(1, 'overrides', JSON.stringify(ovNow));
  const jpegOut = await asAdmin('POST', '/api/mail/daily',
    { png: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==' });
  const withJpeg = sent[sent.length - 1];
  check('a JPEG is attached as a JPEG',
    jpegOut.status === 200 && withJpeg.attachments[0].filename.slice(-4) === '.jpg', withJpeg.attachments);
  check('a day from home reads WFH in the times, not dashes',
    /WFH/.test(withJpeg.html) && /From home/.test(withJpeg.html));

  const pickOut = await asAdmin('POST', '/api/mail/daily', { names: ['Ravi Test'] });
  const picked = sent[sent.length - 1];
  check('a message can name the employees itself',
    pickOut.status === 200 && !/Asha Test/.test(picked.html) && /Ravi Test/.test(picked.html));
  const testOut = await asAdmin('POST', '/api/mail/test', {});
  check('a test message goes to whoever pressed the button',
    testOut.status === 200 && sent[sent.length - 1].to[0] === 'boss@x.com', testOut.body);

  /* An account can sign in by name, so what is stored as its email is not
     always an address - Resend answered such a send with "Invalid `to` field". */
  db.users.push({ id: 2, org_id: 1, email: 'zafar@example.com', name: 'Z', role: 'admin', is_active: true });
  db.users[0].email = 'Boss';
  const oddOut = await asAdmin('POST', '/api/mail/test', {});
  check('an account whose email is not an address falls back to one that is',
    oddOut.status === 200 && sent[sent.length - 1].to[0] === 'zafar@example.com', oddOut.body);
  check('and nothing invalid is ever handed to Resend',
    sent.every(m => m.to.every(a => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a))), sent.map(m => m.to));
  db.users[0].email = 'boss@x.com';
  db.users.pop();

  // Everything raised above has been decided by now, so give it one to carry.
  const waiting = JSON.parse(kvFind(1, 'leaveRequests').value);
  waiting.push({ id: 'req_3', empName: 'Ravi Test', dateFrom: '2026-10-01', dateTo: '2026-10-01',
                 leaveType: 'CL', status: 'pending', createdAt: '2026-09-22T06:00:00Z', updatedAt: '2026-09-22T06:00:00Z' });
  kvSet(1, 'leaveRequests', JSON.stringify(waiting));
  const leaveOut = await asAdmin('POST', '/api/mail/leave', {});
  check('the leave message is separate, and carries its buttons',
    leaveOut.status === 200 && /need/.test(sent[sent.length - 1].subject), leaveOut.body);
  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM;

  // --- bad links ---
  const bad = await hit('POST', '/e/' + approveTok.slice(0, -3) + 'zzz');
  check('a tampered link does nothing', bad.status === 400 && /expired/.test(bad.body), bad.status);

  srv.close();
  const failed = results.filter(r => !r).length;
  console.log(failed ? ('FAILED (' + failed + ' of ' + results.length + ')') : ('ALL PASS (' + results.length + ')'));
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
