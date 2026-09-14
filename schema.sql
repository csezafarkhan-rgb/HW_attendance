-- Homeweavers Attendance — schema
-- Everything is scoped to an org so the same deployment can host more than one
-- company later without a migration.

CREATE TABLE IF NOT EXISTS orgs (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- bcrypt, never plaintext
  name          TEXT,
  -- 'admin'      = super admin, full access including user management
  -- 'admin_view'  = sees the admin panel but cannot change anything
  -- 'employee'    = own record only
  role          TEXT NOT NULL DEFAULT 'employee',
  CONSTRAINT users_role_chk CHECK (role IN ('admin','admin_view','employee')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (org_id, email)
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

-- Session store for connect-pg-simple.
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

-- Backs window.storage.{get,set,delete,list} — the dashboard's existing
-- settings interface. Shared rows (user_id IS NULL) are the org-wide values
-- every user sees; that is what makes settings sync across people.
CREATE TABLE IF NOT EXISTS kv (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  version    BIGINT NOT NULL DEFAULT 1   -- bumped on every save; a stale save gets 409
);
-- One row per (org, key) for shared values, per (org, user, key) for personal.
CREATE UNIQUE INDEX IF NOT EXISTS kv_shared_idx
  ON kv (org_id, key) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kv_personal_idx
  ON kv (org_id, user_id, key) WHERE user_id IS NOT NULL;

-- Employees and their attendance rows. Records are stored relationally rather
-- than as one blob so two people editing different days cannot clobber each
-- other, which a whole-dataset PUT would allow.
CREATE TABLE IF NOT EXISTS employees (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  code       TEXT,
  name       TEXT NOT NULL,
  shift      TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS records (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee    TEXT NOT NULL,     -- matches employees.name (the dashboard's key)
  day         DATE NOT NULL,
  data        JSONB NOT NULL,    -- in/out/dur/late/early/st/c, as the UI expects
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (org_id, employee, day)
);
CREATE INDEX IF NOT EXISTS records_month_idx ON records (org_id, day);

-- Who changed what, entry by entry: a mark on one day, a salary, a request.
-- Written by the server on every shared save; read in the dashboard's day view.
CREATE TABLE IF NOT EXISTS history (
  id           BIGSERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name    TEXT,
  area         TEXT NOT NULL,      -- the setting: overrides, salaries, leaveRequests, records...
  item         TEXT,               -- the entry inside it: "Name|2026-09-10", a request id, a month
  before_value TEXT,
  after_value  TEXT
);
CREATE INDEX IF NOT EXISTS history_item_idx ON history (org_id, item);
CREATE INDEX IF NOT EXISTS history_recent_idx ON history (org_id, id DESC);

-- Script errors from people's browsers, so a broken button is seen by an admin
-- instead of failing quietly on someone's screen. Repeats within an hour add to
-- count rather than new rows; rows older than 30 days are cleared.
CREATE TABLE IF NOT EXISTS client_errors (
  id         BIGSERIAL PRIMARY KEY,
  org_id     INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  first_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  count      INTEGER NOT NULL DEFAULT 1,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT,
  message    TEXT NOT NULL,
  source     TEXT,
  line       INTEGER,
  stack      TEXT,
  page       TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS client_errors_recent_idx ON client_errors (last_at DESC);

-- Lets clients poll "what changed since X" cheaply for live sync.
CREATE TABLE IF NOT EXISTS change_log (
  id         BIGSERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity     TEXT NOT NULL,      -- 'kv' | 'records' | 'employees'
  ref        TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS change_log_idx ON change_log (org_id, id);
