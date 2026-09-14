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
/* Small bodies everywhere by default, so an unauthenticated request cannot make
   the server buffer 25MB. The import routes genuinely need the large limit, and
   they are skipped here rather than parsed twice: express.json marks the request
   once it has read it, so a second parser would be a no-op and the small limit
   would reject the import before it ever reached the route. */
const IMPORT_PATHS = ['/api/dataset', '/api/records', '/api/employees'];
const smallJson = express.json({ limit: '200kb' });
const bigJson = express.json({ limit: '25mb' });
app.use(function (req, res, next) {
  if (IMPORT_PATHS.indexOf(req.path) > -1) return next();
  return smallJson(req, res, next);
});

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

/* Who is calling, read fresh from the users table on every API request. The
   role used to be copied into the session at login and never looked at again,
   so disabling an account or demoting an admin changed nothing for a tab they
   already had open - for up to 30 days with "keep me signed in". */
app.use('/api', function (req, res, next) {
  if (!req.session || !req.session.userId) return next();
  if (req.path === '/login' || req.path === '/logout') return next();
  pool.query('SELECT role, is_active, org_id, name FROM users WHERE id = $1', [req.session.userId])
    .then(function (result) {
      const u = result.rows[0];
      if (!u || !u.is_active) {
        return req.session.destroy(function () {
          res.clearCookie('hw.sid');
          res.status(401).json({ error: 'not_authenticated' });
        });
      }
      if (req.session.role !== u.role) req.session.role = u.role;
      if (req.session.orgId !== u.org_id) req.session.orgId = u.org_id;
      req.user = u;
      next();
    })
    .catch(next);
});

/* Sign an account out everywhere, optionally keeping the session making the
   request. A failure here must not undo the change that asked for it. */
function endSessions(userId, keepSid) {
  return pool.query(
    "DELETE FROM session WHERE (sess->>'userId') = $1 AND sid <> $2",
    [String(userId), keepSid || '']
  ).catch(function (e) { console.error('could not end sessions for user ' + userId + ':', e.message); });
}

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
/* Three tiers of access:
     'admin'      super admin - everything, including managing accounts
     'admin_view' sees the whole admin side but cannot change any of it
     'employee'   own record only
   Read access is the same for both admin tiers; only writing separates them,
   so the checks below gate on canWrite rather than on the role name. */
const ROLES = ['admin', 'admin_view', 'employee'];
function isAdminArea(role) { return role === 'admin' || role === 'admin_view'; }
function canWrite(role) { return role === 'admin'; }

/* Shared keys a non-writer may still write. This is for employees raising their
   own leave request and nobody else: the whole array is written at once, so a
   view-only admin allowed through here could set status:'approved' and approve
   leave. They have no reason to touch it - they raise nothing from the admin
   view - so the exception is theirs alone. */
const EMPLOYEE_WRITABLE = ['leaveRequests'];
function mayWriteSharedKey(role, key) {
  if (canWrite(role)) return true;
  return role === 'employee' && EMPLOYEE_WRITABLE.indexOf(key) > -1;
}

/* What an employee account may read from the shared keys: its own entries and
   the few settings every calendar needs. The KV routes used to hand any signed-in
   account every shared key - salaries, pay rules, signatures, everyone's marks
   and requests. Anything not named here is hidden from employees. */
const EMP_KEYED_BY_DAY = ['overrides', 'halfDays', 'dayShifts', 'mispunchFlags', 'manualRecords',
                          'lateExcuses', 'earlyExcuses', 'manualLeave', 'leaveDeductions'];  // "Name|date"
const EMP_KEYED_BY_NAME = ['joinDates', 'satPolicy', 'shiftAssignments', 'empNames'];         // "Name"
const EMP_READABLE = ['officialLeaves', 'earlyThresholdMin', 'lateThresholdMin',
                      'weeklyLeverageMin', 'companyInfo', 'customShifts'];
const EMP_VISIBLE_KEYS = EMP_KEYED_BY_DAY.concat(EMP_KEYED_BY_NAME, EMP_READABLE, ['leaveRequests', 'signatures']);

function parseJson(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }
function ownRequests(value, name) {
  const all = parseJson(value);
  return Array.isArray(all) ? all.filter(function (r) { return r && r.empName === name; }) : [];
}
/* The shared value as an employee sees it, or undefined when it is hidden.
   requestsValue is the stored leaveRequests, needed to decide which signatures
   their own approved day-off forms print with. */
function valueForEmployee(key, value, name, requestsValue) {
  if (EMP_READABLE.indexOf(key) > -1) return value;
  if (key === 'leaveRequests') return JSON.stringify(ownRequests(value, name));
  const byDay = EMP_KEYED_BY_DAY.indexOf(key) > -1, byName = EMP_KEYED_BY_NAME.indexOf(key) > -1;
  if (byDay || byName || key === 'signatures') {
    const obj = parseJson(value);
    const out = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '{}';
    let approvers = null;
    if (key === 'signatures') {
      approvers = {};
      ownRequests(requestsValue, name).forEach(function (r) {
        if (r.status === 'approved' && r.approvedBy) approvers[String(r.approvedBy).trim().toLowerCase()] = true;
      });
    }
    Object.keys(obj).forEach(function (k) {
      const mine = approvers ? approvers[k] === true
                 : byName ? k === name
                 : k.split('|')[0] === name;
      if (mine) out[k] = obj[k];
    });
    return JSON.stringify(out);
  }
  return undefined;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function clip(v, n) { return String(v == null ? '' : v).slice(0, n); }
/* An employee saves the whole leaveRequests array, and used to be able to save
   anything in it: approve their own leave, or drop everyone else's requests.
   Their save is now merged into the stored array. They may add a new request of
   their own, always as pending, and answer a query on one of their own; every
   other entry stays exactly as stored. */
function mergeEmployeeRequests(storedValue, incomingValue, name) {
  const incoming = parseJson(incomingValue);
  if (!Array.isArray(incoming)) return null;
  const parsed = parseJson(storedValue);
  const out = Array.isArray(parsed) ? parsed : [];
  const byId = {};
  out.forEach(function (r) { if (r && r.id) byId[String(r.id)] = r; });
  const now = new Date().toISOString();
  incoming.forEach(function (r) {
    if (!r || typeof r !== 'object' || r.empName !== name || typeof r.id !== 'string') return;
    const cur = byId[r.id];
    if (!cur) {
      if (!/^req_[A-Za-z0-9_]{1,60}$/.test(r.id)) return;
      if (!DAY_RE.test(r.dateFrom) || !DAY_RE.test(r.dateTo) || r.dateTo < r.dateFrom) return;
      if (!/^[A-Za-z]{1,16}$/.test(String(r.leaveType || ''))) return;
      const fresh = {
        id: r.id, empName: name, dateFrom: r.dateFrom, dateTo: r.dateTo,
        leaveType: r.leaveType, message: clip(r.message, 2000), half: clip(r.half, 20),
        returnOn: DAY_RE.test(r.returnOn || '') ? r.returnOn : '',
        status: 'pending', adminNote: '', employeeReply: '', createdAt: now, updatedAt: now
      };
      out.push(fresh);
      byId[fresh.id] = fresh;
    } else if (cur.empName === name && cur.status === 'query'
               && typeof r.employeeReply === 'string' && r.employeeReply.trim()) {
      cur.employeeReply = clip(r.employeeReply.trim(), 2000);
      cur.status = 'pending';
      cur.updatedAt = now;
    }
  });
  return JSON.stringify(out);
}
/* Nothing in the dashboard deletes a request - they are archived - so an admin's
   save that lacks one is a copy loaded before an employee raised it. Keep it,
   rather than let the admin's older copy silently remove it. */
function keepNewerRequests(storedValue, incomingValue) {
  const stored = parseJson(storedValue), incoming = parseJson(incomingValue);
  if (!Array.isArray(stored) || !Array.isArray(incoming)) return incomingValue;
  const seen = {};
  incoming.forEach(function (r) { if (r && r.id) seen[String(r.id)] = true; });
  const missing = stored.filter(function (r) { return r && r.id && !seen[String(r.id)]; });
  return missing.length ? JSON.stringify(incoming.concat(missing)) : incomingValue;
}

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
  // Only failures count. An office signs in from one address around 9:30, and
  // counting successes locked out everyone after the twentieth person.
  skipSuccessfulRequests: true,
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
         /* users.name has no unique constraint and defaults to 'Admin', so a
            name is only accepted as a handle when exactly one account answers
            to it. Otherwise two people share a login and the lower id wins. */
         OR (lower(COALESCE(name, '')) = $1 AND (
               SELECT count(*) FROM users u2
                WHERE lower(COALESCE(u2.name, '')) = $1 AND u2.is_active
             ) = 1)
      ORDER BY CASE WHEN lower(email) = $1 THEN 0 ELSE 1 END, id
      LIMIT 1`,
    [email]
  );
  const u = rows[0];
  // Same response either way so the endpoint can't be used to enumerate emails.
  if (!u || !u.is_active || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  // A new session id at sign-in, so a cookie planted beforehand is not the one
  // that ends up signed in.
  await new Promise(function (resolve, reject) {
    req.session.regenerate(function (err) { return err ? reject(err) : resolve(); });
  });
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
  await endSessions(req.session.userId, req.sessionID);   // other devices sign in again
  res.json({ ok: true });
});

/* ---------------- user admin ---------------- */

app.get('/api/users', requireRole('admin', 'admin_view'), async (req, res) => {
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
  const r = ROLES.indexOf(role) > -1 ? role : 'employee';
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
      [req.session.orgId, e, hash, n || 'Admin', r]
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
  if (currentQ.rows[0].role === 'admin' && role !== undefined && role !== 'admin') {
    const admins = await pool.query("SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'admin' AND is_active = TRUE", [req.session.orgId]);
    if (admins.rows[0].n <= 1) return res.status(400).json({ error: 'last_admin' });
  }
  const sets = [], vals = [];
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
    vals.push(role); sets.push(`role = $${vals.length}`);
  }
  if (name !== undefined) {
    const n = String(name || '').trim();
    var finalRole = (role !== undefined) ? role : currentQ.rows[0].role;
    if (!n && finalRole === 'employee') return res.status(400).json({ error: 'employee_name_required' });
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
  // A reset password or a disabled account should not leave old sign-ins working.
  if ((password !== undefined && String(password) !== '') || is_active === false) {
    await endSessions(id, id === req.session.userId ? req.sessionID : '');
  }
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
  await endSessions(id, '');
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
  let value = rows[0].value;
  if (shared && req.session.role === 'employee') {
    let requests = null;
    if (key === 'signatures') {
      const rq = await pool.query(
        "SELECT value FROM kv WHERE org_id = $1 AND key = 'leaveRequests' AND user_id IS NULL", [req.session.orgId]);
      requests = rq.rows[0] ? rq.rows[0].value : null;
    }
    value = valueForEmployee(key, value, (req.user && req.user.name) || '', requests);
    if (value === undefined) return res.json(null);
  }
  res.json({ key: rows[0].key, value: value, shared });
});

app.put('/api/kv/:key', requireAuth, async (req, res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({ error: 'bad_key' });
  const shared = req.body && req.body.shared !== false;
  // Viewers are read-only for org-wide data, but must still be able to store
  // their own UI preferences, which are personal rows.
  // Leave requests are the exception: employees raise them, so they have to be
  // able to write that shared key or the request never reaches an admin.
  if (shared && !mayWriteSharedKey(req.session.role, key)) {
    return res.status(403).json({ error: 'read_only' });
  }
  let value = String((req.body && req.body.value) != null ? req.body.value : '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (shared && key === 'leaveRequests') {
      // Locked, so two people saving requests at once are merged one after the other.
      const cur = await client.query(
        'SELECT value FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL FOR UPDATE',
        [req.session.orgId, key]);
      const stored = cur.rows[0] ? cur.rows[0].value : '[]';
      if (req.session.role === 'employee') {
        const merged = mergeEmployeeRequests(stored, value, (req.user && req.user.name) || '');
        if (merged === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'bad_requests' }); }
        value = merged;
      } else {
        value = keepNewerRequests(stored, value);
      }
    }
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
  // Answer with what this account may see - the merged array holds everyone's requests.
  if (shared && req.session.role === 'employee') {
    value = valueForEmployee(key, value, (req.user && req.user.name) || '', null);
  }
  res.json({ key, value, shared });
});

app.delete('/api/kv/:key', requireAuth, async (req, res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({ error: 'bad_key' });
  const shared = req.query.shared !== 'false';
  if (shared && !canWrite(req.session.role)) return res.status(403).json({ error: 'read_only' });
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
  let keys = rows.map(r => r.key);
  if (shared && req.session.role === 'employee') keys = keys.filter(k => EMP_VISIBLE_KEYS.indexOf(k) > -1);
  res.json({ keys, prefix, shared });
});

/* Bulk read — one request at boot instead of ~30 sequential gets. */
app.get('/api/kv-all', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT key, value, (user_id IS NULL) AS shared FROM kv WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2)
     ORDER BY (user_id IS NULL) DESC`,  // personal overrides shared
    [req.session.orgId, req.session.userId]
  );
  const employee = req.session.role === 'employee';
  const name = (req.user && req.user.name) || '';
  let requests = null;
  if (employee) rows.forEach(r => { if (r.shared && r.key === 'leaveRequests') requests = r.value; });
  const out = {};
  rows.forEach(r => {
    if (!employee || !r.shared) { out[r.key] = r.value; return; }
    const v = valueForEmployee(r.key, r.value, name, requests);
    if (v !== undefined) out[r.key] = v;
  });
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
app.put('/api/dataset', requireAuth, bigJson, async (req, res) => {
  if (!canWrite(req.session.role)) return res.status(403).json({ error: 'read_only' });
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
app.post('/api/records', requireAuth, bigJson, async (req, res) => {
  if (!canWrite(req.session.role)) return res.status(403).json({ error: 'read_only' });
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

app.post('/api/employees', requireAuth, bigJson, async (req, res) => {
  if (!canWrite(req.session.role)) return res.status(403).json({ error: 'read_only' });
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
/* The SPA catch-all must not swallow the API: without this an unknown
   /api/... path returned the dashboard HTML with status 200, so client code
   saw success and failed further along. */
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  /* A body that is too large, or malformed JSON, is the caller's mistake, not a
     server fault. Returning 500 for those hid the real cause and filled the log
     with stack traces for something entirely expected. */
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', limit: err.limit });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' });
  }
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
