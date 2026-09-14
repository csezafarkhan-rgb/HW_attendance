// Run the real server.js against an in-memory stand-in for Postgres and the
// session store, and check the access rules end to end over HTTP.
'use strict';
const path = require('path');
const Module = require('module');
const REPO = path.resolve(__dirname, '..');
const rq = m => require(path.join(REPO, 'node_modules', m));
const bcrypt = rq('bcryptjs');
const expressSession = rq('express-session');

// ---------------- fake database ----------------
const db = {
  users: [
    { id: 1, org_id: 1, email: 'boss@x.com', name: 'Boss', role: 'admin', is_active: true },
    { id: 2, org_id: 1, email: 'second@x.com', name: 'Second', role: 'admin', is_active: true },
    { id: 3, org_id: 1, email: 'asha@x.com', name: 'Asha Test', role: 'employee', is_active: true },
    { id: 4, org_id: 1, email: 'ravi@x.com', name: 'Ravi Test', role: 'employee', is_active: true }
  ],
  kv: [],         // {org_id, user_id, key, value}
  records: []     // {org, e, d, data}
};
db.users.forEach(u => { u.password_hash = bcrypt.hashSync('password123', 4); });
let store = null;

function kvFind(org, key, user) { return db.kv.find(r => r.org_id === org && r.key === key && r.user_id === user); }
function query(sql, p) {
  const s = sql.replace(/\s+/g, ' ').trim();
  const rows = x => Promise.resolve({ rows: x, rowCount: x.length });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return rows([]);
  if (s.startsWith('SELECT role, is_active, org_id, name FROM users WHERE id = $1')) {
    return rows(db.users.filter(u => u.id === p[0]).map(u => ({ role: u.role, is_active: u.is_active, org_id: u.org_id, name: u.name })));
  }
  if (s.startsWith('SELECT id, org_id, email, password_hash, name, role, is_active FROM users WHERE lower(email) = $1')) {
    return rows(db.users.filter(u => u.email === p[0] || u.email.split('@')[0] === p[0]));
  }
  if (s.startsWith('UPDATE users SET last_login_at')) return rows([]);
  if (s.startsWith('SELECT password_hash FROM users WHERE id = $1')) return rows(db.users.filter(u => u.id === p[0]));
  if (s.startsWith('UPDATE users SET password_hash = $1 WHERE id = $2')) { db.users.find(u => u.id === p[1]).password_hash = p[0]; return rows([]); }
  if (s.startsWith('SELECT id, role, is_active FROM users WHERE id = $1 AND org_id = $2')) return rows(db.users.filter(u => u.id === p[0] && u.org_id === p[1]));
  if (s.startsWith("SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'admin'")) {
    return rows([{ n: db.users.filter(u => u.org_id === p[0] && u.role === 'admin' && u.is_active).length }]);
  }
  if (s.startsWith('UPDATE users SET ')) {
    const sets = s.slice('UPDATE users SET '.length, s.indexOf(' WHERE')).split(', ');
    const id = p[p.length - 2], u = db.users.find(x => x.id === id);
    sets.forEach(a => { const m = /^(\w+) = \$(\d+)$/.exec(a); u[m[1]] = p[+m[2] - 1]; });
    return rows([u]);
  }
  if (s.startsWith("DELETE FROM session WHERE (sess->>'userId') = $1 AND sid <> $2")) {
    let n = 0;
    Object.keys(store.sessions).forEach(sid => {
      const sess = JSON.parse(store.sessions[sid]);
      if (String(sess.userId) === p[0] && sid !== p[1]) { delete store.sessions[sid]; n++; }
    });
    return rows(new Array(n).fill({}));
  }
  if (s.startsWith('SELECT key, value FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL')) {
    const r = kvFind(p[0], p[1], null); return rows(r ? [{ key: r.key, value: r.value }] : []);
  }
  if (s.startsWith('SELECT value FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL FOR UPDATE')) {
    const r = kvFind(p[0], p[1], null); return rows(r ? [{ value: r.value }] : []);
  }
  if (s.startsWith("SELECT value FROM kv WHERE org_id = $1 AND key = 'leaveRequests' AND user_id IS NULL")) {
    const r = kvFind(p[0], 'leaveRequests', null); return rows(r ? [{ value: r.value }] : []);
  }
  if (s.startsWith('SELECT key, value FROM kv WHERE org_id = $1 AND key = $2 AND user_id = $3')) {
    const r = kvFind(p[0], p[1], p[2]); return rows(r ? [{ key: r.key, value: r.value }] : []);
  }
  if (s.startsWith('INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL')) {
    const r = kvFind(p[0], p[1], null); if (r) r.value = p[2]; else db.kv.push({ org_id: p[0], user_id: null, key: p[1], value: p[2] });
    return rows([]);
  }
  if (s.startsWith('INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1,$2')) {
    const r = kvFind(p[0], p[2], p[1]); if (r) r.value = p[3]; else db.kv.push({ org_id: p[0], user_id: p[1], key: p[2], value: p[3] });
    return rows([]);
  }
  if (s.startsWith('INSERT INTO change_log')) return rows([]);
  if (s.startsWith('INSERT INTO employees')) return rows([]);
  if (s.startsWith('INSERT INTO records')) {
    const r = db.records.find(x => x.org === p[0] && x.e === p[1] && x.d === p[2]);
    if (r) r.data = p[3]; else db.records.push({ org: p[0], e: p[1], d: p[2], data: p[3] });
    return rows([]);
  }
  if (s.startsWith('DELETE FROM records WHERE org_id = $1')) { db.records = db.records.filter(x => x.org !== p[0]); return rows([]); }
  if (s.startsWith('SELECT key FROM kv WHERE org_id = $1 AND user_id IS NULL AND key LIKE $2')) {
    return rows(db.kv.filter(r => r.org_id === p[0] && r.user_id === null && r.key.startsWith(p[1].slice(0, -1))).map(r => ({ key: r.key })));
  }
  if (s.startsWith('SELECT key, value, (user_id IS NULL) AS shared FROM kv')) {
    return rows(db.kv.filter(r => r.org_id === p[0] && (r.user_id === null || r.user_id === p[1]))
      .sort((a, b) => (a.user_id === null ? 0 : 1) - (b.user_id === null ? 0 : 1))
      .map(r => ({ key: r.key, value: r.value, shared: r.user_id === null })));
  }
  return Promise.reject(new Error('fake db: unhandled SQL: ' + s.slice(0, 120)));
}
class FakePool {
  constructor() {}
  query(sql, p) { return query(sql, p || []); }
  connect() { return Promise.resolve({ query: (sql, p) => query(sql, p || []), release() {} }); }
  on() {}
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return { Pool: FakePool };
  if (request === 'connect-pg-simple') {
    return function (session) {
      return class extends session.MemoryStore { constructor() { super(); store = this; } };
    };
  }
  return origLoad.apply(this, arguments);
};

// ---------------- http helpers ----------------
function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method, headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, body: json, cookie };
  };
}
let base = '';
const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

(async function main() {
  process.chdir(REPO);
  const { app } = require(path.join(REPO, 'server.js'));
  const srv = app.listen(0); await new Promise(r => srv.once('listening', r));
  base = 'http://127.0.0.1:' + srv.address().port;

  const boss = client(), second = client(), asha = client(), ashaPhone = client(), ravi = client();
  for (const [c, e] of [[boss, 'boss@x.com'], [second, 'second@x.com'], [asha, 'asha@x.com'], [ashaPhone, 'asha@x.com'], [ravi, 'ravi@x.com']]) {
    const r = await c('POST', '/api/login', { email: e, password: 'password123', remember: true });
    if (r.status !== 200) throw new Error('login failed for ' + e + ': ' + JSON.stringify(r));
  }

  // admin seeds shared data
  const reqs = [
    { id: 'req_a1', empName: 'Asha Test', dateFrom: '2026-09-10', dateTo: '2026-09-10', leaveType: 'CL', status: 'approved', approvedBy: 'Boss@x.com' },
    { id: 'req_a2', empName: 'Asha Test', dateFrom: '2026-09-20', dateTo: '2026-09-20', leaveType: 'Sick', status: 'query', adminNote: 'Why?' },
    { id: 'req_r1', empName: 'Ravi Test', dateFrom: '2026-09-11', dateTo: '2026-09-11', leaveType: 'CL', status: 'pending' }
  ];
  const seed = {
    leaveRequests: reqs,
    salaries: { 'Asha Test': 30000, 'Ravi Test': 45000 },
    overrides: { 'Asha Test|2026-09-10': { cat: 'LEAVE' }, 'Ravi Test|2026-09-11': { cat: 'LEAVE', reason: 'private' } },
    joinDates: { 'Asha Test': '2026-01-01', 'Ravi Test': '2026-02-01' },
    signatures: { 'boss@x.com': { data: 'sigA' }, 'second@x.com': { data: 'sigB' } },
    officialLeaves: { '2026-10-02': 'Gandhi Jayanti' },
    authAccounts: { admin: { username: 'old', password: 'plain' } }
  };
  for (const k of Object.keys(seed)) {
    const r = await boss('PUT', '/api/kv/' + k, { value: JSON.stringify(seed[k]), shared: true });
    if (r.status !== 200) throw new Error('seed ' + k + ' ' + JSON.stringify(r));
  }

  // --- employee reads ---
  const all = (await asha('GET', '/api/kv-all')).body.values;
  check('employee kv-all hides salaries, authAccounts', !('salaries' in all) && !('authAccounts' in all), Object.keys(all));
  check('employee sees only own overrides', JSON.stringify(Object.keys(JSON.parse(all.overrides))) === '["Asha Test|2026-09-10"]', all.overrides);
  check('employee sees only own requests', JSON.parse(all.leaveRequests).map(r => r.id).join() === 'req_a1,req_a2', all.leaveRequests);
  check('employee sees only own join date', all.joinDates === '{"Asha Test":"2026-01-01"}', all.joinDates);
  check('employee gets signature of own approver only', all.signatures === '{"boss@x.com":{"data":"sigA"}}', all.signatures);
  check('employee sees holidays', all.officialLeaves === JSON.stringify(seed.officialLeaves), all.officialLeaves);
  check('employee GET salaries -> null', (await asha('GET', '/api/kv/salaries?shared=true')).body === null);
  const sg = (await asha('GET', '/api/kv/signatures?shared=true')).body;
  check('employee GET signatures filtered', sg && sg.value === '{"boss@x.com":{"data":"sigA"}}', sg);
  const ls = (await asha('GET', '/api/kv?prefix=&shared=true')).body.keys;
  check('employee key list filtered', ls.indexOf('salaries') === -1 && ls.indexOf('authAccounts') === -1 && ls.indexOf('overrides') > -1, ls);
  const bossAll = (await boss('GET', '/api/kv-all')).body.values;
  check('admin still sees everything', 'salaries' in bossAll && JSON.parse(bossAll.leaveRequests).length === 3);

  // --- employee writes requests ---
  const tampered = [
    { id: 'req_a1', empName: 'Asha Test', dateFrom: '2026-09-10', dateTo: '2026-09-12', leaveType: 'CL', status: 'approved' },
    { id: 'req_a2', empName: 'Asha Test', dateFrom: '2026-09-20', dateTo: '2026-09-20', leaveType: 'Sick', status: 'approved', employeeReply: 'Fever, doctor note attached' },
    { id: 'req_new_ok', empName: 'Asha Test', dateFrom: '2026-09-25', dateTo: '2026-09-26', leaveType: 'CL', status: 'approved', message: 'Wedding', approvedBy: 'boss@x.com' },
    { id: 'req_new_xss', empName: 'Asha Test', dateFrom: '2026-09-27', dateTo: '2026-09-27', leaveType: 'x"><img src=x onerror=alert(1)>', status: 'pending' },
    { id: 'req_fake', empName: 'Ravi Test', dateFrom: '2026-09-28', dateTo: '2026-09-28', leaveType: 'CL', status: 'pending' }
  ];
  const put = await asha('PUT', '/api/kv/leaveRequests', { value: JSON.stringify(tampered), shared: true });
  check('employee request save accepted', put.status === 200, put);
  check('response carries only own requests', JSON.parse(put.body.value).every(r => r.empName === 'Asha Test'), put.body);
  const stored = JSON.parse(db.kv.find(r => r.key === 'leaveRequests').value);
  const by = id => stored.find(r => r.id === id);
  check("other employee's request kept", !!by('req_r1') && by('req_r1').status === 'pending', stored.map(r => r.id));
  check('cannot approve own existing request or change its dates', by('req_a1').status === 'approved' && by('req_a1').dateTo === '2026-09-10', by('req_a1'));
  check('query answered -> pending with reply, not approved', by('req_a2').status === 'pending' && by('req_a2').employeeReply === 'Fever, doctor note attached', by('req_a2'));
  check('new request forced to pending, approver dropped', by('req_new_ok') && by('req_new_ok').status === 'pending' && !by('req_new_ok').approvedBy, by('req_new_ok'));
  check('script-bearing leave type refused', !by('req_new_xss'), stored.map(r => r.id));
  check('cannot raise a request for someone else', !by('req_fake'), stored.map(r => r.id));
  check('employee still cannot write salaries', (await asha('PUT', '/api/kv/salaries', { value: '{}', shared: true })).status === 403);

  // --- admin stale copy keeps the new request ---
  const staleAdmin = JSON.parse(bossAll.leaveRequests);
  staleAdmin[2].status = 'approved';
  await boss('PUT', '/api/kv/leaveRequests', { value: JSON.stringify(staleAdmin), shared: true });
  const after = JSON.parse(db.kv.find(r => r.key === 'leaveRequests').value);
  check("admin's stale save keeps the request raised meanwhile", !!after.find(r => r.id === 'req_new_ok') && after.find(r => r.id === 'req_r1').status === 'approved', after.map(r => r.id + ':' + r.status));

  // --- role and active flag re-read on every request ---
  await boss('PATCH', '/api/users/2', { role: 'admin_view' });
  check('demoted admin loses write at once', (await second('PUT', '/api/kv/salaries', { value: '{}', shared: true })).status === 403);
  check('demoted admin can still read', (await second('GET', '/api/kv-all')).status === 200);
  const sessionsBefore = Object.values(store.sessions).filter(s => JSON.parse(s).userId === 3).length;
  await boss('PATCH', '/api/users/3', { is_active: false });
  check('disabled employee rejected on next call', (await asha('GET', '/api/kv-all')).status === 401);
  check("disabled employee's sessions removed", sessionsBefore === 2 && Object.values(store.sessions).filter(s => JSON.parse(s).userId === 3).length === 0, sessionsBefore);
  await boss('PATCH', '/api/users/3', { is_active: true });

  // --- password change ends other sessions, keeps this one ---
  const bossPhone = client();
  await bossPhone('POST', '/api/login', { email: 'boss@x.com', password: 'password123' });
  const cp = await boss('POST', '/api/change-password', { currentPassword: 'password123', newPassword: 'newpassword1' });
  check('password change ok', cp.status === 200, cp);
  check('other device signed out', (await bossPhone('GET', '/api/kv-all')).status === 401);
  check('this device still signed in', (await boss('GET', '/api/kv-all')).status === 200);

  // --- restore replaces the attendance, and only on purpose ---
  const two = { employees: [{ name: 'Asha Test' }], records: [{ e: 'Asha Test', d: '2026-09-01', st: 'PR' }, { e: 'Asha Test', d: '2026-09-02', st: 'PR' }] };
  await boss('PUT', '/api/dataset', two);
  await boss('PUT', '/api/dataset', { employees: [], records: [{ e: 'Asha Test', d: '2026-09-03', st: 'PR' }] });
  check('normal save only adds/updates (3 rows)', db.records.length === 3, db.records.length);
  const rep = await boss('PUT', '/api/dataset?replace=1', { employees: [], records: [{ e: 'Asha Test', d: '2026-09-01', st: 'AB' }] });
  check('replace leaves exactly the restored rows', rep.status === 200 && db.records.length === 1 && JSON.parse(db.records[0].data).st === 'AB', db.records);
  const empty = await boss('PUT', '/api/dataset?replace=1', { employees: [], records: [] });
  check('empty replace refused, nothing deleted', empty.status === 400 && db.records.length === 1, [empty.status, db.records.length]);
  const byEmp = await ravi('PUT', '/api/dataset?replace=1', two);
  check('employee cannot replace', byEmp.status === 403 && db.records.length === 1, byEmp.status);

  // --- login limit counts failures only ---
  let okLogins = 0;
  for (let i = 0; i < 25; i++) { const c = client(); if ((await c('POST', '/api/login', { email: 'ravi@x.com', password: 'password123' })).status === 200) okLogins++; }
  check('25 successful sign-ins from one address all allowed', okLogins === 25, okLogins);
  let blocked = 0;
  for (let i = 0; i < 21; i++) { const c = client(); if ((await c('POST', '/api/login', { email: 'ravi@x.com', password: 'wrong' })).status === 429) blocked++; }
  check('failures still limited (21st refused)', blocked === 1, blocked);

  srv.close();
  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
