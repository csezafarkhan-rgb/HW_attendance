'use strict';
/* Homeweavers Attendance — API server.
 *
 * Replaces the old browser-local storage with Postgres so every user sees the
 * same data. The dashboard already talks to a `window.storage` interface, so
 * the KV endpoints below are shaped to match it exactly.
 */
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

const PORT = process.env.PORT || 3000;
const REMEMBER_MS = 1000 * 60 * 60 * 24 * 30;   // "keep me signed in" window
const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production.');
  process.exit(1);
}

if (isProd && !process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL must be set in production.');
  console.error('       Add the Render PostgreSQL connection string as the DATABASE_URL environment variable.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render PostgreSQL supports TLS. Local development stays non-TLS.
  ssl: isProd ? { rejectUnauthorized: false } : false,
  max: 10,
  connectionTimeoutMillis: 8000,
  statement_timeout: 10000,
  idle_in_transaction_session_timeout: 15000
});

const app = express();

/* Express 4 does not catch rejections from `async` route handlers, and Node
   exits on an unhandled rejection - so one database error killed the whole
   server and the browser saw a 502. Wrap every handler so async errors reach
   the error handler and return a clean 500 instead. */
['get', 'post', 'put', 'patch', 'delete'].forEach(function (method) {
  const original = app[method].bind(app);
  app[method] = function (path) {
    const handlers = Array.prototype.slice.call(arguments, 1).map(function (h) {
      if (typeof h !== 'function' || h.length === 4) return h;
      return function (req, res, next) {
        try { Promise.resolve(h(req, res, next)).catch(next); }
        catch (e) { next(e); }
      };
    });
    return original.apply(null, [path].concat(handlers));
  };
});
app.set('trust proxy', 1); // Render terminates TLS at its proxy
app.use(compression());
app.use(helmet({
  // The dashboard is one big inline-script HTML file, so CSP would have to be
  // unsafe-inline to work at all. Turned off rather than pretending otherwise.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '25mb' })); // imports can be large

app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
  name: 'hw.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,               // HTTPS-only cookie once deployed
    maxAge: REMEMBER_MS          // overridden per login by "keep me signed in"
  }
}));

/* ---------------- helpers ---------------- */

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'not_authenticated' });
  next();
}
function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'not_authenticated' });
    if (roles.indexOf(req.session.role) === -1) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
// Shared keys an employee is allowed to write. Everything else org-wide stays
// admin-only.
const EMPLOYEE_WRITABLE = ['leaveRequests'];

// Mirrors the key rules the dashboard's own storage shim enforced.
function validKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length < 200 && !/[\s\/\\'"]/.test(k);
}
async function logChange(client, orgId, entity, ref, userId) {
  await client.query(
    'INSERT INTO change_log (org_id, entity, ref, changed_by) VALUES ($1,$2,$3,$4)',
    [orgId, entity, ref || null, userId || null]
  );
}

/* ---------------- auth ---------------- */

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });

  const { rows } = await pool.query(
    `SELECT id, org_id, email, password_hash, name, role, is_active
       FROM users
      WHERE lower(email) = $1
         OR lower(split_part(email, '@', 1)) = $1
         OR lower(COALESCE(name, '')) = $1
      ORDER BY CASE WHEN lower(email) = $1 THEN 0 ELSE 1 END, id
      LIMIT 1`,
    [email]
  );
  const u = rows[0];
  // Same response either way so the endpoint can't be used to enumerate emails.
  if (!u || !u.is_active || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.userId = u.id;
  req.session.orgId = u.org_id;
  req.session.role = u.role;
  /* "Keep me signed in" decides how long the cookie outlives the browser.
     Unchecked means a browser-session cookie, so a shared machine does not stay
     signed in after the window is closed. The password is never stored either
     way - this only extends the server session. */
  if (req.body && req.body.remember) {
    req.session.cookie.maxAge = REMEMBER_MS;
  } else {
    req.session.cookie.expires = false;
  }
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role } });
});

app.post('/api/logout', (req, res) => {
  if (req.session) req.session.destroy(() => {});
  res.clearCookie('hw.sid');
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'not_authenticated' });
  const { rows } = await pool.query(
    'SELECT id, email, name, role, org_id FROM users WHERE id = $1 AND is_active = TRUE',
    [req.session.userId]
  );
  if (!rows[0]) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ user: rows[0] });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  if (!rows[0] || !(await bcrypt.compare(String(currentPassword || ''), rows[0].password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const hash = await bcrypt.hash(String(newPassword), 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
  res.json({ ok: true });
});

/* ---------------- user admin ---------------- */

app.get('/api/users', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, name, role, is_active, last_login_at, created_at
       FROM users WHERE org_id = $1 ORDER BY email`,
    [req.session.orgId]
  );
  res.json({ users: rows });
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { email, password, name, role } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  const r = role === 'admin' ? 'admin' : 'employee';
  const n = String(name || '').trim();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'invalid_email' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'password_too_short' });
  if (r === 'employee' && !n) return res.status(400).json({ error: 'employee_name_required' });
  const hash = await bcrypt.hash(String(password), 12);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (org_id, email, password_hash, name, role)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, email, name, role, is_active, last_login_at, created_at`,
      [req.session.orgId, e, hash, n || 'Admin', r]   // hash was missing: 5 placeholders, 4 values
    );
    res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_exists' });
    throw err;
  }
});

app.patch('/api/users/:id', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role, is_active, password, name } = req.body || {};
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  const currentQ = await pool.query('SELECT id, role, is_active FROM users WHERE id = $1 AND org_id = $2', [id, req.session.orgId]);
  if (!currentQ.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (id === req.session.userId && role !== undefined && role !== 'admin') return res.status(400).json({ error: 'cannot_remove_own_admin' });
  if (id === req.session.userId && is_active === false) return res.status(400).json({ error: 'cannot_disable_self' });
  if (currentQ.rows[0].role === 'admin' && role === 'employee') {
    const admins = await pool.query("SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'admin' AND is_active = TRUE", [req.session.orgId]);
    if (admins.rows[0].n <= 1) return res.status(400).json({ error: 'last_admin' });
  }
  const sets = [], vals = [];
  if (role !== undefined) {
    if (!['admin','employee'].includes(role)) return res.status(400).json({ error: 'invalid_role' });
    vals.push(role); sets.push(`role = $${vals.length}`);
  }
  if (name !== undefined) {
    const n = String(name || '').trim();
    if (!n && role !== 'admin') return res.status(400).json({ error: 'employee_name_required' });
    vals.push(n || 'Admin'); sets.push(`name = $${vals.length}`);
  }
  if (typeof is_active === 'boolean') { vals.push(is_active); sets.push(`is_active = $${vals.length}`); }
  if (password !== undefined && String(password) !== '') {
    if (String(password).length < 8) return res.status(400).json({ error: 'password_too_short' });
    vals.push(await bcrypt.hash(String(password), 12)); sets.push(`password_hash = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(id, req.session.orgId);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND org_id = $${vals.length}
     RETURNING id, email, name, role, is_active, last_login_at, created_at`, vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ user: rows[0] });
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  if (id === req.session.userId) return res.status(400).json({ error: 'cannot_delete_self' });
  const target = await pool.query('SELECT id, role FROM users WHERE id = $1 AND org_id = $2', [id, req.session.orgId]);
  if (!target.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (target.rows[0].role === 'admin') {
    const admins = await pool.query("SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'admin' AND is_active = TRUE", [req.session.orgId]);
    if (admins.rows[0].n <= 1) return res.status(400).json({ error: 'last_admin' });
  }
  await pool.query('DELETE FROM users WHERE id = $1 AND org_id = $2', [id, req.session.orgId]);
  res.json({ ok: true });
});

/* ---------------- KV: backs window.storage ---------------- */

app.get('/api/kv/:key', requireAuth, async (req, res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({ error: 'bad_key' });
  const shared = req.query.shared !== 'false';
  const { rows } = await pool.query(
    shared
      ? 'SELECT key, value FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL'
      : 'SELECT key, value FROM kv WHERE org_id = $1 AND key = $2 AND user_id = $3',
    shared ? [req.session.orgId, key] : [req.session.orgId, key, req.session.userId]
  );
  if (!rows[0]) return res.json(null);   // storage.get resolves null when absent
  res.json({ key: rows[0].key, value: rows[0].value, shared });
});

app.put('/api/kv/:key', requireAuth, async (req, res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({ error: 'bad_key' });
  const shared = req.body && req.body.shared !== false;
  // Viewers are read-only for org-wide data, but must still be able to store
  // their own UI preferences, which are personal rows.
  // Leave requests are the exception: employees raise them, so they have to be
  // able to write that shared key or the request never reaches an admin.
  if (shared && req.session.role === 'employee' && EMPLOYEE_WRITABLE.indexOf(key) === -1) {
    return res.status(403).json({ error: 'read_only' });
  }
  const value = String((req.body && req.body.value) != null ? req.body.value : '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (shared) {
      await client.query(
        `INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, $2, $3, $4)
         ON CONFLICT (org_id, key) WHERE user_id IS NULL
         DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [req.session.orgId, key, value, req.session.userId]
      );
    } else {
      await client.query(
        `INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1,$2,$3,$4,$2)
         ON CONFLICT (org_id, user_id, key) WHERE user_id IS NOT NULL
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [req.session.orgId, req.session.userId, key, value]
      );
    }
    if (shared) await logChange(client, req.session.orgId, 'kv', key, req.session.userId);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ key, value, shared });
});

app.delete('/api/kv/:key', requireAuth, async (req, res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({ error: 'bad_key' });
  const shared = req.query.shared !== 'false';
  if (shared && req.session.role === 'employee') return res.status(403).json({ error: 'read_only' });
  await pool.query(
    shared
      ? 'DELETE FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL'
      : 'DELETE FROM kv WHERE org_id = $1 AND key = $2 AND user_id = $3',
    shared ? [req.session.orgId, key] : [req.session.orgId, key, req.session.userId]
  );
  res.json({ key, deleted: true, shared });
});

app.get('/api/kv', requireAuth, async (req, res) => {
  const prefix = String(req.query.prefix || '');
  const shared = req.query.shared !== 'false';
  const { rows } = await pool.query(
    shared
      ? 'SELECT key FROM kv WHERE org_id = $1 AND user_id IS NULL AND key LIKE $2'
      : 'SELECT key FROM kv WHERE org_id = $1 AND user_id = $3 AND key LIKE $2',
    shared ? [req.session.orgId, prefix + '%'] : [req.session.orgId, prefix + '%', req.session.userId]
  );
  res.json({ keys: rows.map(r => r.key), prefix, shared });
});

/* Bulk read — one request at boot instead of ~30 sequential gets. */
app.get('/api/kv-all', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT key, value FROM kv WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2)
     ORDER BY (user_id IS NULL) DESC`,  // personal overrides shared
    [req.session.orgId, req.session.userId]
  );
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  res.json({ values: out });
});

/* ---------------- employees + records ---------------- */

app.get('/api/dataset', requireAuth, async (req, res) => {
  const orgId = req.session.orgId;
  const emp = req.session.role === 'employee'
    ? await pool.query(
        `SELECT code, name, shift FROM employees WHERE org_id = $1 AND is_active = TRUE
         AND name = (SELECT name FROM users WHERE id = $2) ORDER BY id`, [orgId, req.session.userId]
      )
    : await pool.query(
        'SELECT code, name, shift FROM employees WHERE org_id = $1 AND is_active = TRUE ORDER BY id', [orgId]
      );
  const params = [orgId];
  let where = 'org_id = $1';
  if (req.session.role === 'employee') { params.push(req.session.userId); where += ` AND employee = (SELECT name FROM users WHERE id = $${params.length})`; }
  if (req.query.from) { params.push(req.query.from); where += ` AND day >= $${params.length}`; }
  if (req.query.to)   { params.push(req.query.to);   where += ` AND day <= $${params.length}`; }
  const rec = await pool.query(
    `SELECT employee, to_char(day,'YYYY-MM-DD') AS d, data FROM records WHERE ${where} ORDER BY day`, params
  );
  res.json({
    employees: emp.rows,
    records: rec.rows.map(r => Object.assign({ e: r.employee, d: r.d }, r.data))
  });
});

/* Save the current attendance dataset to Postgres. This is deliberately an upsert
   rather than a replace-all: concurrent users can import/edit without deleting
   rows another user has just added. The browser uses this after an import and
   whenever the attendance dataset is changed locally. */
app.put('/api/dataset', requireAuth, async (req, res) => {
  if (req.session.role === 'employee') return res.status(403).json({ error: 'read_only' });
  const employees = Array.isArray(req.body && req.body.employees) ? req.body.employees : [];
  const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
  const client = await pool.connect();
  let employeesUpserted = 0, recordsUpserted = 0;
  try {
    await client.query('BEGIN');
    for (const e of employees) {
      if (!e || !e.name) continue;
      await client.query(
        `INSERT INTO employees (org_id, code, name, shift) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, name) DO UPDATE SET code = EXCLUDED.code, shift = EXCLUDED.shift, is_active = TRUE`,
        [req.session.orgId, e.code || null, String(e.name), e.shift || null]
      );
      employeesUpserted++;
    }
    for (const r of records) {
      if (!r || !r.e || !r.d) continue;
      const data = Object.assign({}, r);
      delete data.e; delete data.d;
      await client.query(
        `INSERT INTO records (org_id, employee, day, data, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, employee, day)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [req.session.orgId, String(r.e), r.d, JSON.stringify(data), req.session.userId]
      );
      recordsUpserted++;
    }
    if (employeesUpserted) await logChange(client, req.session.orgId, 'employees', null, req.session.userId);
    if (recordsUpserted) await logChange(client, req.session.orgId, 'records', null, req.session.userId);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, employees: employeesUpserted, records: recordsUpserted });
});

/* Upsert a batch of records — used by the Excel import and by day edits.
   Per-row upsert (not replace-all) so concurrent editors don't wipe each
   other's work. */
app.post('/api/records', requireAuth, async (req, res) => {
  if (req.session.role === 'employee') return res.status(403).json({ error: 'read_only' });
  const records = (req.body && req.body.records) || [];
  if (!Array.isArray(records)) return res.status(400).json({ error: 'records_must_be_array' });
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    for (const r of records) {
      if (!r || !r.e || !r.d) continue;
      const data = Object.assign({}, r); delete data.e; delete data.d;
      await client.query(
        `INSERT INTO records (org_id, employee, day, data, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, employee, day)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [req.session.orgId, String(r.e), r.d, JSON.stringify(data), req.session.userId]
      );
      n++;
    }
    await logChange(client, req.session.orgId, 'records', null, req.session.userId);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true, upserted: n });
});

app.post('/api/employees', requireAuth, async (req, res) => {
  if (req.session.role === 'employee') return res.status(403).json({ error: 'read_only' });
  const employees = (req.body && req.body.employees) || [];
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    for (const e of employees) {
      if (!e || !e.name) continue;
      await client.query(
        `INSERT INTO employees (org_id, code, name, shift) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, name) DO UPDATE SET code = EXCLUDED.code, shift = EXCLUDED.shift`,
        [req.session.orgId, e.code || null, e.name, e.shift || null]
      );
      n++;
    }
    await logChange(client, req.session.orgId, 'employees', null, req.session.userId);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  res.json({ ok: true, upserted: n });
});

/* Live sync: clients poll this with the last id they saw. Cheap enough to hit
   every few seconds; returns immediately with nothing when idle. */
app.get('/api/changes', requireAuth, async (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const { rows } = await pool.query(
    `SELECT id, entity, ref, changed_by, extract(epoch from changed_at) AS at
     FROM change_log WHERE org_id = $1 AND id > $2 ORDER BY id LIMIT 200`,
    [req.session.orgId, since]
  );
  const { rows: head } = await pool.query(
    'SELECT COALESCE(MAX(id),0) AS max FROM change_log WHERE org_id = $1', [req.session.orgId]
  );
  res.json({
    changes: rows,
    cursor: Number(head[0].max),
    // so a client can ignore echoes of its own writes
    self: req.session.userId
  });
});

/* ---------------- static app ---------------- */

app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

pool.on('error', function (err) {
  console.error('pg pool error (recovering):', err && err.message);
});
process.on('unhandledRejection', function (err) {
  console.error('unhandled rejection (kept alive):', err && err.message);
});

if (require.main === module) {
  app.listen(PORT, () => console.log('listening on ' + PORT));
}
module.exports = { app, pool };
