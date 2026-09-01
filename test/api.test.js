'use strict';
/* Exercises the real server against the real database. */
const { app, pool } = require('../server');

let server, base;
let pass = 0, fail = 0;

function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}

// Minimal cookie-aware fetch wrapper so we can hold two independent sessions.
function client() {
  let cookie = '';
  return async function (method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch (e) {}
    return { status: res.status, body: json };
  };
}

(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;

  const alice = client();   // admin
  const bob = client();     // a second, separate browser session
  const viewer = client();

  console.log('\n-- auth --');
  let r = await alice('POST', '/api/login', { email: 'admin@allyconnect.test', password: 'wrongpass' });
  ok(r.status === 401, 'wrong password rejected', r.body);

  r = await alice('GET', '/api/kv-all');
  ok(r.status === 401, 'unauthenticated request rejected', r.body);

  r = await alice('POST', '/api/login', { email: 'admin@allyconnect.test', password: 'testpass123' });
  ok(r.status === 200 && r.body.user.role === 'admin', 'admin logs in', r.body);

  r = await alice('GET', '/api/me');
  ok(r.status === 200 && r.body.user.email === 'admin@allyconnect.test', '/api/me returns session user', r.body);

  console.log('\n-- KV sync across two users (the actual point) --');
  await bob('POST', '/api/login', { email: 'viewer@allyconnect.test', password: 'viewerpass1' });

  const val = JSON.stringify({ name: 'AllyConnect Pvt. Ltd.', addr: 'Sector 61, Gurugram' });
  r = await alice('PUT', '/api/kv/companyInfo', { value: val, shared: true });
  ok(r.status === 200, 'admin writes shared key', r.body);

  r = await bob('GET', '/api/kv/companyInfo?shared=true');
  ok(r.status === 200 && r.body && r.body.value === val,
     'SECOND USER SEES IT — this is the live-sync guarantee', r.body);

  r = await alice('GET', '/api/kv/doesNotExist');
  ok(r.body === null, 'missing key resolves null (matches storage.get contract)', r.body);

  r = await alice('PUT', '/api/kv/bad key!', { value: 'x' });
  ok(r.status === 400, 'invalid key rejected', r.body);

  console.log('\n-- personal vs shared isolation --');
  await alice('PUT', '/api/kv/myPref', { value: 'alice-value', shared: false });
  await bob('PUT', '/api/kv/myPref', { value: 'bob-value', shared: false });
  const ra = await alice('GET', '/api/kv/myPref?shared=false');
  const rb = await bob('GET', '/api/kv/myPref?shared=false');
  ok(ra.body.value === 'alice-value' && rb.body.value === 'bob-value',
     'personal keys stay per-user', { alice: ra.body, bob: rb.body });

  console.log('\n-- role enforcement --');
  r = await bob('PUT', '/api/kv/companyInfo', { value: 'viewer-tried-to-write', shared: true });
  ok(r.status === 403, 'viewer cannot write', r.body);
  r = await alice('GET', '/api/kv/companyInfo?shared=true');
  ok(r.body.value === val, 'viewer write did not land', r.body);

  r = await bob('GET', '/api/users');
  ok(r.status === 403, 'viewer cannot list users', r.body);
  r = await alice('GET', '/api/users');
  ok(r.status === 200 && r.body.users.length >= 2, 'admin can list users', r.body && r.body.users && r.body.users.length);

  console.log('\n-- records --');
  r = await alice('POST', '/api/employees', { employees: [
    { code: '3', name: 'Zafar Khan', shift: '9:30-6:30' },
    { code: '5', name: 'Rahul Mishra', shift: '9:30-6:30' }
  ]});
  ok(r.status === 200 && r.body.upserted === 2, 'employees upserted', r.body);

  r = await alice('POST', '/api/records', { records: [
    { e: 'Zafar Khan', d: '2026-07-01', in: '9:30', out: '18:32', dur: '9:02', st: 'PR', c: 3 },
    { e: 'Rahul Mishra', d: '2026-07-01', in: '9:39', out: '18:31', dur: '8:52', st: 'PR', c: 3 }
  ]});
  ok(r.status === 200 && r.body.upserted === 2, 'records upserted', r.body);

  r = await bob('GET', '/api/dataset');
  const zafar = r.body.records.find(x => x.e === 'Zafar Khan' && x.d === '2026-07-01');
  ok(zafar && zafar.in === '9:30' && zafar.st === 'PR',
     'second user reads the records back in dashboard shape', zafar);

  console.log('\n-- concurrent edit safety --');
  await alice('POST', '/api/records', { records: [
    { e: 'Zafar Khan', d: '2026-07-01', in: '9:31', out: '18:32', dur: '9:01', st: 'PR', c: 3 }
  ]});
  r = await alice('GET', '/api/dataset');
  const z2 = r.body.records.find(x => x.e === 'Zafar Khan' && x.d === '2026-07-01');
  const r2 = r.body.records.find(x => x.e === 'Rahul Mishra' && x.d === '2026-07-01');
  ok(z2.in === '9:31', 'edited day updated', z2);
  ok(r2 && r2.in === '9:39', 'OTHER employee untouched by that edit (no clobber)', r2);

  console.log('\n-- change feed --');
  r = await alice('GET', '/api/changes?since=0');
  ok(r.status === 200 && r.body.changes.length > 0 && typeof r.body.cursor === 'number',
     'change feed reports activity for polling', { n: r.body.changes.length, cursor: r.body.cursor });
  const cur = r.body.cursor;
  r = await alice('GET', '/api/changes?since=' + cur);
  ok(r.body.changes.length === 0, 'change feed is empty when idle', r.body.changes);

  console.log('\n-- logout --');
  await alice('POST', '/api/logout');
  r = await alice('GET', '/api/me');
  ok(r.status === 401, 'session destroyed on logout', r.body);

  console.log('\n================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('================================\n');

  server.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
