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
const crypto = require('crypto');
const zlib = require('zlib');
const totp = require('./totp');
const mailer = require('./mailer');

const PORT = process.env.PORT || 3000;
const REMEMBER_MS = 1000 * 60 * 60 * 24 * 30;   // "keep me signed in" window
const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production.');
  console.error('       A service created by hand starts with no environment at all. It needs:');
  console.error('         SESSION_SECRET  a long random string (Render can generate one)');
  console.error('         DATABASE_URL    the Postgres Internal Database URL');
  console.error('         NODE_ENV        production');
  console.error('       and, for the first admin account, ADMIN_EMAIL and ADMIN_PASSWORD.');
  console.error('       Start Command must be `npm start`, which creates the tables first.');
  process.exit(1);
}

if (isProd && !process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL must be set in production.');
  console.error('       Add the Render PostgreSQL connection string as the DATABASE_URL environment variable.');
  console.error('       Internal Database URL when the database is in the same Render account as this');
  console.error('       service; External Database URL when it is somewhere else.');
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
/* /api/mail/daily carries the picture of the record, a megabyte or two of it:
   parsed by the small limit first, every emailed screenshot came back 413 and
   the message went out without it. */
const IMPORT_PATHS = ['/api/dataset', '/api/records', '/api/employees', '/api/device/records',
                      '/api/mail/daily'];
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
  pool.query('SELECT role, is_active, org_id, name, email FROM users WHERE id = $1', [req.session.userId])
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
      const TIME_RE = /^\d{1,2}:\d{2}$/;
      const punch = r.leaveType === 'PUNCH';
      // A punch correction is one day, with at least one corrected time.
      if (punch && (r.dateTo !== r.dateFrom || !(TIME_RE.test(r.punchIn || '') || TIME_RE.test(r.punchOut || '')))) return;
      const fresh = {
        id: r.id, empName: name, dateFrom: r.dateFrom, dateTo: r.dateTo,
        leaveType: r.leaveType, message: clip(r.message, 2000), half: clip(r.half, 20),
        returnOn: DAY_RE.test(r.returnOn || '') ? r.returnOn : '',
        status: 'pending', adminNote: '', employeeReply: '', createdAt: now, updatedAt: now
      };
      if (punch) {
        fresh.punchIn = TIME_RE.test(r.punchIn || '') ? r.punchIn : '';
        fresh.punchOut = TIME_RE.test(r.punchOut || '') ? r.punchOut : '';
      }
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
/* ---------- change history and locked months ----------
   A shared value is a whole JSON blob, so "what changed" means comparing the
   stored blob with the incoming one entry by entry. The same comparison serves
   two purposes: the history of who changed which entry, and refusing a change
   to a month whose pay has been run and locked. */
const DAY_MAPS = ['overrides', 'halfDays', 'dayShifts', 'mispunchFlags', 'manualRecords', 'lateExcuses', 'earlyExcuses'];
const MONTH_MAPS = ['manualLeave', 'leaveDeductions'];                  // "Name|YYYY-MM"
function canon(v) {                                                   // key order must not count as a change
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
/* [{item, before, after}] for each entry that differs. Objects by key, arrays of
   things with an id (leave requests) by id, anything else as one value. */
function diffValue(beforeText, afterText) {
  if (beforeText === afterText) return [];
  const b = beforeText == null ? undefined : parseJson(beforeText);
  const a = parseJson(afterText);
  const out = [];
  const push = (item, bv, av) => out.push({ item, before: bv === undefined ? null : clip(canon(bv), 1000), after: av === undefined ? null : clip(canon(av), 1000) });
  if (isPlainObject(a) && (b === undefined || isPlainObject(b))) {
    const bo = b || {};
    Object.keys(Object.assign({}, bo, a)).forEach(k => { if (canon(bo[k]) !== canon(a[k])) push(k, bo[k], a[k]); });
  } else if (Array.isArray(a) && (b === undefined || Array.isArray(b)) && a.every(x => x && x.id)) {
    const byId = {};
    (b || []).forEach(x => { if (x && x.id) byId[x.id] = x; });
    a.forEach(x => { if (canon(byId[x.id]) !== canon(x)) push(String(x.id), byId[x.id], x); });
  } else if (canon(b) !== canon(a)) {
    out.push({ item: '', before: beforeText == null ? null : clip(beforeText, 1000), after: clip(afterText, 1000) });
  }
  return out;
}
// The month an entry belongs to, for the keys a locked month protects.
function entryMonth(key, item) {
  const part = String(item).split('|')[1] || '';
  if (DAY_MAPS.indexOf(key) > -1) return /^\d{4}-\d{2}-\d{2}$/.test(part) ? part.slice(0, 7) : null;
  if (MONTH_MAPS.indexOf(key) > -1) return /^\d{4}-\d{2}$/.test(part) ? part : null;
  if (key === 'officialLeaves') return /^\d{4}-\d{2}-\d{2}$/.test(item) ? String(item).slice(0, 7) : null;
  return null;
}
async function lockedMonthsOf(client, orgId) {
  const r = await client.query("SELECT value FROM kv WHERE org_id = $1 AND key = 'lockedMonths' AND user_id IS NULL", [orgId]);
  const v = r.rows[0] ? parseJson(r.rows[0].value) : null;
  return isPlainObject(v) ? v : {};
}
async function addHistory(client, orgId, userId, userName, area, changes) {
  for (const c of changes.slice(0, 300)) {
    await client.query(
      'INSERT INTO history (org_id, user_id, user_name, area, item, before_value, after_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orgId, userId || null, userName || null, area, c.item, c.before, c.after]);
  }
  if (changes.length > 300) {
    await client.query(
      'INSERT INTO history (org_id, user_id, user_name, area, item, before_value, after_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orgId, userId || null, userName || null, area, '', null, (changes.length - 300) + ' more changes in the same save']);
  }
}
/* Attendance rows, upserted, except in locked months. A whole-dataset save
   carries locked rows too, unchanged; those are skipped quietly. A locked row
   that would actually change is counted, so the page can say it was refused. */
async function upsertRecords(client, orgId, userId, records, locked) {
  const lockedList = Object.keys(locked || {});
  const existing = {};
  if (lockedList.length) {
    const r = await client.query(
      "SELECT employee, to_char(day,'YYYY-MM-DD') AS d, data FROM records WHERE org_id = $1 AND to_char(day,'YYYY-MM') = ANY($2)",
      [orgId, lockedList]);
    r.rows.forEach(x => { existing[x.employee + '|' + x.d] = x.data; });
  }
  let upserted = 0, lockedChanged = 0;
  for (const r of records) {
    if (!r || !r.e || !DAY_RE.test(String(r.d || ''))) continue;
    const data = Object.assign({}, r); delete data.e; delete data.d;
    if (locked && locked[String(r.d).slice(0, 7)]) {
      const had = existing[r.e + '|' + r.d];
      if (had === undefined || canon(had) !== canon(data)) lockedChanged++;
      continue;
    }
    await client.query(
      `INSERT INTO records (org_id, employee, day, data, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, employee, day)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [orgId, String(r.e), r.d, JSON.stringify(data), userId || null]);
    upserted++;
  }
  return { upserted, lockedChanged };
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
  const ts = await twoStepOf(u.id);
  // A new session id at sign-in, so a cookie planted beforehand is not the one
  // that ends up signed in.
  await regenerateSession(req);
  const remember = !!(req.body && req.body.remember);
  if (ts.enabled) {
    /* The password was right, but this session is not signed in until the code
       from the authenticator app is given too. Nothing but POST
       /api/login/two-step reads this. */
    req.session.pendingTwoStep = { userId: u.id, at: Date.now(), tries: 0, remember };
    return res.json({ twoStep: true });
  }
  await finishLogin(req, u, remember);
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role } });
});

function regenerateSession(req) {
  return new Promise(function (resolve, reject) {
    req.session.regenerate(function (err) { return err ? reject(err) : resolve(); });
  });
}
async function finishLogin(req, u, remember) {
  req.session.userId = u.id;
  req.session.orgId = u.org_id;
  req.session.role = u.role;
  /* "Keep me signed in" decides how long the cookie outlives the browser.
     Unchecked means a browser-session cookie, so a shared machine does not stay
     signed in after the window is closed. The password is never stored either
     way - this only extends the server session. */
  if (remember) {
    req.session.cookie.maxAge = REMEMBER_MS;
  } else {
    req.session.cookie.expires = false;
  }
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
}

/* ---------------- two-step sign-in ----------------
   Optional, per account: after the password, a 6-digit code from an
   authenticator app. Ten one-time recovery codes cover a lost phone; after
   that another super admin can switch it off for the account (Users panel),
   and if the only super admin is locked out, RESET_TWO_STEP=<email> in Render
   switches it off on the next deploy (migrate.js). */
const TWO_STEP_ROLES = ['admin', 'admin_view'];
const PENDING_TWO_STEP_MS = 5 * 60 * 1000;
/* Failed codes are counted per account, not per address or session: ten in a
   row lock two-step sign-in (and switching it off) for 15 minutes, whoever is
   asking and from wherever. Re-entering the password does not reset it. */
const TWO_STEP_MAX_FAILS = 10;
async function twoStepOf(userId) {
  const { rows } = await pool.query(
    `SELECT totp_enabled, totp_secret, totp_last_step, totp_recovery,
            (totp_locked_until IS NOT NULL AND totp_locked_until > now()) AS locked
       FROM users WHERE id = $1`, [userId]);
  const r = rows[0] || {};
  const recovery = parseJson(r.totp_recovery);
  return {
    enabled: !!r.totp_enabled,
    secret: r.totp_secret || null,
    lastStep: r.totp_last_step == null ? null : Number(r.totp_last_step),
    recovery: Array.isArray(recovery) ? recovery : [],
    rawRecovery: r.totp_recovery == null ? '' : String(r.totp_recovery),
    locked: !!r.locked
  };
}
async function noteTwoStepFailure(userId) {
  await pool.query(
    `UPDATE users SET totp_fail_count = COALESCE(totp_fail_count, 0) + 1,
            totp_locked_until = CASE WHEN COALESCE(totp_fail_count, 0) + 1 >= $2
                                     THEN now() + interval '15 minutes' ELSE totp_locked_until END
      WHERE id = $1`, [userId, TWO_STEP_MAX_FAILS]);
}
/* A code from the app, or a recovery code. What to write back when it passes:
   the step used (so it cannot be replayed) or the recovery codes left. */
function checkTwoStepCode(ts, code) {
  const step = totp.verify(ts.secret, code, ts.lastStep);
  if (step !== -1) return { ok: true, step, recovery: ts.recovery, usedRecovery: false };
  const left = totp.useRecovery(ts.recovery, code);
  if (left) return { ok: true, step: ts.lastStep, recovery: left, usedRecovery: true };
  return { ok: false };
}
/* Only if nothing changed since the code was checked: two requests racing with
   the same code (or recovery code) cannot both pass, and a slower one cannot
   write back a spent recovery code. False means another request got there first. */
async function saveTwoStepUse(userId, orgId, ts, result) {
  const r = await pool.query(
    `UPDATE users SET totp_last_step = $1, totp_recovery = $2, totp_fail_count = 0, totp_locked_until = NULL
      WHERE id = $3 AND org_id = $4
        AND totp_last_step IS NOT DISTINCT FROM $5::bigint AND COALESCE(totp_recovery, '') = $6
      RETURNING id`,
    [result.step, JSON.stringify(result.recovery), userId, orgId, ts.lastStep, ts.rawRecovery]);
  return r.rows.length === 1;
}
// Per signed-in account, for the routes that take a password or a code.
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => 'user:' + ((req.session && req.session.userId) || 'none'),
  validate: false,
  message: { error: 'too_many_attempts' }
});

app.post('/api/login/two-step', loginLimiter, async (req, res) => {
  const pending = req.session && req.session.pendingTwoStep;
  if (!pending || Date.now() - pending.at > PENDING_TWO_STEP_MS) {
    if (req.session) delete req.session.pendingTwoStep;
    return res.status(401).json({ error: 'two_step_expired' });
  }
  const { rows } = await pool.query(
    'SELECT id, email, name, role, org_id FROM users WHERE id = $1 AND is_active = TRUE', [pending.userId]);
  const u = rows[0];
  if (!u) { delete req.session.pendingTwoStep; return res.status(401).json({ error: 'two_step_expired' }); }
  const ts = await twoStepOf(u.id);
  if (ts.locked) return res.status(429).json({ error: 'two_step_locked' });
  const result = ts.enabled ? checkTwoStepCode(ts, req.body && req.body.code) : { ok: false };
  if (!result.ok || !(await saveTwoStepUse(u.id, u.org_id, ts, result))) {
    await noteTwoStepFailure(u.id);
    pending.tries = (pending.tries || 0) + 1;
    if (pending.tries >= 5) {
      delete req.session.pendingTwoStep;
      return res.status(401).json({ error: 'two_step_expired' });
    }
    return res.status(401).json({ error: 'invalid_code', triesLeft: 5 - pending.tries });
  }
  await regenerateSession(req);
  await finishLogin(req, u, !!pending.remember);
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role },
             recoveryLeft: result.usedRecovery ? result.recovery.length : undefined });
});

app.get('/api/two-step', requireAuth, async (req, res) => {
  const ts = await twoStepOf(req.session.userId);
  res.json({ enabled: ts.enabled, recoveryLeft: ts.enabled ? ts.recovery.length : 0,
             available: TWO_STEP_ROLES.includes(req.session.role) });
});

/* Step 1 of turning it on: the password again, then a new secret for the app.
   It is not in force until a code from the app proves the app has it. */
app.post('/api/two-step/setup', requireRole(...TWO_STEP_ROLES), accountLimiter, async (req, res) => {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  if (!rows[0] || !(await bcrypt.compare(String((req.body && req.body.password) || ''), rows[0].password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const ts = await twoStepOf(req.session.userId);
  if (ts.enabled) return res.status(409).json({ error: 'already_enabled' });
  const secret = totp.newSecret();
  await pool.query('UPDATE users SET totp_secret = $1 WHERE id = $2 AND org_id = $3',
    [secret, req.session.userId, req.session.orgId]);
  const me = await pool.query('SELECT id, email, name, role, org_id FROM users WHERE id = $1 AND is_active = TRUE', [req.session.userId]);
  const account = (me.rows[0] && me.rows[0].email) || 'account';
  res.json({ secret, uri: totp.otpauthUri(secret, account, 'HW Attendance') });
});

// Step 2: a code from the app. Returns the recovery codes, shown this once.
app.post('/api/two-step/enable', requireRole(...TWO_STEP_ROLES), accountLimiter, async (req, res) => {
  const ts = await twoStepOf(req.session.userId);
  if (ts.enabled) return res.status(409).json({ error: 'already_enabled' });
  if (!ts.secret) return res.status(400).json({ error: 'setup_first' });
  const step = totp.verify(ts.secret, req.body && req.body.code, null);
  if (step === -1) return res.status(401).json({ error: 'invalid_code' });
  const codes = totp.newRecoveryCodes(10);
  await pool.query(
    'UPDATE users SET totp_enabled = $1, totp_last_step = $2, totp_recovery = $3 WHERE id = $4 AND org_id = $5',
    [true, step, JSON.stringify(codes.map(totp.hashRecovery)), req.session.userId, req.session.orgId]);
  await endSessions(req.session.userId, req.sessionID);   // other devices sign in again, with a code
  res.json({ ok: true, recoveryCodes: codes });
});

// Switching it off asks for the password and a current code (or a recovery code).
app.post('/api/two-step/disable', requireAuth, accountLimiter, async (req, res) => {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  if (!rows[0] || !(await bcrypt.compare(String((req.body && req.body.password) || ''), rows[0].password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const ts = await twoStepOf(req.session.userId);
  if (!ts.enabled) return res.json({ ok: true });
  if (ts.locked) return res.status(429).json({ error: 'two_step_locked' });
  if (!checkTwoStepCode(ts, req.body && req.body.code).ok) {
    await noteTwoStepFailure(req.session.userId);
    return res.status(401).json({ error: 'invalid_code' });
  }
  await pool.query(
    'UPDATE users SET totp_enabled = $1, totp_secret = $2, totp_last_step = $3, totp_recovery = $4 WHERE id = $5 AND org_id = $6',
    [false, null, null, null, req.session.userId, req.session.orgId]);
  res.json({ ok: true });
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

app.post('/api/change-password', requireAuth, accountLimiter, async (req, res) => {
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
    `SELECT id, email, name, role, is_active, last_login_at, created_at, totp_enabled AS two_step
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
  const { role, is_active, password, name, resetTwoStep } = req.body || {};
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  /* Another super admin's lost phone: switch two-step off for them, so they
     can sign in with the password and set it up again. Your own account is
     switched off from "Your sign-in", which asks for a code. */
  if (resetTwoStep === true) {
    if (id === req.session.userId) return res.status(400).json({ error: 'reset_own_two_step' });
    const t = await pool.query('SELECT id, role, is_active FROM users WHERE id = $1 AND org_id = $2', [id, req.session.orgId]);
    if (!t.rows[0]) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      'UPDATE users SET totp_enabled = $1, totp_secret = $2, totp_last_step = $3, totp_recovery = $4, totp_fail_count = $5, totp_locked_until = $6 WHERE id = $7 AND org_id = $8',
      [false, null, null, null, 0, null, id, req.session.orgId]);
    await endSessions(id, '');
    return res.json({ ok: true });
  }
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
      ? 'SELECT key, value, version FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL'
      : 'SELECT key, value, version FROM kv WHERE org_id = $1 AND key = $2 AND user_id = $3',
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
  res.json({ key: rows[0].key, value: value, shared, version: Number(rows[0].version) });
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
  /* The version of this key the page last read or wrote. Shared values are
     whole JSON blobs, so two people saving one used to mean the second silently
     replaced the first's change. A save made from an older copy is now refused
     with 409 and the page says so. Omitted = the old unchecked save. */
  const base = req.body && req.body.baseVersion;
  const baseVersion = (typeof base === 'number' && Number.isFinite(base)) ? base : null;
  let version = null;
  let requestsBefore = null;                 // for the email about a new request
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (shared) {
      // Locked, so saves of one key happen one after the other.
      const cur = await client.query(
        'SELECT value, version FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL FOR UPDATE',
        [req.session.orgId, key]);
      const row = cur.rows[0];
      if (key === 'leaveRequests') {
        requestsBefore = row ? row.value : '[]';
        // Merged on the server rather than refused - see mergeEmployeeRequests.
        const stored = row ? row.value : '[]';
        if (req.session.role === 'employee') {
          const merged = mergeEmployeeRequests(stored, value, (req.user && req.user.name) || '');
          if (merged === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'bad_requests' }); }
          value = merged;
        } else {
          value = keepNewerRequests(stored, value);
        }
      } else if (baseVersion !== null && row && Number(row.version) !== baseVersion) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'conflict', key, version: Number(row.version) });
      }
      var changes = diffValue(row ? row.value : null, value);
      /* A month whose pay has been run is locked. A save that changes any of its
         days - a mark, a part-day, an excuse, a manual entry - is refused whole,
         naming the months, rather than partly applied. */
      if (key !== 'lockedMonths' && changes.length &&
          (DAY_MAPS.indexOf(key) > -1 || MONTH_MAPS.indexOf(key) > -1 || key === 'officialLeaves')) {
        const locked = await lockedMonthsOf(client, req.session.orgId);
        const hit = {};
        changes.forEach(c => { const m = entryMonth(key, c.item); if (m && locked[m]) hit[m] = true; });
        if (Object.keys(hit).length) {
          await client.query('ROLLBACK');
          return res.status(423).json({ error: 'month_locked', key, months: Object.keys(hit).sort() });
        }
      }
      const up = await client.query(
        `INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, $2, $3, $4)
         ON CONFLICT (org_id, key) WHERE user_id IS NULL
         DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by,
                       version = kv.version + 1
         RETURNING version`,
        [req.session.orgId, key, value, req.session.userId]
      );
      version = Number(up.rows[0].version);
    } else {
      const up = await client.query(
        `INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1,$2,$3,$4,$2)
         ON CONFLICT (org_id, user_id, key) WHERE user_id IS NOT NULL
         DO UPDATE SET value = EXCLUDED.value, updated_at = now(), version = kv.version + 1
         RETURNING version`,
        [req.session.orgId, req.session.userId, key, value]
      );
      version = Number(up.rows[0].version);
    }
    if (shared) {
      await logChange(client, req.session.orgId, 'kv', key, req.session.userId);
      if (changes && changes.length) {
        await addHistory(client, req.session.orgId, req.session.userId,
          (req.user && req.user.name) || ('user ' + req.session.userId), key, changes);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  /* A request that has just been raised is emailed to the admins, with its
     Approve and Reject buttons. After the commit and not awaited: the save has
     already succeeded, and a slow mail server must not hold the answer up. */
  if (shared && key === 'leaveRequests' && requestsBefore !== null) {
    const fresh = newPendingRequests(requestsBefore, value);
    if (fresh.length) notifyNewRequests(req.session.orgId, fresh);
  }
  // Answer with what this account may see - the merged array holds everyone's requests.
  if (shared && req.session.role === 'employee') {
    value = valueForEmployee(key, value, (req.user && req.user.name) || '', null);
  }
  res.json({ key, value, shared, version });
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
  res.set('Cache-Control', 'no-cache');
  const { rows } = await pool.query(
    `SELECT key, value, version, (user_id IS NULL) AS shared FROM kv WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2)
     ORDER BY (user_id IS NULL) DESC`,  // personal overrides shared
    [req.session.orgId, req.session.userId]
  );
  const employee = req.session.role === 'employee';
  const name = (req.user && req.user.name) || '';
  let requests = null;
  if (employee) rows.forEach(r => { if (r.shared && r.key === 'leaveRequests') requests = r.value; });
  const out = {}, versions = {};
  rows.forEach(r => {
    if (!employee || !r.shared) { out[r.key] = r.value; if (r.shared) versions[r.key] = Number(r.version); return; }
    const v = valueForEmployee(r.key, r.value, name, requests);
    if (v !== undefined) { out[r.key] = v; versions[r.key] = Number(r.version); }
  });
  res.json({ values: out, versions });
});

/* ---------------- employees + records ---------------- */

app.get('/api/dataset', requireAuth, async (req, res) => {
  /* Every attendance row the browser can see, re-read whenever anyone edits
     anything. Express hashes the answer into an ETag; this asks the browser to
     check it each time, so an unchanged dataset costs a 304 rather than the
     whole table again. */
  res.set('Cache-Control', 'no-cache');
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
  /* ?replace=1 is a restore: the attendance becomes exactly what was sent.
     An upsert alone could never undo an import - rows the import added stayed -
     so Undo import and Restore brought everything back except the attendance.
     Only the dashboard's restore asks for it, after the person confirms, and an
     empty payload is refused rather than taken as "delete everything". */
  const replace = req.query.replace === '1';
  if (replace && !records.length) return res.status(400).json({ error: 'nothing_to_restore' });
  const client = await pool.connect();
  let employeesUpserted = 0, result = { upserted: 0, lockedChanged: 0 };
  try {
    await client.query('BEGIN');
    const locked = await lockedMonthsOf(client, req.session.orgId);
    const lockedList = Object.keys(locked);
    // A restore never reaches into a locked month: those rows stay as paid.
    if (replace) {
      await client.query(
        "DELETE FROM records WHERE org_id = $1 AND NOT (to_char(day,'YYYY-MM') = ANY($2))",
        [req.session.orgId, lockedList]);
    }
    for (const e of employees) {
      if (!e || !e.name) continue;
      await client.query(
        `INSERT INTO employees (org_id, code, name, shift) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, name) DO UPDATE SET code = EXCLUDED.code, shift = EXCLUDED.shift, is_active = TRUE`,
        [req.session.orgId, e.code || null, String(e.name), e.shift || null]
      );
      employeesUpserted++;
    }
    result = await upsertRecords(client, req.session.orgId, req.session.userId, records, locked);
    if (employeesUpserted) await logChange(client, req.session.orgId, 'employees', null, req.session.userId);
    if (result.upserted) await logChange(client, req.session.orgId, 'records', null, req.session.userId);
    if (replace) {
      await addHistory(client, req.session.orgId, req.session.userId, (req.user && req.user.name) || null,
        'records', [{ item: '', before: null, after: 'Attendance restored from a backup: ' + result.upserted + ' rows' }]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, employees: employeesUpserted, records: result.upserted, lockedChanged: result.lockedChanged });
});

/* Upsert a batch of records — used by the Excel import and by day edits.
   Per-row upsert (not replace-all) so concurrent editors don't wipe each
   other's work. */
app.post('/api/records', requireAuth, bigJson, async (req, res) => {
  if (!canWrite(req.session.role)) return res.status(403).json({ error: 'read_only' });
  const records = (req.body && req.body.records) || [];
  if (!Array.isArray(records)) return res.status(400).json({ error: 'records_must_be_array' });
  const client = await pool.connect();
  let result = { upserted: 0, lockedChanged: 0 };
  try {
    await client.query('BEGIN');
    result = await upsertRecords(client, req.session.orgId, req.session.userId, records,
                                 await lockedMonthsOf(client, req.session.orgId));
    await logChange(client, req.session.orgId, 'records', null, req.session.userId);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true, upserted: result.upserted, lockedChanged: result.lockedChanged });
});

/* ---------------- script errors from browsers ----------------
   Reported by hw-sync.js from the shell and the dashboard. Signed-in people
   only: anyone could post before, filling the database and putting their own
   words in admins' alerts. Rate limited, small, capped per hour, and only the
   error text is kept - never form contents. */
const errorLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const CLIENT_ERRORS_PER_HOUR = 500;
app.post('/api/client-errors', errorLimiter, async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(204).end();   // not stored
  const b = req.body || {};
  const message = clip(b.message, 500).trim();
  if (!message) return res.status(400).json({ error: 'no_message' });
  const recent = await pool.query("SELECT count(*)::int AS n FROM client_errors WHERE first_at > now() - interval '1 hour'");
  if (recent.rows[0] && recent.rows[0].n >= CLIENT_ERRORS_PER_HOUR) return res.json({ ok: true, dropped: true });
  const source = clip(b.source, 300), stack = clip(b.stack, 4000), page = clip(b.page, 60), ua = clip(req.headers['user-agent'], 300);
  const line = Number.isFinite(+b.line) ? Math.max(0, Math.min(10000000, Math.round(+b.line))) : null;
  const userId = (req.session && req.session.userId) || null;
  const orgId = (req.session && req.session.orgId) || null;
  const userName = (req.user && req.user.name) || null;
  const same = await pool.query(
    `UPDATE client_errors SET count = count + 1, last_at = now()
      WHERE message = $1 AND COALESCE(source,'') = $2 AND COALESCE(line,-1) = $3
        AND COALESCE(user_id,-1) = $4 AND last_at > now() - interval '1 hour'
      RETURNING id`, [message, source, line === null ? -1 : line, userId || -1]);
  if (!same.rows.length) {
    await pool.query(
      `INSERT INTO client_errors (org_id, user_id, user_name, message, source, line, stack, page, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [orgId, userId, userName, message, source, line, stack, page, ua]);
    if (Math.random() < 0.05) await pool.query("DELETE FROM client_errors WHERE last_at < now() - interval '30 days'");
  }
  res.json({ ok: true });
});
app.get('/api/client-errors', requireRole('admin', 'admin_view'), async (req, res) => {
  const hours = Math.min(24 * 30, Math.max(1, parseInt(req.query.hours, 10) || 24));
  const { rows } = await pool.query(
    `SELECT id, first_at, last_at, count, user_name, message, source, line, page FROM client_errors
      WHERE last_at > now() - ($1 || ' hours')::interval AND org_id = $2
      ORDER BY last_at DESC LIMIT 200`, [String(hours), req.session.orgId]);
  res.json({ errors: rows });
});

/* Who changed what. Admins only; the day view asks for one entry ("Name|date"). */
app.get('/api/history', requireRole('admin', 'admin_view'), async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const params = [req.session.orgId];
  let where = 'org_id = $1';
  if (req.query.item) { params.push(String(req.query.item)); where += ` AND item = $${params.length}`; }
  if (req.query.area) { params.push(String(req.query.area)); where += ` AND area = $${params.length}`; }
  if (req.query.before) { params.push(parseInt(req.query.before, 10) || 0); where += ` AND id < $${params.length}`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, at, user_name, area, item, before_value, after_value FROM history WHERE ${where}
     ORDER BY id DESC LIMIT $${params.length}`, params);
  res.json({ history: rows });
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
/* ---------------- the office PC ----------------
   The office PC has no user and no session. It proves itself with SYNC_TOKEN, a
   long random value set in Render's environment and kept in a file on that PC,
   outside the repository. Unset, these routes answer 503 and do nothing. */
function requireDevice(req, res, next) {
  const token = String(process.env.SYNC_TOKEN || '');
  if (token.length < 32) return res.status(503).json({ error: 'device_sync_not_configured' });
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ error: 'bad_device_token' });
  }
  next();
}
const deviceLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
async function deviceOrgId() {
  const { rows } = await pool.query('SELECT id FROM orgs ORDER BY id LIMIT 1');
  return rows[0] ? rows[0].id : null;
}

/* Punches straight from the office PC, parsed there by the dashboard's own
   import code. Attendance used to reach the server only when an admin had the
   dashboard open with the watched folder connected, so the site was as old as
   the last time someone looked. This does what an import of that file does:
   each person's day is replaced by the file's row, people new to the file are
   added, and nothing else - marks and manual entries - is touched. */
app.post('/api/device/records', deviceLimiter, requireDevice, bigJson, async (req, res) => {
  const orgId = await deviceOrgId();
  if (!orgId) return res.status(503).json({ error: 'no_org' });
  const records = Array.isArray(req.body && req.body.records) ? req.body.records : null;
  const employees = Array.isArray(req.body && req.body.employees) ? req.body.employees : [];
  if (!records || !records.length) return res.status(400).json({ error: 'no_records' });
  if (records.length > 20000) return res.status(413).json({ error: 'too_many_records' });
  const client = await pool.connect();
  let n = 0, added = 0;
  try {
    await client.query('BEGIN');
    for (const e of employees) {
      if (!e || !e.name || e.name === 'Card') continue;
      const r = await client.query(
        `INSERT INTO employees (org_id, code, name, shift) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, name) DO NOTHING`,
        [orgId, e.code || null, String(e.name), e.shift || '9:00-6:00']);
      added += r.rowCount || 0;
    }
    const usable = records.filter(r => r && typeof r.e === 'string' && r.e && r.e !== 'Card');
    const locked = await lockedMonthsOf(client, orgId);
    const result = await upsertRecords(client, orgId, null, usable, locked);   // a paid month is never re-imported
    n = result.upserted;
    const status = JSON.stringify({
      at: new Date().toISOString(), rows: n, employeesAdded: added,
      newestPunch: String((req.body && req.body.newestPunch) || ''), source: 'office-pc'
    });
    await client.query(
      `INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, 'deviceStatus', $2, NULL)
       ON CONFLICT (org_id, key) WHERE user_id IS NULL
       DO UPDATE SET value = EXCLUDED.value, updated_at = now(), version = kv.version + 1`,
      [orgId, status]);
    await logChange(client, orgId, 'records', 'office-pc', null);
    if (added) await logChange(client, orgId, 'employees', 'office-pc', null);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true, records: n, employeesAdded: added });
});

/* A full copy of the data, for the office PC to keep. The database is on
   Render's free plan, which expires, and backups otherwise only ever happened in
   a browser. Password hashes are included so accounts can be restored; the
   file is as sensitive as the database and is kept outside the repository. */
app.get('/api/device/backup', deviceLimiter, requireDevice, async (req, res) => {
  const orgId = await deviceOrgId();
  if (!orgId) return res.status(503).json({ error: 'no_org' });
  const q = (sql) => pool.query(sql, [orgId]).then(r => r.rows);
  const dump = {
    _type: 'hw-attendance-db-backup', _version: 1, exportedAt: new Date().toISOString(),
    orgs: await pool.query('SELECT * FROM orgs WHERE id = $1', [orgId]).then(r => r.rows),
    users: await q('SELECT id, org_id, email, password_hash, name, role, is_active, created_at, last_login_at FROM users WHERE org_id = $1'),
    kv: await q('SELECT user_id, key, value, updated_at, version FROM kv WHERE org_id = $1'),
    employees: await q('SELECT code, name, shift, is_active FROM employees WHERE org_id = $1'),
    records: await q("SELECT employee, to_char(day,'YYYY-MM-DD') AS day, data, updated_at FROM records WHERE org_id = $1 ORDER BY day")
  };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)));
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Cache-Control', 'no-store');
  res.send(gz);
});

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

/* ------------------------------------------------------------------
   Email (Resend)

   A daily summary of the day's attendance, a note when somebody raises a
   request, and a note when leave was taken without one. The request notes
   carry Approve and Reject buttons: a signed link that opens a page asking
   once, so a decision can be made from a phone without signing in.

   Nothing is sent unless RESEND_API_KEY and RESEND_FROM are set. What goes
   where is in the shared key `mailSettings`; recipients default to every
   active admin account.
   ------------------------------------------------------------------ */
const MAIL_DEFAULTS = {
  daily: true, dailyAt: '19:30', requests: true, unrequested: true,
  to: [], cc: [],
  /* The words are the office's own. Left empty, the message reads as it always
     did; {date} {present} {remote} {leave} {missing} {late} {org} stand in for
     the day's figures in the subject. */
  subject: '', intro: '', footer: '',
  sections: { tally: true, late: true, shifts: true, wfh: true, visits: true, table: true, shot: true }
};
const NO_ADDRESS = 'No admin account has an email address on it. Add one in Users, or type an address in the box below.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function mailSettings(orgId) {
  const r = await pool.query("SELECT value FROM kv WHERE org_id = $1 AND key = 'mailSettings' AND user_id IS NULL", [orgId]);
  const v = r.rows[0] ? parseJson(r.rows[0].value) : null;
  const s = Object.assign({}, MAIL_DEFAULTS, isPlainObject(v) ? v : {});
  s.to = (Array.isArray(s.to) ? s.to : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20);
  s.cc = (Array.isArray(s.cc) ? s.cc : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20);
  s.subject = String(s.subject || '').slice(0, 200);
  s.intro = String(s.intro || '').slice(0, 2000);
  s.footer = String(s.footer || '').slice(0, 2000);
  s.sections = Object.assign({}, MAIL_DEFAULTS.sections, isPlainObject(s.sections) ? s.sections : {});
  if (!/^\d{1,2}:\d{2}$/.test(String(s.dailyAt))) s.dailyAt = MAIL_DEFAULTS.dailyAt;
  return s;
}
/* Every active super admin, plus anyone named in the settings. A view admin is
   left out: they cannot act on the buttons anyway. */
async function mailRecipients(orgId, settings) {
  const r = await pool.query(
    "SELECT email FROM users WHERE org_id = $1 AND is_active AND role = 'admin' ORDER BY id", [orgId]);
  const out = [];
  r.rows.forEach(x => { if (EMAIL_RE.test(String(x.email || '')) && out.indexOf(x.email) === -1) out.push(x.email); });
  (settings.to || []).forEach(e => { if (out.indexOf(e) === -1) out.push(e); });
  return out;
}
/* The office is in India and the server is on UTC, so the day an email is
   about - and the hour it is due - are worked out at +05:30. */
const IST_MS = 5.5 * 3600 * 1000;
function istParts(now) {
  const d = new Date((now || Date.now()) + IST_MS);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function hhmmToMin(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? (+m[1]) * 60 + (+m[2]) : 19 * 60 + 30; }
function orgNameOf(companyInfo) {
  const c = parseJson(companyInfo);
  return (c && (c.name || c.company)) ? String(c.name || c.company) : 'Attendance';
}

/* Who the portal is showing. The selection lives per person (`visibleEmployees`,
   a name -> true/false map), so the scheduled message follows the most recently
   saved admin selection; a message sent from the dashboard carries its own list.
   An employee missing from the map is hidden, exactly as the dashboard reads it. */
async function shownEmployees(orgId) {
  const r = await pool.query(
    `SELECT kv.value FROM kv JOIN users u ON u.id = kv.user_id
      WHERE kv.org_id = $1 AND kv.key = 'visibleEmployees' AND u.role = 'admin' AND u.is_active
      ORDER BY kv.updated_at DESC LIMIT 1`, [orgId]);
  const v = r.rows[0] ? parseJson(r.rows[0].value) : null;
  return isPlainObject(v) ? v : null;
}

async function sharedKeys(orgId, keys) {
  const r = await pool.query(
    'SELECT key, value FROM kv WHERE org_id = $1 AND user_id IS NULL AND key = ANY($2)', [orgId, keys]);
  const out = {};
  r.rows.forEach(x => { out[x.key] = x.value; });
  return out;
}
function linksFor(payload) {
  const base = mailer.baseUrl();
  const secret = process.env.SESSION_SECRET || 'dev-secret';
  const mk = act => base + '/e/' + mailer.actionToken(Object.assign({ act }, payload), secret);
  return { approve: mk('approve'), reject: mk('reject') };
}
/* Leave marked on the record that no request accounts for, newest first. The
   dashboard's own rule: a rejected request or a punch correction covers nothing,
   and a part-day is only covered by a part-day request of the same size. */
function unrequestedFrom(overrides, halfDays, requests, sinceDay) {
  const coveredFull = {}, coveredPart = {};
  const PART = ['HALF', 'SHORT', 'THREEQ'];
  (Array.isArray(requests) ? requests : []).forEach(r => {
    if (!r || r.status === 'rejected' || r.leaveType === 'PUNCH') return;
    const part = PART.indexOf(r.leaveType) > -1;
    for (let d = new Date(r.dateFrom + 'T00:00:00Z'); d <= new Date(r.dateTo + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const key = r.empName + '|' + d.toISOString().slice(0, 10);
      if (part) coveredPart[key] = r.leaveType; else coveredFull[key] = true;
    }
  });
  const out = [];
  Object.keys(overrides || {}).forEach(key => {
    const ov = overrides[key];
    if (!ov || ov.cat !== 'LEAVE' || coveredFull[key]) return;
    const day = key.split('|')[1] || '';
    if (day < sinceDay) return;
    out.push({ empName: key.split('|')[0], dateFrom: day, dateTo: day,
               leaveType: ov.detail === 'Sick' ? 'Sick' : 'CL', message: ov.reason || '' });
  });
  Object.keys(halfDays || {}).forEach(key => {
    const hd = halfDays[key];
    if (!hd) return;
    const kind = hd.kind || 'HALF';
    if (coveredPart[key] === kind || coveredFull[key]) return;
    const day = key.split('|')[1] || '';
    if (day < sinceDay) return;
    out.push({ empName: key.split('|')[0], dateFrom: day, dateTo: day,
               leaveType: kind, half: hd.half || '', message: hd.note || '' });
  });
  return out.sort((a, b) => b.dateFrom.localeCompare(a.dateFrom));
}

/* "9:30-6:30" as minutes past midnight. The first half is the arrival: an hour
   under 8 is read as the afternoon only for the end of the shift, never the
   start, which is how the dashboard reads it too. */
function shiftStartMin(text) {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(text || ''));
  if (!m) return null;
  let h = +m[1];
  if (h > 12) h = h;                       // 13:00 is already the afternoon
  return h * 60 + (+m[2]);
}
function hhmmToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

/* The day's summary, as the email will read. Returns null when there is
   nothing to say (no employees on file). */
async function buildDailyEmail(orgId, day, opts) {
  opts = opts || {};
  const emps = await pool.query(
    'SELECT name FROM employees WHERE org_id = $1 AND is_active ORDER BY lower(name)', [orgId]);
  if (!emps.rows.length) return null;
  let names = emps.rows.map(e => e.name);
  const picked = Array.isArray(opts.names) && opts.names.length ? opts.names.map(String) : null;
  if (picked) names = names.filter(n => picked.indexOf(n) > -1);
  else {
    const shown = await shownEmployees(orgId);
    if (shown) names = names.filter(n => shown[n] === true);
  }
  if (!names.length) names = emps.rows.map(e => e.name);      // nothing selected: send the lot
  const hidden = emps.rows.length - names.length;
  const recs = await pool.query(
    'SELECT employee, data FROM records WHERE org_id = $1 AND day = $2', [orgId, day]);
  const kv = await sharedKeys(orgId, ['overrides', 'halfDays', 'empNames', 'leaveRequests', 'companyInfo',
                                      'dayShifts', 'shiftAssignments', 'lateThresholdMin', 'lateExcuses']);
  const byEmp = {};
  recs.rows.forEach(r => { byEmp[r.employee] = r.data || {}; });
  const overrides = parseJson(kv.overrides) || {};
  const halfDays = parseJson(kv.halfDays) || {};

  const shownNames = parseJson(kv.empNames) || {};
  const rows = names.map(empName => {
    const e = { name: empName };
    const name = shownNames[e.name] || e.name;
    const ov = overrides[e.name + '|' + day];
    const rec = byEmp[e.name] || {};
    let state = 'missing', label = 'No punch', away = '', kind = 'missing';
    if (ov && ov.cat === 'LEAVE') { state = 'leave'; kind = 'leave'; label = 'Leave' + (ov.detail ? (' · ' + ov.detail) : ''); }
    else if (ov && ov.cat === 'WFH') { state = 'remote'; kind = 'wfh'; label = 'From home'; away = 'WFH'; }
    else if (ov && ov.cat === 'VISIT') { state = 'remote'; kind = 'visit'; label = 'Visit' + (ov.detail ? (' · ' + ov.detail) : ''); away = 'Visit'; }
    else if (rec['in']) { state = 'present'; kind = 'present'; label = rec.out ? 'Present' : 'In, not out yet'; }
    const hd = halfDays[e.name + '|' + day];
    if (hd && state !== 'leave') label += ' · part day';
    /* A day worked from home or at a customer has no punches, and two dashes
       said nothing about it: the times read WFH or Visit instead. */
    return { name, 'in': rec['in'] || away, out: rec.out || away, state, kind, label };
  });

  /* The three lists the banner over the record shows: who was late, whose
     shift was changed for the day, and who is working from home. Worked out
     here so the message says the same as the screen. */
  const dayShifts = parseJson(kv.dayShifts) || {};
  const assigned = parseJson(kv.shiftAssignments) || {};
  const excuses = parseJson(kv.lateExcuses) || {};
  const threshold = Number(parseJson(kv.lateThresholdMin)) || Number(kv.lateThresholdMin) || 10;
  const late = [], shifts = [], wfh = [], visits = [];
  names.forEach(empName => {
    const shown = shownNames[empName] || empName;
    const key = empName + '|' + day;
    const rec = byEmp[empName] || {};
    const ov = overrides[key];
    const todayShift = dayShifts[key] || null;
    const usual = assigned[empName] || null;
    if (todayShift && usual && todayShift !== usual) {
      shifts.push({ name: shown, detail: todayShift + ' today \u00b7 usual ' + usual });
    }
    /* A day at a customer is not a day at home, and saying so in one list put
       somebody on a visit under "working from home". */
    if (ov && (ov.cat === 'WFH' || ov.cat === 'VISIT')) {
      const started = rec['in'] ? ('started ' + mailer.clock(rec['in'])) : 'no start recorded yet';
      if (ov.cat === 'VISIT') visits.push({ name: shown, detail: (ov.detail ? (ov.detail + ' · ') : '') + started });
      else wfh.push({ name: shown, detail: started });
      return;
    }
    const start = shiftStartMin(todayShift || usual || '9:30-6:30');
    const came = hhmmToMinutes(rec['in']);
    if (came != null && start != null && came - start > threshold) {
      late.push({ name: shown,
                  detail: 'in ' + mailer.clock(rec['in']) + ' (' + (came - start) + ' min late)'
                        + (excuses[key] ? ' \u2014 excused' : '') });
    }
  });

  const settings = opts.settings || await mailSettings(orgId);
  return mailer.dailyEmail({
    orgName: orgNameOf(kv.companyInfo),
    dateLabel: new Date(day + 'T00:00:00Z').toUTCString().slice(0, 16),
    rows, hidden: hidden > 0 ? hidden : 0, attached: !!opts.attached, siteUrl: mailer.baseUrl(),
    late, shifts, wfh, visits,
    sections: settings.sections, subject: settings.subject,
    intro: settings.intro, footer: settings.footer,
    shotUrl: opts.shotUrl || ''
  });
}

/* The leave message: everything waiting for a decision, with its buttons.
   Returns null when there is nothing to decide. */
async function buildLeaveEmail(orgId) {
  const settings = await mailSettings(orgId);
  const kv = await sharedKeys(orgId, ['overrides', 'halfDays', 'leaveRequests', 'companyInfo']);
  const requests = parseJson(kv.leaveRequests) || [];
  const pending = requests.filter(r => r && (r.status === 'pending' || r.status === 'query'))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 15)
    .map(r => ({ req: r, heading: r.status === 'query' ? 'A query was raised' : 'Waiting since ' + String(r.createdAt || '').slice(0, 10),
                 links: linksFor({ k: 'req', org: orgId, id: r.id }) }));
  const since = new Date(Date.now() + IST_MS - 30 * 86400000).toISOString().slice(0, 10);
  const unreq = settings.unrequested
    ? unrequestedFrom(parseJson(kv.overrides) || {}, parseJson(kv.halfDays) || {}, requests, since)
        .slice(0, 15).map(u => ({
          req: u, heading: 'No request on file',
          links: linksFor({ k: 'unreq', org: orgId, e: u.empName, d: u.dateFrom,
                            t: u.leaveType, h: u.half || '' })
        }))
    : [];
  return mailer.leaveEmail({
    orgName: orgNameOf(kv.companyInfo), pending, unrequested: unreq, siteUrl: mailer.baseUrl()
  });
}

/* A mail client will not draw a picture built into the HTML, so the one shown
   in the message is kept here and fetched from the site when the message is
   opened. The name is thirty-two random characters; rows older than sixty days
   go when a new one is written. */
async function keepShot(dataUrl) {
  const head = /^data:image\/(png|jpeg);base64,/.exec(String(dataUrl || ''));
  if (!head) return '';
  const body = String(dataUrl).replace(/^data:image\/[a-z]+;base64,/, '').replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body) || body.length > 3 * 1024 * 1024) return '';
  const id = crypto.randomBytes(16).toString('hex');
  await pool.query(`CREATE TABLE IF NOT EXISTS mail_shots (
    id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query('INSERT INTO mail_shots (id, mime, data) VALUES ($1,$2,$3)',
    [id, 'image/' + head[1], body]);
  await pool.query("DELETE FROM mail_shots WHERE at < now() - interval '60 days'");
  return mailer.baseUrl() + '/shot/' + id + (head[1] === 'jpeg' ? '.jpg' : '.png');
}
/* Opened straight from a mail client, so no session: the name is the secret,
   and nothing but that day's picture is behind it. */
app.get('/shot/:id', async (req, res) => {
  const id = String(req.params.id || '').replace(/\.(png|jpg|jpeg)$/i, '');
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
  let row = null;
  try {
    const r = await pool.query('SELECT mime, data FROM mail_shots WHERE id = $1', [id]);
    row = r.rows[0] || null;
  } catch (e) { return res.status(404).end(); }
  if (!row) return res.status(404).end();
  const buf = Buffer.from(row.data, 'base64');
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'public, max-age=2592000, immutable');
  res.send(buf);
});

async function sendDailyEmail(orgId, day, opts) {
  opts = opts || {};
  if (!mailer.ready()) return { ok: false, error: 'email is not configured' };
  const settings = await mailSettings(orgId);
  const to = await mailRecipients(orgId, settings);
  if (!to.length) return { ok: false, error: NO_ADDRESS };
  /* The picture the dashboard took of the record, as the HD Screenshot button
     makes it: a PNG, base64, and nothing else. */
  let attachments = [];
  const raw = typeof opts.png === 'string' ? opts.png : '';
  const head = /^data:image\/(png|jpeg);base64,/.exec(raw);
  const picture = raw.replace(/^data:image\/[a-z]+;base64,/, '').replace(/\s+/g, '');
  if (picture && /^[A-Za-z0-9+/=]+$/.test(picture) && picture.length < 11 * 1024 * 1024) {
    const ext = (head && head[1] === 'jpeg') ? 'jpg' : 'png';
    attachments = [{ filename: 'attendance-' + (day || istParts().day) + '.' + ext, content: picture }];
  }
  /* The picture inside the message is a smaller copy, so opening the mail does
     not pull megabytes; the attachment stays full size. */
  let shotUrl = '';
  if (settings.sections && settings.sections.shot !== false) {
    try { shotUrl = await keepShot(opts.inline || opts.png); }
    catch (e) { console.error('the picture could not be kept:', e && e.message); }
  }
  const mail = await buildDailyEmail(orgId, day || istParts().day,
    { names: opts.names, attached: attachments.length > 0, shotUrl, settings });
  if (!mail) return { ok: false, error: 'no employees on file' };
  // Asked for a preview: hand the finished message back instead of sending it.
  if (opts.preview) {
    return { ok: true, mail: { to, cc: settings.cc, subject: mail.subject, html: mail.html, attachments } };
  }
  const r = await mailer.send({ to, cc: settings.cc, subject: mail.subject, html: mail.html, attachments });
  return Object.assign({ to: to.length, cc: (settings.cc || []).length, attached: attachments.length > 0 }, r);
}
async function sendLeaveEmail(orgId) {
  if (!mailer.ready()) return { ok: false, error: 'email is not configured' };
  const settings = await mailSettings(orgId);
  const to = await mailRecipients(orgId, settings);
  if (!to.length) return { ok: false, error: NO_ADDRESS };
  const mail = await buildLeaveEmail(orgId);
  if (!mail) return { ok: true, nothing: true };          // nothing waiting: no message
  const r = await mailer.send({ to, cc: settings.cc, subject: mail.subject, html: mail.html });
  return Object.assign({ to: to.length, cc: (settings.cc || []).length }, r);
}

/* One new request, emailed as it is raised. Never throws: a request must be
   saved whether or not the email goes out. */
async function notifyNewRequests(orgId, added) {
  try {
    if (!mailer.ready() || !added.length) return;
    const settings = await mailSettings(orgId);
    if (!settings.requests) return;
    const to = await mailRecipients(orgId, settings);
    if (!to.length) return;
    const kv = await sharedKeys(orgId, ['companyInfo']);
    for (const r of added.slice(0, 5)) {
      const mail = mailer.requestEmail({
        orgName: orgNameOf(kv.companyInfo), req: r,
        links: linksFor({ k: 'req', org: orgId, id: r.id }),
        siteUrl: mailer.baseUrl()
      });
      await mailer.send({ to, subject: mail.subject, html: mail.html });
    }
  } catch (e) {
    console.error('request email failed (request itself was saved):', e && e.message);
  }
}
/* Which requests are new and still waiting, comparing what was stored with
   what was just saved. */
function newPendingRequests(beforeText, afterText) {
  const before = parseJson(beforeText), after = parseJson(afterText);
  if (!Array.isArray(after)) return [];
  const had = {};
  (Array.isArray(before) ? before : []).forEach(r => { if (r && r.id) had[String(r.id)] = true; });
  return after.filter(r => r && r.id && !had[String(r.id)] && r.status === 'pending');
}

/* ---- acting on a button in an email ---- */

const PART_KINDS = ['HALF', 'SHORT', 'THREEQ'];
function markForRequest(req) {
  if (PART_KINDS.indexOf(req.leaveType) > -1) {
    return { key: 'halfDays', value: {
      reqId: req.id, kind: req.leaveType, half: req.half || '', leave: 'CL',
      note: (req.half === 'PM' ? 'Second half' : 'First half') + (req.message ? (' · ' + req.message) : ''),
      at: new Date().toISOString() } };
  }
  const cat = req.leaveType === 'WFH' ? 'WFH' : req.leaveType === 'VISIT' ? 'VISIT' : 'LEAVE';
  return { key: 'overrides', value: {
    cat, detail: cat === 'LEAVE' ? req.leaveType : '', reason: req.message || '',
    reqId: req.id, at: new Date().toISOString() } };
}
function daysBetween(from, to) {
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z') && out.length < 400; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
/* Applies one emailed decision inside a single transaction, writing exactly what
   the dashboard writes: the request's new status, and the marks an approval puts
   on the record. A day already carrying somebody else's mark is left alone, and
   a locked month is not touched at all. */
async function applyEmailDecision(p) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await lockedMonthsOf(client, p.org);
    const read = async key => {
      const r = await client.query(
        'SELECT value FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL FOR UPDATE', [p.org, key]);
      return r.rows[0] ? r.rows[0].value : null;
    };
    const write = async (key, before, after) => {
      await client.query(
        `INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, $2, $3, NULL)
         ON CONFLICT (org_id, key) WHERE user_id IS NULL
         DO UPDATE SET value = EXCLUDED.value, updated_at = now(), version = kv.version + 1`,
        [p.org, key, after]);
      await logChange(client, p.org, 'kv', key, null);
      const changes = diffValue(before, after);
      if (changes.length) await addHistory(client, p.org, null, 'email decision', key, changes);
    };
    const now = new Date().toISOString();
    const reqsText = await read('leaveRequests');
    const reqs = parseJson(reqsText) || [];
    let skipped = 0, kept = 0, summary = '';

    if (p.k === 'req') {
      const req = reqs.filter(r => r && r.id === p.id)[0];
      if (!req) { await client.query('ROLLBACK'); return { ok: false, title: 'That request is gone', detail: 'It is no longer on file.' }; }
      if (req.status !== 'pending' && req.status !== 'query') {
        await client.query('ROLLBACK');
        return { ok: false, title: 'Already decided',
                 detail: dispReq(req) + ' was already ' + req.status + '. Open the dashboard to change it.' };
      }
      req.status = p.act === 'approve' ? 'approved' : 'rejected';
      req.updatedAt = now;
      if (p.act === 'approve') req.approvedBy = 'email';
      else delete req.approvedBy;
      summary = dispReq(req);

      if (p.act === 'approve') {
        if (req.leaveType === 'PUNCH') {
          const beforeM = await read('manualRecords');
          const man = parseJson(beforeM) || {};
          const key = req.empName + '|' + req.dateFrom;
          if (locked[req.dateFrom.slice(0, 7)]) skipped++;
          else if (man[key] && man[key].reqId !== req.id) kept++;
          else {
            man[key] = { 'in': req.punchIn || '', out: req.punchOut || '',
                         st: (req.punchIn || req.punchOut) ? 'PR' : 'AB', reqId: req.id };
            await write('manualRecords', beforeM, JSON.stringify(man));
          }
        } else {
          const mark = markForRequest(req);
          const beforeK = await read(mark.key);
          const map = parseJson(beforeK) || {};
          let wrote = 0;
          daysBetween(req.dateFrom, req.dateTo).forEach(d => {
            const key = req.empName + '|' + d;
            if (locked[d.slice(0, 7)]) { skipped++; return; }
            if (map[key] && map[key].reqId !== req.id) { kept++; return; }
            map[key] = mark.value;
            wrote++;
          });
          if (wrote) await write(mark.key, beforeK, JSON.stringify(map));
        }
      }
      await write('leaveRequests', reqsText, JSON.stringify(reqs));
    } else if (p.k === 'unreq') {
      const covered = reqs.some(r => r && r.empName === p.e && r.status !== 'rejected'
                                  && r.dateFrom <= p.d && r.dateTo >= p.d
                                  && (PART_KINDS.indexOf(r.leaveType) > -1) === (PART_KINDS.indexOf(p.t) > -1));
      if (covered) {
        await client.query('ROLLBACK');
        return { ok: false, title: 'Already settled', detail: p.e + '’s ' + p.d + ' now has a request against it.' };
      }
      const fresh = {
        id: 'req_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
        empName: p.e, dateFrom: p.d, dateTo: p.d, leaveType: p.t, half: p.h || '',
        message: 'Taken without a request', status: p.act === 'approve' ? 'approved' : 'rejected',
        adminNote: p.act === 'approve' ? 'Approved by email' : 'Not authorised — the day was removed from the record.',
        employeeReply: '', createdAt: now, updatedAt: now
      };
      if (p.act === 'approve') fresh.approvedBy = 'email';
      reqs.push(fresh);
      summary = dispReq(fresh);
      if (p.act === 'reject') {
        if (locked[p.d.slice(0, 7)]) skipped++;
        else {
          const key = p.e + '|' + p.d;
          const part = PART_KINDS.indexOf(p.t) > -1;
          const mapKey = part ? 'halfDays' : 'overrides';
          const beforeK = await read(mapKey);
          const map = parseJson(beforeK) || {};
          const cur = map[key];
          const sameKind = cur && (part ? (cur.kind || 'HALF') === p.t : cur.cat === 'LEAVE');
          if (cur && !cur.reqId && sameKind) { delete map[key]; await write(mapKey, beforeK, JSON.stringify(map)); }
          else if (cur) kept++;
        }
      }
      await write('leaveRequests', reqsText, JSON.stringify(reqs));
    } else {
      await client.query('ROLLBACK');
      return { ok: false, title: 'That link is not valid', detail: 'Open the dashboard and decide there.' };
    }
    await client.query('COMMIT');
    const notes = [];
    if (kept) notes.push(kept + ' day(s) already carried another mark and were left alone.');
    if (skipped) notes.push(skipped + ' day(s) are in a locked month and were not changed.');
    return { ok: true,
             title: p.act === 'approve' ? 'Approved' : 'Rejected',
             detail: summary + '. ' + (notes.join(' ') || 'The dashboard shows it now.') };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}
function dispReq(r) {
  return r.empName + ' · ' + mailer.kindName(r.leaveType) + ' · ' + mailer.dateRange(r.dateFrom, r.dateTo);
}

/* The page a button in an email opens. GET asks; POST acts - so a mail scanner
   following every link cannot decide anything. */
const mailActionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.get('/e/:token', mailActionLimiter, (req, res) => {
  const p = mailer.verifyAction(req.params.token, process.env.SESSION_SECRET || 'dev-secret');
  res.set('Cache-Control', 'no-store').type('html');
  if (!p) return res.status(400).send(mailer.resultPage('That link has expired',
    'Links in an email are good for ' + mailer.ACTION_DAYS + ' days. Open the dashboard and decide there.', false));
  const what = p.k === 'unreq'
    ? (p.e + ' · ' + mailer.kindName(p.t) + ' · ' + p.d)
    : 'the request in the email';
  res.send(mailer.confirmPage({
    action: p.act, unrequested: p.k === 'unreq', summary: what,
    postTo: '/e/' + req.params.token
  }));
});
app.post('/e/:token', mailActionLimiter, async (req, res) => {
  const p = mailer.verifyAction(req.params.token, process.env.SESSION_SECRET || 'dev-secret');
  res.set('Cache-Control', 'no-store').type('html');
  if (!p) return res.status(400).send(mailer.resultPage('That link has expired',
    'Open the dashboard and decide there.', false));
  const out = await applyEmailDecision(p);
  res.status(out.ok ? 200 : 409).send(mailer.resultPage(out.title, out.detail, out.ok));
});

/* Admin controls: what is configured, a test email, and "send today's now". */
app.get('/api/mail', requireRole('admin', 'admin_view'), async (req, res) => {
  const s = await mailSettings(req.session.orgId);
  const to = await mailRecipients(req.session.orgId, s);
  const mine = String((req.user && req.user.email) || '');
  res.json({ configured: mailer.ready(), from: mailer.conf().from, siteUrl: mailer.baseUrl(),
             settings: s, to, you: EMAIL_RE.test(mine) ? mine : '' });
});
app.post('/api/mail/test', requireRole('admin'), async (req, res) => {
  if (!mailer.ready()) return res.status(400).json({ error: 'not_configured' });
  /* An account can sign in by name or by the part before the @, so what is
     stored as its email is not always an address. Resend answers such a send
     with "Invalid `to` field", which says nothing about whose address is
     wrong; the address is checked here and the answer names it. */
  let to = String((req.user && req.user.email) || '').trim();
  if (!EMAIL_RE.test(to)) {
    const fallback = await mailRecipients(req.session.orgId, await mailSettings(req.session.orgId));
    if (!fallback.length) {
      return res.status(400).json({ error: 'Your account has no email address on it ('
        + (to || 'blank') + '), and no other admin has one either. Put an address on the account in Users.' });
    }
    to = fallback[0];
  }
  const r = await mailer.send({
    to, subject: 'Attendance email is working',
    html: mailer.layout('Attendance', 'Test message', ['<p>This is the test message from the dashboard. '
      + 'Daily summaries and leave requests will arrive here.</p>'])
  });
  res.status(r.ok ? 200 : 502).json(Object.assign({ sentTo: to }, r));
});
/* A message is looked at before it goes. The dashboard asks for a preview,
   which builds exactly what would be sent and holds it here; pressing Send
   then posts nothing but the word, so the picture crosses the wire once. The
   copy is kept for ten minutes, per person. */
const previews = new Map();
function keepPreview(userId, mail) {
  previews.set(userId, Object.assign({ at: Date.now() }, mail));
  for (const [id, p] of previews) if (Date.now() - p.at > 10 * 60 * 1000) previews.delete(id);
}

/* Sent from the dashboard's Email button: it hands over the picture it has just
   rendered and the employees it is showing, so the message matches the screen. */
app.post('/api/mail/daily', requireRole('admin'), bigJson, async (req, res) => {
  const body = req.body || {};
  /* A picture too big to send is not a reason to lose the message: the figures
     go out without it, and the answer says so. */
  if (typeof body.png === 'string' && body.png.length > 9 * 1024 * 1024) body.png = '';

  if (body.send === 'preview') {
    const held = previews.get(req.session.userId);
    if (!held) return res.status(410).json({ error: 'that preview has expired - open it again' });
    previews.delete(req.session.userId);
    const r = await mailer.send({ to: held.to, cc: held.cc, subject: held.subject, html: held.html,
                                  attachments: held.attachments });
    return res.status(r.ok ? 200 : 502).json(Object.assign(
      { to: held.to.length, attached: (held.attachments || []).length > 0 }, r));
  }

  const opts = { png: body.png, inline: body.inline,
                 names: Array.isArray(body.names) ? body.names.slice(0, 200) : null,
                 preview: !!body.preview };
  const r = await sendDailyEmail(req.session.orgId, istParts().day, opts);
  if (body.preview && r.ok && r.mail) {
    keepPreview(req.session.userId, r.mail);
    return res.json({ ok: true, preview: { subject: r.mail.subject, html: r.mail.html },
                      to: r.mail.to, attached: (r.mail.attachments || []).length > 0 });
  }
  res.status(r.ok ? 200 : 502).json(r);
});
app.post('/api/mail/leave', requireRole('admin'), async (req, res) => {
  const r = await sendLeaveEmail(req.session.orgId);
  res.status(r.ok ? 200 : 502).json(r);
});

/* The daily summary goes out once, at the hour in the settings, India time.
   Checked every five minutes: Render restarts the service when it wakes, so a
   timer set once at boot would never fire. `maintenance_done` marks the day as
   sent, so a restart cannot send it twice. */
const DAILY_CHECK_MS = 5 * 60 * 1000;
async function dailyEmailTick() {
  if (!mailer.ready()) return;
  const { day, min } = istParts();
  const orgs = await pool.query('SELECT id FROM orgs ORDER BY id');
  for (const org of orgs.rows) {
    try {
      const s = await mailSettings(org.id);
      if (!s.daily || min < hhmmToMin(s.dailyAt)) continue;
      const job = 'daily-email:' + org.id + ':' + day;
      const claimed = await pool.query(
        'INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING RETURNING job', [job]);
      if (!claimed.rows.length) continue;                 // already sent today
      const r = await sendDailyEmail(org.id, day);
      // The leave message goes out beside it, and only when something is waiting.
      if (r.ok) { try { await sendLeaveEmail(org.id); } catch (e) { console.error('leave email:', e && e.message); } }
      if (!r.ok) {
        // Let tomorrow's run try again rather than leave the day marked as done.
        await pool.query('DELETE FROM maintenance_done WHERE job = $1', [job]);
        console.error('daily email not sent:', r.error);
      }
    } catch (e) {
      console.error('daily email tick failed:', e && e.message);
    }
  }
}

/* index.html carries the whole dashboard and runs to well over a megabyte.
   It was served `no-store`, so every open, every reload and every tab fetched
   the lot again - the free plan's 5GB of bandwidth went in three weeks and the
   service was suspended. `no-cache` still revalidates on every load, so a new
   build is picked up at once, but an unchanged one answers 304 with no body. */
/* ------------------------------------------------------------------
   Is the database there, and how much of the plan is left?

   The service was suspended in September for going past the free plan's 5GB
   of responses, and nobody saw it coming: the figure lived in Render's billing
   page and nowhere else. Every response is weighed here and the month's total
   kept in the database, so the dashboard can show it beside the database's own
   size and say something before the site goes dark.

   Counting is in memory and written once a minute, so a busy minute costs one
   UPDATE rather than one per request, and a restart loses at most that minute.
   ------------------------------------------------------------------ */
const STARTED_AT = new Date();
const FREE_BYTES = 5 * 1024 * 1024 * 1024;      // the plan's monthly responses
const FREE_DB_BYTES = 1024 * 1024 * 1024;       // and its database
let usage = { month: '', bytes: 0, requests: 0 };
let usageDirty = false;

function monthNow() { return new Date().toISOString().slice(0, 7); }

app.use(function (req, res, next) {
  const m = monthNow();
  if (usage.month !== m) usage = { month: m, bytes: 0, requests: 0 };
  res.on('finish', function () {
    /* What actually went down the wire: the body Express reports, plus a
       rough allowance for the headers, which are far from free on a page
       that answers 304 all day. */
    const len = Number(res.getHeader('content-length') || 0);
    usage.bytes += (isFinite(len) ? len : 0) + 350;
    usage.requests += 1;
    usageDirty = true;
  });
  next();
});

let usageTableReady = false;
async function flushUsage() {
  if (!usageDirty || !usage.month) return;
  const snapshot = { month: usage.month, bytes: usage.bytes, requests: usage.requests };
  usageDirty = false;
  try {
    if (!usageTableReady) {
      await pool.query(`CREATE TABLE IF NOT EXISTS usage_bytes (
        month TEXT PRIMARY KEY, bytes BIGINT NOT NULL DEFAULT 0,
        requests BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      usageTableReady = true;
    }
    /* The row holds the month's total across restarts, so this process adds
       only what it has counted since the last write. */
    await pool.query(
      `INSERT INTO usage_bytes (month, bytes, requests) VALUES ($1,$2,$3)
       ON CONFLICT (month) DO UPDATE SET bytes = usage_bytes.bytes + EXCLUDED.bytes,
         requests = usage_bytes.requests + EXCLUDED.requests, updated_at = now()`,
      [snapshot.month, snapshot.bytes, snapshot.requests]);
    usage.bytes -= snapshot.bytes;
    usage.requests -= snapshot.requests;
  } catch (e) {
    usageDirty = true;                       // try again next minute
    console.error('usage not written:', e && e.message);
  }
}

/* A free Render database is deleted thirty days after it is created, and the
   only warning is a line on its Render page. Postgres does not record when a
   database was made, so the first time this app meets one it writes the date
   down; the expiry is thirty days on from there, or whatever DB_EXPIRES_AT
   says if the real date is known. */
const FREE_DB_DAYS = Number(process.env.DB_FREE_DAYS || 30);
let firstSeenCache = null;
async function dbFirstSeen() {
  if (firstSeenCache) return firstSeenCache;
  await pool.query(`CREATE TABLE IF NOT EXISTS service_meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  /* The tables were made when the database was, give or take the minutes it
     took to deploy, so the oldest thing we know about is close enough. */
  const r = await pool.query(
    `INSERT INTO service_meta (key, value) VALUES ('db_first_seen', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSZ'))
     ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
     RETURNING value`);
  firstSeenCache = r.rows[0] ? r.rows[0].value : null;
  return firstSeenCache;
}
function dbExpiry(firstSeen) {
  const set = String(process.env.DB_EXPIRES_AT || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(set)) return new Date(set).toISOString();
  if (!firstSeen) return null;
  const d = new Date(firstSeen);
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + FREE_DB_DAYS);
  return d.toISOString();
}

/* What the dashboard's indicator shows. Cheap enough to ask for every minute:
   one size query, one count, one row. */
app.get('/api/status', requireRole('admin', 'admin_view'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const out = { at: new Date().toISOString(), startedAt: STARTED_AT.toISOString(),
                db: { ok: false }, plan: { bytes: FREE_BYTES, dbBytes: FREE_DB_BYTES } };
  const t0 = Date.now();
  try {
    /* Render's storage figure is the whole disk, not this one database: every
       database on the instance, plus Postgres's own catalogues and its
       write-ahead log. Reporting only our own made the dashboard read 1% where
       Render read 7%. Both are shown - the meter follows Render, and the note
       says how much of it is the attendance data. */
    const r = await pool.query(
      `SELECT pg_database_size(current_database())::bigint AS size,
              (SELECT sum(pg_database_size(datname))::bigint FROM pg_database) AS all_dbs,
              current_setting('server_version') AS version,
              current_database() AS name`);
    /* The write-ahead log sits on the same disk and Render counts it, but
       reading the log directory needs rights a hosted account does not get.
       min_wal_size was tried as a stand-in and overshot by half - it is what
       Postgres keeps room for, not what is there. So the figure is what can
       actually be measured, the databases, and the panel says plainly that
       Render's own percentage runs higher because of the log. */
    let wal = 0;
    try {
      const w = await pool.query('SELECT COALESCE(sum(size), 0)::bigint AS wal FROM pg_ls_waldir()');
      wal = Number(w.rows[0].wal) || 0;
    } catch (e) { /* not readable on a hosted account */ }
    const own = Number(r.rows[0].size);
    const dbs = Number(r.rows[0].all_dbs || own);
    out.db = { ok: true, ms: Date.now() - t0, size: dbs + wal, own: own, databases: dbs,
               wal: wal, walKnown: wal > 0,
               version: r.rows[0].version, name: r.rows[0].name };
    try {
      const seen = await dbFirstSeen();
      out.db.firstSeen = seen;
      out.db.expiresAt = dbExpiry(seen);
      out.db.freeDays = FREE_DB_DAYS;
    } catch (e) { /* the date is a nicety; the size is not */ }
  } catch (e) {
    out.db = { ok: false, ms: Date.now() - t0, error: (e && e.message) || 'no answer' };
    return res.json(out);
  }
  try {
    const c = await pool.query(
      `SELECT (SELECT count(*) FROM records WHERE org_id = $1)::int AS records,
              (SELECT count(*) FROM employees WHERE org_id = $1 AND is_active)::int AS employees,
              (SELECT count(*) FROM history WHERE org_id = $1)::int AS history`, [req.session.orgId]);
    out.counts = c.rows[0];
  } catch (e) { out.counts = null; }
  try {
    await flushUsage();
    const u = await pool.query('SELECT bytes, requests FROM usage_bytes WHERE month = $1', [monthNow()]);
    const row = u.rows[0] || { bytes: 0, requests: 0 };
    out.usage = { month: monthNow(), bytes: Number(row.bytes) + usage.bytes,
                  requests: Number(row.requests) + usage.requests };
  } catch (e) { out.usage = { month: monthNow(), bytes: usage.bytes, requests: usage.requests }; }
  try {
    const d = await pool.query(
      "SELECT value FROM kv WHERE org_id = $1 AND key = 'deviceStatus' AND user_id IS NULL", [req.session.orgId]);
    const v = d.rows[0] ? parseJson(d.rows[0].value) : null;
    out.office = (v && v.at) ? { at: v.at, rows: v.rows || null } : null;
  } catch (e) { out.office = null; }
  res.json(out);
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
/* The SPA catch-all must not swallow the API: without this an unknown
   /api/... path returned the dashboard HTML with status 200, so client code
   saw success and failed further along. */
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

/* A service whose start command is `node server.js` never runs the migration,
   so the site came up on an empty database and every call answered 500. The
   tables are checked here instead: missing, they are created before the first
   request, whatever command started the process. */
async function ensureSchema() {
  const r = await pool.query("SELECT to_regclass('public.users') AS t");
  if (r.rows[0] && r.rows[0].t) {
    /* Tables but nobody in them: the first admin is created by the migration,
       and it only fires when the users table is empty. Without this a database
       created before ADMIN_EMAIL was set could never be signed into at all. */
    const n = await pool.query('SELECT count(*)::int AS n FROM users');
    if (n.rows[0].n > 0) return;
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
      console.log('no accounts yet - set ADMIN_EMAIL and ADMIN_PASSWORD, then restart');
      return;
    }
    console.log('no accounts yet - creating the first admin');
  } else {
    console.log('no tables yet - creating them');
  }
  await new Promise((resolve, reject) => {
    const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'migrate.js')],
      { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('migrate exited with ' + code)));
  });
}

if (require.main === module) {
  ensureSchema()
    .catch(e => console.error('could not create the tables:', e && e.message))
    // Listen either way: a service that answers is one whose log can be read.
    .finally(() => app.listen(PORT, () => console.log('listening on ' + PORT)));
  setInterval(function () { flushUsage().catch(function () {}); }, 60000).unref();
  if (mailer.ready()) {
    setTimeout(dailyEmailTick, 60000).unref();
    setInterval(dailyEmailTick, DAILY_CHECK_MS).unref();
  } else {
    console.log('email is off: set RESEND_API_KEY and RESEND_FROM to turn it on');
  }
}
module.exports = { app, pool };
