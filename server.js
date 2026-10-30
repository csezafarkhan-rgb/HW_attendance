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
                      '/api/mail/daily', '/api/mail/month'];
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
/* Three of the office work away from the card readers, so their day was typed
   in for them every morning. They type it themselves now - but only their own
   day, only while it is today or yesterday, and only if the office has marked
   them as marking their own. Each of those is checked here rather than in the
   page, because the page is theirs to edit and this is not. */
const EMPLOYEE_WRITABLE = ['leaveRequests', 'dailyTasks', 'manualRecords', 'lateExcuses',
                           'overrides', 'dayShifts'];
function mayWriteSharedKey(role, key) {
  if (canWrite(role)) return true;
  return role === 'employee' && EMPLOYEE_WRITABLE.indexOf(key) > -1;
}

/* What an employee account may read from the shared keys: its own entries and
   the few settings every calendar needs. The KV routes used to hand any signed-in
   account every shared key - salaries, pay rules, signatures, everyone's marks
   and requests. Anything not named here is hidden from employees. */
const EMP_KEYED_BY_DAY = ['overrides', 'halfDays', 'dayShifts', 'mispunchFlags', 'manualRecords',
                          'lateExcuses', 'earlyExcuses', 'manualLeave', 'leaveDeductions',
                          'dailyTasks'];  // "Name|date"
const EMP_KEYED_BY_NAME = ['joinDates', 'satPolicy', 'shiftAssignments', 'empNames',
                          'selfMark'];                                       // "Name"
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
/* What one person says they did, folded into what everybody has said.

   The map is sent whole, so an employee saving their Tuesday would otherwise
   be saving everybody's everything - their copy of the other names, as their
   page last read them. Only the days under their own name are taken; every
   other key is left exactly as it was stored. The same guard leave requests
   have, for the same reason.

   A day is a list of lines. Empty lines are dropped, the list is capped, and a
   day with nothing left in it is removed rather than stored as an empty one. */
const TASK_MAX_LINES = 30;
const TASK_MAX_LEN = 300;
function mergeEmployeeTasks(storedValue, incomingValue, name) {
  const incoming = parseJson(incomingValue);
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;
  const parsed = parseJson(storedValue);
  const out = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  const mine = k => String(k).slice(0, String(k).lastIndexOf('|')) === name;
  /* Their own days, as they stand now - so a day they have deleted goes. */
  Object.keys(out).forEach(k => { if (mine(k)) delete out[k]; });
  Object.keys(incoming).forEach(k => {
    if (!mine(k)) return;                                  // not theirs to write
    const day = String(k).slice(String(k).lastIndexOf('|') + 1);
    if (!DAY_RE.test(day)) return;
    const v = incoming[k];
    const raw = Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : null);
    if (!raw) return;
    const items = raw.map(x => String(x == null ? '' : x).trim().slice(0, TASK_MAX_LEN))
      .filter(Boolean).slice(0, TASK_MAX_LINES);
    if (!items.length) return;                             // nothing said: nothing stored
    out[k] = { items, at: new Date().toISOString() };
  });
  return JSON.stringify(out);
}
/* The day somebody may write: today, and only today. Counted at +05:30, where
   the office is.

   Yesterday used to be open as well, on the grounds that somebody might not
   get to it until the morning. It is shut because a day you can still go back
   and fill in is a day that can be written to suit the week it ended up being,
   and the office asked for it shut. Anything older, or missed, goes through
   them - which is what the office entry on the day itself is for. */
/* The same reading of a shift the page does, kept here because the page is
   theirs to edit and this decides which day they may write. If one of the two
   is ever changed the other has to move with it; test/night-shift.test.js
   checks the pair against the same table of slots. */
function parseShiftSpan(str) {
  const parts = String(str || '').split('-');
  if (parts.length < 2) return null;
  const sp = parts[0].split(':').map(Number);
  const ep = parts[1].split(':').map(Number);
  if (!isFinite(sp[0]) || !isFinite(ep[0])) return null;
  const startMin = sp[0] * 60 + (isFinite(sp[1]) ? sp[1] : 0);
  const endM = isFinite(ep[1]) ? ep[1] : 0;
  const asDay = (ep[0] < 12 ? ep[0] + 12 : ep[0]) * 60 + endM;
  if (asDay > startMin && (asDay - startMin) <= 12 * 60) {
    return { startMin, endMin: asDay, overnight: false };
  }
  let night = ep[0] * 60 + endM;
  while (night <= startMin) night += 24 * 60;
  return { startMin, endMin: night, overnight: true };
}
/* Whichever standing shift was in force on that day. A one-off shift for a
   single date is not consulted: it is keyed by the very date being worked out,
   which would be circular. */
function shiftFor(assignments, name, day) {
  const runs = (assignments && assignments[name]) || null;
  if (!Array.isArray(runs)) return '';
  let best = null;
  runs.forEach(r => {
    if (!r || !r.from || r.from > day) return;
    if (!best || r.from >= best.from) best = r;
  });
  return best ? String(best.shift || '') : '';
}
/* The day somebody may write: the working day, and only that one.

   Not the calendar day for anybody on a night shift - at two in the morning
   the shift they are standing in started yesterday, and today's date would
   file the night under the wrong day. The day turns over at the shift's own
   start time instead of at midnight; for a day shift the two are the same. */
function ownDays(shift) {
  const now = new Date(Date.now() + IST_MS);
  const today = now.toISOString().slice(0, 10);
  const sh = parseShiftSpan(shift);
  if (sh && sh.overnight) {
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (mins < sh.startMin) {
      return [new Date(now.getTime() - 86400000).toISOString().slice(0, 10)];
    }
  }
  return [today];
}
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/* Their own in and out, for their own day.

   Everything else in the map is left exactly as it was: this replaces only the
   keys under their name within the window, so a save from their page can
   neither reach another person's day nor an older one of their own. The office
   can still type over any of it afterwards - an entry says it came from the
   person, and that is all it claims. */
function mergeEmployeeManual(storedValue, incomingValue, name, selfMarkValue, shift) {
  const incoming = parseJson(incomingValue);
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;
  const marked = parseJson(selfMarkValue);
  if (!marked || marked[name] !== true) return false;      // not one of theirs to mark
  const parsed = parseJson(storedValue);
  const out = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  const days = ownDays(shift);
  const mine = k => {
    const i = String(k).lastIndexOf('|');
    return i > 0 && String(k).slice(0, i) === name && days.indexOf(String(k).slice(i + 1)) > -1;
  };
  /* Their own days as they now stand, so clearing one clears it - but keep a
     copy first, because each time carries the moment it was written and that
     has to survive the day being written again. */
  const before = {};
  Object.keys(out).forEach(k => { if (mine(k)) { before[k] = out[k]; delete out[k]; } });
  Object.keys(incoming).forEach(k => {
    if (!mine(k)) return;
    const v = incoming[k];
    if (!v || typeof v !== 'object') return;
    const tin = String(v['in'] == null ? '' : v['in']).trim();
    const tout = String(v.out == null ? '' : v.out).trim();
    if (tin && !TIME_RE.test(tin)) return;
    if (tout && !TIME_RE.test(tout)) return;
    if (!tin && !tout) return;                             // nothing said is a deletion
    /* Nothing later than now, on today. The page caps its own boxes, but the
       page is theirs to edit, so the clock is checked again here. A couple of
       minutes of slack: their machine's clock is not ours. */
    if (String(k).slice(String(k).lastIndexOf('|') + 1) === days[0]) {
      const now = new Date(Date.now() + IST_MS);
      const cap = now.getUTCHours() * 60 + now.getUTCMinutes() + 2;
      const asMin = t => { const p = t.split(':'); return (+p[0]) * 60 + (+p[1]); };
      if ((tin && asMin(tin) > cap) || (tout && asMin(tout) > cap)) return;
    }
    /* When each time was written, kept per time rather than per record. A
       record has one "last touched" moment, and using it would make a morning
       in time look nine hours backdated the moment they typed their out time
       in the evening. A time that has not changed keeps the stamp it had. */
    const nowIso = new Date().toISOString();
    const was = (before[k] && typeof before[k] === 'object') ? before[k] : null;
    const stamp = (t, had, hadAt) => (t && had === t && hadAt) ? hadAt : (t ? nowIso : '');
    /* Arrived is present. Wanting both times before it counts as a day meant
       somebody who marked their arrival at ten to ten sat there reading
       "Absent" in red until the evening - on their own page and on the
       office's. A day with a time on it is a day they were here; the duration
       simply waits for the other half. */
    out[k] = { 'in': tin, out: tout, st: (tin || tout) ? 'PR' : 'AB',
               by: 'self', at: nowIso,
               inAt: stamp(tin, was && was['in'], was && was.inAt),
               outAt: stamp(tout, was && was.out, was && was.outAt) };
  });
  return JSON.stringify(out);
}

/* A day spent out on a visit, written by the person who spent it.

   This one is guarded harder than the rest, because a visit credits a whole
   working day: it is the one thing somebody could write for themselves that
   pays. So only the people the office has marked as typing their own day may
   write one, only for themselves, only for today, and only ever the VISIT
   category - leave and WFH decide money and time off and stay the office's.

   And it will not write over a day the office has already settled. An entry
   that did not come from the person themselves is left exactly as it is. */
const VISIT_DETAIL_MAX = 40;
const VISIT_REASON_MAX = 200;
/* Where somebody is today is not the same question as who types their in
   time. Somebody who punches a card still goes out on a visit, and the office
   cannot know they have until it is told - so this is not behind the
   self-marking gate. It writes VISIT on days of their own and nothing else,
   which is as narrow as it was when only self-markers could reach it. */
function mergeEmployeeVisit(storedValue, incomingValue, name, selfMarkValue, shift) {
  const incoming = parseJson(incomingValue);
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;
  const parsed = parseJson(storedValue);
  const out = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  const days = ownDays(shift);
  const mine = k => {
    const i = String(k).lastIndexOf('|');
    return i > 0 && String(k).slice(0, i) === name && days.indexOf(String(k).slice(i + 1)) > -1;
  };
  /* Only days of their own that they wrote themselves are theirs to clear. A
     visit the office entered stays until the office removes it. */
  const before = {};
  Object.keys(out).forEach(k => {
    if (!mine(k)) return;
    const v = out[k];
    if (v && typeof v === 'object' && v.by === 'self') { before[k] = v; delete out[k]; }
  });
  Object.keys(incoming).forEach(k => {
    if (!mine(k)) return;
    const v = incoming[k];
    if (!v || typeof v !== 'object') return;
    if (v.cat !== 'VISIT') return;                       // the only one they may write
    const settled = out[k];
    if (settled && typeof settled === 'object' && settled.by !== 'self') return;   // the office's day
    const detail = String(v.detail == null ? '' : v.detail).trim().slice(0, VISIT_DETAIL_MAX);
    if (!detail) return;                                 // a visit to nowhere is not a visit
    const reason = String(v.reason == null ? '' : v.reason).trim().slice(0, VISIT_REASON_MAX);
    const was = before[k];
    const nowIso = new Date().toISOString();
    out[k] = { cat: 'VISIT', detail: detail, reason: reason, by: 'self',
               at: (was && was.detail === detail && was.at) ? was.at : nowIso };
  });
  return JSON.stringify(out);
}

/* Why they were late, for the office to accept or not.

   An excuse cancels the lateness, so one written by the person it is about
   cannot simply take effect: it is stored waiting (`pending`), the minutes go
   on counting, and an admin clearing that flag is what excuses the day. An
   entry the office has already accepted is left untouched - otherwise writing
   a new reason over it would quietly un-accept it. */
/* The hours somebody is working today, set by the person working them.

   A shift is the measure every other figure on their day is taken against:
   whether they were late, whether they left early, how much of the day they
   owe. So this is not a free hand - it is the same bargain the late mark
   strikes. They may set it for a day that is theirs to set, their own name
   and no other, and the office is told at once rather than asked first.

   The standing shift is untouched. This writes the one-off a day can carry,
   which is what the office itself writes when somebody's hours move for a
   day, and it is undone by taking it off again. */
function mergeEmployeeDayShifts(storedValue, incomingValue, name, shift) {
  const incoming = parseJson(incomingValue);
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;
  const parsed = parseJson(storedValue);
  const out = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  const days = ownDays(shift);
  const mine = k => {
    const i = String(k).lastIndexOf('|');
    return i > 0 && String(k).slice(0, i) === name && days.indexOf(String(k).slice(i + 1)) > -1;
  };
  /* Every row that is theirs to write is rebuilt from what they sent; every
     other row in the map is left exactly as stored, because the page sends
     the whole map and their copy of everybody else's is only as fresh as
     their last read. */
  Object.keys(out).forEach(k => { if (mine(k)) delete out[k]; });
  Object.keys(incoming).forEach(k => {
    if (!mine(k)) return;
    const v = String(incoming[k] == null ? '' : incoming[k]).trim();
    if (!v) return;                                   // taking it off is simply not writing it
    const span = parseShiftSpan(v);
    if (!span) return;                                // not a pair of times: not a shift
    out[k] = v;
  });
  return JSON.stringify(out);
}
/* Which of their own days changed hands, for the message that follows. */
function newlyOwnShifts(beforeText, afterText, name) {
  const asMap = t => {
    const v = parseJson(t);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  };
  const was = asMap(beforeText), now = asMap(afterText), out = [];
  const seen = {};
  Object.keys(now).concat(Object.keys(was)).forEach(k => {
    if (seen[k]) return;
    seen[k] = true;
    const i = String(k).lastIndexOf('|');
    if (i < 1 || String(k).slice(0, i) !== name) return;
    const day = String(k).slice(i + 1);
    if (!DAY_RE.test(day)) return;
    const before = String(was[k] || ''), after = String(now[k] || '');
    if (before === after) return;
    out.push({ empName: name, day, from: before, to: after });
  });
  return out;
}
const EXCUSE_MAX = 300;
function mergeEmployeeExcuses(storedValue, incomingValue, name, shift) {
  const incoming = parseJson(incomingValue);
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;
  const parsed = parseJson(storedValue);
  const out = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  const days = ownDays(shift);
  const mine = k => {
    const i = String(k).lastIndexOf('|');
    return i > 0 && String(k).slice(0, i) === name && days.indexOf(String(k).slice(i + 1)) > -1;
  };
  /* A reason somebody gives for their own late arrival counts from the moment
     they give it. It used to be written as waiting and excused nothing until
     the office ticked it, and in practice the office was never told there was
     anything to tick - so the office asked for the mark to stand on its own
     and for a message to go out for review instead of for permission.

     What they still may not touch is a decision the office made: an entry the
     office wrote stays the office's. One they wrote themselves they may change
     or take back, which is how a mark made by mistake is undone. */
  const byOffice = k => { const v = out[k]; return !!v && typeof v === 'object' && v.by !== 'self'; };
  Object.keys(out).forEach(k => { if (mine(k) && !byOffice(k)) delete out[k]; });
  /* Two answers a late day can be given, and only one of them takes the
     minutes off. `kind: 'late'` is their own lateness - traffic, something at
     home - and excuses nothing, so it may be given with no reason at all.
     Anything else is work having made them late, which does take the minutes
     off, and that one is not accepted without a reason: an excuse with nothing
     written on it is what the office would have to come and ask about. */
  Object.keys(incoming).forEach(k => {
    if (!mine(k) || byOffice(k)) return;
    const v = incoming[k];
    const own = !!v && v.kind === 'late';
    const note = String((v && v.note) || '').trim().slice(0, EXCUSE_MAX);
    if (!note && !own) return;
    const row = { note, at: new Date().toISOString(), by: 'self' };
    if (own) row.kind = 'late';
    out[k] = row;
  });
  return JSON.stringify(out);
}

/* Which of their own requests somebody may take back: the ones nobody has
   acted on. The page offers the button on exactly these, but the page is
   theirs to edit, so this is where it is decided. */
const EMP_CANCELLABLE = ['pending', 'query', 'recommended'];
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
    } else if (cur.empName === name && r.status === 'cancelled'
               && EMP_CANCELLABLE.indexOf(cur.status) > -1) {
      /* Taking their own request back, while nobody has acted on it. Checked
         before the query reply below, so cancelling one that has a query on it
         cancels rather than answering.

         Only in this direction: 'cancelled' is not in the list, so they cannot
         bring it back and nor can they touch one already granted or refused -
         a granted day is on the record, and taking it off is the office's. */
      cur.status = 'cancelled';
      cur.cancelledAt = now;
      cur.updatedAt = now;
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

/* ---- a password set from a link in an email -------------------------------
   Two errands, one road: an account just made needs its first password, and
   somebody who has forgotten theirs needs another. Both are a signed link to
   the same page.

   The link carries a stamp taken from the password it was issued against, so
   the moment a password is set the link stops working - used once, and dead
   the day an admin sets one by hand. Nothing is stored for it. */
const PW_LINK_HOURS = { invite: 7 * 24, reset: 3 };
function pwStamp(hash) {
  return crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 12);
}
function pwSecret() { return process.env.SESSION_SECRET || 'dev-secret'; }
function pwToken(u, kind) {
  return mailer.signAction({ t: 'pw', k: kind, u: u.id, o: u.org_id, v: pwStamp(u.password_hash),
                             exp: Date.now() + PW_LINK_HOURS[kind] * 3600000 }, pwSecret());
}
function pwGoodFor(kind) { return kind === 'invite' ? '7 days' : '3 hours'; }
async function pwFromToken(token) {
  const p = mailer.verifyAction(token, pwSecret());
  if (!p || p.t !== 'pw') return null;
  const r = await pool.query(
    'SELECT id, org_id, email, name, password_hash, is_active FROM users WHERE id = $1', [p.u]);
  const u = r.rows[0];
  if (!u || !u.is_active || u.org_id !== p.o) return null;
  if (pwStamp(u.password_hash) !== p.v) return null;      // spent, or set another way since
  return { p, u };
}
/* Writes to whoever the account belongs to. Never in the way of the thing that
   asked for it: a send that fails is reported, not thrown. */
async function sendPasswordLink(u, kind) {
  if (!mailer.ready()) return { ok: false, error: 'not_configured' };
  if (!EMAIL_RE.test(String(u.email || ''))) return { ok: false, error: 'no_address' };
  const kv = await sharedKeys(u.org_id, ['companyInfo']);
  const mail = mailer.passwordEmail({
    kind, email: u.email, name: u.name, orgName: orgNameOf(kv.companyInfo),
    goodFor: pwGoodFor(kind),
    link: mailer.baseUrl().replace(/\/+$/, '') + '/set-password/' + pwToken(u, kind)
  });
  const r = await mailer.send({ to: u.email, subject: mail.subject, html: mail.html });
  await logMail(u.org_id, kind === 'invite' ? 'invite' : 'reset',
    { to: [u.email], subject: mail.subject, html: mail.html }, r);
  return r;
}

const pwLinkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.get('/set-password/:token', pwLinkLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store').type('html');
  const hit = await pwFromToken(req.params.token);
  if (!hit) return res.status(400).send(mailer.resultPage('That link has run out',
    'A password link works once, and not for long. Use "Forgot password?" on the sign-in card for another.',
    false, mailer.baseUrl()));
  res.send(mailer.passwordPage({ email: hit.u.email, invite: hit.p.k === 'invite',
                                 postTo: '/set-password/' + req.params.token }));
});
app.post('/set-password/:token', pwLinkLimiter, express.urlencoded({ extended: false, limit: '20kb' }),
  async (req, res) => {
    res.set('Cache-Control', 'no-store').type('html');
    const hit = await pwFromToken(req.params.token);
    if (!hit) return res.status(400).send(mailer.resultPage('That link has run out',
      'It may already have been used. Use "Forgot password?" on the sign-in card for another.',
      false, mailer.baseUrl()));
    const a = String((req.body && req.body.pw1) || ''), b = String((req.body && req.body.pw2) || '');
    const say = msg => res.status(400).send(mailer.passwordPage({
      email: hit.u.email, invite: hit.p.k === 'invite', error: msg,
      postTo: '/set-password/' + req.params.token }));
    if (a.length < 8) return say('Use at least 8 characters.');
    if (a.length > 200) return say('That is longer than 200 characters.');
    if (a !== b) return say('The two did not match. Type it again.');
    const hash = await bcrypt.hash(a, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, hit.u.id]);
    /* Whoever was signed in as them signs in again - if the password was
       forgotten because somebody else had it, this is where they lose it. */
    await endSessions(hit.u.id, '');
    res.send(mailer.resultPage('Password saved',
      'Sign in as ' + hit.u.email + ' with the password you just chose.', true, mailer.baseUrl()));
  });

/* "Forgot password?" on the sign-in card. Answers the same either way, so the
   card cannot be used to find out who has an account. */
app.post('/api/forgot', loginLimiter, async (req, res) => {
  const who = String((req.body && req.body.email) || '').trim().toLowerCase();
  res.json({ ok: true });                                  // said before anything is looked up
  if (!who) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, org_id, email, name, password_hash FROM users
        WHERE is_active AND (lower(email) = $1 OR lower(split_part(email, '@', 1)) = $1
              OR (lower(COALESCE(name, '')) = $1 AND (
                    SELECT count(*) FROM users u2
                     WHERE lower(COALESCE(u2.name, '')) = $1 AND u2.is_active) = 1))
        ORDER BY CASE WHEN lower(email) = $1 THEN 0 ELSE 1 END, id LIMIT 1`, [who]);
    if (rows[0]) await sendPasswordLink(rows[0], 'reset');
  } catch (e) {
    console.error('the reset link could not be sent:', e && e.message);
  }
});

/* An admin sending the link again - the first one ran out, or never arrived. */
app.post('/api/users/:id/invite', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  const r = await pool.query(
    'SELECT id, org_id, email, name, password_hash, is_active FROM users WHERE id = $1 AND org_id = $2',
    [id, req.session.orgId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  const out = await sendPasswordLink(r.rows[0], 'invite');
  if (!out.ok) return res.status(502).json({ error: out.error || 'send_failed' });
  res.json({ ok: true, sentTo: r.rows[0].email });
});

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
  /* A password left blank means the person chooses their own: the account is
     made with one nobody knows, and the link in their email is the way in. */
  const invited = !String(password || '');
  if (!invited && String(password).length < 8) return res.status(400).json({ error: 'password_too_short' });
  if (r === 'employee' && !n) return res.status(400).json({ error: 'employee_name_required' });
  const hash = await bcrypt.hash(invited ? crypto.randomBytes(32).toString('hex') : String(password), 12);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (org_id, email, password_hash, name, role)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, org_id, email, password_hash, name, role, is_active, last_login_at, created_at`,
      [req.session.orgId, e, hash, n || 'Admin', r]
    );
    /* Everybody new is written to: the invited to set a password, the rest to
       know the account is there and change what was typed for them. */
    const invite = await sendPasswordLink(rows[0], 'invite').catch(() => ({ ok: false, error: 'send_failed' }));
    delete rows[0].password_hash;
    delete rows[0].org_id;
    res.json({ user: rows[0], invited, mailed: !!invite.ok, mailError: invite.ok ? '' : (invite.error || 'send_failed') });
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
  let excusesBefore = null, shiftsBefore = null;                  // and the one about a late arrival answered for
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (shared) {
      // Locked, so saves of one key happen one after the other.
      const cur = await client.query(
        'SELECT value, version FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL FOR UPDATE',
        [req.session.orgId, key]);
      const row = cur.rows[0];
      /* Which day is theirs to write depends on their shift: a night shift's
         day turns over at its own start, not at midnight. Read here so every
         merge below judges it the same way. */
      let empShift = '';
      if (req.session.role === 'employee'
          && ['manualRecords', 'overrides', 'lateExcuses', 'dayShifts'].indexOf(key) > -1) {
        const sa = await client.query(
          "SELECT value FROM kv WHERE org_id = $1 AND key = 'shiftAssignments' AND user_id IS NULL",
          [req.session.orgId]);
        empShift = shiftFor(parseJson(sa.rows[0] ? sa.rows[0].value : '{}'),
                            (req.user && req.user.name) || '',
                            new Date(Date.now() + IST_MS).toISOString().slice(0, 10));
      }
      if (key === 'dailyTasks' && req.session.role === 'employee') {
        const merged = mergeEmployeeTasks(row ? row.value : '{}', value, (req.user && req.user.name) || '');
        if (merged === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'bad_tasks' }); }
        value = merged;
      } else if (key === 'manualRecords' && req.session.role === 'employee') {
        const mark = await client.query(
          "SELECT value FROM kv WHERE org_id = $1 AND key = 'selfMark' AND user_id IS NULL",
          [req.session.orgId]);
        const merged = mergeEmployeeManual(row ? row.value : '{}', value,
                                           (req.user && req.user.name) || '',
                                           mark.rows[0] ? mark.rows[0].value : '{}', empShift);
        if (merged === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'bad_times' }); }
        if (merged === false) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'not_self_marked' }); }
        value = merged;
      } else if (key === 'overrides' && req.session.role === 'employee') {
        const mark = await client.query(
          "SELECT value FROM kv WHERE org_id = $1 AND key = 'selfMark' AND user_id IS NULL",
          [req.session.orgId]);
        const merged = mergeEmployeeVisit(row ? row.value : '{}', value,
                                          (req.user && req.user.name) || '',
                                          mark.rows[0] ? mark.rows[0].value : '{}', empShift);
        if (merged === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'bad_visit' }); }
        if (merged === false) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'not_self_marked' }); }
        value = merged;
      } else if (key === 'dayShifts' && req.session.role === 'employee') {
        shiftsBefore = row ? row.value : '{}';
        const merged = mergeEmployeeDayShifts(row ? row.value : '{}', value,
                                              (req.user && req.user.name) || '', empShift);
        if (merged === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'bad_shift' }); }
        value = merged;
      } else if (key === 'lateExcuses' && req.session.role === 'employee') {
        excusesBefore = row ? row.value : '{}';
        const merged = mergeEmployeeExcuses(row ? row.value : '{}', value,
                                            (req.user && req.user.name) || '', empShift);
        if (merged === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'bad_excuse' }); }
        value = merged;
      } else if (key === 'leaveRequests') {
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
    /* And whoever has just been told yes or no hears it from the site. */
    newlyDecided(requestsBefore, value).slice(0, 10)
      .forEach(r => { notifyDecision(req.session.orgId, r); });
    /* A request moved to 'recommended' from the portal. Nothing produces that
       state any more - one word settles a request now - but one raised before
       the change can still be sitting in it, and the management still has to
       hear that it is theirs to finish. */
    newlyRecommended(requestsBefore, value).slice(0, 10)
      .forEach(r => { notifyRecommended(req.session.orgId, r); });
  }
  /* Somebody has marked their own late arrival as excused. It is already on
     the record - this is for reading, not for deciding - so it goes out after
     the commit and is not waited for. */
  if (shared && key === 'lateExcuses' && excusesBefore !== null) {
    const fresh = newlySelfExcused(excusesBefore, value);
    if (fresh.length) notifySelfExcused(req.session.orgId, fresh.slice(0, 10));
  }
  /* And somebody who has moved their own hours for a day. The same bargain
     and the same people: already on the record, sent for reading. */
  if (shared && key === 'dayShifts' && shiftsBefore !== null) {
    const moved = newlyOwnShifts(shiftsBefore, value, (req.user && req.user.name) || '');
    if (moved.length) notifyShiftChange(req.session.orgId, moved.slice(0, 10));
  }
  /* And a day marked as leave straight on the grid, which is the same news
     arriving by another door. */
  if (shared && (key === 'overrides' || key === 'halfDays') && changes && changes.length) {
    notifyUnrequestedMarks(req.session.orgId, key, changes);
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
  /* The office is given everybody, each with the flag that says whether they
     are still here; the page keeps those who are off its lists and keeps the
     rest in the copy it holds. Handing out only the active ones meant a
     browser backup carried a leaver's attendance rows with no row on the
     roster to say whose they were. An employee only ever gets themselves. */
  const emp = req.session.role === 'employee'
    ? await pool.query(
        `SELECT code, name, shift, is_active FROM employees WHERE org_id = $1 AND is_active = TRUE
         AND name = (SELECT name FROM users WHERE id = $2) ORDER BY id`, [orgId, req.session.userId]
      )
    : await pool.query(
        'SELECT code, name, shift, is_active FROM employees WHERE org_id = $1 ORDER BY id', [orgId]
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
      /* Somebody who has left stays left. This used to set is_active = TRUE on
         every save, so the next time the page wrote the dataset - which it
         does after almost anything - a person who had been taken off the
         roster came straight back, and no amount of removing them on screen
         ever stuck.

         The flag is only written when the payload actually carries one, which
         a restore from backup does and an ordinary save does not. A name the
         table has never seen is new, and new people start active. */
      const flag = (e && typeof e.is_active === 'boolean') ? e.is_active : null;
      await client.query(
        `INSERT INTO employees (org_id, code, name, shift, is_active) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, name) DO UPDATE SET code = EXCLUDED.code, shift = EXCLUDED.shift,
           is_active = COALESCE($6, employees.is_active)`,
        [req.session.orgId, e.code || null, String(e.name), e.shift || null,
         flag === null ? true : flag, flag]
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

/* Somebody who has left. Their rows stay exactly where they are - this is a
   flag on the person, not a deletion - and every read of the roster already
   asks for the active ones, so they come off the grid, the pickers, the
   payroll, the shifts panel and the daily message at once. The backup carries
   the flag, so a restore puts back who had left as well as who was here.

   Deleting them was the only thing on offer before, and it did two wrong
   things at once: it threw away the attendance rows that are the reason to
   keep a record at all, and it did not stick, because the roster is rebuilt
   from this table on the next page load. */
app.get('/api/employees/left', requireRole('admin', 'admin_view'), async (req, res) => {
  const r = await pool.query(
    `SELECT name, code, shift FROM employees
      WHERE org_id = $1 AND is_active = FALSE ORDER BY lower(name)`, [req.session.orgId]);
  res.json({ left: r.rows });
});
app.post('/api/employees/left', requireRole('admin'), async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const left = !!(req.body && req.body.left);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const r = await pool.query(
    'UPDATE employees SET is_active = $1 WHERE org_id = $2 AND name = $3 RETURNING name',
    [!left, req.session.orgId, name]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_such_employee' });
  await logChange(pool, req.session.orgId, 'employees', name, req.session.userId);
  await addHistory(pool, req.session.orgId, req.session.userId, (req.user && req.user.name) || null,
    'employees', [{ item: name, before: left ? 'here' : 'left',
                    after: left ? 'left' : 'here' }]);
  res.json({ ok: true, name, left });
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
/* ---------------- clocking in and out ----------------
   A typed time is a claim. The server took any time up to the present moment,
   so somebody arriving at ten to twelve could write half past nine and the
   record kept it - the only answer being that the office was shown, afterwards,
   how long after the fact it had been typed. That is a report of backdating,
   not a defence against it.

   Here nothing is typed. The time is this server's own clock at the moment the
   press arrives, so a mark cannot be older than the request that made it, and
   the browser's clock - which is the person's to set - never comes into it.

   What it writes is what the card wrote: the same manualRecords entry, so
   every total, late mark and export downstream carries on unchanged. */
app.post('/api/clock', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  if (req.session.role !== 'employee') return res.status(403).json({ error: 'not_an_employee' });
  const which = String((req.body && req.body.which) || '').trim();
  if (which !== 'in' && which !== 'out') return res.status(400).json({ error: 'bad_which' });
  const orgId = req.session.orgId;
  const name = String((req.user && req.user.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'no_name' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    /* The same gate the typed card had: only those the office has marked may
       put their own day on the record at all. */
    const mark = await client.query(
      "SELECT value FROM kv WHERE org_id = $1 AND key = 'selfMark' AND user_id IS NULL", [orgId]);
    const marked = parseJson(mark.rows[0] ? mark.rows[0].value : '{}') || {};
    if (marked[name] !== true) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'not_self_marked' }); }
    /* Which day this belongs to is the shift's question, not the calendar's: a
       night shift started yesterday is still yesterday's day until it ends. */
    const sa = await client.query(
      "SELECT value FROM kv WHERE org_id = $1 AND key = 'shiftAssignments' AND user_id IS NULL", [orgId]);
    const day = ownDays(shiftFor(parseJson(sa.rows[0] ? sa.rows[0].value : '{}'), name,
                                 new Date(Date.now() + IST_MS).toISOString().slice(0, 10)))[0];
    const key = name + '|' + day;
    const row = await client.query(
      "SELECT value FROM kv WHERE org_id = $1 AND key = 'manualRecords' AND user_id IS NULL FOR UPDATE", [orgId]);
    const store = parseJson(row.rows[0] ? row.rows[0].value : '{}') || {};
    const had = (store[key] && typeof store[key] === 'object') ? store[key] : null;
    const nowIst = new Date(Date.now() + IST_MS);
    const hhmm = String(nowIst.getUTCHours()).padStart(2, '0') + ':'
               + String(nowIst.getUTCMinutes()).padStart(2, '0');
    const nowIso = new Date().toISOString();
    /* Pressing the same button twice is a slip, not a correction: the first
       time stands and the second press is told so rather than quietly moving
       an arrival later. */
    if (which === 'in' && had && had['in']) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'already_in', at: had['in'] });
    }
    if (which === 'out') {
      if (!had || !had['in']) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'not_in_yet' }); }
      if (had.out) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_out', at: had.out }); }
    }
    /* What the readers have for this day. A mark somebody makes on the portal
       has always sat over the reader's row for the same day, which was safe
       while a day had to be typed - nobody typed a day the reader already
       had. One button is a different thing: a single press on a day already
       read off the card wrote the moment of the press over a real arrival,
       and the hours of the day with it.

       So a clock mark never moves an arrival later or a departure earlier. It
       is read in the same transaction as the write, against the same day. */
    const rr = await client.query(
      'SELECT data FROM records WHERE org_id = $1 AND employee = $2 AND day = $3',
      [orgId, name, day]);
    const seen = (rr.rows[0] && rr.rows[0].data) ? rr.rows[0].data : {};
    const asMin = t => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
      return m ? (+m[1]) * 60 + (+m[2]) : null;
    };
    const keepEarlier = (a, b) => {
      const x = asMin(a), y = asMin(b);
      if (x === null) return b || '';
      if (y === null) return a || '';
      return y < x ? b : a;
    };
    const keepLater = (a, b) => {
      const x = asMin(a), y = asMin(b);
      if (x === null) return b || '';
      if (y === null) return a || '';
      return y > x ? b : a;
    };
    /* Only the half being marked is weighed against the reader. Folding the
       reader's leaving time in while somebody is clocking IN would hand them a
       day that was over before it started. */
    const inRaw = which === 'in' ? hhmm : (had ? had['in'] : '');
    const outRaw = which === 'out' ? hhmm : (had ? had.out : '');
    const next = {
      'in': which === 'in' ? keepEarlier(inRaw, seen['in']) : inRaw,
      out: which === 'out' ? keepLater(outRaw, seen.out) : outRaw,
      st: 'PR', by: 'self', at: nowIso,
      /* Written at the same moment it happened, which is the whole point: the
         gap the office was shown is nought by construction. */
      inAt: which === 'in' ? nowIso : ((had && had.inAt) || ''),
      outAt: which === 'out' ? nowIso : ((had && had.outAt) || '')
    };
    store[key] = next;
    await client.query(
      `INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, 'manualRecords', $2, $3)
       ON CONFLICT (org_id, key) WHERE user_id IS NULL
       DO UPDATE SET value = EXCLUDED.value, updated_at = now(), version = kv.version + 1,
                     updated_by = EXCLUDED.updated_by`,
      [orgId, JSON.stringify(store), req.session.userId]);
    await logChange(client, orgId, 'manualRecords', null, req.session.userId);
    await client.query('COMMIT');
    res.json({ ok: true, day, 'in': next['in'], out: next.out, which, at: hhmm,
      /* Said so the card can tell them their day starts from the card reader's
         arrival rather than from the press they just made. */
      kept: (which === 'in' && next['in'] !== hhmm) ? next['in']
          : ((which === 'out' && next.out !== hhmm) ? next.out : '') });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* the error below is the one that matters */ }
    console.error('clock failed:', e && e.message);
    res.status(500).json({ error: 'clock_failed' });
  } finally { client.release(); }
});

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
  sections: { tally: true, late: true, shifts: true, wfh: true, visits: true, table: true, shot: true },
  /* The leave message goes to different people and says a different thing, so
     it keeps its own address list and wording. Anything left blank here falls
     back to the attendance settings above. */
  leave: { to: [], cc: [], subject: '', intro: '', footer: '', confirm: true,
           firstIntro: '', firstTo: [], firstCc: [] },
  /* The full month is sent by hand, so it has no hour of its own - only who it
     goes to and what it says. */
  month: { to: [], cc: [], subject: '', intro: '', footer: '' },
  /* A word before a holiday, so nobody turns up to a closed building. `days`
     is how far ahead it goes out; `at` is the hour of that day, India time. */
  holiday: { on: true, days: 2, at: '10:00', to: [], cc: [], subject: '', intro: '', footer: '' },
  /* What everybody worked on, written by them and gathered into one message.
     It can ride out with the attendance record - the two are the same day's
     news - or keep an hour of its own, for an office that wants the work log
     earlier than the record, or wants it when the record is turned off. Either
     way it goes once a day: both paths claim the same job. */
  tasks: { on: false, auto: false, at: '19:30',
           to: [], cc: [], subject: '', intro: '', footer: '' },
  /* Somebody marking their own late arrival excused is told to whoever the
     office wants reading it. It is a different thing from every list above:
     nobody is being asked for anything.

     `final` means the people who give the final word on leave, read from that
     list as it stands rather than copied - set it there once and this follows,
     instead of two lists to keep in step. Turn it off and the addresses below
     are used instead; with neither, nothing is sent rather than the news going
     somewhere nobody chose. */
  excused: { final: true, to: [], cc: [], subject: '', intro: '', footer: '',
             shift: { subject: '', intro: '', footer: '' } }
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
  const hd = isPlainObject(s.holiday) ? s.holiday : {};
  s.holiday = {
    on: hd.on !== false,
    days: Math.max(0, Math.min(30, Number(hd.days) >= 0 ? Number(hd.days) : 2)),
    at: /^\d{1,2}:\d{2}$/.test(String(hd.at)) ? String(hd.at) : '10:00',
    to: (Array.isArray(hd.to) ? hd.to : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20),
    cc: (Array.isArray(hd.cc) ? hd.cc : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20),
    subject: String(hd.subject || '').slice(0, 200),
    intro: String(hd.intro || '').slice(0, 2000),
    footer: String(hd.footer || '').slice(0, 2000)
  };
  const mo = isPlainObject(s.month) ? s.month : {};
  s.month = {
    to: (Array.isArray(mo.to) ? mo.to : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20),
    cc: (Array.isArray(mo.cc) ? mo.cc : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20),
    subject: String(mo.subject || '').slice(0, 200),
    intro: String(mo.intro || '').slice(0, 2000),
    footer: String(mo.footer || '').slice(0, 2000)
  };
  const tk = isPlainObject(s.tasks) ? s.tasks : {};
  s.tasks = {
    on: tk.on === true,
    /* Its own hour, kept apart from the attendance record's: an office that
       turns the record off should still be able to have the work log sent. */
    auto: tk.auto === true,
    at: /^\d{1,2}:\d{2}$/.test(String(tk.at)) ? String(tk.at) : MAIL_DEFAULTS.tasks.at,
    to: (Array.isArray(tk.to) ? tk.to : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20),
    cc: (Array.isArray(tk.cc) ? tk.cc : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20),
    subject: String(tk.subject || '').slice(0, 200),
    intro: String(tk.intro || '').slice(0, 2000),
    footer: String(tk.footer || '').slice(0, 2000)
  };
  const lv = isPlainObject(s.leave) ? s.leave : {};
  s.leave = {
    to: (Array.isArray(lv.to) ? lv.to : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20),
    cc: (Array.isArray(lv.cc) ? lv.cc : []).map(x => String(x).trim()).filter(x => EMAIL_RE.test(x)).slice(0, 20),
    subject: String(lv.subject || '').slice(0, 200),
    intro: String(lv.intro || '').slice(0, 2000),
    footer: String(lv.footer || '').slice(0, 2000),
    confirm: lv.confirm !== false,
    /* The first approver is written to before the super admins are, so the
       words addressed to the super admins would be addressed to the wrong
       person. Left empty, the message carries the ordinary wording. */
    firstIntro: String(lv.firstIntro == null ? '' : lv.firstIntro).slice(0, 2000),
    /* The first stage is a different message to different people, so it keeps
       its own addresses. The first approver is written to whatever is here -
       they are the one being asked - and these are who else sees it. */
    firstTo: (Array.isArray(lv.firstTo) ? lv.firstTo : []).map(x => String(x).trim())
      .filter(x => EMAIL_RE.test(x)).slice(0, 20),
    firstCc: (Array.isArray(lv.firstCc) ? lv.firstCc : []).map(x => String(x).trim())
      .filter(x => EMAIL_RE.test(x)).slice(0, 20)
  };
  const ex = isPlainObject(s.excused) ? s.excused : {};
  s.excused = {
    final: ex.final !== false,
    to: (Array.isArray(ex.to) ? ex.to : []).map(x => String(x).trim())
      .filter(x => EMAIL_RE.test(x)).slice(0, 20),
    cc: (Array.isArray(ex.cc) ? ex.cc : []).map(x => String(x).trim())
      .filter(x => EMAIL_RE.test(x)).slice(0, 20),
    subject: clip(ex.subject, 200), intro: clip(ex.intro, 2000), footer: clip(ex.footer, 2000),
    /* The same addresses, a different message: a day somebody moved their own
       hours for is not a day they were excused for being late, and the office
       wanted each to read as what it is. */
    shift: (function () {
      const sh = isPlainObject(ex.shift) ? ex.shift : {};
      return { subject: clip(sh.subject, 200), intro: clip(sh.intro, 2000), footer: clip(sh.footer, 2000) };
    })()
  };
  if (!/^\d{1,2}:\d{2}$/.test(String(s.dailyAt))) s.dailyAt = MAIL_DEFAULTS.dailyAt;
  return s;
}
/* What else sees it. A tab's own Cc box, and nothing else once that tab names
   its own TO: a message addressed to the one address typed on the Work tab was
   still carrying whoever sits on the attendance Cc, because an empty Cc box
   fell back to the attendance settings whatever else the tab said.

   The fallback is still there for a tab that names nobody at all - that tab is
   the attendance message's audience, Cc and all. */
function mailCc(settings, which) {
  const tab = (which && settings[which]) || {};
  const own = Array.isArray(tab.cc) ? tab.cc : [];
  if (own.length) return own;
  const to = Array.isArray(tab.to) ? tab.to : [];
  const first = Array.isArray(tab.firstTo) ? tab.firstTo : [];
  if (to.length || first.length) return [];
  return settings.cc || [];
}
/* Every active super admin, plus anyone named in the settings. A view admin is
   left out: they cannot act on the buttons anyway. */
async function mailRecipients(orgId, settings, which) {
  /* Whoever is named on the tab is who it goes to - nobody else. A tab with
     nothing in its TO box falls back to the attendance list, as the box says.

     The admins used to be added to every list whatever was typed, so naming
     one address on the Leave tab still sent the message to all of them. They
     are the fallback now, not a standing audience: if no box names anybody,
     the message goes to the admins rather than to nobody at all. */
  const own = (which === 'leave' && settings.leave && settings.leave.to.length) ? settings.leave.to
            : (which === 'tasks' && settings.tasks && settings.tasks.to.length) ? settings.tasks.to
            : (which === 'holiday' && settings.holiday && settings.holiday.to.length) ? settings.holiday.to
            : (which === 'month' && settings.month && settings.month.to.length) ? settings.month.to
            : (settings.to || []);
  const out = [];
  own.forEach(e => { if (EMAIL_RE.test(String(e || '')) && out.indexOf(e) === -1) out.push(e); });
  if (out.length) return out;
  const r = await pool.query(
    "SELECT email FROM users WHERE org_id = $1 AND is_active AND role = 'admin' ORDER BY id", [orgId]);
  r.rows.forEach(x => { if (EMAIL_RE.test(String(x.email || '')) && out.indexOf(x.email) === -1) out.push(x.email); });
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
/* The same, with the first approver's name sealed into the link, so the record
   can say who recommended it without trusting anything the browser sends. */
async function requestLinks(orgId, reqId, stage, approver) {
  if (stage !== 1) return linksFor({ k: 'req', org: orgId, id: reqId, s: stage || 0 });
  /* Whoever holds the stage for this one request, which need not be the
     office's own first approver. */
  const by = approver ? await approverName(orgId, approver)
                      : ((await firstApproverOf(orgId)) || {}).name || 'the first approver';
  return linksFor({ k: 'req', org: orgId, id: reqId, s: 1, by });
}
/* Leave marked on the record that no request accounts for, newest first. The
   dashboard's own rule: a rejected request or a punch correction covers nothing,
   and a part-day is only covered by a part-day request of the same size. */
function unrequestedFrom(overrides, halfDays, requests, sinceDay) {
  const coveredFull = {}, coveredPart = {};
  const PART = ['HALF', 'SHORT', 'THREEQ'];
  (Array.isArray(requests) ? requests : []).forEach(r => {
    /* Refused, or taken back by the person who asked: either way it accounts
       for nothing, and the day stands as leave nobody agreed to. */
    if (!r || r.status === 'rejected' || r.status === 'cancelled' || r.leaveType === 'PUNCH') return;
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
/* The slot somebody was on upon a given day.

   A shift is a list of runs, each saying when it came into force, so that
   moving somebody to a new slot does not rewrite the months already closed. A
   value left from before that existed is one run that has always been in force,
   which is what it meant.

   The dashboard works it out the same way. It has to: this message says who was
   late, and late is measured against the slot they were actually on. Reading
   the list as though it were still a plain string left `usual` holding an
   array, shiftStartMin could make nothing of it, and the late list came out
   empty for everybody. */
function shiftInForce(assigned, empName, day) {
  const v = assigned ? assigned[empName] : null;
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const runs = v.filter(r => r && r.shift)
    .map(r => ({ from: String(r.from || '0000-01-01'), shift: String(r.shift) }))
    .sort((a, b) => (a.from < b.from ? -1 : (a.from > b.from ? 1 : 0)));
  if (!runs.length) return null;
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].from <= day) return runs[i].shift;
  return runs[0].shift;                    // before any of them: the earliest known
}
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
                                      'dayShifts', 'shiftAssignments', 'lateThresholdMin', 'lateExcuses',
                                      'manualRecords']);
  const byEmp = {};
  recs.rows.forEach(r => { byEmp[r.employee] = r.data || {}; });
  /* Somebody who works where there is no reader is entered by hand, every day.
     The message only ever read the punch file, so they came out under the card
     for people who have not arrived - which was tolerable while that card was
     called "No punch", since it was true of the file, and is not tolerable now
     it says they have not reached the office, which is false of the person.

     A punch always wins; this only fills the silence. "-" is how the day is
     written while somebody is still in, and is not an out time. */
  const manualRecs = parseJson(kv.manualRecords) || {};
  names.forEach(n => {
    const m = manualRecs[n + '|' + day];
    if (!m || !m['in']) return;
    const rec = byEmp[n];
    if (rec && rec['in']) return;
    byEmp[n] = { 'in': m['in'], out: (m.out && m.out !== '-') ? m.out : '',
                 st: m.st || 'PR', manual: true };
  });
  const overrides = parseJson(kv.overrides) || {};
  const halfDays = parseJson(kv.halfDays) || {};

  const shownNames = parseJson(kv.empNames) || {};
  const rows = names.map(empName => {
    const e = { name: empName };
    const name = shownNames[e.name] || e.name;
    const ov = overrides[e.name + '|' + day];
    const rec = byEmp[e.name] || {};
    /* "No punch" described the file; this describes the person, which is what
       somebody reading the message at ten in the morning wants to know. */
    let state = 'missing', label = 'Not Reached Office', away = '', kind = 'missing';
    if (ov && ov.cat === 'LEAVE') { state = 'leave'; kind = 'leave'; label = 'Leave' + (ov.detail ? (' · ' + ov.detail) : ''); }
    else if (ov && ov.cat === 'WFH') { state = 'remote'; kind = 'wfh'; label = 'From home'; away = 'WFH'; }
    else if (ov && ov.cat === 'VISIT') { state = 'remote'; kind = 'visit'; label = 'Visit' + (ov.detail ? (' · ' + ov.detail) : ''); away = 'Visit'; }
    else if (rec['in']) { state = 'present'; kind = 'present'; label = rec.out ? 'Present' : 'In, not out yet'; }
    const hd = halfDays[e.name + '|' + day];
    if (hd && state !== 'leave') label += ' · part day';
    /* A day worked from home or at a customer has no punches, and two dashes
       said nothing about it: the times read WFH or Visit instead. */
    return { name, 'in': rec['in'] || away, out: rec.out || away, state, kind, label,
             /* When they arrived, as a number, so the message can list a card
                in the order people came in rather than alphabetically. */
             inMin: hhmmToMinutes(rec['in']) };
  });

  /* The three lists the banner over the record shows: who was late, whose
     shift was changed for the day, and who is working from home. Worked out
     here so the message says the same as the screen. */
  const dayShifts = parseJson(kv.dayShifts) || {};
  const assigned = parseJson(kv.shiftAssignments) || {};
  /* An excuse still waiting on the office does not cancel anything yet, so the
     message counts that arrival as late exactly as the screen does. */
  const allExcuses = parseJson(kv.lateExcuses) || {};
  const excuses = {};
  Object.keys(allExcuses).forEach(k => {
    const v = allExcuses[k];
    /* Work having made them late takes the minutes off. Their own lateness,
       written down, does not - and neither does the older shape, a reason that
       waited on the office. */
    if (v && typeof v === 'object' && (v.pending === true || v.kind === 'late')) return;
    excuses[k] = v;
  });
  const threshold = Number(parseJson(kv.lateThresholdMin)) || Number(kv.lateThresholdMin) || 10;
  const late = [], shifts = [], wfh = [], visits = [];
  names.forEach((empName, i) => {
    const shown = shownNames[empName] || empName;
    const key = empName + '|' + day;
    const rec = byEmp[empName] || {};
    const ov = overrides[key];
    const todayShift = dayShifts[key] || null;
    const usual = shiftInForce(assigned, empName, day);
    /* The slot they are on, carried onto the row so the message can group a
       card by it. Set before the work-from-home branch below returns, so every
       row has it whether or not that branch is taken. */
    if (rows[i]) rows[i].shift = todayShift || usual || '';
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
      /* A reason the person gave for themselves is waiting on the office. It
         changes nothing yet - the minutes still count, here and on the screen -
         but it was typed into a box that told nobody, so a day could be
         answered for and never read. The message carries it in their words,
         which is where the office already looks every evening. */
      const said = allExcuses[key];
      const own = !!said && typeof said === 'object'
                  && (said.pending === true || said.kind === 'late');
      const plea = (own && String(said.note || '').trim()) ? String(said.note).trim() : '';
      late.push({ name: shown,
                  detail: 'in ' + mailer.clock(rec['in']) + ' (' + mailer.minsSaid(came - start) + ' late)'
                        + (excuses[key] ? ' \u2014 excused'
                           : (plea ? (' \u2014 they say: \u201c'
                                      + plea.slice(0, 160) + '\u201d')
                                   : (own ? ' \u2014 marked late by them' : ''))) });
      /* So the card can mark the hour they came in. A lateness that has been
         answered for keeps its hour and its measure - that is what the office
         is reading the card for - and is marked as answered, which the card
         shows in a different colour rather than leaving out. */
      if (rows[i]) {
        rows[i].late = came - start;
        if (excuses[key]) rows[i].excused = true;
      }
    }
  });

  const settings = opts.settings || await mailSettings(orgId);
  return mailer.dailyEmail({
    orgName: orgNameOf(kv.companyInfo),
    dateLabel: mailer.fmtDay(day, true),
    rows, hidden: hidden > 0 ? hidden : 0, attached: !!opts.attached, siteUrl: mailer.baseUrl(),
    sentAt: mailer.clock(Math.floor(istParts().min / 60) + ':' + String(istParts().min % 60).padStart(2, '0')),
    late, shifts, wfh, visits,
    sections: settings.sections, subject: settings.subject,
    intro: settings.intro, footer: settings.footer,
    shotUrl: opts.shotUrl || ''
  });
}

/* The leave message: everything waiting for a decision, with its buttons.
   Returns null when there is nothing to decide.

   Where leave is granted in two stages this is built twice, once for each, and
   each message holds only what is that stage's to decide - stage 1 what the
   first approver has not passed on, stage 2 what they have. It used to be one
   message to the super admins holding the lot, with buttons that granted even
   on days the first approver had not so much as seen, which is the one thing
   two stages exist to prevent. Stage 0 is leave granted in one, where
   everything shows and the buttons grant, as it always did. */
async function buildLeaveEmail(orgId, stage, forApprover) {
  const settings = await mailSettings(orgId);
  const kv = await sharedKeys(orgId, ['overrides', 'halfDays', 'leaveRequests', 'companyInfo']);
  const requests = parseJson(kv.leaveRequests) || [];
  const first = await firstApproverOf(orgId);
  const route = await approvalRouteOf(orgId);
  const fallback = (first && first.email) || '';
  /* Stage 1 is one approver's; without one named there is only one stage. */
  const mine = forApprover || fallback;
  const st = (stage === 2) ? 2 : (mine ? 1 : 0);
  /* Whose name goes in the buttons, so the record can say who recommended
     it without trusting anything the browser sends. */
  const byName = st === 1 ? await approverName(orgId, mine) : '';
  const myWords = st === 1 ? firstWords(await approverIntroOf(orgId), mine, settings) : '';
  /* An archived request is out of the way by definition - the dashboard keeps
     it off the Requests page, and the message said seven were waiting when the
     portal said none. */
  const live = r => r && !r.archived
    && (r.status === 'pending' || r.status === 'query' || r.status === 'recommended');
  const isMine = r => stageOwns(st, route, r, fallback, mine);
  const pending = requests.filter(r => live(r) && isMine(r))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 15)
    .map(r => ({ req: r,
                 heading: r.status === 'recommended'
                   ? ('Approved by ' + (r.recommendedBy || 'the first approver') + ', waiting on you')
                   : (r.status === 'query' ? 'A query was raised'
                      : (st === 1 ? ('For you to look at first, since '
                                     + mailer.fmtDay(String(r.createdAt || '').slice(0, 10)))
                               : 'Waiting since ' + mailer.fmtDay(String(r.createdAt || '').slice(0, 10)))),
                 /* The stage is sealed into the button, so a link cannot be made
                    to grant by stripping it. */
                 links: linksFor(st === 1
                   ? { k: 'req', org: orgId, id: r.id, s: 1, by: byName }
                   : { k: 'req', org: orgId, id: r.id, s: 2 }) }));
  const since = new Date(Date.now() + IST_MS - 30 * 86400000).toISOString().slice(0, 10);
  /* A day marked with no request behind it has been through no stage at all,
     so it belongs to the first approver - for the people who have one. For
     anybody set to skip that stage it goes to the final word instead, which is
     the only place it would otherwise be seen at all. */
  const unreqMine = u => stageOwnsUnreq(st, route, u, fallback, mine);
  const unreq = settings.unrequested
    ? unrequestedFrom(parseJson(kv.overrides) || {}, parseJson(kv.halfDays) || {}, requests, since)
        .filter(unreqMine)
        .slice(0, 15).map(u => ({
          req: u,
          heading: st === 1 ? 'For you to look at first' : 'No request on file',
          links: linksFor(st === 1
            ? { k: 'unreq', org: orgId, e: u.empName, d: u.dateFrom,
                t: u.leaveType, h: u.half || '', s: 1, by: byName }
            : { k: 'unreq', org: orgId, e: u.empName, d: u.dateFrom,
                t: u.leaveType, h: u.half || '' })
        }))
    : [];
  /* Where the whole message is about one request, it carries the year behind
     it, exactly as the one sent when that request was raised. A digest of
     several people does not: it would be a year each, and the first thing it
     would hand every approver is a dozen people's leave records.

     Which is the same rule the copy list goes by - about one person, or about
     everybody. */
  const only = (pending.length + unreq.length === 1) ? (pending[0] || unreq[0]) : null;
  if (only && only.req && only.req.empName) {
    const rec = await leaveRecordFor(orgId, only.req.empName, only.req);
    if (rec) only.req = Object.assign({}, only.req, { leaveRecord: rec });
  }
  const built = mailer.leaveEmail({
    orgName: orgNameOf(kv.companyInfo), pending, unrequested: unreq, siteUrl: mailer.baseUrl(),
    subject: settings.leave.subject, footer: settings.leave.footer,
    intro: myWords || settings.leave.intro,
    approver: byName
  });
  /* Whose days are in it, so the sender can copy them where the message turns
     out to be about one person. A digest naming several is not theirs to read. */
  if (built) {
    built.names = Array.from(new Set(
      pending.map(p => p.req && p.req.empName)
        .concat(unreq.map(u => u.req && u.req.empName)).filter(Boolean)));
    /* And which of them were passed on by somebody, so a first approver can be
       copied on the message their own yes caused. */
    built.reqs = pending.map(p => p.req).filter(Boolean);
  }
  return built;
}

/* Every message that goes out is kept: what it was, when, who it went to and
   the message itself, so the Backup tab can show what the office was told and
   when. Kept ninety days; the picture inside a message is already kept
   separately and outlives nothing. */
let mailLogReady = false;
async function logMail(orgId, kind, msg, result) {
  try {
    if (!mailLogReady) {
      await pool.query(`CREATE TABLE IF NOT EXISTS mail_log (
        id BIGSERIAL PRIMARY KEY, org_id INTEGER, at TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind TEXT NOT NULL, subject TEXT, recipients TEXT, cc TEXT,
        ok BOOLEAN NOT NULL DEFAULT TRUE, detail TEXT, attached BOOLEAN NOT NULL DEFAULT FALSE,
        html TEXT)`);
      await pool.query('CREATE INDEX IF NOT EXISTS mail_log_recent_idx ON mail_log (org_id, id DESC)');
      mailLogReady = true;
    }
    await pool.query(
      `INSERT INTO mail_log (org_id, kind, subject, recipients, cc, ok, detail, attached, html)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orgId, kind, String(msg.subject || '').slice(0, 300),
       (msg.to || []).join(', ').slice(0, 500), (msg.cc || []).join(', ').slice(0, 500),
       !!(result && result.ok), String((result && (result.error || result.id)) || '').slice(0, 300),
       !!(msg.attachments && msg.attachments.length), String(msg.html || '').slice(0, 400000)]);
    await pool.query("DELETE FROM mail_log WHERE at < now() - interval '90 days'");
  } catch (e) {
    console.error('the message was sent but not written down:', e && e.message);
  }
}
/* What was sent, newest first. The message itself is fetched a row at a time,
   so the list stays small. */
app.get('/api/mail/log', requireRole('admin', 'admin_view'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const r = await pool.query(
      `SELECT id, at, kind, subject, recipients, cc, ok, detail, attached
         FROM mail_log WHERE org_id = $1 ORDER BY id DESC LIMIT 60`, [req.session.orgId]);
    res.json({ sent: r.rows });
  } catch (e) { res.json({ sent: [] }); }
});
app.get('/api/mail/log/:id', requireRole('admin', 'admin_view'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(id > 0)) return res.status(400).json({ error: 'bad_id' });
  const r = await pool.query(
    'SELECT id, at, kind, subject, recipients, cc, ok, detail, attached, html FROM mail_log WHERE org_id = $1 AND id = $2',
    [req.session.orgId, id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

/* A mail client will not draw a picture built into the HTML, so the one shown
   in the message is kept here and fetched from the site when the message is
   opened. The name is thirty-two random characters; rows older than sixty days
   go when a new one is written. */
async function keepShot(dataUrl) {
  const head = /^data:image\/(png|jpeg);base64,/.exec(String(dataUrl || ''));
  if (!head) return '';
  const body = String(dataUrl).replace(/^data:image\/[a-z]+;base64,/, '').replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body) || body.length > 4 * 1024 * 1024) return '';
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
  await logMail(orgId, 'attendance', { to, cc: settings.cc, subject: mail.subject, html: mail.html, attachments }, r);
  return Object.assign({ to: to.length, cc: (settings.cc || []).length, attached: attachments.length > 0 }, r);
}
/* The month, rather than the day. The dashboard has already drawn the grid and
   built the workbook - it is the only thing that knows which months are in
   view - so both arrive here ready, and this addresses the message and sends
   it. Goes to the Attendance tab's people: it is the same record, over a
   longer window. */
const MONTH_XLSX_MAX = 18 * 1024 * 1024;        // base64, before Resend's own limit
async function sendMonthEmail(orgId, opts) {
  opts = opts || {};
  if (!mailer.ready()) return { ok: false, error: 'email is not configured' };
  const settings = await mailSettings(orgId);
  const to = await mailRecipients(orgId, settings, 'month');
  if (!to.length) return { ok: false, error: NO_ADDRESS };

  const attachments = [];
  const b64 = v => String(v || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  /* The workbook, and nothing else: a month is too wide to read as a picture.
     Too big to send is not a reason to lose the message - the figures still go,
     and the answer says the file did not. */
  const sheetName = clip(opts.fileName || '', 120).replace(/[^\w .\-]/g, '') || 'attendance.xlsx';
  const book = b64(opts.xlsx);
  let fileSent = '';
  if (book && /^[A-Za-z0-9+/=]+$/.test(book) && book.length < MONTH_XLSX_MAX) {
    attachments.push({ filename: sheetName, content: book });
    fileSent = sheetName;
  }

  const kv = await sharedKeys(orgId, ['companyInfo']);
  const mail = mailer.monthEmail({
    orgName: orgNameOf(kv.companyInfo),
    monthLabel: clip(opts.monthLabel || '', 120),
    shown: Number.isFinite(opts.shown) ? opts.shown : null,
    hidden: Number.isFinite(opts.hidden) ? opts.hidden : 0,
    days: Number.isFinite(opts.days) ? opts.days : null,
    subject: settings.month.subject, intro: settings.month.intro, footer: settings.month.footer,
    fileName: fileSent, siteUrl: mailer.baseUrl(),
    sentAt: mailer.clock(Math.floor(istParts().min / 60) + ':'
                         + String(istParts().min % 60).padStart(2, '0'))
  });
  const cc = mailCc(settings, 'month');
  const msg = { to, cc, subject: mail.subject, html: mail.html, attachments };
  if (opts.preview) return { ok: true, mail: msg, attachedFile: !!fileSent };
  const r = await mailer.send(msg);
  await logMail(orgId, 'month', msg, r);
  return Object.assign({ to: to.length, cc: cc.length,
                         attached: attachments.length > 0, file: fileSent }, r);
}

/* The holidays on the calendar, as {day, name, note}, from the day given
   onwards. The dashboard stores them by date, either as a name or as a name
   with a note beside it. */
async function holidaysFrom(orgId, fromDay, toDay) {
  const kv = await sharedKeys(orgId, ['officialLeaves']);
  const all = parseJson(kv.officialLeaves) || {};
  return Object.keys(all).filter(d => DAY_RE.test(d) && d >= fromDay && (!toDay || d <= toDay)).sort()
    .map(d => {
      const v = all[d];
      return { day: d,
               name: (v && typeof v === 'object') ? (v.name || 'Holiday') : String(v || 'Holiday'),
               note: (v && typeof v === 'object') ? (v.note || '') : '' };
    });
}
function daysApart(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
/* `days` ahead exactly, for the scheduled run; the next one coming, for a
   message sent by hand. */
async function sendHolidayEmail(orgId, opts) {
  opts = opts || {};
  if (!mailer.ready()) return { ok: false, error: 'email is not configured' };
  const settings = await mailSettings(orgId);
  const today = istParts().day;
  let holidays = [];
  if (opts.on) {
    holidays = (await holidaysFrom(orgId, opts.on, opts.on));
  } else {
    const soon = await holidaysFrom(orgId, today);
    holidays = soon.length ? [soon[0]] : [];
  }
  if (!holidays.length) return { ok: true, nothing: true };
  const kv = await sharedKeys(orgId, ['companyInfo']);
  const mail = mailer.holidayEmail({
    orgName: orgNameOf(kv.companyInfo),
    holidays: holidays.map(h => ({
      name: h.name, note: h.note, away: daysApart(today, h.day),
      when: mailer.fmtDay(h.day, true)
    })),
    subject: settings.holiday.subject, intro: settings.holiday.intro,
    footer: settings.holiday.footer, siteUrl: mailer.baseUrl()
  });
  if (!mail) return { ok: true, nothing: true };
  const to = await mailRecipients(orgId, settings, 'holiday');
  if (!to.length) return { ok: false, error: NO_ADDRESS };
  const cc = mailCc(settings, 'holiday');
  /* The preview carries which holiday it is for, so that pressing Send on it -
     which is how the word normally goes out - marks that holiday as spoken for
     the same as any other route. */
  if (opts.preview) return { ok: true, holiday: holidays[0].day,
    mail: { to, cc, subject: mail.subject, html: mail.html, attachments: [], holiday: holidays[0].day } };
  const r = await mailer.send({ to, cc, subject: mail.subject, html: mail.html });
  await logMail(orgId, 'holiday', { to, cc, subject: mail.subject, html: mail.html }, r);
  if (r.ok) await markHolidaySaid(orgId, holidays[0].day);
  return Object.assign({ to: to.length, cc: cc.length, holiday: holidays[0].day }, r);
}
/* Spoken for, however the word went out - by hand, from a preview, or on the
   tick. Sending by hand used to leave no mark, so the tick would say it again
   the next day as though nobody had. */
async function markHolidaySaid(orgId, day) {
  if (!day) return;
  try {
    await pool.query('INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING',
                     ['holiday-email:' + orgId + ':' + day]);
  } catch (e) { console.error('the holiday word went out but was not marked:', e && e.message); }
}

/* What everybody worked on, in one message. Gathered from what they wrote on
   their own pages - this adds nothing and judges nothing, it only collects.

   The order is the office's own employee order, so the message reads down the
   same list as every other page. */
async function sendTasksEmail(orgId, day, opts) {
  opts = opts || {};
  if (!mailer.ready()) return { ok: false, error: 'email is not configured' };
  const settings = opts.settings || await mailSettings(orgId);
  const emps = await pool.query(
    'SELECT name FROM employees WHERE org_id = $1 AND is_active ORDER BY lower(name)', [orgId]);
  if (!emps.rows.length) return { ok: true, nothing: true };
  /* The people the portal is showing, which is what the attendance message has
     always gone by. Without it the work log named everybody in the employees
     table - a card-punch entry called "500" and somebody who had resigned among
     them - and then reported them for writing nothing. Hiding somebody on the
     portal now takes them out of this message too. */
  let people = emps.rows.map(e => e.name);
  const shown = await shownEmployees(orgId);
  if (shown) {
    const kept = people.filter(n => shown[n] === true);
    if (kept.length) people = kept;                 // nothing selected: the lot, as elsewhere
  }
  const kv = await sharedKeys(orgId, ['dailyTasks', 'empNames', 'companyInfo', 'overrides']);
  const tasks = parseJson(kv.dailyTasks) || {};
  const shownNames = parseJson(kv.empNames) || {};
  const overrides = parseJson(kv.overrides) || {};
  const wrote = [], silent = [];
  people.forEach(name => {
    const label = shownNames[name] || name;
    const v = tasks[name + '|' + day];
    const items = (v && Array.isArray(v.items)) ? v.items.filter(Boolean) : [];
    if (items.length) { wrote.push({ name: label, count: items.length, items }); return; }
    /* Somebody on leave has not failed to write anything - they were not here.
       Naming them among the silent would read as a reproach. */
    const ov = overrides[name + '|' + day];
    if (ov && ov.cat === 'LEAVE') return;
    silent.push(label);
  });
  const mail = mailer.tasksEmail({
    orgName: orgNameOf(kv.companyInfo), dateLabel: mailer.fmtDay(day, true),
    people: wrote, silent, subject: settings.tasks.subject,
    intro: settings.tasks.intro, footer: settings.tasks.footer, siteUrl: mailer.baseUrl()
  });
  if (!mail) return { ok: true, nothing: true };        // nobody wrote anything
  const to = await mailRecipients(orgId, settings, 'tasks');
  if (!to.length) return { ok: false, error: NO_ADDRESS };
  const cc = mailCc(settings, 'tasks');
  if (opts.preview) return { ok: true, mail: { to, cc, subject: mail.subject, html: mail.html, attachments: [] } };
  const r = await mailer.send({ to, cc, subject: mail.subject, html: mail.html });
  await logMail(orgId, 'tasks', { to, cc, subject: mail.subject, html: mail.html }, r);
  return Object.assign({ to: to.length, cc: cc.length, people: wrote.length }, r);
}

async function sendLeaveEmail(orgId, opts) {
  const preview = !!(opts && opts.preview);
  if (!mailer.ready()) return { ok: false, error: 'email is not configured' };
  const settings = await mailSettings(orgId);
  const first = await firstApproverOf(orgId, settings);
  /* One message where leave is granted in one stage; where it is granted in
     two, one for each, so neither set of people is handed a decision that is
     not theirs to make. A stage with nothing waiting sends nothing. */
  const route = await approvalRouteOf(orgId);
  const fallback = (first && first.email) || '';
  /* Whether leave is granted in two stages is a question of whether anybody
     holds the first one - which is not the same as the office having named a
     default. Gating this on the default alone meant that naming an approver
     against one person and leaving the Leave tab's own line empty sent their
     new requests to that person, as it should, and then had the nightly
     summary grant in one stage as though nobody were there. */
  const approvers = firstApprovers(route, fallback);
  const legs = [];
  if (approvers.length) {
    /* One stage-1 message per person holding a first stage, each holding only
       their own people. Where somebody is routed to an approver of their own,
       that address gets a message about them and nobody else - and the office's
       own first approver is not told about a request that is not theirs. */
    const ccMap = await approverCcOf(orgId);
    approvers.forEach(who => { legs.push(legFor(settings, who, fallback, ccMap)); });
    legs.push({ stage: 2, to: await mailRecipients(orgId, settings, 'leave'),
                cc: mailCc(settings, 'leave') });
  } else {
    legs.push({ stage: 0, to: await mailRecipients(orgId, settings, 'leave'),
                cc: mailCc(settings, 'leave') });
  }
  /* Built first, sent after - and where a preview was asked for, not sent at
     all. Leave is the one message that can be several: a stage with nobody
     waiting at it builds nothing, and two stages with people at both build two
     messages to two sets of people. So the preview holds all of them and says
     how many, rather than showing one and quietly posting the rest. */
  let addressed = 0;
  const built = [];
  for (const leg of legs) {
    if (!leg.to.length) continue;
    addressed++;
    const mail = await buildLeaveEmail(orgId, leg.stage, leg.approver);
    if (!mail) continue;                                   // nothing at this stage
    /* About one person: they are copied. About several: they are not, because
       a digest is everybody's business and nobody else's. */
    const alone = await ownersIfAlone(orgId, mail.names || [], leg.to, leg.cc);
    /* Anybody whose yes put a request in this message is copied on it, whatever
       else the message holds: it is the answer to their own recommendation, and
       being named in its heading is not the same as being told. */
    const passed = notAlready(await recommenderOf(orgId, settings, mail.reqs || []),
                              leg.to, leg.cc.concat(alone));
    built.push({ to: leg.to, cc: leg.cc.concat(alone).concat(passed),
                 subject: mail.subject, html: mail.html });
  }
  if (!addressed) return { ok: false, error: NO_ADDRESS };
  if (!built.length) return { ok: true, nothing: true };   // nothing waiting: no message
  if (preview) return { ok: true, mails: built };
  let sent = 0, toN = 0, ccN = 0, failed = null;
  for (const msg of built) {
    const r = await mailer.send(msg);
    await logMail(orgId, 'leave', msg, r);
    if (r.ok) { sent++; toN += msg.to.length; ccN += msg.cc.length; }
    else failed = failed || r;
  }
  if (!sent && failed) return failed;
  return { ok: true, to: toN, cc: ccN, messages: sent };
}

/* One new request, emailed as it is raised. Never throws: a request must be
   saved whether or not the email goes out. */
async function notifyNewRequests(orgId, added) {
  try {
    if (!mailer.ready() || !added.length) return;
    const settings = await mailSettings(orgId);
    if (!settings.requests) return;
    /* Where somebody is marked to look at requests first, the request goes to
       them and to nobody else: asking both at once would have the office
       granting leave the first approver had not seen.

       Whether this particular request goes through them is set against the
       person who raised it, so the two sets of addresses are worked out once
       and each request is sent down its own road. */
    const first = await firstApproverOf(orgId, settings);
    const route = await approvalRouteOf(orgId);
    const fallback = (first && first.email) || '';
    const intros = await approverIntroOf(orgId);
    const ccMap = await approverCcOf(orgId);
    const finalLeg = { to: await mailRecipients(orgId, settings, 'leave'),
                       cc: mailCc(settings, 'leave') };
    const kv = await sharedKeys(orgId, ['companyInfo']);
    for (const r of added.slice(0, 5)) {
      /* Whoever holds the first stage for this particular person - which may
         be an address named against them alone. */
      const who = approverFor(route, r.empName, fallback);
      const leg = who ? legFor(settings, who, fallback, ccMap) : finalLeg;
      if (!leg.to.length) continue;
      /* The year behind this one request, for whoever has to decide it. */
      const withRecord = Object.assign({}, r, { leaveRecord: await leaveRecordFor(orgId, r.empName, r) });
      const mail = mailer.requestEmail({
        orgName: orgNameOf(kv.companyInfo), req: withRecord,
        links: await requestLinks(orgId, r.id, who ? 1 : 0, who),
        siteUrl: mailer.baseUrl(),
        heading: who ? 'A request for you to look at first'
                     : 'A request is waiting for a decision',
        intro: (who && firstWords(intros, who, settings)) || settings.leave.intro,
        approver: who ? await approverName(orgId, who) : '',
        footer: settings.leave.footer
      });
      /* The person who raised it, copied in: a request going round about
         somebody that they never see is one they cannot correct. */
      const theirs = await ownersOf(orgId, [r.empName], leg.to, leg.cc);
      const msg = { to: leg.to, cc: leg.cc.concat(theirs), subject: mail.subject, html: mail.html };
      const sentOne = await mailer.send(msg);
      await logMail(orgId, 'request', msg, sentOne);
    }
  } catch (e) {
    console.error('request email failed (request itself was saved):', e && e.message);
  }
}
/* Who looks at every leave request before a super admin grants it: the first
   address on the Leave tab's first-approval line. An address rather than an
   account, so it can be anybody - somebody with no login, a shared inbox, or
   wherever the office wants the first word to go while it is trying the two
   stages out. No address there means leave is granted in one stage, as it was
   before this existed.

   Where that address does belong to an account, their name is used, so the
   message that follows can say who approved it rather than reciting an
   address. */
/* The name behind an address, where it belongs to an account - so a message
   can say who recommended something rather than reciting an address. */
async function approverName(orgId, email) {
  const addr = String(email || '').trim();
  if (!EMAIL_RE.test(addr)) return 'the first approver';
  try {
    const r = await pool.query(
      'SELECT name FROM users WHERE org_id = $1 AND lower(email) = lower($2) ORDER BY id LIMIT 1',
      [orgId, addr]);
    if (r.rows[0] && String(r.rows[0].name || '').trim()) return String(r.rows[0].name).trim();
  } catch (e) { /* the address stands in for the name */ }
  return addr;
}
async function firstApproverOf(orgId, settings) {
  const s = settings || await mailSettings(orgId);
  const email = ((s.leave && s.leave.firstTo) || [])[0] || '';
  if (!EMAIL_RE.test(email)) return null;
  let name = email;
  try {
    const r = await pool.query(
      'SELECT name FROM users WHERE org_id = $1 AND lower(email) = lower($2) ORDER BY id LIMIT 1',
      [orgId, email]);
    if (r.rows[0] && String(r.rows[0].name || '').trim()) name = String(r.rows[0].name).trim();
  } catch (e) { /* the address stands in for the name */ }
  return { email, name };
}
/* Whose leave goes through that first approver. Naming one used to send every
   request in the company through them; it is set against the name now, in the
   shifts panel beside the shift itself.

   Only the people who skip the first stage are stored, so an empty map - a
   company that has never opened the panel - is everybody going through both,
   exactly what naming a first approver meant before this existed. */
async function approvalRouteOf(orgId) {
  const kv = await sharedKeys(orgId, ['approvalRoute']);
  const map = parseJson(kv.approvalRoute);
  return (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
}
/* The wording one approver reads, where the office set them wording of their
   own. Kept against the address rather than against the person who asked,
   because one message can cover several people - the nightly summary gathers
   everybody an approver looks after into one - and wording kept against a
   person would have had to pick one of them. Empty, or missing, means the
   wording every first approver gets. */
async function approverIntroOf(orgId) {
  const kv = await sharedKeys(orgId, ['approverIntro']);
  const map = parseJson(kv.approverIntro);
  return (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
}
/* Who else is copied on one approver's first-stage message, kept against the
   address for the same reason the wording is. The office's own first approver
   is not in here: that line has a Cc of its own in the settings. */
async function approverCcOf(orgId) {
  const kv = await sharedKeys(orgId, ['approverCc']);
  const map = parseJson(kv.approverCc);
  return (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
}
/* The words this one address reads: their own, or the office's for everybody
   who holds the stage. Empty means nothing was written for either. */
function firstWords(intros, who, settings) {
  const own = String((intros || {})[String(who || '').trim().toLowerCase()] || '').trim();
  return own || String((settings.leave || {}).firstIntro || '');
}
function needsFirstApproval(route, name) {
  return (route || {})[name] !== 'final';
}
/* Who holds the first stage for one person, as an address, or null where
   nobody does.

   A row in the map is one of three things: missing, meaning the office's own
   first approver; the word 'final', meaning no first stage at all; or an
   address, meaning that person's leave goes to somebody else first. The third
   is why this exists - one employee reports to somebody outside the usual
   line, and routing the whole company through that person to serve one of them
   is not an answer. */
function approverFor(route, name, fallback) {
  const v = (route || {})[name];
  if (v === 'final') return null;
  const own = typeof v === 'string' && EMAIL_RE.test(v.trim()) ? v.trim() : '';
  const who = own || String(fallback || '').trim();
  return EMAIL_RE.test(who) ? who.toLowerCase() : null;
}
/* Whose decision a waiting request is, at the stage the message is being built
   for. At one stage (st 0) everybody's.

   Stage 1 belongs to one named approver at a time: what they have not passed
   on, for the people whose leave goes through them and nobody else's. Stage 2
   is the final word's: what has been passed on, plus - from the moment it is
   raised - anything from somebody with no first stage at all, since no one
   else is ever going to look at it. */
function stageOwns(st, route, r, fallback, forApprover) {
  if (st === 0) return true;
  const who = approverFor(route, r && r.empName, fallback);
  if (st === 2) return r.status === 'recommended' || !who;
  return !!who && who === String(forApprover || '').toLowerCase()
      && r.status !== 'recommended';
}
/* The same, for a day marked on the record with no request behind it. It has
   been through no stage at all, so it belongs to whoever holds the first stage
   for that person - or to the final word where nobody does. */
function stageOwnsUnreq(st, route, u, fallback, forApprover) {
  if (st === 0) return true;
  const who = approverFor(route, u && u.empName, fallback);
  return st === 1 ? (!!who && who === String(forApprover || '').toLowerCase()) : !who;
}
/* Every address that holds a first stage for somebody: the office's own, and
   each one named against a particular person. One message each, so nobody is
   handed a decision that is not theirs.

   The office's own is always in the list rather than worked out from who is
   left over - a stage with nothing waiting builds no message and sends
   nothing, which settles it without needing the roll of employees here. */
function firstApprovers(route, fallback) {
  const seen = {}, out = [];
  const add = a => {
    const k = String(a || '').trim().toLowerCase();
    if (EMAIL_RE.test(k) && !seen[k]) { seen[k] = true; out.push(k); }
  };
  add(fallback);
  Object.keys(route || {}).forEach(n => {
    const v = route[n];
    if (typeof v === 'string' && v !== 'final') add(v);
  });
  return out;
}
/* Who a stage-1 message goes to. The office's own first approver keeps the
   line it was configured with, because that stage may be shared by several
   people; an approver named against one person is that one address. */
function legFor(settings, who, fallback, ccMap) {
  if (who === String(fallback || '').trim().toLowerCase()) {
    const to = ((settings.leave && settings.leave.firstTo) || []).slice();
    /* Its own Cc, and anything kept against this address the way every other
       approver's copy list is kept - the panel has one box for both now. */
    const extra = ((ccMap || {})[who] || []).map(a => String(a || '').trim().toLowerCase());
    const seen = {}, cc = [];
    ((settings.leave && settings.leave.firstCc) || []).concat(extra).forEach(a => {
      const k = String(a || '').trim().toLowerCase();
      if (EMAIL_RE.test(k) && to.indexOf(k) === -1 && !seen[k]) { seen[k] = true; cc.push(k); }
    });
    return { stage: 1, approver: who, to, cc };
  }
  /* An address named against one person could be written to and never copied:
     the office's Cc belongs to the office's own line, and there was nowhere
     else to put one. This is that somewhere - kept against the approver, like
     their wording, and read here rather than trusted, because it is a stored
     map that decides who a message reaches. */
  const seen = {}, cc = [];
  ((ccMap || {})[who] || []).forEach(a => {
    const k = String(a || '').trim().toLowerCase();
    if (EMAIL_RE.test(k) && k !== who && !seen[k]) { seen[k] = true; cc.push(k); }
  });
  return { stage: 1, approver: who, to: [who], cc };
}

/* The person the leave belongs to, by their own account. Accounts are made
   with the employee's name against them, so that is what ties a request to an
   address; without an account there is nobody to write to. */
/* The people a message about somebody's own day is copied to: the people who
   made it. A notice about what you did that you never see is one you cannot
   correct, and the one person certain to know whether it is right is the one
   it is about. Anybody with no account, or no address on it, is simply not
   there to copy. */
/* ---- the year behind one request ----
   An approver deciding from an email has the dates and nothing else. What
   turns that into a decision is the year behind it: what is left of each kind
   of leave, what has gone already, and when.

   The arithmetic belongs to the dashboard - joining dates, accrual, part days,
   deductions, months entered by hand - and writing it again here would be two
   versions of the truth. So the page publishes what it worked out and this
   reads it, with the date it was taken, which is why the message says "as the
   dashboard had them". The days around the request are worked out here,
   because they are a question about everybody rather than about one person. */
async function leaveRecordFor(orgId, empName, req) {
  try {
    const kv = await sharedKeys(orgId, ['leaveRecord', 'leaveRequests', 'overrides',
                                        'halfDays', 'empNames']);
    const snap = parseJson(kv.leaveRecord) || {};
    const mine = (snap.people || {})[empName] || null;
    const shown = parseJson(kv.empNames) || {};
    const requests = parseJson(kv.leaveRequests) || [];
    const overrides = parseJson(kv.overrides) || {};
    const halfDays = parseJson(kv.halfDays) || {};
    /* The days this request covers, so the rest can be said about them. */
    const days = [];
    if (req && DAY_RE.test(String(req.dateFrom || ''))) {
      const to = DAY_RE.test(String(req.dateTo || '')) ? req.dateTo : req.dateFrom;
      for (let d = new Date(req.dateFrom + 'T00:00:00Z'); days.length < 60; d.setUTCDate(d.getUTCDate() + 1)) {
        const iso = d.toISOString().slice(0, 10);
        days.push(iso);
        if (iso >= to) break;
      }
    }
    /* Anybody else already away on one of those days - the fact most likely to
       turn a yes into a no, and the one nobody can see from the request. */
    const away = {};
    days.forEach(day => {
      Object.keys(overrides).forEach(k => {
        const v = overrides[k];
        if (!v || v.cat !== 'LEAVE') return;
        const name = k.slice(0, k.lastIndexOf('|'));
        if (k.slice(k.lastIndexOf('|') + 1) === day && name !== empName) away[name] = true;
      });
      Object.keys(halfDays).forEach(k => {
        const name = k.slice(0, k.lastIndexOf('|'));
        if (k.slice(k.lastIndexOf('|') + 1) === day && name !== empName) away[name] = true;
      });
      requests.forEach(r => {
        if (!r || r.status !== 'approved' || r.empName === empName) return;
        if (r.leaveType === 'PUNCH' || r.leaveType === 'WFH' || r.leaveType === 'VISIT') return;
        if (String(r.dateFrom) <= day && String(r.dateTo || r.dateFrom) >= day) away[r.empName] = true;
      });
    });
    /* And anything else of their own still waiting, which an approver saying
       yes to this one should know about. */
    const alsoWaiting = requests.filter(r => r && r.empName === empName && r.status === 'pending'
      && (!req || r.id !== req.id) && r.leaveType !== 'PUNCH')
      .slice(0, 4)
      .map(r => ({ dates: mailer.dateRange(r.dateFrom, r.dateTo),
                   kind: mailer.kindName(r.leaveType), raised: String(r.createdAt || '').slice(0, 10) }));
    if (!mine && !Object.keys(away).length && !alsoWaiting.length) return null;
    return {
      record: mine, asOf: snap.at || '', 
      away: Object.keys(away).map(n => shown[n] || n).sort(),
      alsoWaiting
    };
  } catch (e) {
    console.error('leave record for the message failed:', e && e.message);
    return null;                        // a message without it is better than none
  }
}
/* The same, but only where the message is about one person. A digest naming
   several people is a different thing: copying somebody on it would hand them
   everybody else's leave, which is not theirs to read. So a group of one is
   copied and a group of several is not. */
/* The address that passed a request on. A first approver's yes is the reason
   the management is being written to at all, and until now they were told
   nothing of what became of it - their name was in the heading of a message
   they never saw. Copied, like the person who asked.

   The name on the request is a name, not an address, so the address is worked
   out the way the first stage is worked out everywhere else: the approver named
   against that person, or the office's own where nobody is. */
async function recommenderOf(orgId, settings, reqs) {
  const live = (reqs || []).filter(r => r && r.status === 'recommended' && r.empName);
  if (!live.length) return [];
  const first = await firstApproverOf(orgId, settings);
  const fallback = (first && first.email) || '';
  const route = await approvalRouteOf(orgId);
  const seen = {}, out = [];
  for (const r of live) {
    /* Whoever actually pressed it, by the name the button carried and the
       accounts' own roll - which is the right answer even where the office has
       since pointed that person's leave somewhere else, or named nobody at all.
       Only failing that is the stage read off the route as a stand-in. */
    const byName = await employeeAddress(orgId, r.recommendedBy || '');
    const who = byName || approverFor(route, r.empName, fallback) || '';
    const k = String(who).toLowerCase();
    if (k && !seen[k]) { seen[k] = true; out.push(k); }
  }
  return out;
}
/* The same, minus anybody already written to or copied. */
function notAlready(list, to, cc) {
  const seen = {};
  (to || []).concat(cc || []).forEach(a => { seen[String(a || '').toLowerCase()] = true; });
  return (list || []).filter(a => {
    const k = String(a || '').toLowerCase();
    if (!k || seen[k]) return false;
    seen[k] = true;
    return true;
  });
}
async function ownersIfAlone(orgId, names, to, cc) {
  const distinct = Array.from(new Set((names || []).filter(Boolean)));
  if (distinct.length !== 1) return [];
  return ownersOf(orgId, distinct, to, cc);
}
async function ownersOf(orgId, names, to, cc) {
  const out = [];
  const seen = {};
  (to || []).concat(cc || []).forEach(a => { seen[String(a).toLowerCase()] = true; });
  for (const n of Array.from(new Set(names.filter(Boolean)))) {
    const addr = (await employeeAddress(orgId, n)).toLowerCase();
    if (addr && !seen[addr]) { seen[addr] = true; out.push(addr); }
  }
  return out;
}
async function employeeAddress(orgId, empName) {
  const r = await pool.query(
    `SELECT email FROM users WHERE org_id = $1 AND is_active
       AND lower(COALESCE(name, '')) = lower($2) ORDER BY id LIMIT 1`, [orgId, String(empName || '')]);
  const email = r.rows[0] ? String(r.rows[0].email || '') : '';
  return EMAIL_RE.test(email) ? email : '';
}

/* Once a request is settled - from the buttons in an email or on the portal -
   the person who asked is told, with the office copied. Claimed against the
   request and the answer, so one decision is one message however many saves
   carry it. */
async function notifyDecision(orgId, req) {
  try {
    if (!mailer.ready() || !req || !req.id) return;
    if (req.status !== 'approved' && req.status !== 'rejected') return;
    const settings = await mailSettings(orgId);
    if (!settings.leave.confirm) return;
    const to = await employeeAddress(orgId, req.empName);
    if (!to) return;                                   // no account, nobody to write to
    const job = 'decision-email:' + orgId + ':' + req.id + ':' + req.status;
    const claimed = await pool.query(
      'INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING RETURNING job', [job]);
    if (!claimed.rows.length) return;
    const kv = await sharedKeys(orgId, ['companyInfo']);
    const mail = mailer.decisionEmail({
      orgName: orgNameOf(kv.companyInfo), req, decision: req.status, siteUrl: mailer.baseUrl()
    });
    const cc = mailCc(settings, 'leave');
    const r = await mailer.send({ to, cc, subject: mail.subject, html: mail.html });
    await logMail(orgId, 'decision', { to: [to], cc, subject: mail.subject, html: mail.html }, r);
  } catch (e) {
    console.error('the decision stands but its message failed:', e && e.message);
  }
}

/* The first approver has said yes. The super admins are asked for the word
   that grants it, and are told whose recommendation they are acting on. */
async function notifyRecommended(orgId, req) {
  try {
    if (!mailer.ready() || !req || !req.id) return;
    const settings = await mailSettings(orgId);
    if (!settings.requests) return;
    const to = await mailRecipients(orgId, settings, 'leave');
    if (!to.length) return;
    const job = 'recommended-email:' + orgId + ':' + req.id;
    const claimed = await pool.query(
      'INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING RETURNING job', [job]);
    if (!claimed.rows.length) return;
    const kv = await sharedKeys(orgId, ['companyInfo']);
    const mail = mailer.requestEmail({
      orgName: orgNameOf(kv.companyInfo),
      req: Object.assign({}, req, { leaveRecord: await leaveRecordFor(orgId, req.empName, req) }),
      links: linksFor({ k: 'req', org: orgId, id: req.id, s: 2 }),
      siteUrl: mailer.baseUrl(),
      heading: 'Approved by ' + (req.recommendedBy || 'the first approver') + ', waiting on you',
      intro: settings.leave.intro, footer: settings.leave.footer
    });
    const cc = mailCc(settings, 'leave').concat(
      await ownersOf(orgId, [req.empName], to, mailCc(settings, 'leave')));
    /* And whoever passed it on, so a first approver sees what became of their
       own recommendation rather than reading their name in a heading they
       were never shown. */
    cc.push.apply(cc, notAlready(await recommenderOf(orgId, settings, [req]), to, cc));
    const r = await mailer.send({ to, cc, subject: mail.subject, html: mail.html });
    await logMail(orgId, 'request', { to, cc, subject: mail.subject, html: mail.html }, r);
  } catch (e) {
    console.error('the recommendation stands but its message failed:', e && e.message);
  }
}

/* Which requests have just been settled, comparing what was stored with what
   was saved: a decision made on the portal, rather than from an email. */
function newlyDecided(beforeText, afterText) {
  const before = parseJson(beforeText), after = parseJson(afterText);
  if (!Array.isArray(after)) return [];
  const was = {};
  (Array.isArray(before) ? before : []).forEach(r => { if (r && r.id) was[String(r.id)] = r.status; });
  return after.filter(r => r && r.id && (r.status === 'approved' || r.status === 'rejected')
                        && was[String(r.id)] !== r.status);
}
/* The same, for the middle of the two-stage grant: a request the first
   approver has just passed on from the portal. */
function newlyRecommended(beforeText, afterText) {
  const before = parseJson(beforeText), after = parseJson(afterText);
  if (!Array.isArray(after)) return [];
  const was = {};
  (Array.isArray(before) ? before : []).forEach(r => { if (r && r.id) was[String(r.id)] = r.status; });
  return after.filter(r => r && r.id && r.status === 'recommended' && was[String(r.id)] !== 'recommended');
}

/* Which marks are new: somebody has answered for their own late arrival, or
   has changed what they said. One the office wrote is not this - that is the
   office deciding, and nobody needs telling about their own decision. */
function newlySelfExcused(beforeText, afterText) {
  const asMap = t => {
    const v = parseJson(t);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  };
  const was = asMap(beforeText), now = asMap(afterText), out = [];
  Object.keys(now).forEach(k => {
    const v = now[k];
    /* Only the mark that takes the minutes off is news. Somebody writing down
       that they were late for their own reasons has taken nothing off the day,
       and the office reads those in the evening message with everything else. */
    if (!v || typeof v !== 'object' || v.by !== 'self'
        || v.pending === true || v.kind === 'late') return;
    const old = was[k];
    if (old && typeof old === 'object' && old.by === 'self' && old.note === v.note) return;
    const i = String(k).lastIndexOf('|');
    if (i < 1) return;
    const day = String(k).slice(i + 1);
    if (!DAY_RE.test(day)) return;
    out.push({ empName: String(k).slice(0, i), day, note: String(v.note || ''),
               changed: !!(old && typeof old === 'object' && old.by === 'self') });
  });
  return out;
}
/* The message about it. For reading, not for deciding: the day is already
   excused on the record, there are no buttons on it, and it goes to whoever
   the office named for this and nobody else - an empty list means nobody
   wanted telling, so nothing is sent. */
async function notifySelfExcused(orgId, marks) {
  try {
    if (!mailer.ready() || !marks || !marks.length) return;
    const settings = await mailSettings(orgId);
    /* The people who give the final word on leave, read from that list as it
       stands. The office asked for this to reach the management who decide
       leave, and keeping a second copy of their addresses here would mean two
       lists to keep in step and one of them quietly wrong. */
    const to = settings.excused.final
      ? (await mailRecipients(orgId, settings, 'leave')).slice()
      : (settings.excused.to || []).slice();
    if (!to.length) return;
    const cc = (settings.excused.cc || []).filter(a => to.indexOf(a) < 0);
    const kv = await sharedKeys(orgId, ['companyInfo', 'empNames', 'dayShifts', 'shiftAssignments',
                                        'lateThresholdMin']);
    const shownNames = parseJson(kv.empNames) || {};
    const dayShifts = parseJson(kv.dayShifts) || {};
    const assigned = parseJson(kv.shiftAssignments) || {};
    /* How late they actually were is read off the record here rather than
       taken from the page: the page is theirs, and a figure in a message
       about their own lateness is the one figure worth checking. */
    const days = Array.from(new Set(marks.map(m => m.day)));
    const recs = await pool.query(
      'SELECT employee, day, data FROM records WHERE org_id = $1 AND day = ANY($2)', [orgId, days]);
    const byKey = {};
    recs.rows.forEach(r => {
      const d = (r.day instanceof Date) ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
      byKey[r.employee + '|' + d] = r.data || {};
    });
    const items = marks.map(m => {
      const key = m.empName + '|' + m.day;
      const rec = byKey[key] || {};
      const shift = dayShifts[key] || shiftInForce(assigned, m.empName, m.day) || '';
      const start = shiftStartMin(shift || '9:30-6:30');
      const came = hhmmToMinutes(rec['in']);
      return {
        name: shownNames[m.empName] || m.empName,
        day: m.day, note: m.note, changed: m.changed,
        came: rec['in'] || '', shift: shift,
        late: (came != null && start != null && came - start > 0) ? (came - start) : null
      };
    });
    /* And the people whose days these are. */
    cc.push.apply(cc, await ownersOf(orgId, marks.map(m => m.empName), to, cc));
    const mail = mailer.excusedEmail({
      orgName: orgNameOf(kv.companyInfo), items, siteUrl: mailer.baseUrl(),
      /* The office's own words, the same ones the test shows it. */
      subject: settings.excused.subject, intro: settings.excused.intro,
      footer: settings.excused.footer
    });
    if (!mail) return;
    const msg = { to, cc, subject: mail.subject, html: mail.html };
    const sent = await mailer.send(msg);
    await logMail(orgId, 'excused', msg, sent);
  } catch (e) {
    /* The mark is on the record either way; only the telling failed. */
    console.error('the excused mark stands but its message failed:', e && e.message);
  }
}
/* Somebody has set their own hours for a day. The same people hear about it as
   hear about an excused late mark - it is the same kind of news, made by the
   same person about their own day - and the words are the office's own, kept
   apart from the excused ones because what matters here is which hours. */
async function notifyShiftChange(orgId, moves) {
  try {
    if (!mailer.ready() || !moves || !moves.length) return;
    const settings = await mailSettings(orgId);
    const to = settings.excused.final
      ? (await mailRecipients(orgId, settings, 'leave')).slice()
      : (settings.excused.to || []).slice();
    if (!to.length) return;
    const cc = (settings.excused.cc || []).filter(a => to.indexOf(a) < 0);
    const kv = await sharedKeys(orgId, ['companyInfo', 'empNames', 'shiftAssignments']);
    const shownNames = parseJson(kv.empNames) || {};
    const assigned = parseJson(kv.shiftAssignments) || {};
    const words = (settings.excused.shift || {});
    const items = moves.map(m => ({
      name: shownNames[m.empName] || m.empName,
      day: m.day,
      /* What the day had before, which is the standing shift where the day
         carried nothing of its own - the figure the office would otherwise
         have to go and look up. */
      from: m.from || shiftFor(assigned, m.empName) || '',
      to: m.to
    }));
    cc.push.apply(cc, await ownersOf(orgId, moves.map(m => m.empName), to, cc));
    const mail = mailer.shiftEmail({
      orgName: orgNameOf(kv.companyInfo), items, siteUrl: mailer.baseUrl(),
      subject: words.subject, intro: words.intro, footer: words.footer
    });
    if (!mail) return;
    const msg = { to, cc, subject: mail.subject, html: mail.html };
    const sent = await mailer.send(msg);
    await logMail(orgId, 'shift', msg, sent);
  } catch (e) {
    console.error('the shift stands but its message failed:', e && e.message);
  }
}

/* A day marked as leave on the grid with no request behind it is the same
   thing as a request, arriving by a different door: somebody is away and it has
   not been agreed. So it is sent the same way, with its Approve and Reject
   buttons, as the mark is made.

   Each day is claimed in maintenance_done first, so editing the same day twice
   - or two admins saving at once - does not send it twice. */
async function notifyUnrequestedMarks(orgId, key, changes) {
  try {
    if (!mailer.ready() || !changes || !changes.length) return;
    const settings = await mailSettings(orgId);
    if (!settings.unrequested) return;
    const PART = ['HALF', 'SHORT', 'THREEQ'];
    /* Only marks that have just appeared, and only leave: a WFH or visit day is
       not something anybody has to decide. */
    const fresh = [], cleared = [];
    changes.slice(0, 60).forEach(c => {
      const after = parseJson(c.after);
      if (!after) {
        /* The mark has gone - undone on the grid, or removed by a rejection.
           Its claim goes with it, so if the day is marked again it is sent
           again rather than silently swallowed. */
        if (DAY_RE.test(String(c.item).split('|')[1] || '')) cleared.push(String(c.item));
        return;
      }
      const emp = String(c.item).split('|')[0], day = String(c.item).split('|')[1] || '';
      if (!DAY_RE.test(day)) return;
      if (key === 'overrides') {
        if (after.cat !== 'LEAVE' || after.reqId) return;   // a request wrote it: already known
        fresh.push({ empName: emp, dateFrom: day, dateTo: day,
                     leaveType: after.detail === 'Sick' ? 'Sick' : 'CL', message: after.reason || '' });
      } else if (key === 'halfDays') {
        if (after.reqId) return;
        const kind = after.kind || 'HALF';
        if (PART.indexOf(kind) === -1) return;
        fresh.push({ empName: emp, dateFrom: day, dateTo: day, leaveType: kind,
                     half: after.half || '', message: after.note || '' });
      }
    });
    for (const item of cleared) {
      await pool.query('DELETE FROM maintenance_done WHERE job = $1', ['unreq-email:' + orgId + ':' + item]);
    }
    if (!fresh.length) return;

    const kv = await sharedKeys(orgId, ['leaveRequests', 'companyInfo']);
    const requests = parseJson(kv.leaveRequests) || [];
    const covered = (m) => requests.some(r => r && r.status !== 'rejected'
      && r.status !== 'cancelled' && r.leaveType !== 'PUNCH'
      && r.empName === m.empName && r.dateFrom <= m.dateFrom && r.dateTo >= m.dateFrom
      && ((PART.indexOf(r.leaveType) > -1) === (PART.indexOf(m.leaveType) > -1)));
    const worth = [];
    for (const m of fresh) {
      if (covered(m)) continue;
      const job = 'unreq-email:' + orgId + ':' + m.empName + '|' + m.dateFrom;
      const claimed = await pool.query(
        'INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING RETURNING job', [job]);
      if (claimed.rows.length) worth.push(m);
    }
    if (!worth.length) return;

    /* The same two stages a request takes. A mark is a request by another
       door, so where somebody is named to look at leave first it goes to them
       and to nobody else, and their yes passes it on rather than granting it.
       The stage is sealed into the buttons, so a link cannot be made to grant
       by stripping it.

       A batch of marks can hold both kinds of people, so it is split by whose
       stage each one is and sent as two messages rather than one addressed to
       whoever happened to come first. */
    const first = await firstApproverOf(orgId, settings);
    const route = await approvalRouteOf(orgId);
    const fallback = (first && first.email) || '';
    /* One group per person holding a first stage, and one for the marks that
       have no first stage at all. */
    const markCc = await approverCcOf(orgId);
    const groups = [];
    firstApprovers(route, fallback).forEach(who => {
      groups.push({ stage: 1, approver: who,
                    items: worth.filter(m => approverFor(route, m.empName, fallback) === who) });
    });
    groups.push({ stage: 0, approver: '',
                  items: worth.filter(m => !approverFor(route, m.empName, fallback)) });
    for (const g of groups) {
      if (!g.items.length) continue;
      const stage = g.stage;
      const byName = stage === 1 ? await approverName(orgId, g.approver) : '';
      const gWords = stage ? firstWords(await approverIntroOf(orgId), g.approver, settings) : '';
      const mail = mailer.leaveEmail({
        orgName: orgNameOf(kv.companyInfo), pending: [],
        unrequested: g.items.slice(0, 15).map(m => ({
          req: m,
          heading: stage ? 'Marked on the record, for you to look at first'
                         : 'Marked on the record, no request',
          links: linksFor(stage
            ? { k: 'unreq', org: orgId, e: m.empName, d: m.dateFrom,
                t: m.leaveType, h: m.half || '', s: 1, by: byName }
            : { k: 'unreq', org: orgId, e: m.empName, d: m.dateFrom,
                t: m.leaveType, h: m.half || '' })
        })),
        subject: settings.leave.subject,
        intro: gWords || settings.leave.intro,
        approver: byName,
        footer: settings.leave.footer, siteUrl: mailer.baseUrl()
      });
      if (!mail) continue;
      let to, cc;
      if (stage) {
        const leg = legFor(settings, g.approver, fallback, markCc);
        to = leg.to; cc = leg.cc;
      } else {
        to = await mailRecipients(orgId, settings, 'leave');
        cc = mailCc(settings, 'leave');
      }
      if (!to.length) continue;
      /* One person's days: they are copied. Several people's in the one
         message: nobody is, because it is not theirs to read. */
      cc = cc.concat(await ownersIfAlone(orgId, g.items.map(m => m.empName), to, cc));
      const r = await mailer.send({ to, cc, subject: mail.subject, html: mail.html });
      await logMail(orgId, 'leave', { to, cc, subject: mail.subject, html: mail.html }, r);
    }
  } catch (e) {
    console.error('leave-without-a-request email failed (the mark itself was saved):', e && e.message);
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
async function applyEmailDecision(p, note) {
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
    let skipped = 0, kept = 0, summary = '', decided = null, recommended = null;

    if (p.k === 'req') {
      const req = reqs.filter(r => r && r.id === p.id)[0];
      if (!req) { await client.query('ROLLBACK'); return { ok: false, title: 'That request is gone', detail: 'It is no longer on file.' }; }
      /* One approval, by whoever it was sent to.

         It used to take two: an approver marked to look first said yes, which
         moved it to a super admin rather than granting it, and the super admin
         said yes again. The office asked for the first word to be the only
         word - the person it is sent to is the person who decides it - and for
         anybody routed straight to the management, nothing changes, because
         that was already one word.

         The stage still rides in the link, because it says whose word this is
         and so who the note is written to. It no longer decides whether the
         yes grants anything: it always does. */
      const byFirst = p.s === 1;
      if (WAITING.indexOf(req.status) === -1) {
        await client.query('ROLLBACK');
        return settledSay(dispReq(req), req.status);
      }
      req.status = p.act === 'approve' ? 'approved' : 'rejected';
      req.updatedAt = now;
      if (note) req.adminNote = note;                  // the reason, in their own words
      /* Whoever was sent it is whoever granted it, and the record says which of
         them it was rather than the word 'email'. */
      if (p.act === 'approve') req.approvedBy = byFirst ? (p.by || 'email') : 'email';
      else delete req.approvedBy;
      summary = dispReq(req);
      decided = req;

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
      const covered = reqs.filter(r => coversDay(r, p))[0];
      if (covered) {
        await client.query('ROLLBACK');
        return settledSay(dispReq(covered), covered.status);
      }
      /* Two stages, the same as a request: where the link carries a first
         stage, a yes recommends and a no ends it there. A link made before
         anybody was named carries no stage and grants in one, as it did. */
      const firstUnreq = p.s === 1;
      const fresh = {
        id: 'req_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
        empName: p.e, dateFrom: p.d, dateTo: p.d, leaveType: p.t, half: p.h || '',
        message: 'Taken without a request',
        status: p.act !== 'approve' ? 'rejected' : 'approved',
        adminNote: note || (p.act === 'approve' ? 'Approved by email'
                                                 : 'Not authorised — the day was removed from the record.'),
        employeeReply: '', createdAt: now, updatedAt: now
      };
      /* One word settles it here too: whoever the day was sent to decides it.
         It used to be passed on to a super admin, which is the stage the office
         has asked to drop. */
      if (p.act === 'approve') fresh.approvedBy = firstUnreq ? (p.by || 'email') : 'email';
      reqs.push(fresh);
      summary = dispReq(fresh);
      decided = fresh;
      /* Decided: the day starts afresh. Marked again later, it is sent again. */
      await client.query('DELETE FROM maintenance_done WHERE job = $1',
        ['unreq-email:' + p.org + ':' + p.e + '|' + p.d]);
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
    /* Decided from the email: tell the person it belongs to, as the portal
       does. After the commit, and never in the way of the answer. */
    if (decided) notifyDecision(p.org, decided);
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
/* Whichever way a request was answered, that answer stands: the buttons in an
   email decide once. Changing one's mind is a job for the panel, where the
   whole record is in view. */
/* Every state a request can be in and still be waiting on somebody. */
const WAITING = ['pending', 'query', 'recommended'];
function settledSay(summary, status) {
  return { ok: false, title: 'This request is already settled',
           detail: summary + ' was already ' + (status === 'approved' ? 'approved' : 'rejected')
             + '. If you need to revise it, please make the change from the attendance panel.' };
}
/* Whether a stored request already speaks for the day a "taken without a
   request" link is about - answered either way. */
function coversDay(r, p) {
  return !!r && r.empName === p.e && r.dateFrom <= p.d && r.dateTo >= p.d
      && (PART_KINDS.indexOf(r.leaveType) > -1) === (PART_KINDS.indexOf(p.t) > -1);
}
/* What the link is about, if it has already been settled - so the page says so
   before anything is pressed, rather than after. */
async function alreadySettled(p) {
  try {
    const r = await pool.query(
      'SELECT value FROM kv WHERE org_id = $1 AND key = $2 AND user_id IS NULL', [p.org, 'leaveRequests']);
    const reqs = parseJson(r.rows[0] ? r.rows[0].value : null) || [];
    const hit = p.k === 'unreq'
      ? reqs.filter(x => coversDay(x, p))[0]
      : reqs.filter(x => x && x.id === p.id)[0];
    if (!hit) return null;
    /* A request passed on by a first approver sits at 'recommended', waiting on
       the management - which is the one state this gate did not know about. The
       final approver's own link opened on “already settled” and there was no way
       past it: the page that asks never appeared, so the button that grants it
       was never reached. Anything still waiting on somebody is not settled. */
    if (p.k !== 'unreq' && WAITING.indexOf(hit.status) > -1) return null;
    return settledSay(dispReq(hit), hit.status);
  } catch (e) { return null; }      // if it cannot be read, the POST still guards
}

/* The page a button in an email opens. GET asks; POST acts - so a mail scanner
   following every link cannot decide anything. */
const mailActionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.get('/e/:token', mailActionLimiter, async (req, res) => {
  const p = mailer.verifyAction(req.params.token, process.env.SESSION_SECRET || 'dev-secret');
  res.set('Cache-Control', 'no-store').type('html');
  if (!p) return res.status(400).send(mailer.resultPage('That link has expired',
    'Links in an email are good for ' + mailer.ACTION_DAYS + ' days. Open the dashboard and decide there.', false));
  const done = await alreadySettled(p);
  if (done) return res.status(409).send(mailer.resultPage(done.title, done.detail, false));
  const what = p.k === 'unreq'
    ? (p.e + ' · ' + mailer.kindName(p.t) + ' · ' + mailer.fmtDay(p.d))
    : 'the request in the email';
  res.send(mailer.confirmPage({
    action: p.act, unrequested: p.k === 'unreq', summary: what,
    who: p.k === 'unreq' ? p.e : '',
    /* One word settles it, so a note on it is written to the person who asked
       - there is no longer a stage after this one to pass it to. */
    firstStage: false,
    postTo: '/e/' + req.params.token
  }));
});
const formBody = express.urlencoded({ extended: false, limit: '20kb' });
app.post('/e/:token', mailActionLimiter, formBody, async (req, res) => {
  const p = mailer.verifyAction(req.params.token, process.env.SESSION_SECRET || 'dev-secret');
  res.set('Cache-Control', 'no-store').type('html');
  if (!p) return res.status(400).send(mailer.resultPage('That link has expired',
    'Open the dashboard and decide there.', false));
  // Whatever was typed in the box on that page travels with the decision.
  const out = await applyEmailDecision(p, clip((req.body && req.body.note) || '', 500).trim());
  res.status(out.ok ? 200 : 409).send(mailer.resultPage(out.title, out.detail, out.ok));
});

/* Admin controls: what is configured, a test email, and "send today's now". */
app.get('/api/mail', requireRole('admin', 'admin_view'), async (req, res) => {
  const s = await mailSettings(req.session.orgId);
  const to = await mailRecipients(req.session.orgId, s);
  const first = await firstApproverOf(req.session.orgId, s);
  const mine = String((req.user && req.user.email) || '');
  /* The wording each message is built with. The panel shows it in the box when
     nothing has been saved over it, so what is on screen is what goes out - it
     was reading `defaults` all along and never being sent any, so every box
     looked empty until somebody typed in it. */
  res.json({ configured: mailer.ready(), from: mailer.conf().from, siteUrl: mailer.baseUrl(),
             settings: s, to, defaults: mailer.DEFAULT_TEXT,
             firstApprover: first ? { name: first.name, email: first.email } : null,
             you: EMAIL_RE.test(mine) ? mine : '' });
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
  /* The tab the office is looking at, so what comes back is that message
     rather than a note saying the wiring works. Built exactly as the real one
     is, with the office's own wording, and addressed to the one person asking
     instead of to the people it would really reach. */
  const kind = String((req.body && req.body.kind) || '').trim();
  let demo = null;
  if (kind === 'lt') {
    const settings = await mailSettings(req.session.orgId);
    const kv = await sharedKeys(req.session.orgId, ['companyInfo', 'lateExcuses', 'empNames']);
    const shownNames = parseJson(kv.empNames) || {};
    /* A real one off the record if there is one, so the message is read with
       the office's own names and words in it; a worked example otherwise,
       which is the only honest thing to show when nothing has been marked. */
    const marks = Object.keys(parseJson(kv.lateExcuses) || {})
      .map(k => ({ k, v: (parseJson(kv.lateExcuses) || {})[k] }))
      .filter(x => x.v && typeof x.v === 'object' && x.v.by === 'self'
                   && x.v.pending !== true && x.v.kind !== 'late')
      .slice(-1);
    const items = marks.length
      ? marks.map(x => {
          const i = x.k.lastIndexOf('|');
          const who = x.k.slice(0, i);
          return { name: shownNames[who] || who, day: x.k.slice(i + 1),
                   note: String(x.v.note || ''), late: null };
        })
      : [{ name: 'A name from the record', day: istParts().day,
           note: 'the client call ran over from yesterday',
           came: '09:52', shift: '9:30-6:30', late: 22 }];
    demo = mailer.excusedEmail({
      orgName: orgNameOf(kv.companyInfo), siteUrl: mailer.baseUrl(), items,
      subject: settings.excused.subject, intro: settings.excused.intro,
      footer: settings.excused.footer
    });
  }
  /* The late tab carries two messages now, so a test of it shows both: the
     same addresses, told about two different things in two different ways. */
  let demo2 = null;
  if (kind === 'lt') {
    const settings = await mailSettings(req.session.orgId);
    const kv = await sharedKeys(req.session.orgId, ['companyInfo', 'empNames', 'shiftAssignments']);
    const shownNames = parseJson(kv.empNames) || {};
    const me = (req.user && req.user.name) || 'A name from the record';
    const words = settings.excused.shift || {};
    demo2 = mailer.shiftEmail({
      orgName: orgNameOf(kv.companyInfo), siteUrl: mailer.baseUrl(),
      items: [{ name: shownNames[me] || me, day: istParts().day,
                from: shiftFor(parseJson(kv.shiftAssignments) || {}, me) || '9:30-6:30',
                to: '11:00-8:00' }],
      subject: words.subject, intro: words.intro, footer: words.footer
    });
  }
  const testMail = demo ? { to: [to], subject: demo.subject, html: demo.html } : {
    to: [to], subject: 'Attendance email is working',
    html: mailer.layout('Attendance', 'Test message', ['<p>This is the test message from the dashboard. '
      + 'Daily summaries and leave requests will arrive here.</p>'])
  };
  const r = await mailer.send({ to, subject: testMail.subject, html: testMail.html });
  await logMail(req.session.orgId, demo ? 'excused' : 'test', testMail, r);
  if (r.ok && demo2) {
    const second = { to: [to], subject: demo2.subject, html: demo2.html };
    const r2 = await mailer.send({ to, subject: second.subject, html: second.html });
    await logMail(req.session.orgId, 'shift', second, r2);
  }
  res.status(r.ok ? 200 : 502).json(Object.assign({ sentTo: to, demo: !!demo, both: !!demo2 }, r));
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
    await logMail(req.session.orgId, 'attendance', held, r);
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
app.post('/api/mail/holiday', requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  if (body.send === 'preview') {
    const held = previews.get(req.session.userId);
    if (!held) return res.status(410).json({ error: 'that preview has expired - open it again' });
    previews.delete(req.session.userId);
    const r = await mailer.send({ to: held.to, cc: held.cc, subject: held.subject, html: held.html });
    await logMail(req.session.orgId, 'holiday', held, r);
    if (r.ok) await markHolidaySaid(req.session.orgId, held.holiday);
    return res.status(r.ok ? 200 : 502).json(Object.assign({ to: held.to.length }, r));
  }
  const out = await sendHolidayEmail(req.session.orgId, { preview: !!body.preview });
  if (body.preview && out.ok && out.mail) {
    keepPreview(req.session.userId, out.mail);
    return res.json({ ok: true, preview: { subject: out.mail.subject, html: out.mail.html },
                      to: out.mail.to, attached: false });
  }
  res.status(out.ok ? 200 : 502).json(out);
});
app.post('/api/mail/month', requireRole('admin'), bigJson, async (req, res) => {
  const body = req.body || {};
  if (body.send === 'preview') {
    const held = previews.get(req.session.userId);
    if (!held) return res.status(410).json({ error: 'that preview has expired - open it again' });
    previews.delete(req.session.userId);
    const r = await mailer.send({ to: held.to, cc: held.cc, subject: held.subject,
                                  html: held.html, attachments: held.attachments });
    await logMail(req.session.orgId, 'month', held, r);
    return res.status(r.ok ? 200 : 502).json(Object.assign(
      { to: held.to.length, attached: (held.attachments || []).length > 0 }, r));
  }
  const out = await sendMonthEmail(req.session.orgId, {
    xlsx: body.xlsx, fileName: body.fileName,
    monthLabel: body.monthLabel, slug: body.slug,
    shown: Number(body.shown), hidden: Number(body.hidden), days: Number(body.days),
    preview: !!body.preview
  });
  if (body.preview && out.ok && out.mail) {
    keepPreview(req.session.userId, out.mail);
    return res.json({ ok: true, preview: { subject: out.mail.subject, html: out.mail.html },
                      to: out.mail.to, attached: (out.mail.attachments || []).length > 0,
                      file: out.attachedFile });
  }
  res.status(out.ok ? 200 : 502).json(out);
});
app.post('/api/mail/tasks', requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const day = DAY_RE.test(String(body.day || '')) ? String(body.day) : istParts().day;
  /* Sending is a second press, never the first: the dashboard asks for the
     message, it is held here, and this is the word that lets it go. It used to
     send on the first press, which is how a work log went to four people
     before anybody had seen it. */
  if (body.send === 'preview') {
    const held = previews.get(req.session.userId);
    if (!held) return res.status(410).json({ error: 'that preview has expired - open it again' });
    previews.delete(req.session.userId);
    const r = await mailer.send({ to: held.to, cc: held.cc, subject: held.subject, html: held.html });
    await logMail(req.session.orgId, 'tasks', held, r);
    return res.status(r.ok ? 200 : 502).json(Object.assign({ to: held.to.length }, r));
  }
  const out = await sendTasksEmail(req.session.orgId, day, { preview: true });
  if (out.ok && out.mail) {
    keepPreview(req.session.userId, out.mail);
    return res.json({ ok: true, preview: { subject: out.mail.subject, html: out.mail.html },
                      to: out.mail.to });
  }
  res.status(out.ok ? 200 : 502).json(out);
});
app.post('/api/mail/leave', requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  /* Pressing Send on the preview, which posts nothing but the word: the copy
     held here is what goes, so what was read is what is sent. */
  if (body.send === 'preview') {
    const held = previews.get(req.session.userId);
    if (!held || !held.mails) return res.status(410).json({ error: 'that preview has expired - open it again' });
    previews.delete(req.session.userId);
    let sent = 0, toN = 0, ccN = 0, failed = null;
    for (const msg of held.mails) {
      const r = await mailer.send(msg);
      await logMail(req.session.orgId, 'leave', msg, r);
      if (r.ok) { sent++; toN += msg.to.length; ccN += (msg.cc || []).length; }
      else failed = failed || r;
    }
    if (!sent && failed) return res.status(502).json(failed);
    return res.json({ ok: true, to: toN, cc: ccN, messages: sent });
  }
  const r = await sendLeaveEmail(req.session.orgId, { preview: !!body.preview });
  if (body.preview && r.ok && r.mails) {
    keepPreview(req.session.userId, { mails: r.mails });
    const first = r.mails[0];
    return res.json({ ok: true, preview: { subject: first.subject, html: first.html },
                      to: first.to, cc: first.cc, messages: r.mails.length,
                      others: r.mails.slice(1).map(x => ({ subject: x.subject, to: x.to })) });
  }
  res.status(r.ok ? 200 : 502).json(r);
});

/* The daily summary goes out once, at the hour in the settings, India time.
   Checked every five minutes: Render restarts the service when it wakes, so a
   timer set once at boot would never fire. `maintenance_done` marks the day as
   sent, so a restart cannot send it twice. */
const DAILY_CHECK_MS = 5 * 60 * 1000;
/* The work log, sent once for the day however its turn came up - on its own
   hour, or beside the attendance record. The day is claimed first, so the two
   paths cannot both send it; a day that sends nothing, or fails, gives the
   claim back so the next wake can try again. */
async function sendTasksOnce(orgId, day, settings) {
  const job = 'tasks-email:' + orgId + ':' + day;
  const claimed = await pool.query(
    'INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING RETURNING job', [job]);
  if (!claimed.rows.length) return { ok: true, already: true };
  const r = await sendTasksEmail(orgId, day, { settings });
  if (!r.ok || r.nothing) await pool.query('DELETE FROM maintenance_done WHERE job = $1', [job]);
  return r;
}
/* ---- DeskTime ----
   A second record of the same days, made by a different instrument: the card
   reader says somebody was here, DeskTime says their computer woke and how
   long it was in use. The dashboard sets them side by side; this is how the
   second one arrives without anybody typing it.

   The key belongs to the DeskTime account owner, so it is read from the
   environment first - where a secret belongs - and from a shared key only as
   a fallback, for an office that would rather paste it into the panel than
   wait for a deploy. With neither, nothing here runs and nothing breaks. */
const DESKTIME_API = 'https://desktime.com/api/v2/json/employees';
async function deskTimeKeyOf(orgId) {
  const env = String(process.env.DESKTIME_API_KEY || '').trim();
  if (env) return env;
  const kv = await sharedKeys(orgId, ['deskTimeKey']);
  return String(kv.deskTimeKey || '').trim();
}
/* "2026-10-28 09:34:12", "09:34:12" and "9:34 AM" all mean the same moment. */
function dtClock(v) {
  const s = String(v == null ? '' : v);
  const m = /(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return '';
  let h = Number(m[1]);
  if (/pm/i.test(s) && h < 12) h += 12;
  if (/am/i.test(s) && h === 12) h = 0;
  return ('0' + h).slice(-2) + ':' + m[2];
}
/* Durations come as a count of seconds. A number small enough to be minutes is
   taken as minutes rather than as a few seconds at a desk, because the one
   reading that is certainly wrong is the one that turns a working day into a
   rounding error. */
function dtMinutes(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 1440 ? Math.round(n / 60) : Math.round(n);
}
/* DeskTime keeps its own roll of names, and they are not the record's names.
   Only the ones that differ are mapped; anything unmapped stands as it is, so
   a new person shows up under whatever DeskTime calls them rather than
   vanishing. */
function dtNameOf(map, raw) {
  const k = String(raw || '').trim();
  if (!k) return '';
  const hit = (map || {})[k] !== undefined ? map[k] : map[k.toLowerCase()];
  return String(hit === undefined || hit === null || hit === '' ? k : hit);
}
/* One day, read from DeskTime and folded into what is already stored. Never
   throws: a pull that fails says so and leaves the record as it was. */
async function pullDeskTime(orgId, day) {
  if (!DAY_RE.test(String(day || ''))) return { ok: false, error: 'bad_day' };
  const key = await deskTimeKeyOf(orgId);
  if (!key) return { ok: false, error: 'no_key' };
  let body = null, status = 0, text = '';
  try {
    /* The key goes in a header, not on the query string. This asked with
       ?apiKey= - which was a guess, written before there was any key to try it
       with - and DeskTime's own documentation says X-API-Key. It would have
       answered 401 to every nightly pull, silently, for as long as it took
       somebody to notice the figures were not moving.

       A key on a query string is also a key in every log and proxy it passes
       through, which is its own reason. */
    const r = await fetch(DESKTIME_API + '?date=' + encodeURIComponent(day),
                          { headers: { Accept: 'application/json', 'X-API-Key': key } });
    status = r.status;
    text = await r.text();
    try { body = JSON.parse(text); } catch (e) { body = null; }
  } catch (e) {
    return { ok: false, error: 'unreachable', detail: (e && e.message) || '' };
  }
  if (!body || typeof body !== 'object') return { ok: false, error: 'not_json', status, said: text.slice(0, 200) };
  if (body.error) return { ok: false, error: 'desktime_said', status, said: String(body.error).slice(0, 200) };
  /* DeskTime nests the people under the company rather than listing them:
     { employees: { "<companyId>": { "<employeeId>": { name, arrivedTime, … } } } }.
     Read as one level it found a single item whose keys were the nine employee
     ids - nine people seen as one, and nothing written.

     So it goes down until it finds things that look like people rather than
     like more folders. A record is one with a name on it, or a time; a folder
     is anything else, and is opened. */
  const looksLikePerson = v => !!v && typeof v === 'object' && !Array.isArray(v)
    && (v.name !== undefined || v.employeeName !== undefined || v.fullName !== undefined
        || v.arrivedTime !== undefined || v.arrived !== undefined);
  const flatten = (v, depth) => {
    if (!v || typeof v !== 'object') return [];
    if (looksLikePerson(v)) return [v];
    if (depth > 3) return [];
    const kids = Array.isArray(v) ? v : Object.keys(v).map(k => v[k]);
    return kids.reduce((out, k) => out.concat(flatten(k, depth + 1)), []);
  };
  const list = flatten(body.employees, 0);
  /* What a record actually carried, reported back with the result. The field
     names are DeskTime's; this is how they get checked in one look rather than
     by guesswork. */
  const fields = list[0] && typeof list[0] === 'object' ? Object.keys(list[0]).slice(0, 25) : [];
  const kv = await sharedKeys(orgId, ['deskTime', 'deskTimeNames']);
  const store = parseJson(kv.deskTime) || {};
  const names = parseJson(kv.deskTimeNames) || {};
  let wrote = 0;
  list.forEach(e => {
    if (!e || typeof e !== 'object') return;
    const who = dtNameOf(names, e.name || e.employeeName || e.fullName || '');
    const arrived = dtClock(e.arrivedTime || e.arrived || e.arrive_time || e.startTime);
    if (!who || !arrived) return;                       // nothing was tracked
    /* Two durations, and they are not the same thing. `atWorkTime` is the span
       from arriving to leaving, lunch and idle afternoons included;
       `desktimeTime` is the part of it the computer was actually in use, and
       that is the figure DeskTime's own page leads with and the office reads
       as the day's work. Both are kept, because the gap between them is
       itself worth seeing. */
    const pick = (...names) => {
      for (const n of names) if (e[n] !== undefined && e[n] !== null) return e[n];
      return 0;
    };
    store[who + '|' + day] = {
      i: arrived,
      o: dtClock(e.leftTime || e.left || e.left_time || e.endTime),
      w: dtMinutes(pick('atWorkTime', 'atWork', 'at_work_time', 'timeAtWork')),
      d: dtMinutes(pick('desktimeTime', 'deskTimeTime', 'desktime_time', 'desktime'))
    };
    wrote++;
  });
  if (wrote) {
    await pool.query(
      `INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, 'deskTime', $2, NULL)
       ON CONFLICT (org_id, key) WHERE user_id IS NULL
       DO UPDATE SET value = EXCLUDED.value, updated_at = now(), version = kv.version + 1`,
      [orgId, JSON.stringify(store)]);
  }
  return { ok: true, day, wrote, seen: list.length, fields };
}
/* Asked for by hand, a day or a stretch of days at a time. A stretch is capped
   because each day is one call to DeskTime and a careless range would be a
   month of them in a row. */
app.post('/api/desktime/pull', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const from = String(b.from || b.day || '').trim();
  const to = String(b.to || from).trim();
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || to < from) return res.status(400).json({ error: 'bad_range' });
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); days.length < 31; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    days.push(iso);
    if (iso >= to) break;
  }
  const out = [];
  for (const day of days) {
    try { out.push(await pullDeskTime(req.session.orgId, day)); }
    catch (e) { out.push({ ok: false, day, error: 'threw', detail: (e && e.message) || '' }); }
  }
  const wrote = out.reduce((n, r) => n + (r.wrote || 0), 0);
  res.json({ ok: out.some(r => r.ok), days: out.length, wrote, results: out.slice(0, 5) });
});
/* And once a night, for yesterday and for the day that is running - yesterday
   because a day is only whole once it is over, today because somebody looking
   in the afternoon should not be looking at nothing. Claimed per day, so two
   instances of the service do not both go asking. */
async function deskTimeTick() {
  const orgs = await pool.query('SELECT id FROM orgs ORDER BY id');
  const { day } = istParts();
  const before = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  for (const org of orgs.rows) {
    try {
      if (!(await deskTimeKeyOf(org.id))) continue;              // nothing configured: nothing to do
      await pullDeskTime(org.id, day);                           // today, as often as the tick runs
      const job = 'desktime-pull:' + org.id + ':' + before;
      const claimed = await pool.query(
        'INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING RETURNING job', [job]);
      if (!claimed.rows.length) continue;                        // yesterday is already in
      const r = await pullDeskTime(org.id, before);
      if (!r.ok) await pool.query('DELETE FROM maintenance_done WHERE job = $1', [job]);
    } catch (e) {
      console.error('desktime pull:', e && e.message);
    }
  }
}

async function dailyEmailTick() {
  if (!mailer.ready()) return;
  const { day, min } = istParts();
  const orgs = await pool.query('SELECT id FROM orgs ORDER BY id');
  for (const org of orgs.rows) {
    try {
      const s = await mailSettings(org.id);
      /* Every holiday between today and `days` ahead gets its word, once,
         whatever the daily message is doing.

         This used to ask for one date - exactly `days` off - and nothing else.
         That works only if the service is awake on that one day. It sleeps when
         nobody is using it, so a holiday whose turn came up on a Sunday had its
         only chance taken with it: Dussehra fell on a Monday, its word was due
         on the Sunday, and nothing went out at all.

         Looking across the whole window instead means a missed day is caught
         the next time the service wakes. A word the morning before is late, and
         still stops somebody turning up to a locked building. */
      if (s.holiday.on && min >= hhmmToMin(s.holiday.at)) {
        const until = new Date(Date.now() + IST_MS + s.holiday.days * 86400000)
          .toISOString().slice(0, 10);
        for (const h of await holidaysFrom(org.id, day, until)) {
          const job = 'holiday-email:' + org.id + ':' + h.day;
          const claimed = await pool.query(
            'INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING RETURNING job', [job]);
          if (!claimed.rows.length) continue;            // already spoken for
          const hr = await sendHolidayEmail(org.id, { on: h.day });
          if (!hr.ok || hr.nothing) await pool.query('DELETE FROM maintenance_done WHERE job = $1', [job]);
        }
      }
      /* The work log on its own hour. Claimed under the same job name the
         ride-along uses, so an office with both turned on still gets one
         message a day rather than two. */
      if (s.tasks.auto && min >= hhmmToMin(s.tasks.at)) {
        try { await sendTasksOnce(org.id, day, s); }
        catch (e) { console.error('work email:', e && e.message); }
      }
      if (!s.daily || min < hhmmToMin(s.dailyAt)) continue;
      const job = 'daily-email:' + org.id + ':' + day;
      const claimed = await pool.query(
        'INSERT INTO maintenance_done (job) VALUES ($1) ON CONFLICT (job) DO NOTHING RETURNING job', [job]);
      if (!claimed.rows.length) continue;                 // already sent today
      const r = await sendDailyEmail(org.id, day);
      // The leave message goes out beside it, and only when something is waiting.
      if (r.ok) { try { await sendLeaveEmail(org.id); } catch (e) { console.error('leave email:', e && e.message); } }
      /* And what everybody worked on, where the office has asked for it. Same
         day, same send - two messages rather than one, because they go to
         different people and answer different questions. */
      if (r.ok && s.tasks.on) {
        try { await sendTasksOnce(org.id, day, s); }
        catch (e) { console.error('work email:', e && e.message); }
      }
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
/* The free plan stops at 5GB of responses a month; a paid one is far higher.
   PLAN_GB says which, so the meter measures against the plan being paid for
   rather than against the one the service started life on. */
const FREE_BYTES = Math.round(Number(process.env.PLAN_GB || 5) * 1024 * 1024 * 1024);
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
/* A paid database is not deleted on a thirtieth day, so counting towards one
   and warning about it is simply wrong. DB_EXPIRES_AT=never says so, and the
   panel then says nothing about expiry at all rather than inventing a date. */
const DB_NEVER_EXPIRES = /^(never|none|paid|no)$/i.test(String(process.env.DB_EXPIRES_AT || '').trim())
  || Number(process.env.DB_FREE_DAYS) === 0;
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
  if (DB_NEVER_EXPIRES) return null;
  const set = String(process.env.DB_EXPIRES_AT || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(set)) return new Date(set).toISOString();
  if (!firstSeen) return null;
  const d = new Date(firstSeen);
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + FREE_DB_DAYS);
  return d.toISOString();
}

/* What this costs to run, a month, in the currency Render bills in.

   The service cannot read Render's billing - that would mean carrying an API
   key able to do far more than read a number - so the figures are told to it.
   Change a plan, change COST_PLANS, and the panel is right again; left unset,
   it says nothing rather than guessing. Each item is `label:amount`. */
function monthlyCost() {
  const raw = String(process.env.COST_PLANS || '').trim();
  if (!raw) return null;
  const items = [];
  raw.split(/\s*[,;]\s*/).forEach(part => {
    const m = /^(.+?):\s*\$?\s*([0-9]+(?:\.[0-9]+)?)$/.exec(part.trim());
    if (m) items.push({ what: m[1].trim().slice(0, 40), usd: Number(m[2]) });
  });
  if (!items.length) return null;
  const total = items.reduce((a, b) => a + b.usd, 0);
  /* What is not in the figure. Storage, bandwidth past the plan and anything
     else Render adds are billed separately and are not known here, so the
     panel says so rather than letting the total read as the whole bill.
     COST_NOTE replaces the wording where something else needs saying. */
  const note = String(process.env.COST_NOTE || '').trim()
    || 'Only this project’s own services. Storage, anything over the plan and the '
       + 'workspace’s own seats are billed on top — Billing has the whole figure.';
  /* How much of the month has been used. Render charges by the second, so what
     has been run up by now is the month's figure times the part of the month
     that has gone - which is an estimate, and is called one on screen. The
     office works at +05:30, so the day is counted there rather than at UTC. */
  const now = new Date(Date.now() + 5.5 * 3600000);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const elapsed = (now.getUTCDate() - 1) + (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;
  const monthly = Math.round(total * 100) / 100;
  return {
    currency: 'USD', monthly, items, note,
    soFar: Math.round(monthly * (elapsed / daysIn) * 100) / 100,
    day: now.getUTCDate(), daysIn,
    month: ['January','February','March','April','May','June','July',
            'August','September','October','November','December'][m]
  };
}

/* What the dashboard's indicator shows. Cheap enough to ask for every minute:
   one size query, one count, one row. */
app.get('/api/status', requireRole('admin', 'admin_view'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const out = { at: new Date().toISOString(), startedAt: STARTED_AT.toISOString(),
                db: { ok: false }, plan: { bytes: FREE_BYTES, dbBytes: FREE_DB_BYTES },
                cost: monthlyCost() };
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
    const n = await pool.query('SELECT count(*)::int AS n FROM users');
    if (n.rows[0].n > 0) {
      /* Tables and people in them - but the schema still has to be applied.
         It is written to be run over and over (CREATE TABLE IF NOT EXISTS, ADD
         COLUMN IF NOT EXISTS), and this used to return here instead, so a
         column added to schema.sql never reached a database that already had
         accounts in it. Deploying the two-stage leave approval left the users
         list answering 500 for exactly that reason: the query asked for a
         column the table had never been given. */
      console.log('bringing the schema up to date');
    } else if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
      console.log('no accounts yet - set ADMIN_EMAIL and ADMIN_PASSWORD, then restart');
    } else {
      console.log('no accounts yet - creating the first admin');
    }
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
  /* Its own tick rather than a passenger on the email one: the two records
     should sit side by side whether or not this office sends any mail. */
  setTimeout(function () { deskTimeTick().catch(function () {}); }, 90000).unref();
  setInterval(function () { deskTimeTick().catch(function () {}); }, DAILY_CHECK_MS).unref();
  if (mailer.ready()) {
    setTimeout(dailyEmailTick, 60000).unref();
    setInterval(dailyEmailTick, DAILY_CHECK_MS).unref();
  } else {
    console.log('email is off: set RESEND_API_KEY and RESEND_FROM to turn it on');
  }
}
/* dailyEmailTick is exported so the scheduler itself can be tested, rather
   than only the sending it calls. The holiday word going missing was a fault in
   the timing, not in the message. */
module.exports = { app, pool, dailyEmailTick, deskTimeTick, pullDeskTime };
