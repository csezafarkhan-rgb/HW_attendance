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
  records: [],    // {org, e, d, data}
  employees: [],  // {org, name, code, shift}
  changes: [],
  history: [],
  errors: []
};
const DEVICE_TOKEN = 'test-device-token-' + 'x'.repeat(40);
process.env.SYNC_TOKEN = DEVICE_TOKEN;
db.users.forEach(u => { u.password_hash = bcrypt.hashSync('password123', 4); });
let store = null;

function kvFind(org, key, user) { return db.kv.find(r => r.org_id === org && r.key === key && r.user_id === user); }
function query(sql, p) {
  const s = sql.replace(/\s+/g, ' ').trim();
  const rows = x => Promise.resolve({ rows: x, rowCount: x.length });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return rows([]);
  // --- script errors from browsers ---
  if (s.startsWith('UPDATE client_errors SET count = count + 1')) {
    const hit = db.errors.find(e => e.message === p[0] && (e.source || '') === p[1] && (e.line == null ? -1 : e.line) === p[2] && (e.user_id || -1) === p[3]);
    if (hit) { hit.count++; return rows([{ id: hit.id }]); }
    return rows([]);
  }
  if (s.startsWith('INSERT INTO client_errors')) {
    db.errors.push({ id: db.errors.length + 1, org_id: p[0], user_id: p[1], user_name: p[2], message: p[3], source: p[4], line: p[5], stack: p[6], page: p[7], count: 1 });
    return rows([]);
  }
  if (s.startsWith('DELETE FROM client_errors')) return rows([]);
  if (s.startsWith('SELECT id, first_at, last_at, count, user_name, message, source, line, page FROM client_errors')) return rows(db.errors.slice().reverse());
  // --- locked months and history ---
  if (s.startsWith("SELECT value FROM kv WHERE org_id = $1 AND key = 'lockedMonths' AND user_id IS NULL")) {
    const r = kvFind(p[0], 'lockedMonths', null); return rows(r ? [{ value: r.value }] : []);
  }
  if (s.startsWith('SELECT pg_database_size')) return rows([{ size: '41943040', now: new Date() }]);
  if (s.startsWith('CREATE TABLE IF NOT EXISTS usage_bytes')) return rows([]);
  if (s.startsWith('INSERT INTO usage_bytes')) { db.usage = (db.usage || 0) + Number(p[1]); return rows([]); }
  if (s.startsWith('SELECT bytes, requests FROM usage_bytes')) return rows([{ bytes: String(db.usage || 0), requests: '12' }]);
  if (s.startsWith('SELECT (SELECT count(*) FROM records')) {
    return rows([{ records: db.records.length, employees: db.employees.length, history: db.history.length }]);
  }
  if (s.startsWith('INSERT INTO history')) {
    db.history.push({ id: db.history.length + 1, org_id: p[0], user_id: p[1], user_name: p[2], area: p[3], item: p[4], before_value: p[5], after_value: p[6], at: new Date() });
    return rows([]);
  }
  if (s.startsWith('SELECT id, at, user_name, area, item, before_value, after_value FROM history WHERE')) {
    let out = db.history.filter(h => h.org_id === p[0]);
    let i = 1;
    if (/ AND item = \$/.test(s)) { const v = p[i++]; out = out.filter(h => h.item === v); }
    if (/ AND area = \$/.test(s)) { const v = p[i++]; out = out.filter(h => h.area === v); }
    return rows(out.slice().reverse().slice(0, p[p.length - 1]));
  }
  if (s.startsWith("SELECT employee, to_char(day,'YYYY-MM-DD') AS d, data FROM records WHERE org_id = $1 AND to_char(day,'YYYY-MM') = ANY($2)")) {
    return rows(db.records.filter(r => r.org === p[0] && p[1].indexOf(r.d.slice(0, 7)) > -1).map(r => ({ employee: r.e, d: r.d, data: JSON.parse(r.data) })));
  }
  if (s.startsWith("DELETE FROM records WHERE org_id = $1 AND NOT (to_char(day,'YYYY-MM') = ANY($2))")) {
    db.records = db.records.filter(r => r.org !== p[0] || p[1].indexOf(r.d.slice(0, 7)) > -1);
    return rows([]);
  }
  // --- the office PC's routes ---
  if (s === 'SELECT id FROM orgs ORDER BY id LIMIT 1') return rows([{ id: 1 }]);
  if (s.startsWith("INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, 'deviceStatus'")) {
    let r = kvFind(p[0], 'deviceStatus', null);
    if (r) { r.value = p[1]; r.version = String(Number(r.version) + 1); }
    else db.kv.push({ org_id: p[0], user_id: null, key: 'deviceStatus', value: p[1], version: '1' });
    return rows([]);
  }
  if (s.startsWith('INSERT INTO employees (org_id, code, name, shift) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, name) DO NOTHING')) {
    if (db.employees.find(e => e.org === p[0] && e.name === p[2])) return Promise.resolve({ rows: [], rowCount: 0 });
    db.employees.push({ org: p[0], code: p[1], name: p[2], shift: p[3] });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (s.startsWith('INSERT INTO records (org_id, employee, day, data, updated_by) VALUES ($1,$2,$3,$4,NULL)')) {
    const r = db.records.find(x => x.org === p[0] && x.e === p[1] && x.d === p[2]);
    if (r) r.data = p[3]; else db.records.push({ org: p[0], e: p[1], d: p[2], data: p[3] });
    return rows([]);
  }
  if (s === 'SELECT * FROM orgs WHERE id = $1') return rows([{ id: 1, name: 'Test Org' }]);
  if (s.startsWith('SELECT id, org_id, email, password_hash, name, role, is_active, created_at, last_login_at FROM users WHERE org_id = $1')) return rows(db.users);
  if (s.startsWith('SELECT user_id, key, value, updated_at, version FROM kv WHERE org_id = $1')) return rows(db.kv);
  if (s.startsWith('SELECT code, name, shift, is_active FROM employees WHERE org_id = $1')) return rows(db.employees);
  if (s.startsWith("SELECT employee, to_char(day,'YYYY-MM-DD') AS day, data, updated_at FROM records WHERE org_id = $1")) {
    return rows(db.records.map(r => ({ employee: r.e, day: r.d, data: JSON.parse(r.data) })));
  }
  if (s.startsWith('SELECT role, is_active, org_id, name, email FROM users WHERE id = $1')) {
    return rows(db.users.filter(u => u.id === p[0])
      .map(u => ({ role: u.role, is_active: u.is_active, org_id: u.org_id, name: u.name, email: u.email })));
  }
  if (s.startsWith('SELECT id, org_id, email, password_hash, name, role, is_active FROM users WHERE lower(email) = $1')) {
    return rows(db.users.filter(u => u.email === p[0] || u.email.split('@')[0] === p[0]));
  }
  if (s.startsWith('UPDATE users SET last_login_at')) return rows([]);
  if (s.startsWith('SELECT totp_enabled, totp_secret, totp_last_step, totp_recovery, (totp_locked_until')) {
    return rows(db.users.filter(u => u.id === p[0]).map(u => Object.assign({}, u, { locked: !!(u.totp_locked_until && u.totp_locked_until > Date.now()) })));
  }
  if (s.startsWith('UPDATE users SET totp_fail_count = COALESCE(totp_fail_count, 0) + 1')) {
    const u = db.users.find(x => x.id === p[0]); u.totp_fail_count = (u.totp_fail_count || 0) + 1;
    if (u.totp_fail_count >= p[1]) u.totp_locked_until = Date.now() + 15 * 60 * 1000;
    return rows([]);
  }
  // The conditional save: only if the code state is still what was read.
  if (s.startsWith('UPDATE users SET totp_last_step = $1, totp_recovery = $2, totp_fail_count = 0, totp_locked_until = NULL')) {
    const u = db.users.find(x => x.id === p[2] && x.org_id === p[3]);
    const same = u && (u.totp_last_step == null ? null : Number(u.totp_last_step)) === (p[4] == null ? null : Number(p[4]))
      && (u.totp_recovery == null ? '' : String(u.totp_recovery)) === p[5];
    if (!same) return rows([]);
    u.totp_last_step = p[0]; u.totp_recovery = p[1]; u.totp_fail_count = 0; u.totp_locked_until = null;
    return rows([{ id: u.id }]);
  }
  if (s.startsWith("SELECT count(*)::int AS n FROM client_errors")) return rows([{ n: db.errors.length }]);
  if (s.startsWith('SELECT id, email, name, role, org_id FROM users WHERE id = $1 AND is_active = TRUE')) return rows(db.users.filter(u => u.id === p[0] && u.is_active));
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
  if (s.startsWith('SELECT key, value, version FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL')) {
    const r = kvFind(p[0], p[1], null); return rows(r ? [{ key: r.key, value: r.value, version: r.version }] : []);
  }
  if (s.startsWith('SELECT value, version FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL FOR UPDATE')) {
    const r = kvFind(p[0], p[1], null); return rows(r ? [{ value: r.value, version: r.version }] : []);
  }
  if (s.startsWith("SELECT value FROM kv WHERE org_id = $1 AND key = 'leaveRequests' AND user_id IS NULL")) {
    const r = kvFind(p[0], 'leaveRequests', null); return rows(r ? [{ value: r.value }] : []);
  }
  if (s.startsWith('SELECT key, value, version FROM kv WHERE org_id = $1 AND key = $2 AND user_id = $3')) {
    const r = kvFind(p[0], p[1], p[2]); return rows(r ? [{ key: r.key, value: r.value, version: r.version }] : []);
  }
  if (s.startsWith('INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL')) {
    let r = kvFind(p[0], p[1], null);
    if (r) { r.value = p[2]; r.version = String(Number(r.version) + 1); }   // pg returns bigint as text
    else { r = { org_id: p[0], user_id: null, key: p[1], value: p[2], version: '1' }; db.kv.push(r); }
    return rows([{ version: r.version }]);
  }
  if (s.startsWith('INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1,$2')) {
    let r = kvFind(p[0], p[2], p[1]);
    if (r) { r.value = p[3]; r.version = String(Number(r.version) + 1); }
    else { r = { org_id: p[0], user_id: p[1], key: p[2], value: p[3], version: '1' }; db.kv.push(r); }
    return rows([{ version: r.version }]);
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
  if (s.startsWith('SELECT key, value, version, (user_id IS NULL) AS shared FROM kv')) {
    return rows(db.kv.filter(r => r.org_id === p[0] && (r.user_id === null || r.user_id === p[1]))
      .sort((a, b) => (a.user_id === null ? 0 : 1) - (b.user_id === null ? 0 : 1))
      .map(r => ({ key: r.key, value: r.value, version: r.version, shared: r.user_id === null })));
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
function client(ip) {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method, headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}, ip ? { 'x-forwarded-for': ip } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, body: json, cookie, headers: res.headers };
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

  // --- forgot-to-punch requests ---
  const punchReqs = [
    { id: 'req_punch_ok', empName: 'Asha Test', dateFrom: '2026-09-12', dateTo: '2026-09-12', leaveType: 'PUNCH', punchIn: '', punchOut: '18:40', message: 'reader missed me', status: 'approved' },
    { id: 'req_punch_range', empName: 'Asha Test', dateFrom: '2026-09-12', dateTo: '2026-09-13', leaveType: 'PUNCH', punchIn: '9:30', message: 'x' },
    { id: 'req_punch_notime', empName: 'Asha Test', dateFrom: '2026-09-12', dateTo: '2026-09-12', leaveType: 'PUNCH', message: 'x' },
    { id: 'req_punch_badtime', empName: 'Asha Test', dateFrom: '2026-09-11', dateTo: '2026-09-11', leaveType: 'PUNCH', punchIn: '9:30<script>', punchOut: '18:00', message: 'x' }
  ];
  await asha('PUT', '/api/kv/leaveRequests', { value: JSON.stringify(punchReqs), shared: true });
  const afterPunch = JSON.parse(db.kv.find(r => r.key === 'leaveRequests').value);
  const pOk = afterPunch.find(r => r.id === 'req_punch_ok');
  check('punch correction kept as pending with its time', pOk && pOk.status === 'pending' && pOk.punchOut === '18:40' && pOk.punchIn === '', pOk);
  check('a punch correction over a range or with no time refused', !afterPunch.find(r => r.id === 'req_punch_range') && !afterPunch.find(r => r.id === 'req_punch_notime'));
  const pBad = afterPunch.find(r => r.id === 'req_punch_badtime');
  check('a malformed time is dropped, the valid one kept', pBad && pBad.punchIn === '' && pBad.punchOut === '18:00', pBad);

  // --- admin stale copy keeps the new request ---
  const staleAdmin = JSON.parse(bossAll.leaveRequests);
  staleAdmin[2].status = 'approved';
  await boss('PUT', '/api/kv/leaveRequests', { value: JSON.stringify(staleAdmin), shared: true });
  const after = JSON.parse(db.kv.find(r => r.key === 'leaveRequests').value);
  check("admin's stale save keeps the request raised meanwhile", !!after.find(r => r.id === 'req_new_ok') && after.find(r => r.id === 'req_r1').status === 'approved', after.map(r => r.id + ':' + r.status));

  // --- a save made from an older copy is refused ---
  const v0 = (await boss('GET', '/api/kv/joinDates?shared=true')).body.version;
  const bySecond = await second('PUT', '/api/kv/joinDates', { value: '{"Asha Test":"2026-02-01"}', shared: true, baseVersion: v0 });
  check('save from the current version accepted, version bumped', bySecond.status === 200 && bySecond.body.version === v0 + 1, bySecond.body);
  const stale = await boss('PUT', '/api/kv/joinDates', { value: '{"Asha Test":"2026-03-01"}', shared: true, baseVersion: v0 });
  check('save from an older copy refused with 409 and the current version', stale.status === 409 && stale.body.error === 'conflict' && stale.body.version === v0 + 1, stale);
  check("the other admin's change survives", JSON.parse(db.kv.find(r => r.key === 'joinDates').value)['Asha Test'] === '2026-02-01');
  const retry = await boss('PUT', '/api/kv/joinDates', { value: '{"Asha Test":"2026-03-01"}', shared: true, baseVersion: v0 + 1 });
  check('after reloading (current version) the save goes through', retry.status === 200 && retry.body.version === v0 + 2, retry.body);
  const unversioned = await boss('PUT', '/api/kv/joinDates', { value: '{"Asha Test":"2026-01-01"}', shared: true });
  check('a save without a version still works (older pages)', unversioned.status === 200, unversioned.status);
  const kvAllV = (await boss('GET', '/api/kv-all')).body;
  check('kv-all reports versions', kvAllV.versions && kvAllV.versions.joinDates === v0 + 3, kvAllV.versions);
  const reqStale = await boss('PUT', '/api/kv/leaveRequests', { value: JSON.stringify(JSON.parse(kvAllV.values.leaveRequests)), shared: true, baseVersion: 1 });
  check('leaveRequests are merged, never refused as a conflict', reqStale.status === 200, reqStale.status);

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

  // --- script errors ---
  const anon = client();
  const e1 = await anon('POST', '/api/client-errors', { message: 'Spam from nowhere', source: 'x', line: 1 });
  check('a report from someone not signed in is not stored', e1.status === 204 && db.errors.length === 0, { status: e1.status, n: db.errors.length });
  await ravi('POST', '/api/client-errors', { message: "TypeError: Cannot read properties of undefined (reading 'split')", source: 'about:srcdoc', line: 1234, page: 'dashboard' });
  await ravi('POST', '/api/client-errors', { message: "TypeError: Cannot read properties of undefined (reading 'split')", source: 'about:srcdoc', line: 1234, page: 'dashboard' });
  check('the same error again counts, not a new row', db.errors.length === 1 && db.errors[0].count === 2, db.errors);
  await boss('POST', '/api/client-errors', { message: 'ReferenceError: x is not defined', source: 'about:srcdoc', line: 9 });
  check('a signed-in report records who', db.errors.length === 2 && db.errors[1].user_name === 'Boss', db.errors[1]);
  check('an empty report is refused', (await boss('POST', '/api/client-errors', { message: '  ' })).status === 400);
  const errList = await boss('GET', '/api/client-errors?hours=24');
  check('admins read the errors', errList.status === 200 && errList.body.errors.length === 2, errList.body);
  check('employees cannot read them', (await ravi('GET', '/api/client-errors')).status === 403);

  // --- locked months ---
  await boss('PUT', '/api/kv/overrides', { value: JSON.stringify({ 'Asha Test|2026-08-20': { cat: 'LEAVE', detail: 'CL' }, 'Asha Test|2026-09-10': { cat: 'LEAVE' } }), shared: true });
  const histBefore = db.history.length;
  const lockRes = await boss('PUT', '/api/kv/lockedMonths', { value: JSON.stringify({ '2026-08': { by: 'Boss', at: '2026-09-05' } }), shared: true });
  check('admin locks August', lockRes.status === 200);
  check('an employee cannot lock or unlock a month', (await ravi('PUT', '/api/kv/lockedMonths', { value: '{}', shared: true })).status === 403);
  const augEdit = await boss('PUT', '/api/kv/overrides', { value: JSON.stringify({ 'Asha Test|2026-08-20': { cat: 'WFH' }, 'Asha Test|2026-09-10': { cat: 'LEAVE' } }), shared: true });
  check('changing a day in a locked month is refused (423, month named)', augEdit.status === 423 && augEdit.body.error === 'month_locked' && augEdit.body.months.join() === '2026-08', augEdit.body);
  check('...and nothing of that save was applied', JSON.parse(kvFind(1, 'overrides', null).value)['Asha Test|2026-08-20'].cat === 'LEAVE');
  const sepEdit = await boss('PUT', '/api/kv/overrides', { value: JSON.stringify({ 'Asha Test|2026-08-20': { cat: 'LEAVE', detail: 'CL' }, 'Asha Test|2026-09-10': { cat: 'WFH' } }), shared: true });
  check('a change only in an open month still saves, locked entries unchanged', sepEdit.status === 200, sepEdit.status);
  const ded = await boss('PUT', '/api/kv/leaveDeductions', { value: JSON.stringify({ 'Asha Test|2026-08': 2 }), shared: true });
  check('a month-keyed setting (salary deduction) for a locked month is refused too', ded.status === 423, ded.status);

  // --- change history ---
  const sepHist = db.history.slice(histBefore).filter(h => h.area === 'overrides' && h.item === 'Asha Test|2026-09-10');
  check('history records who changed which day, from what to what', sepHist.length === 1 && sepHist[0].user_name === 'Boss'
    && /LEAVE/.test(sepHist[0].before_value) && /WFH/.test(sepHist[0].after_value), sepHist);
  check('unchanged entries are not written to history', !db.history.slice(histBefore).some(h => h.item === 'Asha Test|2026-08-20'));
  check('the lock itself is in history', db.history.slice(histBefore).some(h => h.area === 'lockedMonths' && h.item === '2026-08'));
  const hApi = await boss('GET', '/api/history?item=' + encodeURIComponent('Asha Test|2026-09-10'));
  check('admins read one day’s history', hApi.status === 200 && hApi.body.history.length >= 1 && hApi.body.history[0].area === 'overrides', hApi.body);
  check('employees cannot read history', (await ravi('GET', '/api/history')).status === 403);

  // --- attendance rows in a locked month ---
  db.records.push({ org: 1, e: 'Asha Test', d: '2026-08-21', data: JSON.stringify({ in: '9:30', out: '18:30', st: 'PR' }) });
  const dsLocked = await boss('PUT', '/api/dataset', { employees: [], records: [
    { e: 'Asha Test', d: '2026-08-21', in: '9:30', out: '18:30', st: 'PR' },          // unchanged: skipped quietly
    { e: 'Asha Test', d: '2026-08-22', in: '9:31', out: '18:31', st: 'PR' },          // new in a locked month
    { e: 'Asha Test', d: '2026-09-02', in: '9:32', out: '18:32', st: 'PR' } ] });
  check('dataset save skips locked rows and reports the one that would change', dsLocked.status === 200 && dsLocked.body.records === 1 && dsLocked.body.lockedChanged === 1, dsLocked.body);
  check('the locked month was not written', !db.records.some(r => r.d === '2026-08-22'));
  await boss('PUT', '/api/dataset?replace=1', { employees: [], records: [{ e: 'Asha Test', d: '2026-09-03', st: 'PR' }] });
  check('a restore keeps the locked month’s rows', db.records.some(r => r.d === '2026-08-21') && !db.records.some(r => r.d === '2026-09-02'), db.records.map(r => r.d));
  await boss('PUT', '/api/kv/lockedMonths', { value: '{}', shared: true });          // unlock for the tests below

  // --- the office PC: token-only upload and backup ---
  const device = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, json: (() => { try { return JSON.parse(buf.toString()); } catch (e) { return null; } })() };
  };
  const pushBody = {
    employees: [{ name: 'New Person', code: 'N1', shift: '9:30-6:30' }, { name: 'Card', code: '', shift: '' }],
    records: [
      { e: 'New Person', d: '2026-09-14', in: '9:35', out: '', st: 'PR', c: 1 },
      { e: 'Asha Test', d: '2026-09-01', in: '9:40', out: '18:30', st: 'PR', c: 2 },
      { e: 'Card', d: '2026-09-14', st: 'AB' },
      { e: 'Bad Date', d: '2026-10-NaN', st: 'PR' }
    ],
    newestPunch: '2026-09-14'
  };
  check('upload with no token refused', (await device('POST', '/api/device/records', pushBody)).status === 401);
  check('upload with a wrong token refused', (await device('POST', '/api/device/records', pushBody, 'nope-' + 'y'.repeat(40))).status === 401);
  check('a signed-in admin cannot use the device route either', (await boss('POST', '/api/device/records', pushBody)).status === 401);
  delete process.env.SYNC_TOKEN;
  check('nothing works until SYNC_TOKEN is set (503)', (await device('POST', '/api/device/records', pushBody, DEVICE_TOKEN)).status === 503);
  process.env.SYNC_TOKEN = DEVICE_TOKEN;
  const before = db.records.length;
  const pushed = await device('POST', '/api/device/records', pushBody, DEVICE_TOKEN);
  check('upload accepted: 2 rows, 1 new person', pushed.status === 200 && pushed.json.records === 2 && pushed.json.employeesAdded === 1, pushed.json);
  check('Card and bad dates skipped', !db.records.some(r => r.e === 'Card' || r.e === 'Bad Date') && !db.employees.some(e => e.name === 'Card'));
  check("that person's day replaced by the file's row", JSON.parse(db.records.find(r => r.e === 'Asha Test' && r.d === '2026-09-01').data).in === '9:40');
  check('new day added', db.records.some(r => r.e === 'New Person' && r.d === '2026-09-14') && db.records.length > before, db.records.length - before);
  const status = JSON.parse(kvFind(1, 'deviceStatus', null).value);
  check('last upload recorded for the dashboard', status.rows === 2 && status.newestPunch === '2026-09-14' && !!status.at, status);
  // Ravi: Asha was signed out everywhere by the disable check above.
  check('employees cannot see the office-PC status', !('deviceStatus' in (await ravi('GET', '/api/kv-all')).body.values));

  /* The indicator in the toolbar: is the database answering, and how much of
     the plan's 5GB of responses has gone. Admins only - it is about the
     service, not about anybody's attendance. */
  const health = await boss('GET', '/api/status');
  check('an admin can see the database and plan figures',
    health.status === 200 && health.body.db.ok === true && health.body.db.size === 41943040
      && health.body.plan.bytes === 5 * 1024 * 1024 * 1024
      && typeof health.body.usage.bytes === 'number' && health.body.usage.requests > 0, health.body);
  check('it counts what is on file',
    health.body.counts && typeof health.body.counts.records === 'number', health.body.counts);
  check('employees cannot', (await ravi('GET', '/api/status')).status === 403);

  /* Bandwidth: the dashboard page and the two big reads must revalidate, not
     be fetched whole every time. Serving index.html `no-store` used up the
     plan's 5GB in three weeks and the service was suspended. */
  const pageRes = await fetch(base + '/', { headers: { cookie: (await boss('GET', '/api/me')).cookie } });
  const pageCc = String(pageRes.headers.get('cache-control') || '');
  check('the dashboard page revalidates instead of downloading again',
    /no-cache/.test(pageCc) && !/no-store/.test(pageCc), pageCc);
  check('the page carries an ETag to revalidate against', !!pageRes.headers.get('etag'));
  const dsHead = (await boss('GET', '/api/dataset')).headers;
  check('the dataset revalidates too',
    /no-cache/.test(String(dsHead.get('cache-control') || '')) && !!dsHead.get('etag'),
    String(dsHead.get('cache-control')));
  const kvHead = (await boss('GET', '/api/kv-all')).headers;
  check('and so do the settings', /no-cache/.test(String(kvHead.get('cache-control') || '')), String(kvHead.get('cache-control')));
  check('backup needs the token', (await device('GET', '/api/device/backup')).status === 401);
  const bk = await device('GET', '/api/device/backup', undefined, DEVICE_TOKEN);
  let dump = null; try { dump = JSON.parse(require('zlib').gunzipSync(bk.buf).toString()); } catch (e) {}
  check('backup is a complete gzip copy', bk.status === 200 && dump && dump._type === 'hw-attendance-db-backup'
    && dump.records.length === db.records.length && dump.users.length === db.users.length && dump.kv.length === db.kv.length, dump && Object.keys(dump));

  // --- login limit counts failures only ---
  let okLogins = 0;
  for (let i = 0; i < 25; i++) { const c = client(); if ((await c('POST', '/api/login', { email: 'ravi@x.com', password: 'password123' })).status === 200) okLogins++; }
  check('25 successful sign-ins from one address all allowed', okLogins === 25, okLogins);
  let blocked = 0;
  for (let i = 0; i < 21; i++) { const c = client(); if ((await c('POST', '/api/login', { email: 'ravi@x.com', password: 'wrong' })).status === 429) blocked++; }
  check('failures still limited (21st refused)', blocked === 1, blocked);

  // --- two-step sign-in (from another address: the one above is now limited) ---
  const totp = require(path.join(REPO, 'totp.js'));
  const IP = '10.0.0.7';
  const sec = client(IP);
  await sec('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  check('turning it on asks for the password', (await sec('POST', '/api/two-step/setup', { password: 'nope' })).status === 401);
  const setup = await sec('POST', '/api/two-step/setup', { password: 'password123' });
  check('setup gives a key and an app link', setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.body.secret) && /^otpauth:\/\/totp\//.test(setup.body.uri), setup.body);
  const key = setup.body.secret;
  check('not in force before a code confirms it', db.users[1].totp_enabled !== true);
  check('a wrong code does not turn it on', (await sec('POST', '/api/two-step/enable', { code: '000000' })).status === 401);
  const nowStep = totp.stepNow();
  const en = await sec('POST', '/api/two-step/enable', { code: totp.codeAt(key, nowStep) });
  check('a code from the app turns it on, with 10 recovery codes', en.status === 200 && en.body.recoveryCodes.length === 10 && db.users[1].totp_enabled === true, en.body);
  check('recovery codes are stored only as hashes', !en.body.recoveryCodes.some(c => String(db.users[1].totp_recovery).includes(c)));
  check('employees cannot turn it on', (await ravi('POST', '/api/two-step/setup', { password: 'password123' })).status === 403);

  const s2 = client(IP);
  const pw = await s2('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  check('the right password alone asks for a code', pw.status === 200 && pw.body.twoStep === true && !pw.body.user, pw.body);
  check('...and is not signed in yet', (await s2('GET', '/api/me')).status === 401 && (await s2('GET', '/api/kv-all')).status === 401);
  check('the code already used cannot be used again', (await s2('POST', '/api/login/two-step', { code: totp.codeAt(key, nowStep) })).body.error === 'invalid_code');
  const ok2 = await s2('POST', '/api/login/two-step', { code: totp.codeAt(key, nowStep + 1) });
  check('the current code signs in', ok2.status === 200 && ok2.body.user && ok2.body.user.email === 'second@x.com', ok2.body);
  check('...and the session works', (await s2('GET', '/api/me')).status === 200);

  const s3 = client(IP);
  await s3('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  const rc = await s3('POST', '/api/login/two-step', { code: en.body.recoveryCodes[0].toUpperCase() });
  check('a recovery code signs in once, and says how many are left', rc.status === 200 && rc.body.recoveryLeft === 9, rc.body);
  const s4 = client(IP);
  await s4('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  check('the same recovery code does not work twice', (await s4('POST', '/api/login/two-step', { code: en.body.recoveryCodes[0] })).status === 401);
  let last = null;
  for (let i = 0; i < 4; i++) last = await s4('POST', '/api/login/two-step', { code: '111111' });
  check('five wrong codes end the attempt', last.body.error === 'two_step_expired', last.body);
  check('...and then even a right code needs the password again', (await s4('POST', '/api/login/two-step', { code: totp.codeAt(key, nowStep + 1) })).body.error === 'two_step_expired');
  check('no code step without the password first', (await client(IP)('POST', '/api/login/two-step', { code: '123456' })).body.error === 'two_step_expired');
  const st = await s2('GET', '/api/two-step');
  check('status shows on, 9 codes left', st.body.enabled === true && st.body.recoveryLeft === 9, st.body);

  const self = await boss('PATCH', '/api/users/1', { resetTwoStep: true });
  check('a super admin cannot reset their own two-step from the list', self.status === 400, self);
  check('employees cannot reset anyone', (await ravi('PATCH', '/api/users/2', { resetTwoStep: true })).status === 403);
  const rs = await boss('PATCH', '/api/users/2', { resetTwoStep: true });
  check('another super admin can reset it (lost phone)', rs.status === 200 && db.users[1].totp_enabled === false && !db.users[1].totp_secret);
  check('...which signs them out', (await s2('GET', '/api/me')).status === 401);
  const plain = await client(IP)('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  check('...and they sign in with the password again', plain.status === 200 && plain.body.user, plain.body);

  const b2 = client(IP);
  const bl = await b2('POST', '/api/login', { email: 'boss@x.com', password: 'newpassword1' });  // changed earlier in this test
  const bs = await b2('POST', '/api/two-step/setup', { password: 'newpassword1' });
  const be = await b2('POST', '/api/two-step/enable', { code: totp.codeAt(bs.body.secret, totp.stepNow()) });
  const bd = await b2('POST', '/api/two-step/disable', { password: 'newpassword1', code: '000000' });
  check('turning it off needs a code', bd.status === 401 && bd.body.error === 'invalid_code' && db.users[0].totp_enabled === true, [bl, bs, be, bd]);
  const off = await b2('POST', '/api/two-step/disable', { password: 'newpassword1', code: totp.codeAt(bs.body.secret, totp.stepNow() + 1) });
  check('password and a code turn it off', off.status === 200 && db.users[0].totp_enabled === false, off.body);

  // --- one code cannot be used twice at once; failures lock the account, not the address ---
  const s5 = client('10.0.1.1');
  await s5('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  const setup2 = await s5('POST', '/api/two-step/setup', { password: 'password123' });
  const st2 = totp.stepNow();
  const en2 = await s5('POST', '/api/two-step/enable', { code: totp.codeAt(setup2.body.secret, st2) });
  const ra = client('10.0.1.2'), rb = client('10.0.1.3');
  await ra('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  await rb('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  const sameCode = totp.codeAt(setup2.body.secret, st2 + 1);
  const race = await Promise.all([ra('POST', '/api/login/two-step', { code: sameCode }), rb('POST', '/api/login/two-step', { code: sameCode })]);
  check('the same code sent twice at once signs in only once', race.filter(x => x.status === 200).length === 1, race.map(x => x.status));
  const recRace = [client('10.0.1.4'), client('10.0.1.5')];
  for (const c of recRace) await c('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  const rr = await Promise.all(recRace.map(c => c('POST', '/api/login/two-step', { code: en2.body.recoveryCodes[1] })));
  check('the same recovery code sent twice at once works once', rr.filter(x => x.status === 200).length === 1, rr.map(x => x.status));
  let fails = 0;
  for (let round = 0; round < 3 && fails < 10; round++) {
    const c = client('10.0.2.' + round);
    await c('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
    for (let i = 0; i < 5 && fails < 10; i++) { await c('POST', '/api/login/two-step', { code: '000000' }); fails++; }
  }
  const lockedTry = client('10.0.3.1');
  await lockedTry('POST', '/api/login', { email: 'second@x.com', password: 'password123' });
  const lk = await lockedTry('POST', '/api/login/two-step', { code: en2.body.recoveryCodes[2] });
  check('ten wrong codes lock two-step sign-in for the account, from any address', lk.status === 429 && lk.body.error === 'two_step_locked', lk);

  srv.close();
  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
