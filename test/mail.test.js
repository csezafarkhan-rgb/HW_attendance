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

/* ---------------- where a link points ---------------- */
{
  const keep = { r: process.env.RENDER_EXTERNAL_URL, a: process.env.APP_URL };
  const reread = () => { delete require.cache[require.resolve(path.join(REPO, 'mailer.js'))];
                         return require(path.join(REPO, 'mailer.js')).baseUrl(); };
  /* Render fills RENDER_EXTERNAL_URL in itself, with the onrender.com address
     it handed out. While that was read first, a site with a domain of its own
     could never use it: every Approve button and every "open the dashboard"
     went to the hosting address, and after a move, to the old host's. */
  process.env.RENDER_EXTERNAL_URL = 'https://hw-attendance-av4h.onrender.com';
  process.env.APP_URL = 'https://attendance.homeweavers.net';
  check('an address set on purpose beats the one the platform filled in',
    reread() === 'https://attendance.homeweavers.net', reread());
  delete process.env.APP_URL;
  check('and the platform’s own is still used when nothing was set',
    reread() === 'https://hw-attendance-av4h.onrender.com', reread());
  process.env.APP_URL = 'https://attendance.homeweavers.net/';
  check('a trailing slash does not become a double one in a link',
    reread() === 'https://attendance.homeweavers.net', reread());
  if (keep.r == null) delete process.env.RENDER_EXTERNAL_URL; else process.env.RENDER_EXTERNAL_URL = keep.r;
  if (keep.a == null) delete process.env.APP_URL; else process.env.APP_URL = keep.a;
  delete require.cache[require.resolve(path.join(REPO, 'mailer.js'))];
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
  check('the subject is the wording the message starts with', mail.subject === 'Attendance · Tue, 22 Sep', mail.subject);
  const cards = mailer.dailyEmail({
    orgName: 'Test Co', dateLabel: 'Tue, 22 Sep',
    rows: [
      { name: 'Asha Test', state: 'present', kind: 'present', label: 'Present' },
      { name: 'Ravi Test', state: 'remote', kind: 'wfh', label: 'From home' },
      { name: 'Priya Test', state: 'remote', kind: 'visit', label: 'Visit' }
    ],
    sections: { table: false }
  });
  check('work from home and a customer visit are counted apart, each with its names',
    /Work from home/.test(cards.html) && /Visiting/.test(cards.html)
      && !/From home \/ visiting/.test(cards.html)
      && /Ravi Test/.test(cards.html) && /Priya Test/.test(cards.html), cards.html.slice(0, 60));
  check('a kind nobody is on is left out', !/On leave/.test(cards.html));
  /* A late arrival is picked out on the card, so it is seen without reading
     the list below; an excused one is left plain. */
  const marked = mailer.dailyEmail({
    orgName: 'Test Co', dateLabel: 'Wed, 23 Sep 2026',
    rows: [{ name: 'Early One', state: 'present', kind: 'present', 'in': '9:16', inMin: 556 },
           { name: 'Late One', state: 'present', kind: 'present', 'in': '10:13', inMin: 613, late: 43 }],
    sections: { table: false }
  });
  check('a late arrival has its hour picked out, and says by how much after it',
    /Late One<span style="background:#FFF3C4[^>]*> \(10:13 AM\)<\/span><span[^>]*> - 43 min late<\/span>/
      .test(marked.html),
    (/Late One<span[\s\S]{0,220}/.exec(marked.html) || [])[0]);
  check('and an on-time arrival is left plain',
    /Early One<span style="color:#5B6675[^>]*> \(9:16 AM\)/.test(marked.html));
  check('the names on a card are numbered', /1_Asha Test/.test(cards.html) && /1_Ravi Test/.test(cards.html));
  check('dates read as the office writes them',
    mailer.fmtDay('2026-09-24') === '24 Sep’ 2026'
      && mailer.fmtDay('2026-09-24', true) === 'Thu, 24 Sep’ 2026'
      && mailer.dateRange('2026-09-24', '2026-09-26') === '24 Sep’ 2026 → 26 Sep’ 2026',
    mailer.fmtDay('2026-09-24', true));
  const timed = mailer.dailyEmail({
    orgName: 'Test Co', dateLabel: 'Tue, 22 Sep', sections: { table: false },
    rows: [{ name: 'Early Test', kind: 'present', 'in': '9:10', inMin: 550 },
           { name: 'Nopunch Test', kind: 'missing', 'in': '', inMin: null }]
  });
  check('a card shows when each of them came in',
    /1_Early Test<span[^>]*> \(9:10 AM\)/.test(timed.html) && /1_Nopunch Test</.test(timed.html), timed.html.slice(0, 60));
  const arrived = mailer.dailyEmail({
    orgName: 'Test Co', dateLabel: 'Tue, 22 Sep', sections: { table: false },
    rows: [
      { name: 'Later Test', kind: 'present', inMin: 620 },
      { name: 'Early Test', kind: 'present', inMin: 545 },
      { name: 'Nopunch Test', kind: 'present', inMin: null }
    ]
  });
  check('a card runs in the order people arrived, whoever has no time yet last',
    /1_Early Test[\s\S]*2_Later Test[\s\S]*3_Nopunch Test/.test(arrived.html));
  check('the cards sit on one line',
    (((cards.html.match(/<table[^>]*table-layout:fixed[^>]*>[\s\S]*?<\/table>/) || [''])[0]).match(/<tr>/g) || []).length === 1);
  const lists = mailer.dailyEmail({
    orgName: 'Test Co', dateLabel: 'Tue, 22 Sep', rows: [], sections: { table: false },
    wfh: [{ name: 'Ravi Test', detail: 'no start recorded yet' }],
    visits: [{ name: 'Priya Test', detail: 'Panipat · no start recorded yet' }]
  });
  const home = lists.html.slice(lists.html.indexOf('Working from home'), lists.html.indexOf('Visiting today'));
  check('somebody at a customer is not listed as working from home',
    home.indexOf('Priya Test') === -1 && home.indexOf('Ravi Test') > -1
      && /Visiting today[\s\S]*Priya Test/.test(lists.html));

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
  check('the leave message counts what needs a decision', /2 waiting for a decision/.test(leave.subject), leave.subject);
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
  if (s.startsWith('SELECT value, version FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL')) {
    const r = kvFind(p[0], p[1]); return rows(r ? [{ value: r.value, version: r.version }] : []);
  }
  if (s.startsWith('INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, $2, $3, $4)')) {
    kvSet(p[0], p[1], p[2]);
    return rows([{ version: kvFind(p[0], p[1]).version }]);
  }
  if (s.startsWith('SELECT value FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL')) {
    const r = kvFind(p[0], p[1]); return rows(r ? [{ value: r.value }] : []);
  }
  if (s.startsWith('INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, $2, $3, NULL)')) {
    kvSet(p[0], p[1], p[2]); return rows([]);
  }
  if (s.startsWith('INSERT INTO maintenance_done')) {
    db.jobs = db.jobs || {};
    if (db.jobs[p[0]]) return rows([]);
    db.jobs[p[0]] = true; return rows([{ job: p[0] }]);
  }
  if (s.startsWith('DELETE FROM maintenance_done')) { if (db.jobs) delete db.jobs[p[0]]; return rows([]); }
  if (s.startsWith('CREATE TABLE IF NOT EXISTS mail_log')) return rows([]);
  if (s.startsWith('CREATE INDEX IF NOT EXISTS mail_log_recent_idx')) return rows([]);
  if (s.startsWith('INSERT INTO mail_log')) {
    db.mailLog = (db.mailLog || []);
    db.mailLog.unshift({ id: db.mailLog.length + 1, at: new Date(), kind: p[1], subject: p[2],
                         recipients: p[3], cc: p[4], ok: p[5], detail: p[6], attached: p[7], html: p[8] });
    return rows([]);
  }
  if (s.startsWith('DELETE FROM mail_log')) return rows([]);
  if (s.startsWith('SELECT id, at, kind, subject, recipients, cc, ok, detail, attached FROM mail_log')) {
    return rows((db.mailLog || []).map(x => Object.assign({}, x, { html: undefined })));
  }
  if (s.startsWith('SELECT id, at, kind, subject, recipients, cc, ok, detail, attached, html FROM mail_log')) {
    const hit = (db.mailLog || []).find(x => x.id === p[1]);
    return rows(hit ? [hit] : []);
  }
  if (s.startsWith('CREATE TABLE IF NOT EXISTS mail_shots')) return rows([]);
  if (s.startsWith('INSERT INTO mail_shots')) { db.shots = (db.shots || []).concat([{ id: p[0], mime: p[1], data: p[2] }]); return rows([]); }
  if (s.startsWith('DELETE FROM mail_shots')) return rows([]);
  if (s.startsWith('SELECT mime, data FROM mail_shots')) {
    const hit = (db.shots || []).find(x => x.id === p[0]);
    return rows(hit ? [{ mime: hit.mime, data: hit.data }] : []);
  }
  if (s.startsWith('INSERT INTO change_log')) { db.changes.push(p); return rows([]); }
  if (s.startsWith('INSERT INTO history')) { db.history.push({ area: p[3], item: p[4] }); return rows([]); }
  if (s.startsWith('SELECT id FROM orgs')) return rows([{ id: 1 }]);
  if (s.startsWith('SELECT id, org_id, email, password_hash, name, role, is_active FROM users')) {
    return rows(db.users.filter(u => u.email === p[0]));
  }
  if (s.startsWith('SELECT id, org_id, email, name, password_hash, is_active FROM users WHERE id = $1 AND org_id = $2')) {
    return rows(db.users.filter(u => u.id === p[0] && u.org_id === p[1]));
  }
  if (s.startsWith('SELECT id, org_id, email, name, password_hash, is_active FROM users WHERE id = $1')) {
    return rows(db.users.filter(u => u.id === p[0]));
  }
  if (s.startsWith('SELECT id, org_id, email, name, password_hash FROM users')) {
    const want = String(p[0]).toLowerCase();
    return rows(db.users.filter(u => u.is_active && (String(u.email).toLowerCase() === want
      || String(u.email).split('@')[0].toLowerCase() === want
      || String(u.name || '').toLowerCase() === want)).slice(0, 1));
  }
  if (s.startsWith('INSERT INTO users (org_id, email, password_hash, name, role)')) {
    const made = { id: db.users.length + 20, org_id: p[0], email: p[1], password_hash: p[2],
                   name: p[3], role: p[4], is_active: true, last_login_at: null, created_at: new Date() };
    db.users.push(made);
    return rows([Object.assign({}, made)]);
  }
  if (s.startsWith('UPDATE users SET password_hash')) {
    const hit = db.users.find(u => u.id === p[1]);
    if (hit) hit.password_hash = p[0];
    return rows([]);
  }
  if (s.startsWith('DELETE FROM session')) return rows([]);
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
  /* Who looks at every leave request before a super admin grants it. Nobody is
     marked unless a test marks them, so leave is granted in one stage. */
  if (s.startsWith('SELECT id, email, name FROM users')) {
    return rows(db.users.filter(u => u.org_id === p[0] && u.is_active && u.leave_approver)
      .map(u => ({ id: u.id, email: u.email, name: u.name })));
  }
  if (s.startsWith('UPDATE users SET leave_approver')) {
    db.users.forEach(u => { if (u.org_id === p[1] || u.org_id === p[0]) u.leave_approver = (u.id === p[0]); });
    return rows([]);
  }
  /* The one account a session belongs to, which is how the gate works out
     whose press a button in an email is. It used to fall through to the
     catch-all below and come back with the admins, so the gate was being
     handed somebody it had not asked for - and passed only because one of
     them happened to be the approver. */
  if (s.startsWith('SELECT email, name FROM users WHERE id = $1')) {
    const hit = db.users.find(u => u.id === p[0] && u.org_id === p[1] && u.is_active);
    return rows(hit ? [{ email: hit.email, name: hit.name }] : []);
  }
  /* Every account of that name, not the first one found: the real query stopped
     taking the lowest id the day two accounts turned out to share a name and a
     man's leave went to his colleague. The stub hands back all of them so the
     refusal to guess can actually be exercised. */
  if (s.startsWith('SELECT id, email FROM users WHERE org_id = $1 AND is_active AND lower(COALESCE(name')) {
    const hits = db.users.filter(u => u.org_id === p[0] && u.is_active
      && String(u.name || '').toLowerCase() === String(p[1]).toLowerCase());
    return rows(hits.map(u => ({ id: u.id, email: u.email })));
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
  const { app, dailyEmailTick } = require(path.join(REPO, 'server.js'));
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
  /* Pressing a button in an email is now done BY somebody: the link says
     which request, the session says who, and only the people named against
     that person count. So these presses carry the admin's cookie, the way a
     real one carries whoever is signed in on the phone. Passing no cookie is
     the signed-out case, and is checked on its own below. */
  const hit = async (method, url, cookie) => {
    const send = cookie === null ? undefined : (cookie || adminCookie);
    const r = await fetch(base + url, {
      method, redirect: 'manual', headers: send ? { Cookie: send } : {} });
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

  // --- who may press it ---
  const approveTok = tok({ k: 'req', org: 1, id: 'req_1', act: 'approve' });
  {
    /* Signed out, the link decides nothing - it used to decide for whoever
       was holding it, which is how a copied-in reader could approve leave. */
    const out = await hit('GET', '/e/' + approveTok, null);
    check('a link pressed by nobody signed in is refused',
      out.status === 401 && /Sign in to decide this/.test(out.body), out.status);
    const outPost = await hit('POST', '/e/' + approveTok, null);
    check('and posting straight at it, without the page, is refused too',
      outPost.status === 401, outPost.status);
    /* Signed in, but not one of the people named against this person. */
    kvSet(1, 'approvalRoute', JSON.stringify({ 'Asha Test': ['someone-else@x.com'] }));
    const notMine = await hit('GET', '/e/' + approveTok);
    check('an account that is only copied in is refused',
      notMine.status === 403 && /not yours to decide/.test(notMine.body), notMine.status);
    check('and is told who it is actually with',
      /someone-else@x\.com/.test(notMine.body), null);
    const notMinePost = await hit('POST', '/e/' + approveTok);
    check('that refusal holds on the POST, which is the one that acts',
      notMinePost.status === 403, notMinePost.status);
    const still = JSON.parse(kvFind(1, 'leaveRequests').value).find(r => r.id === 'req_1');
    check('and the request is left exactly as it was',
      still.status === 'pending', still.status);
    kvSet(1, 'approvalRoute', JSON.stringify({}));
  }

  // --- the page a button opens ---
  const shown = await hit('GET', '/e/' + approveTok);
  check('the link opens a page that asks first', shown.status === 200 && /<form method="POST"/.test(shown.body), shown.status);
  const reqsStill = JSON.parse(kvFind(1, 'leaveRequests').value);
  check('opening the link decides nothing', reqsStill[0].status === 'pending', reqsStill[0]);

  // --- approving ---
  const done = await hit('POST', '/e/' + approveTok);
  const reqs = JSON.parse(kvFind(1, 'leaveRequests').value);
  const ovs = JSON.parse(kvFind(1, 'overrides').value);
  check('pressing the button approves the request', done.status === 200 && reqs[0].status === 'approved', reqs[0]);
  /* Who granted it, by name. It used to say the word 'email', because
     nothing on that path knew who had pressed the button - the link decided
     for whoever held it. The gate establishes that now, so a request three
     people could have answered says which of them did. */
  check('the approval is marked with the name of whoever granted it',
    reqs[0].approvedBy === 'Boss', reqs[0]);
  check('the day is marked on the record, stamped with the request',
    ovs['Asha Test|2026-09-25'] && ovs['Asha Test|2026-09-25'].reqId === 'req_1', ovs);
  check('a day already carrying another mark is left alone',
    ovs['Asha Test|2026-09-26'].cat === 'VISIT', ovs);
  check('and the page says so', /already carried another mark/.test(done.body), done.body.slice(0, 300));

  // --- the same link a second time ---
  const again = await hit('POST', '/e/' + approveTok);
  check('the same link cannot decide twice',
    again.status === 409 && /already settled/i.test(again.body), again.status);

  // --- a decision on something already settled ---
  const reopen = await hit('GET', '/e/' + tok({ k: 'req', org: 1, id: 'req_2', act: 'reject' }));
  check('a settled request does not even offer the button',
    reopen.status === 409 && /already settled/i.test(reopen.body) && !/<form method="POST"/.test(reopen.body),
    reopen.status);
  check('and it points at the panel for a change of mind',
    /attendance panel/i.test(reopen.body), reopen.body.slice(0, 400));
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

  /* Answered once, answered for good: the other button on the same message
     cannot turn a refusal into an approval. */
  const flip = await hit('POST', '/e/' + tok({ k: 'unreq', org: 1, e: 'Ravi Test', d: '2026-09-18', t: 'CL', h: '', act: 'approve' }));
  check('a day already answered cannot be answered the other way',
    flip.status === 409 && /already settled/i.test(flip.body), flip.status);
  check('and no second request is written for it',
    JSON.parse(kvFind(1, 'leaveRequests').value)
      .filter(r => r.empName === 'Ravi Test' && r.dateFrom === '2026-09-18').length === 1);

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
    /WFH/.test(withJpeg.html) && /Work from home/.test(withJpeg.html));


  /* ---- the whole month, as a workbook ---- */
  const fakeBook = 'UEsDBBQAAAAIAA' + 'A'.repeat(600);          // stands in for the .xlsx
  const monthPv = await asAdmin('POST', '/api/mail/month', {
    xlsx: fakeBook, fileName: 'Attendance_Grid_2026-09.xlsx',
    monthLabel: 'September 2026', slug: '2026-09', shown: 2, hidden: 1, days: 30, preview: true });
  check('the month message is built for looking at first',
    monthPv.status === 200 && /September 2026/.test(monthPv.body.preview.subject)
      && monthPv.body.file === true, monthPv.body && (monthPv.body.error || monthPv.body.preview));
  /* Two sends of the same month were the same message word for word, and Gmail
     hides a repeat behind a "..." - which is how one arrived looking as though
     it had no content at all. */
  check('the header says which month it is and when it went',
    /September 2026 · sent /.test(monthPv.body.preview.html), monthPv.body.preview.html.slice(0, 600));
  check('and it says what is in the file',
    /Attendance_Grid_2026-09\.xlsx/.test(monthPv.body.preview.html)
      && /how they did over the month/.test(monthPv.body.preview.html));
  check('with the month and the head-count stated',
    /September 2026/.test(monthPv.body.preview.html) && />2 of 3</.test(monthPv.body.preview.html)
      && />30</.test(monthPv.body.preview.html), monthPv.body.preview.html.slice(0, 200));
  const monthBefore = sent.length;
  const monthOut = await asAdmin('POST', '/api/mail/month', { send: 'preview' });
  const monthMail = sent[sent.length - 1];
  check('confirming sends it, carrying the workbook and nothing else',
    monthOut.status === 200 && sent.length === monthBefore + 1
      && (monthMail.attachments || []).length === 1
      && monthMail.attachments[0].filename === 'Attendance_Grid_2026-09.xlsx',
    monthMail && (monthMail.attachments || []).map(a => a.filename));
  /* A month is too wide to read as a picture; the workbook says it properly. */
  check('and no picture of the grid, inside the message or attached',
    !/<img/.test(monthMail.html) && !(monthMail.attachments || []).some(a => /\.(png|jpg)$/.test(a.filename)),
    monthMail && (monthMail.attachments || []).map(a => a.filename));
  /* The month has a tab of its own, as the other three do: its own people and
     its own words. */
  kvSet(1, 'mailSettings', JSON.stringify({
    to: ['office@x.com'], cc: ['office-cc@x.com'],
    month: { to: ['accounts@x.com'], cc: ['audit@x.com'],
             subject: 'The {month} record', intro: 'Hello accounts,', footer: 'Thanks.' }
  }));
  const own = await asAdmin('POST', '/api/mail/month', {
    xlsx: fakeBook, fileName: 'Attendance_Grid_2026-09.xlsx',
    monthLabel: 'September 2026', shown: 2, days: 30, preview: true });
  check('the month tab addresses its own message',
    own.status === 200 && JSON.stringify(own.body.to) === JSON.stringify(['accounts@x.com']),
    own.body && own.body.to);
  check('and words it in its own words',
    own.body.preview.subject === 'The September 2026 record'
      && /Hello accounts,/.test(own.body.preview.html) && /Thanks\./.test(own.body.preview.html),
    own.body.preview.subject);
  const ownBefore = sent.length;
  await asAdmin('POST', '/api/mail/month', { send: 'preview' });
  check('its Cc is its own too',
    sent.length === ownBefore + 1 && JSON.stringify(sent[sent.length - 1].cc) === JSON.stringify(['audit@x.com']),
    sent[sent.length - 1].cc);
  /* Left blank, it falls back like the rest. */
  kvSet(1, 'mailSettings', JSON.stringify({ to: ['office@x.com'], cc: [], month: { to: [], cc: [] } }));
  const fell = await asAdmin('POST', '/api/mail/month', {
    xlsx: fakeBook, fileName: 'x.xlsx', monthLabel: 'September 2026', shown: 2, days: 30, preview: true });
  check('an empty month tab goes where the attendance message goes',
    JSON.stringify(fell.body.to) === JSON.stringify(['office@x.com'])
      && /Attendance \u00b7 September 2026/.test(fell.body.preview.subject), fell.body.to);

  /* The panel shows the wording a message is built with, so it has to be told
     what that wording is. */
  const cfg = await asAdmin('GET', '/api/mail');
  check('the settings panel is given the built-in wording for every message',
    cfg.status === 200 && cfg.body.defaults && cfg.body.defaults.month
      && cfg.body.defaults.daily && cfg.body.defaults.leave && cfg.body.defaults.holiday
      && /\{month\}/.test(cfg.body.defaults.month.subject),
    cfg.body && Object.keys(cfg.body.defaults || {}));

  /* A workbook too large to send must not take the message with it. */
  const big = await asAdmin('POST', '/api/mail/month', {
    xlsx: 'A'.repeat(19 * 1024 * 1024), fileName: 'huge.xlsx',
    monthLabel: 'September 2026', shown: 2, days: 30, preview: true });
  check('a workbook too big to send is left out, and the message still goes',
    big.status === 200 && big.body.file === false && !/huge\.xlsx/.test(big.body.preview.html),
    big.body && big.body.file);

  /* The picture of a month's record runs to a megabyte or more. Parsed by the
     200kb limit the whole send came back 413 and the message went out bare. */
  const bigPng = 'iVBORw0KGgo' + 'A'.repeat(400 * 1024);
  const bigOut = await asAdmin('POST', '/api/mail/daily', { png: 'data:image/png;base64,' + bigPng });
  check('a megabyte of picture is accepted, not refused as too large',
    bigOut.status === 200 && sent[sent.length - 1].attachments
      && sent[sent.length - 1].attachments[0].content.length > 400 * 1024, bigOut.body);

  /* A message is looked at before it goes: the preview builds it and sends
     nothing, and the send that follows carries only the word. */
  const before = sent.length;
  const pv = await asAdmin('POST', '/api/mail/daily', { preview: true, png: 'data:image/png;base64,' + onePng });
  check('a preview builds the message without sending it',
    pv.status === 200 && sent.length === before && /Attendance/.test(pv.body.preview.subject)
      && /Asha Test/.test(pv.body.preview.html) && pv.body.attached === true, pv.body && pv.body.error);
  const confirmed = await asAdmin('POST', '/api/mail/daily', { send: 'preview' });
  check('confirming sends exactly what was shown',
    confirmed.status === 200 && sent.length === before + 1
      && sent[sent.length - 1].subject === pv.body.preview.subject
      && sent[sent.length - 1].attachments[0].content === onePng, confirmed.body);
  const twice = await asAdmin('POST', '/api/mail/daily', { send: 'preview' });
  check('the same preview cannot be sent twice', twice.status === 410, twice.body);

  /* ---- the slot somebody was on, in the message ----
     A shift is a list of runs now, each saying when it came into force, so that
     moving somebody does not rewrite months already closed. This message says
     who was late, and late is measured against the slot they were actually on.
     Read as though it were still a plain string, the whole late list came out
     empty - for everybody, every day - and nothing noticed, because an empty
     late list is exactly what a good day looks like. */
  {
    const was = kvFind(1, 'shiftAssignments');
    const htmlOf = r => (r.body && r.body.preview && r.body.preview.html) || '';
    /* Asha punched in at 9:33 and is on a 9:00 start, so she is 33 minutes late
       against a threshold of ten. */
    kvSet(1, 'shiftAssignments', JSON.stringify({
      'Asha Test': [{ from: '0000-01-01', shift: '9:00-6:00' }] }));
    const runs = await asAdmin('POST', '/api/mail/daily', { preview: true });
    check('somebody past their slot is marked late when shifts carry a history',
      /min late/.test(htmlOf(runs)) && /Asha Test/.test(htmlOf(runs)),
      htmlOf(runs) ? 'no "min late" in the message' : runs.body);
    check('and nothing in the message reads as an object',
      htmlOf(runs).indexOf('[object Object]') === -1);

    /* A store that has not been through the dashboard since still holds the old
       shape, and must go on working. */
    kvSet(1, 'shiftAssignments', JSON.stringify({ 'Asha Test': '9:00-6:00' }));
    const plain = await asAdmin('POST', '/api/mail/daily', { preview: true });
    check('a shift stored the old way still marks them late',
      /min late/.test(htmlOf(plain)), plain.body);

    /* And the run in force is the one for the day being reported, not whichever
       came last: a slot starting tomorrow says nothing about today. */
    kvSet(1, 'shiftAssignments', JSON.stringify({
      'Asha Test': [{ from: '0000-01-01', shift: '9:00-6:00' },
                    { from: '2099-01-01', shift: '11:00-8:00' }] }));
    const future = await asAdmin('POST', '/api/mail/daily', { preview: true });
    check('a slot that starts in the future is not used for today',
      /min late/.test(htmlOf(future)), future.body);

    kvSet(1, 'shiftAssignments', was ? was.value : JSON.stringify({}));
  }

  /* ---- a day entered by hand is a day at work ----
     Somebody who works where there is no card reader is entered by hand, every
     day. The message read the punch file and nothing else, so they came out
     under the card for people who have not arrived. That was tolerable while
     the card was called "No punch" - true of the file - and is not tolerable
     now it says they have not reached the office, which is false of the person. */
  {
    const wasOv = kvFind(1, 'overrides'), wasMan = kvFind(1, 'manualRecords');
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const htmlOf = r => (r.body && r.body.preview && r.body.preview.html) || '';
    /* Nothing standing in the way: Ravi has no punch and no override, so he is
       somebody who has not turned up. */
    kvSet(1, 'overrides', JSON.stringify({}));
    kvSet(1, 'manualRecords', JSON.stringify({}));
    const without = htmlOf(await asAdmin('POST', '/api/mail/daily', { preview: true }));
    /* The names inside the Present card, and only those. Comparing positions
       instead does not work: a card with nobody on it is left out altogether,
       so once the last missing person is accounted for there is no "Not Reached
       Office" heading to be before. */
    const presentNames = h => {
      const m = /Present<\/div><div[^>]*>([\s\S]*?)<\/div><\/div><\/td>/.exec(h);
      return m ? m[1] : '';
    };
    const inPresent = h => presentNames(h).indexOf('Ravi Test') > -1;
    check('with no punch and nothing entered, they have not reached the office',
      !inPresent(without), 'Ravi Test was counted present with nothing on file');

    kvSet(1, 'manualRecords', JSON.stringify({
      ['Ravi Test|' + today]: { 'in': '10:00', out: '-', st: 'PR' } }));
    const withMan = htmlOf(await asAdmin('POST', '/api/mail/daily', { preview: true }));
    check('a day entered by hand puts them with the people who are in',
      inPresent(withMan) && /10:00 AM/.test(withMan), 'not in the Present card');
    check('and they are no longer counted as not having reached the office',
      withMan.indexOf('Not Reached Office') === -1
        || presentNames(withMan).indexOf('Ravi Test') > -1, 'still under the missing card');
    /* "-" is how the day is written while somebody is still in. It is not an
       out time and must not be printed as one. */
    check('still being in is not printed as an out time of "-"',
      withMan.indexOf('>-<') === -1 && !/>\s*-\s*</.test(withMan));

    /* A real punch is the better record and must win. */
    kvSet(1, 'manualRecords', JSON.stringify({
      ['Asha Test|' + today]: { 'in': '7:00', out: '12:00', st: 'PR' } }));
    const punched = htmlOf(await asAdmin('POST', '/api/mail/daily', { preview: true }));
    check('a punch beats a figure entered by hand',
      /9:33 AM/.test(punched) && !/7:00 AM/.test(punched), 'the hand-typed time won');

    kvSet(1, 'overrides', wasOv ? wasOv.value : JSON.stringify({}));
    kvSet(1, 'manualRecords', wasMan ? wasMan.value : JSON.stringify({}));
  }

  /* The office writes its own message: who is copied, the subject, the words
     at the top and foot, and which parts of the message appear at all. */
  kvSet(1, 'mailSettings', JSON.stringify({
    to: ['boss@x.com'], cc: ['second@x.com'],
    subject: 'Register {date} · {missing} missing', intro: 'Today at a glance.',
    footer: 'Anything wrong, tell your manager.',
    sections: { tally: true, late: true, shifts: true, wfh: true, table: true, shot: true }
  }));
  const dressed = await asAdmin('POST', '/api/mail/daily',
    { inline: 'data:image/jpeg;base64,' + onePng, png: 'data:image/png;base64,' + onePng });
  const msg2 = sent[sent.length - 1];
  check('the subject is the one written on the portal, with the day filled in',
    /^Register /.test(msg2.subject) && /missing$/.test(msg2.subject), msg2.subject);
  check('the words at the top and foot are in the message',
    /Today at a glance/.test(msg2.html) && /tell your manager/.test(msg2.html));
  check('anyone copied is copied', (msg2.cc || []).indexOf('second@x.com') > -1, msg2.cc);
  const shot = /<img src="([^"]*\/shot\/[a-f0-9]{32}\.(png|jpg))"/.exec(msg2.html);
  check('the record is shown inside the message, not only attached', !!shot, msg2.html.slice(0, 80));
  if (shot) {
    const r = await realFetch(base + shot[1].replace(/^https?:\/\/[^/]+/, ''));
    check('and that picture is served to the mail client',
      r.status === 200 && (r.headers.get('content-type') || '').indexOf('image/') === 0, r.status);
  }
  const bare = JSON.parse(kvFind(1, 'mailSettings').value);
  bare.sections = { tally: false, late: false, shifts: false, wfh: false, table: true, shot: false };
  kvSet(1, 'mailSettings', JSON.stringify(bare));
  await asAdmin('POST', '/api/mail/daily', {});
  const trimmed = sent[sent.length - 1];
  check('a section switched off is left out',
    !/Late today/.test(trimmed.html) && !/<img src=/.test(trimmed.html) && /Asha Test/.test(trimmed.html));
  /* A word before a holiday, with its own settings and its own address list. */
  const soon = new Date(Date.now() + 5.5 * 3600 * 1000 + 2 * 86400000).toISOString().slice(0, 10);
  kvSet(1, 'officialLeaves', JSON.stringify({ [soon]: { name: 'Dussehra', note: 'Entire building closed' } }));
  kvSet(1, 'mailSettings', JSON.stringify({
    to: ['boss@x.com'],
    holiday: { on: true, days: 2, at: '00:01', to: ['second@x.com'],
               subject: 'Holiday · {name} · in {days} days',
               intro: 'Please plan your work.', footer: 'Best regards' }
  }));
  const holPv = await asAdmin('POST', '/api/mail/holiday', { preview: true });
  check('the holiday reminder names the holiday and how far off it is',
    holPv.status === 200 && /Dussehra/.test(holPv.body.preview.subject)
      && /in 2 days/.test(holPv.body.preview.subject)
      && /Entire building closed/.test(holPv.body.preview.html)
      && /Please plan your work/.test(holPv.body.preview.html), holPv.body && holPv.body.error);
  check('it goes to its own address', (holPv.body.to || []).indexOf('second@x.com') > -1, holPv.body.to);
  const holSent = await asAdmin('POST', '/api/mail/holiday', { send: 'preview' });
  check('and it sends', holSent.status === 200 && /Dussehra/.test(sent[sent.length - 1].subject), holSent.body);
  kvSet(1, 'officialLeaves', JSON.stringify({}));
  const none = await asAdmin('POST', '/api/mail/holiday', { preview: true });
  check('with no holiday on the calendar, nothing is built', none.body && none.body.nothing === true, none.body);

  /* ---- the word before a holiday has to survive a quiet day ----
     The tick asked for one date - exactly `days` off - and nothing else. The
     service sleeps when nobody is using it, so a holiday whose turn came up on
     a day nobody opened the dashboard had its only chance taken with it:
     Dussehra fell on a Monday, its word was due on the Sunday, and nothing went
     out at all. Looking across the window instead means a missed day is caught
     the next time the service wakes. */
  {
    const istDay = n => new Date(Date.now() + 5.5 * 3600 * 1000 + n * 86400000)
      .toISOString().slice(0, 10);
    const setHoliday = (n, name) => kvSet(1, 'officialLeaves',
      JSON.stringify({ [istDay(n)]: { name: name, note: '' } }));
    /* daily off, so the tick is only doing the holiday; `at` in the small hours
       so the time of day this runs at never decides the answer. */
    kvSet(1, 'mailSettings', JSON.stringify({ to: ['boss@x.com'], cc: [], daily: false,
      holiday: { on: true, days: 2, at: '00:01', to: ['team@x.com'], cc: [] } }));
    const tick = async () => { const n = sent.length; await dailyEmailTick(); return sent.length - n; };

    db.jobs = {}; setHoliday(2, 'Dussehra');
    const onTime = await tick();
    check('a holiday two days off is announced',
      onTime === 1 && /Dussehra/.test(sent[sent.length - 1].html), onTime);
    check('and not announced a second time', (await tick()) === 0);

    /* The day it was due passed with the service asleep. It is now one day off
       and nobody has been told. */
    db.jobs = {}; setHoliday(1, 'Dussehra');
    const late = await tick();
    check('a holiday whose day was missed is still announced, late',
      late === 1 && /Dussehra/.test(sent[sent.length - 1].html), late);

    /* Even on the morning of it: late is better than silent. */
    db.jobs = {}; setHoliday(0, 'Dussehra');
    check('and on the day itself, rather than not at all', (await tick()) === 1);

    /* One further off than the window waits its turn. */
    db.jobs = {}; setHoliday(5, 'Diwali');
    check('one further off than the window is left for later', (await tick()) === 0);

    /* Two inside the window each get their own word, not just the first. */
    db.jobs = {};
    kvSet(1, 'officialLeaves', JSON.stringify({
      [istDay(1)]: { name: 'Dussehra', note: '' }, [istDay(2)]: { name: 'Goverdhan', note: '' } }));
    const both = await tick();
    check('two inside the window are both announced', both === 2, both);

    /* Sent by hand, the tick must not say it again the next morning. */
    db.jobs = {}; setHoliday(2, 'Dussehra');
    const byHand = await asAdmin('POST', '/api/mail/holiday', {});
    check('a word sent by hand goes out', byHand.status === 200 && !byHand.body.nothing, byHand.body);
    check('and the tick does not repeat it', (await tick()) === 0);

    /* The same when it goes out from a preview, which is how it is normally
       sent - that route used to leave no mark at all. */
    db.jobs = {}; setHoliday(2, 'Dussehra');
    const pv = await asAdmin('POST', '/api/mail/holiday', { preview: true });
    const viaPv = await asAdmin('POST', '/api/mail/holiday', { send: 'preview' });
    check('a word sent from a preview goes out',
      pv.status === 200 && viaPv.status === 200, { pv: pv.body, sent: viaPv.body });
    check('and the tick does not repeat that either', (await tick()) === 0);

    db.jobs = {}; kvSet(1, 'officialLeaves', JSON.stringify({}));
  }

  kvSet(1, 'mailSettings', JSON.stringify({ to: [], cc: [] }));

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

  /* An archived request is off the Requests page, so it is not waiting for
     anybody and must not be counted as though it were. */
  const withArchived = JSON.parse(kvFind(1, 'leaveRequests').value);
  withArchived.push({ id: 'req_old', empName: 'Asha Test', dateFrom: '2026-08-14', dateTo: '2026-08-14',
                      leaveType: 'CL', status: 'pending', archived: '2026-08-20T05:00:00Z',
                      createdAt: '2026-08-12T05:00:00Z', updatedAt: '2026-08-12T05:00:00Z' });
  kvSet(1, 'leaveRequests', JSON.stringify(withArchived));
  const quiet = await asAdmin('POST', '/api/mail/leave', {});
  check('an archived request is not counted as waiting',
    quiet.body && quiet.body.nothing === true, quiet.body);

  // Everything raised above has been decided by now, so give it one to carry.
  const waiting = JSON.parse(kvFind(1, 'leaveRequests').value);
  waiting.push({ id: 'req_3', empName: 'Ravi Test', dateFrom: '2026-10-01', dateTo: '2026-10-01',
                 leaveType: 'CL', status: 'pending', createdAt: '2026-09-22T06:00:00Z', updatedAt: '2026-09-22T06:00:00Z' });
  kvSet(1, 'leaveRequests', JSON.stringify(waiting));
  const leaveOut = await asAdmin('POST', '/api/mail/leave', {});
  check('the leave message is separate, and carries its buttons',
    leaveOut.status === 200 && /waiting for a decision/.test(sent[sent.length - 1].subject), leaveOut.body);
  /* Once it is settled, the person who asked hears so, with the office copied. */
  db.users.push({ id: 7, org_id: 1, email: 'keshav@homeweavers.net', name: 'Keshav Garg',
                  role: 'employee', is_active: true });
  kvSet(1, 'mailSettings', JSON.stringify({ to: ['boss@x.com'], leave: { cc: ['support@x.com'], confirm: true } }));
  kvSet(1, 'leaveRequests', JSON.stringify([
    { id: 'req_k', empName: 'Keshav Garg', dateFrom: '2026-09-24', dateTo: '2026-09-24',
      leaveType: 'Sick', status: 'pending', createdAt: '2026-09-24T04:00:00Z', updatedAt: '2026-09-24T04:00:00Z' }
  ]));
  const decideTok = mailer.actionToken({ k: 'req', org: 1, id: 'req_k', act: 'approve' }, SECRET);
  const decidedBefore = sent.length;
  await realFetch(base + '/e/' + decideTok,
    { method: 'POST', headers: { Cookie: adminCookie } });
  await new Promise(r => setTimeout(r, 600));
  const told = sent[sent.length - 1];
  /* The answer is addressed exactly as the question was - the same TO, the
     same CC - so the two are a question and its answer in one thread rather
     than two notices that happen to be about the same day. */
  check('the employee is told when their leave is decided',
    sent.length === decidedBefore + 1
      && (told.to || []).concat(told.cc || []).indexOf('keshav@homeweavers.net') > -1
      && /approved/i.test(told.subject), told && { to: told.to, cc: told.cc, subject: told.subject });
  check('and the addresses saved on the Leave tab are copied',
    (told.cc || []).indexOf('support@x.com') > -1, told && told.cc);
  /* The people who were asked to decide it learn what became of it. They used
     to be left out: three are sent a request, one answers, and the other two
     are still holding a question that has been settled. */
  check('the people who were asked are told how it was answered',
    (told.to || []).indexOf('boss@x.com') > -1, told && told.to);
  check('and the person it is about reads it where they read the question',
    (told.cc || []).indexOf('keshav@homeweavers.net') > -1
    && (told.to || []).indexOf('keshav@homeweavers.net') === -1, [told.to, told.cc]);
  check('the message names the days it was about', /24 Sep’ 2026/.test(told.html));

  /* ---- who a message is addressed to ----
     The admins used to be written to whatever was typed on a tab, so naming
     one address on the Leave tab still sent it to every admin as well. */
  kvSet(1, 'mailSettings', JSON.stringify({
    to: ['office@x.com'], cc: [],
    leave: { to: ['support@homeweavers.net'], cc: ['support@homeweavers.net'] }
  }));
  const pending = JSON.parse(kvFind(1, 'leaveRequests').value);
  pending.push({ id: 'req_to', empName: 'Ravi Test', dateFrom: '2026-11-04', dateTo: '2026-11-04',
                 leaveType: 'CL', status: 'pending', createdAt: '2026-11-01T06:00:00Z',
                 updatedAt: '2026-11-01T06:00:00Z' });
  kvSet(1, 'leaveRequests', JSON.stringify(pending));
  const addressed = await asAdmin('POST', '/api/mail/leave', {});
  const onlyThem = sent[sent.length - 1];
  check('a tab that names its own address writes to that address alone',
    addressed.status === 200 && JSON.stringify(onlyThem.to) === JSON.stringify(['support@homeweavers.net']),
    onlyThem && onlyThem.to);
  check('and not to the admins as well',
    (onlyThem.to || []).indexOf('boss@x.com') === -1 && (onlyThem.to || []).indexOf('office@x.com') === -1,
    onlyThem && onlyThem.to);
  check('an address in both boxes is written to once, on the TO line',
    !(onlyThem.cc || []).length, onlyThem && onlyThem.cc);

  /* A tab left blank still means "the same as the attendance message". */
  kvSet(1, 'mailSettings', JSON.stringify({ to: ['office@x.com'], cc: [], leave: { to: [], cc: [] } }));
  const fellBack = JSON.parse(kvFind(1, 'leaveRequests').value);
  fellBack.push({ id: 'req_to2', empName: 'Ravi Test', dateFrom: '2026-11-05', dateTo: '2026-11-05',
                  leaveType: 'CL', status: 'pending', createdAt: '2026-11-01T06:00:00Z',
                  updatedAt: '2026-11-01T06:00:00Z' });
  kvSet(1, 'leaveRequests', JSON.stringify(fellBack));
  await asAdmin('POST', '/api/mail/leave', {});
  check('a tab with an empty TO box goes where the attendance message goes',
    JSON.stringify(sent[sent.length - 1].to) === JSON.stringify(['office@x.com']), sent[sent.length - 1].to);

  /* With nothing named anywhere it still has to reach somebody. */
  kvSet(1, 'mailSettings', JSON.stringify({ to: [], cc: [], leave: { to: [], cc: [] } }));
  const noneNamed = JSON.parse(kvFind(1, 'leaveRequests').value);
  noneNamed.push({ id: 'req_to3', empName: 'Ravi Test', dateFrom: '2026-11-06', dateTo: '2026-11-06',
                   leaveType: 'CL', status: 'pending', createdAt: '2026-11-01T06:00:00Z',
                   updatedAt: '2026-11-01T06:00:00Z' });
  kvSet(1, 'leaveRequests', JSON.stringify(noneNamed));
  await asAdmin('POST', '/api/mail/leave', {});
  check('with no box filled in anywhere it falls back to the admins',
    (sent[sent.length - 1].to || []).indexOf('boss@x.com') > -1, sent[sent.length - 1].to);

  /* ---- who a leave message is addressed to ----
     One rule: TO is everybody who may decide it, CC is everybody else, and a
     CC copy carries no buttons. Which means two messages for one request,
     because the difference between the two is the buttons, and a Cc line
     cannot take the buttons off a message somebody has already been handed.

     It replaced two stages - somebody looked first and passed it on, and a
     second word granted it. One word settles a request now, so the question
     is not when somebody is asked but whether they may answer. */
  {
    db.users.push({ id: 11, org_id: 1, email: 'karan@homeweavers.net', name: 'karan Ahuja',
                    role: 'employee', is_active: true });
    db.users.push({ id: 12, org_id: 1, email: 'munish@homeweavers.net', name: 'Munish Dhamija',
                    role: 'employee', is_active: true });
    db.users.push({ id: 13, org_id: 1, email: 'shyam@homeweavers.net', name: 'Shyam Lal',
                    role: 'employee', is_active: true });
    /* The arrangement the office works to: the Gurgaon office through Karan,
       the Panipat factory through Munish and Karan both, and the management
       named against nobody - so they decide only the rows nobody else is
       named against, which is what an empty row has always meant. */
    kvSet(1, 'mailSettings', JSON.stringify({ to: ['boss@x.com'], cc: [], requests: true,
      leave: { to: ['nitish@homeweavers.net', 'shivani@homeweavers.net'], cc: [] } }));
    kvSet(1, 'approvalRoute', JSON.stringify({
      'Keshav Garg': ['karan@homeweavers.net'],
      'Shyam Lal': ['munish@homeweavers.net', 'karan@homeweavers.net'],
      'karan Ahuja': [], 'Munish Dhamija': [] }));
    kvSet(1, 'overrides', '{}');
    kvSet(1, 'leaveRequests', JSON.stringify([]));

    const raise = async (id, who, day) => {
      const before = sent.length;
      const all = JSON.parse(kvFind(1, 'leaveRequests').value);
      all.push({ id, empName: who, dateFrom: day, dateTo: day, leaveType: 'CL',
                 status: 'pending', createdAt: '2026-11-01T05:00:00Z',
                 updatedAt: '2026-11-01T05:00:00Z' });
      await asAdmin('PUT', '/api/kv/leaveRequests', { value: JSON.stringify(all), shared: true });
      await new Promise(r => setTimeout(r, 700));
      return sent.slice(before);
    };
    /* The buttons are the authority, so looking for them is how a test asks
       which copy it is holding. */
    const decides = m => /Approve/.test(String(m.html || ''));
    const addrs = m => (m.to || []).slice().sort();

    let msgs = await raise('req_gur', 'Keshav Garg', '2026-11-12');
    const decide = msgs.find(decides), told = msgs.find(m => !decides(m));
    /* One message, buttons and all. It used to be two - the second stripped of
       its buttons - because the link decided for whoever held it. The gate
       reads the account now, so everybody can be sent the same thing. */
    check('a request is one message, to the people who may answer it',
      msgs.length === 1 && !!decide && !told, msgs.map(m => m.to));
    check('the approver named against that person may decide it',
      !!decide && JSON.stringify(addrs(decide)) === JSON.stringify(
        ['karan@homeweavers.net']),
      decide && decide.to);
    /* And an owner nobody named against them is not on it at all. They used
       to be on every leave message by standing; the office asked for the
       table to mean what it says instead. */
    check('and an owner nobody named against them is not on it',
      !!decide && addrs(decide).indexOf('nitish@homeweavers.net') === -1
      && (decide.cc || []).indexOf('nitish@homeweavers.net') === -1,
      [decide && decide.to, decide && decide.cc]);
    /* The person who asked is on it, on the Cc line, where the people who are
       only being told go. Being there decides nothing: the TO line is the
       list the gate checks, and they are never on it for their own leave. */
    check('and the person who asked is copied in, but not asked',
      !!decide && (decide.cc || []).indexOf('keshav@homeweavers.net') > -1
      && addrs(decide).indexOf('keshav@homeweavers.net') === -1,
      [decide && decide.to, decide && decide.cc]);

    /* Two approvers named against one person, because the office asked for
       the factory's manager and the office's both. */
    msgs = await raise('req_pan', 'Shyam Lal', '2026-11-13');
    const pan = msgs.find(decides);
    check('two approvers named against one person both get the deciding copy',
      !!pan && JSON.stringify(addrs(pan)) === JSON.stringify(
        ['karan@homeweavers.net', 'munish@homeweavers.net']),
      pan && pan.to);

    /* A manager asking for leave is asking, not granting. */
    msgs = await raise('req_mgr', 'karan Ahuja', '2026-11-14');
    const mgr = msgs.find(decides);
    check('a manager\u2019s own leave goes to the management and not to himself',
      !!mgr && JSON.stringify(addrs(mgr)) === JSON.stringify(
        ['nitish@homeweavers.net', 'shivani@homeweavers.net']), mgr && mgr.to);
    /* He is an approver, and this is his own leave, so he is on the Cc line
       like anybody else being told - and the gate will not take his press. */
    check('and he is told of it without being able to decide it',
      !!mgr && (mgr.cc || []).indexOf('karan@homeweavers.net') > -1
      && addrs(mgr).indexOf('karan@homeweavers.net') === -1,
      [mgr && mgr.to, mgr && mgr.cc]);

    /* Nobody named against them at all: the management, and that is all. */
    msgs = await raise('req_plain', 'Ravi Test', '2026-11-15');
    const plain = msgs.find(decides);
    check('somebody with nobody named against them goes to the management alone',
      !!plain && JSON.stringify(addrs(plain)) === JSON.stringify(
        ['nitish@homeweavers.net', 'shivani@homeweavers.net']), plain && plain.to);

    /* The office's standing copy list sits on the Cc line: being copied in is
       not a vote, and it is the TO line the gate weighs a press against. */
    kvSet(1, 'mailSettings', JSON.stringify({ to: ['boss@x.com'], cc: [], requests: true,
      leave: { to: ['nitish@homeweavers.net', 'shivani@homeweavers.net'], cc: ['watch@x.com'] } }));
    msgs = await raise('req_cc', 'Keshav Garg', '2026-11-16');
    const ccDecide = msgs.find(decides);
    check('an address in the Cc box is told, not asked',
      !!ccDecide && (ccDecide.cc || []).indexOf('watch@x.com') > -1,
      ccDecide && ccDecide.cc);
    check('and is not among the people who may decide',
      !!ccDecide && ccDecide.to.indexOf('watch@x.com') === -1, ccDecide && ccDecide.to);

    kvSet(1, 'leaveRequests', JSON.stringify([]));
  }

  /* ---- a password set from a link in an email ---- */
  const pwBefore = sent.length;
  const forgotten = await realFetch(base + '/api/forgot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'keshav@homeweavers.net' })
  });
  await new Promise(r => setTimeout(r, 400));
  const linkMail = sent[sent.length - 1];
  check('forgetting a password sends a link to that account',
    forgotten.status === 200 && sent.length === pwBefore + 1
      && (linkMail.to || [])[0] === 'keshav@homeweavers.net'
      && /Reset your password/.test(linkMail.subject), linkMail && linkMail.subject);
  const noSuch = await realFetch(base + '/api/forgot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@nowhere.test' })
  });
  await new Promise(r => setTimeout(r, 300));
  check('an address with no account is answered the same way, and written to nobody',
    noSuch.status === 200 && sent.length === pwBefore + 1, sent.length - pwBefore);

  const linkHref = (/href="([^"]*set-password[^"]*)"/.exec(linkMail.html) || [])[1] || '';
  const pwPath = linkHref.slice(linkHref.indexOf('/set-password/'));
  const pwAsks = await realFetch(base + pwPath).then(r => r.text());
  check('the link opens a page asking for the new password twice',
    /name="pw1"/.test(pwAsks) && /name="pw2"/.test(pwAsks) && /keshav@homeweavers.net/.test(pwAsks));
  const post = (path, body) => realFetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual'
  });
  const short = await post(pwPath, 'pw1=abc&pw2=abc');
  check('a short password is refused, with the page shown again',
    short.status === 400 && /at least 8/.test(await short.text()), short.status);
  const mismatch = await post(pwPath, 'pw1=longenough1&pw2=longenough2');
  check('two that do not match are refused', mismatch.status === 400
    && /did not match/.test(await mismatch.text()), mismatch.status);
  const set = await post(pwPath, 'pw1=a-fine-password&pw2=a-fine-password');
  check('a good one is saved', set.status === 200 && /Password saved/.test(await set.text()), set.status);
  const keshav = db.users.find(u => u.email === 'keshav@homeweavers.net');
  check('and it is the password on the account now',
    bcrypt.compareSync('a-fine-password', keshav.password_hash));
  const spent = await post(pwPath, 'pw1=another-password&pw2=another-password');
  check('the same link cannot set a second password',
    spent.status === 400 && /run out/.test(await spent.text()), spent.status);

  /* An account made with no password: they are written to, and the account
     cannot be signed into until they have chosen one. */
  const madeBefore = sent.length;
  const made = await asAdmin('POST', '/api/users',
    { email: 'newbie@homeweavers.net', password: '', name: 'New Bie', role: 'employee' });
  check('a user made with no password is emailed a link',
    made.status === 200 && made.body.invited === true && made.body.mailed === true
      && sent.length === madeBefore + 1 && /Set your password/.test(sent[sent.length - 1].subject),
    made.body);
  check('and the link says who it is for',
    /newbie@homeweavers.net/.test(sent[sent.length - 1].html));

  /* A refusal can carry a word of explanation, typed on the page the button
     opens - and the person who asked reads it. */
  kvSet(1, 'leaveRequests', JSON.stringify([
    { id: 'req_n', empName: 'Keshav Garg', dateFrom: '2026-10-05', dateTo: '2026-10-05',
      leaveType: 'CL', status: 'pending', createdAt: '2026-10-01T04:00:00Z', updatedAt: '2026-10-01T04:00:00Z' }
  ]));
  /* This one is about the box on the page and the words reaching the person
     who asked, not about who may open it, so the office decides here. */
  kvSet(1, 'mailSettings', JSON.stringify({ to: ['boss@x.com'], cc: [], requests: true,
    leave: { to: ['boss@x.com'], cc: [], confirm: true } }));
  kvSet(1, 'approvalRoute', JSON.stringify({}));
  const noteTok = mailer.actionToken({ k: 'req', org: 1, id: 'req_n', act: 'reject' }, SECRET);
  const asks = await realFetch(base + '/e/' + noteTok,
    { headers: { Cookie: adminCookie } }).then(r => r.text());
  check('the refusal page offers a box for a reason', /<textarea name="note"/.test(asks));
  const noteBefore = sent.length;
  await realFetch(base + '/e/' + noteTok, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: 'note=' + encodeURIComponent('We are short-handed that week')
  });
  await new Promise(r => setTimeout(r, 600));
  const stored = JSON.parse(kvFind(1, 'leaveRequests').value).filter(r => r.id === 'req_n')[0];
  check('what was typed is kept on the request', stored.adminNote === 'We are short-handed that week', stored);
  const withNote = sent[sent.length - 1];
  check('and the employee is told in those words',
    sent.length === noteBefore + 1 && /short-handed that week/.test(withNote.html), withNote && withNote.subject);

  /* A decision made on the portal says the same thing. */
  const portalBefore = sent.length;
  const withRefusal = JSON.parse(kvFind(1, 'leaveRequests').value);
  withRefusal.push({ id: 'req_k2', empName: 'Keshav Garg', dateFrom: '2026-09-26', dateTo: '2026-09-26',
               leaveType: 'CL', status: 'rejected', adminNote: 'Too short notice',
               createdAt: '2026-09-25T04:00:00Z', updatedAt: '2026-09-25T05:00:00Z' });
  await asAdmin('PUT', '/api/kv/leaveRequests', { value: JSON.stringify(withRefusal), shared: true });
  await new Promise(r => setTimeout(r, 600));
  const refused = sent[sent.length - 1];
  check('a decision made on the portal is told the same way',
    sent.length === portalBefore + 1
      && (refused.cc || []).indexOf('keshav@homeweavers.net') > -1
      && /not approved/i.test(refused.subject),
    refused && { to: refused.to, cc: refused.cc, subject: refused.subject });
  await asAdmin('PUT', '/api/kv/leaveRequests', { value: JSON.stringify(withRefusal), shared: true });
  await new Promise(r => setTimeout(r, 400));
  check('saving the same decision again tells nobody twice', sent.length === portalBefore + 1);

  /* ---- the digest, gathered by whoever may decide ----
     It went to the people who grant whatever the Leave tab said, carrying
     buttons that granted on days somebody else was supposed to see first.
     One message each now, holding what is theirs: if it is in your message,
     it is yours. */
  {
    kvSet(1, 'mailSettings', JSON.stringify({ to: ['boss@x.com'], unrequested: true, requests: true,
      leave: { to: ['nitish@homeweavers.net'], cc: [] } }));
    kvSet(1, 'approvalRoute', JSON.stringify({
      'Keshav Garg': ['karan@homeweavers.net'], 'Ravi Test': [] }));
    kvSet(1, 'leaveRequests', JSON.stringify([
      { id: 'dg_gur', empName: 'Keshav Garg', dateFrom: '2026-11-10', dateTo: '2026-11-10',
        leaveType: 'CL', status: 'pending',
        createdAt: '2026-11-01T06:00:00Z', updatedAt: '2026-11-01T06:00:00Z' },
      { id: 'dg_plain', empName: 'Ravi Test', dateFrom: '2026-11-11', dateTo: '2026-11-11',
        leaveType: 'CL', status: 'pending',
        createdAt: '2026-11-01T06:00:00Z', updatedAt: '2026-11-01T06:00:00Z' }
    ]));
    /* Dated from today rather than written down: "no request behind it" only
       looks back thirty days, and a date typed in drops out of that window as
       soon as the calendar moves past it. */
    const recently = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    kvSet(1, 'overrides', JSON.stringify({
      ['Keshav Garg|' + recently]: { cat: 'LEAVE', detail: 'CL', reason: 'family' } }));

    const before = sent.length;
    const out = await asAdmin('POST', '/api/mail/leave', {});
    const msgs = sent.slice(before);
    const toKaran = msgs.find(m => (m.to || []).indexOf('karan@homeweavers.net') > -1);
    const toMgmt = msgs.find(m => (m.to || []).indexOf('nitish@homeweavers.net') > -1);
    check('one message to each person who may decide something',
      out.status === 200 && msgs.length === 2 && !!toKaran && !!toMgmt, msgs.map(m => m.to));
    check('the manager gets his own people and nobody else\u2019s',
      !!toKaran && /Keshav Garg/.test(toKaran.html) && !/Ravi Test/.test(toKaran.html));
    /* The management used to be on everything. They are a column on the table
       now, so they get what they are named against - and the rows nobody is
       named against, which is what an empty row has always meant. */
    check('the management get the rows nobody else is named against',
      !!toMgmt && /Ravi Test/.test(toMgmt.html), toMgmt && toMgmt.to);
    check('and not the ones somebody else was named against',
      !!toMgmt && !/Keshav Garg/.test(toMgmt.html), toMgmt && toMgmt.to);
    check('including a day marked with no request behind it',
      !!toKaran && /no request/i.test(toKaran.html));
    /* A digest names several people, which is not theirs to read, so there is
       nobody to copy: it goes to the one person who may act on it. */
    check('and nobody is copied on a digest',
      msgs.every(m => !(m.cc || []).length), msgs.map(m => m.cc));
    kvSet(1, 'overrides', '{}');
    kvSet(1, 'leaveRequests', JSON.stringify([]));
  }

  /* A day marked as leave straight on the grid is the same news as a request,
     and goes out the same way - once. */
  kvSet(1, 'mailSettings', JSON.stringify({ to: ['boss@x.com'], unrequested: true }));
  kvSet(1, 'leaveRequests', JSON.stringify([]));
  kvSet(1, 'lockedMonths', JSON.stringify({}));   // the locked month above is done with
  const marksBefore = sent.length;
  const markOne = { 'Asha Test|2026-09-30': { cat: 'LEAVE', detail: 'CL', reason: 'family' } };
  await asAdmin('PUT', '/api/kv/overrides', { value: JSON.stringify(markOne), shared: true });
  await new Promise(r => setTimeout(r, 600));
  const marked = sent[sent.length - 1];
  check('a leave mark with no request behind it is emailed as it is made',
    sent.length === marksBefore + 1 && /Taken without a request/.test(marked.html)
      && /Asha Test/.test(marked.html), sent.length - marksBefore);
  check('and it carries its Approve and Reject buttons',
    /\/e\/[A-Za-z0-9_-]+\./.test(marked.html));
  await asAdmin('PUT', '/api/kv/overrides', {
    value: JSON.stringify(Object.assign({}, markOne, { 'Asha Test|2026-09-30': { cat: 'LEAVE', detail: 'CL', reason: 'family, updated' } })),
    shared: true });
  await new Promise(r => setTimeout(r, 400));
  check('editing the same day does not send it again', sent.length === marksBefore + 1, sent.length - marksBefore);
  /* Undo the mark and make it again: that is news a second time. */
  await asAdmin('PUT', '/api/kv/overrides', { value: JSON.stringify({}), shared: true });
  await new Promise(r => setTimeout(r, 400));
  await asAdmin('PUT', '/api/kv/overrides', { value: JSON.stringify(markOne), shared: true });
  await new Promise(r => setTimeout(r, 500));
  check('a day marked again after the mark was removed is sent again',
    sent.length === marksBefore + 2, sent.length - marksBefore);
  await asAdmin('PUT', '/api/kv/overrides', { value: JSON.stringify({}), shared: true });
  await new Promise(r => setTimeout(r, 300));

  const wfhOnly = { 'Ravi Test|2026-09-30': { cat: 'WFH' } };
  await asAdmin('PUT', '/api/kv/overrides', { value: JSON.stringify(wfhOnly), shared: true });
  await new Promise(r => setTimeout(r, 400));
  check('a day from home is not something to decide, so nothing is sent',
    sent.length === marksBefore + 2, sent.length - marksBefore);

  /* ---- a day marked with no request behind it ----
     The same news arriving by another door, so it is addressed the same way:
     everybody who may decide it, each able to act on their own copy. */
  {
    kvSet(1, 'mailSettings', JSON.stringify({ to: ['boss@x.com'], unrequested: true, requests: true,
      leave: { to: ['nitish@homeweavers.net'], cc: [] } }));
    /* One person with a manager named against them, and one with nobody. */
    kvSet(1, 'approvalRoute', JSON.stringify({ 'Keshav Garg': ['karan@homeweavers.net'],
                                               'Ravi Test': [] }));
    kvSet(1, 'leaveRequests', JSON.stringify([]));
    await asAdmin('PUT', '/api/kv/overrides', { value: JSON.stringify({}), shared: true });
    await new Promise(r => setTimeout(r, 350));

    const day = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const before = sent.length;
    await asAdmin('PUT', '/api/kv/overrides', {
      value: JSON.stringify({
        ['Keshav Garg|' + day]: { cat: 'LEAVE', detail: 'CL', reason: 'family' },
        ['Ravi Test|' + day]: { cat: 'LEAVE', detail: 'CL', reason: 'family' } }),
      shared: true });
    await new Promise(r => setTimeout(r, 800));
    const msgs = sent.slice(before);
    const toKaran = msgs.find(m => (m.to || []).indexOf('karan@homeweavers.net') > -1);
    const toMgmt = msgs.find(m => (m.to || []).indexOf('nitish@homeweavers.net') > -1);
    check('a day marked with no request reaches whoever may decide it',
      !!toKaran && !!toMgmt, msgs.map(m => m.to));
    check('each of them can act on their own copy',
      !!toKaran && /Approve/.test(toKaran.html) && /Approve/.test(toMgmt.html));
    /* And each of them gets their own, not each other's. */
    check('the manager gets the person named against him',
      !!toKaran && /Keshav Garg/.test(toKaran.html) && !/Ravi Test/.test(toKaran.html),
      toKaran && toKaran.to);
    check('and the management get the one nobody was named against',
      !!toMgmt && /Ravi Test/.test(toMgmt.html) && !/Keshav Garg/.test(toMgmt.html),
      toMgmt && toMgmt.to);

    await asAdmin('PUT', '/api/kv/overrides', { value: JSON.stringify({}), shared: true });
    kvSet(1, 'leaveRequests', JSON.stringify([]));
    await new Promise(r => setTimeout(r, 300));
  }


  /* --- a tab's own address list is the whole of it ---
     The Work tab named one address and the message still carried the people on
     the attendance Cc, because an empty Cc box fell back to the attendance
     settings whatever else the tab said. A tab that names its own TO is
     addressed; nothing is added to it. */
  {
    /* The day the server will ask for: today at +05:30, where the office is. */
    const istDay = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const written = {};
    written['Asha Test|' + istDay] = { items: ['Closed the October queries'] };
    kvSet(1, 'dailyTasks', JSON.stringify(written));
    kvSet(1, 'mailSettings', JSON.stringify({
      to: ['shivani@x.com', 'nitish@x.com', 'documents@x.com', 'dutt@x.com'],
      cc: ['watch@x.com'], daily: false,
      tasks: { on: false, to: ['support@x.com'], cc: [] }
    }));
    const before = sent.length;
    const built = await asAdmin('POST', '/api/mail/tasks', {});
    check('asking for the work log builds it and sends nothing',
      built.status === 200 && !!built.body.preview && sent.length === before,
      { status: built.status, sent: sent.length - before });
    check('and it says who it would go to, before it goes',
      JSON.stringify(built.body.to) === JSON.stringify(['support@x.com']), built.body.to);

    const went = await asAdmin('POST', '/api/mail/tasks', { send: 'preview' });
    const work = sent[sent.length - 1];
    check('pressing send sends the one that was shown',
      went.status === 200 && sent.length === before + 1, went.status);
    check('the work log goes only to the address saved on the Work tab',
      JSON.stringify(work.to) === JSON.stringify(['support@x.com']),
      work && { to: work.to, cc: work.cc });
    check('and carries nobody from the attendance tab, on the line or behind it',
      !(work.to || []).concat(work.cc || []).some(a => /shivani|nitish|documents|dutt|watch/.test(a))
        && (work.cc || []).length === 0,
      work && { to: work.to, cc: work.cc });

    /* An expired or already-used preview sends nothing: the word that sends is
       spent once, so a second press cannot send the message twice. */
    const twice = await asAdmin('POST', '/api/mail/tasks', { send: 'preview' });
    check('the same preview cannot be sent twice',
      twice.status === 410 && sent.length === before + 1, twice.status);

    /* Who the message names. The employees table carries whatever the punch
       machine has ever written down - a card called "500", somebody who has
       since resigned - and the work log was naming all of them and then
       reporting them for writing nothing. It lists the people the portal
       lists, which is what the attendance message has always done. */
    {
      db.employees.push({ name: '500' }, { name: 'Gone Person' });
      kvSet(1, 'mailSettings', JSON.stringify({
        to: ['boss@x.com'], cc: [], daily: false, tasks: { on: false, to: ['support@x.com'], cc: [] }
      }));
      const built = await asAdmin('POST', '/api/mail/tasks', {});
      const html = built.body && built.body.preview && built.body.preview.html;
      check('a card-punch entry is not reported for writing nothing',
        !!html && !/>500</.test(html) && !/ 500,/.test(html), (/Nothing written[^<]*/.exec(html || '') || [])[0]);
      check('nor is somebody the portal no longer shows',
        !!html && !/Gone Person/.test(html), (/Nothing written[^<]*/.exec(html || '') || [])[0]);
      check('and the people the portal does show are still named',
        !!html && /Ravi Test/.test(html), (/Nothing written[^<]*/.exec(html || '') || [])[0]);
      db.employees = db.employees.filter(e => e.name !== '500' && e.name !== 'Gone Person');
    }

    /* A tab that names nobody is the attendance message's audience - that is
       what the box says, and it is how the work log reached four people. */
    kvSet(1, 'mailSettings', JSON.stringify({
      to: ['shivani@x.com', 'nitish@x.com'], cc: ['watch@x.com'], daily: false,
      tasks: { on: false, to: [], cc: [] }
    }));
    await asAdmin('POST', '/api/mail/tasks', {});
    const fellBack = await asAdmin('POST', '/api/mail/tasks', { send: 'preview' });
    const inherited = sent[sent.length - 1];
    check('a Work tab naming nobody falls back to the attendance list, as the box says',
      fellBack.status === 200
        && JSON.stringify(inherited.to) === JSON.stringify(['shivani@x.com', 'nitish@x.com'])
        && JSON.stringify(inherited.cc) === JSON.stringify(['watch@x.com']),
      inherited && { to: inherited.to, cc: inherited.cc });
  }

  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM;

  /* What has been sent is kept, so the Backup tab can show it later. */
  const log = await asAdmin('GET', '/api/mail/log');
  check('every message that goes out is written down',
    log.status === 200 && log.body.sent.length > 0
      && log.body.sent.some(x => x.kind === 'attendance')
      && log.body.sent.some(x => x.kind === 'holiday'), (log.body.sent || []).map(x => x.kind));
  const one = log.body.sent[0];
  const opened = await asAdmin('GET', '/api/mail/log/' + one.id);
  check('and can be read back exactly as it was sent',
    opened.status === 200 && typeof opened.body.html === 'string' && opened.body.html.length > 100,
    opened.body && opened.body.error);
  check('a failure is written down too, with the reason',
    log.body.sent.every(x => typeof x.ok === 'boolean'));

  // --- bad links ---
  const bad = await hit('POST', '/e/' + approveTok.slice(0, -3) + 'zzz');
  check('a tampered link does nothing', bad.status === 400 && /expired/.test(bad.body), bad.status);

  /* ---- and the one rule the whole arrangement rests on ----

     Everybody in To can decide it; everybody in Cc is only told. The
     difference is the buttons, and a Cc line cannot take buttons off a
     message somebody has already been handed - so a copy that is only told
     is sent as its own message, with nothing on it to press.

     This sweeps every message this whole run sent, rather than the few each
     check looked at, because the fault would be one path out of a dozen
     getting it wrong and nobody noticing until somebody approved their own
     leave. */
  {
    /* The guarantee has not changed - the people who are only told cannot
       decide anything - but what makes it true has. It used to be that they
       were never handed a message with buttons on it. They are now, and the
       buttons do not work for them: the gate reads the account, not the link.

       What is still worth sweeping is the TO line, because that is the list
       the gate checks against. Nobody may be on it for their own leave. */
    const decides = m => /Approve<\/span>|>Approve</.test(String(m.html || ''));
    const clickable = sent.filter(decides);
    check('something that can be decided was in fact sent', clickable.length > 0,
      sent.length);
    const asked = ['keshav@homeweavers.net', 'rahul@homeweavers.net',
                   'ravi@homeweavers.net', 'quality@homeweavers.net', 'asha@x.com'];
    const inTo = clickable.filter(m =>
      (m.to || []).some(a => asked.indexOf(String(a).toLowerCase()) > -1));
    check('and no employee was ever in the TO of one, which is the list that counts',
      inTo.length === 0, inTo.map(m => m.to));
  }

  srv.close();
  const failed = results.filter(r => !r).length;
  console.log(failed ? ('FAILED (' + failed + ' of ' + results.length + ')') : ('ALL PASS (' + results.length + ')'));
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });

/* ---- nothing goes out on one press ----
   Every button on the Email menu builds its message and hands it back to be
   looked at; sending is a second press. Leave was the exception: a decision
   reached the first approver the instant somebody's finger landed, with nobody
   having read a word of it. */
{
  const srv = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  check('the leave button asks for a preview rather than a send',
    /post\('\/api\/mail\/leave', \{ preview: true \}/.test(app));
  check('and sends only from inside the preview window',
    /'\/api\/mail\/leave', \{ preview: true \}[\s\S]{0,400}showPreview\(j[\s\S]{0,400}send:'preview'/.test(app));
  check('the server builds it without sending when a preview is asked for',
    /if \(preview\) return \{ ok: true, mails: built\.mails \};/.test(srv));
  check('and holds every message behind that one press, not just the first',
    /keepPreview\(req\.session\.userId, \{ mails: r\.mails \}\)/.test(srv));
  /* It used to show the first message and name the rest. Naming a message is
     not reading it, and what the office is checking is what each person is
     about to be told - so the window pages through all of them. */
  check('the server hands back every message, not just the first',
    /const all = r\.mails\.map\(x => \(\{ subject: x\.subject, to: x\.to \|\| \[\], cc: x\.cc \|\| \[\],/
      .test(srv) && /messages: all\.length, mails: all/.test(srv));
  check('the window reads them all rather than counting them',
    /var mails = \(pv\.mails && pv\.mails\.length\) \? pv\.mails/.test(app)
    && /'Message ' \+ \(at \+ 1\) \+ ' of ' \+ mails\.length/.test(app));
  check('and one message is still one message, with no pager on it',
    /var many = mails\.length > 1;/.test(app)
    && /\? \('Send all ' \+ mails\.length\) : 'Send it'/.test(app));
  check('it names who is only being told as well as who is asked',
    /cc\.textContent = \(m\.cc && m\.cc\.length\) \? \('Cc ' \+ m\.cc\.join\(', '\)\) : '';/.test(app));
  check('pressing send posts the word alone, and what was read is what goes',
    /body\.send === 'preview'[\s\S]{0,400}for \(const msg of held\.mails\)/.test(srv));
  check('an expired preview is refused rather than rebuilt behind their back',
    /that preview has expired - open it again/.test(srv));
  /* The one button that is meant to send on the press is the test. */
  check('every other message button on the menu previews first',
    ['daily', 'month', 'holiday', 'tasks', 'leave'].every(k =>
      app.indexOf("'/api/mail/" + k + "'") > -1
      && /send:'preview'/.test(app.slice(app.indexOf("'/api/mail/" + k + "'"),
                                         app.indexOf("'/api/mail/" + k + "'") + 1400))));
}

/* ---- a word with the decision ----
   A refusal has always had a box: a reason the person who asked should hear.
   Approving had none, so a first approver's yes arrived as a bare name, and
   anything they knew about why it should go through - that the week is
   covered, that it was agreed in person - had to be said in a separate mail or
   not at all. */
{
  const m = require('../mailer.js');
  const srv = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const first = m.confirmPage({ action: 'approve', firstStage: true,
    summary: 'the request in the email', postTo: '/e/t' });
  const fin = m.confirmPage({ action: 'approve', firstStage: false, who: 'Keshav Garg',
    summary: 'x', postTo: '/e/t' });
  const rej = m.confirmPage({ action: 'reject', who: 'Keshav Garg', summary: 'x', postTo: '/e/t' });

  check('a first approver can say a word with their yes',
    /name="note"/.test(first) && /A word for the management with your approval/.test(first));
  check('and it is plainly optional',
    /\(optional\)/.test(first));
  check('the hint says the sort of thing that helps',
    /The week is covered/.test(first));
  /* Who reads it depends on which decision it is. */
  check('a final approver is writing to the person who asked',
    /A word for Keshav Garg with your approval/.test(fin));
  check('and a refusal still is too',
    /A word for Keshav Garg, if you want to give one/.test(rej));
  /* One word settles a request now, so a note on it is written to the person
     who asked - there is no stage after this one to pass it to. */
  check('the page knows a note has nowhere else to go',
    /firstStage: false,/.test(srv));
  /* The plumbing it lands in. */
  check('the word given with a decision is kept as the decision’s own',
    /if \(note\) req\.adminNote = note;/.test(srv));
  /* These pages are opened from an email, in whatever browser is to hand, and
     they never said what they were written in: "Approve · Attendance"
     arrived as "Approve Â· Attendance". */
  check('every page an email link opens says its own charset',
    [m.confirmPage({ action: 'approve', firstStage: true, summary: 'x', postTo: '#' }),
     m.resultPage('t', 'd', true),
     m.passwordPage({ kind: 'invite', link: 'https://x', name: 'A' })]
      .every(h => /<meta charset="utf-8">/.test(h)));
  check('an empty box decides it on its own, as before',
    /clip\(\(req\.body && req\.body\.note\) \|\| '', 500\)\.trim\(\)/.test(srv));
}

/* ---- what Outlook can draw ----
   Outlook renders mail with Word's engine. It ignores white-space:pre-line, so
   a signature typed on three lines arrived as one; it drops the margin on an
   inline-block, so two buttons came out welded together; and it recolours a
   link it has not been told about firmly enough, which turned a white label on
   a dark button purple. */
{
  const m = require('../mailer.js');
  const mail = m.requestEmail({
    orgName: 'x', heading: 'h',
    intro: 'Dear karan Ahuja,' + '\n\n' + 'A leave request is waiting.',
    footer: 'Best regards,' + '\n' + 'Zafar K.' + '\n' + 'Home Weavers Inc',
    req: { id: 'r1', empName: 'Keshav Garg', leaveType: 'CL', dateFrom: '2026-11-06',
           dateTo: '2026-11-06', message: 'urgent', createdAt: '2026-10-29T06:00:00Z' },
    links: { approve: 'https://x/a', reject: 'https://x/r' }, siteUrl: 'https://x/'
  });
  check('no message leans on white-space to break its lines',
    !/pre-line/.test(mail.html));
  check('the breaks somebody typed are written as tags',
    (mail.html.match(/<br>/g) || []).length >= 4, (mail.html.match(/<br>/g) || []).length);
  check('a button is a coloured cell, which Word paints, not a styled link',
    /<td bgcolor="#137A3B"[^>]*background:#137A3B/.test(mail.html));
  check('and carries its own padding for Word as well',
    /mso-padding-alt/.test(mail.html));
  check('the label says it is white inside the link as well as on it',
    /<a href="https:\/\/x\/a"[^>]*color:#ffffff[\s\S]{0,160}<span style="color:#ffffff/.test(mail.html));
  check('two buttons cannot weld together, because each is its own table',
    (mail.html.match(/<table role="presentation" border="0"/g) || []).length >= 2);
  check('every coloured area says so in an attribute, not only in a style',
    /bgcolor="#F3F6FB"/.test(mail.html) && /bgcolor="#ffffff"/.test(mail.html));
  check('and the message declares its own charset',
    /<meta charset="utf-8">/.test(mail.html));
}


