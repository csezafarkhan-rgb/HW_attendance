# Homeweavers Attendance

Multi-user attendance dashboard. Node + Express + Postgres, deployed on Render.

## What changed from the old single-file version

The old app stored everything in the browser (`localStorage` + IndexedDB), so
every person saw their own private copy and clearing browser data wiped it.
Data now lives in Postgres and is shared by all users. The login is enforced
server-side with bcrypt-hashed passwords and HTTP-only session cookies — the
old client-side gate (password hash embedded in the HTML) is gone.

## Deploying to Render

### Recommended: Render Blueprint

1. Push this repo to GitHub (**private**).
2. In Render, choose **New > Blueprint** and point it at the repo.
3. `render.yaml` creates both the `hw-attendance` web service and the `hw-attendance-db` PostgreSQL database.
4. Render injects the database connection into `DATABASE_URL` and generates `SESSION_SECRET`.
5. Add `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the Render dashboard.
6. The first deploy runs `npm run migrate && npm start`, creates the schema, and bootstraps the first admin when the users table is empty.

### If the web service already exists

If the service was created directly from **Web Service > GitHub** instead of from the Blueprint, `render.yaml` does **not** retroactively create/connect the database for that existing service. In that case:

1. Create a Render PostgreSQL database named `hw-attendance-db` (or use an existing Render PostgreSQL database).
2. Open **hw-attendance > Environment**.
3. Add `DATABASE_URL` and set its value to the database's **Internal Database URL**. Do not use `localhost` or `127.0.0.1`.
4. Keep `NODE_ENV=production` and `SESSION_SECRET` set.
5. Add `ADMIN_EMAIL` and `ADMIN_PASSWORD` if you want the first admin to be created automatically.
6. Save and redeploy.

The application now fails fast with a clear message if `DATABASE_URL` is missing in production instead of silently trying `127.0.0.1:5432`.

### Starting again on a fresh Render account

A service created by hand (**New → Web Service**) starts with no environment at
all, so the first deploy ends with `FATAL: SESSION_SECRET must be set in
production`. Either point Render at `render.yaml` (**New → Blueprint**), which
sets everything up and asks for the values it cannot invent, or set it by hand:

| Setting | Value |
|---|---|
| Build Command | `npm ci` |
| Start Command | `npm start` — it creates the tables first (`prestart`) |
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | a long random string (**Generate** in Render's editor) |
| `DATABASE_URL` | the database's **Internal Database URL** |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the first admin, created when the users table is empty |
| `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO` | email (optional) |
| `SYNC_TOKEN` | lets the office PC upload attendance (optional) |

Create the PostgreSQL database first, or the service has nothing to connect to.

**The data does not come with the account.** A new database is empty. Either
point `DATABASE_URL` at the old database (its **External Database URL**, if that
account still has it), or sign in as the new admin and use **Backup & Restore →
Restore from a backup file** with the most recent `Attendance_Backup_*.json`
from the office PC's backup folder. The dashboard writes one every day it is
opened, so the newest is at most a day behind.

## Environment variables

Required on Render:

- `NODE_ENV=production`
- `SESSION_SECRET=<strong random secret>`
- `DATABASE_URL=<Render PostgreSQL Internal Database URL>`

For automatic first-admin creation:

- `ADMIN_EMAIL=<admin email>`
- `ADMIN_PASSWORD=<password, 8+ characters>`
- `ADMIN_NAME=<optional display name>`
- `ORG_NAME=<optional organization name>`

Email (Resend), for the daily summary and leave requests:

- `RESEND_API_KEY=<key from resend.com>`
- `RESEND_FROM=Attendance <attendance@yourdomain>` (the domain must be verified in Resend)
- `RESEND_REPLY_TO=<optional address replies go to>`

Occasional:

- `SYNC_TOKEN=<long random string>` lets the office PC upload attendance and take backups (`scripts/attendance-sync/README.md`)
- `RESET_TWO_STEP=<email>` switches that account's two-step sign-in off once (not again on later restarts); remove it afterwards. To reset the same account again later, use `<email>#2`

## Local development

    npm install
    export DATABASE_URL=postgresql://postgres:devpass@localhost:5432/hw_attendance
    npm run migrate
    node scripts/create-user.js admin@local.test testpass123 admin
    npm start

Run the checks that need no database. The same run happens on GitHub for every
push (`.github/workflows/ci.yml`):

    npm test

It parses every script, runs `server.js` against an in-memory stand-in for
Postgres to check the access rules, runs the dashboard's leave, request,
restore and dataset logic, and checks the office-PC helper's access rules.
CI also rebuilds `public/index.html` and fails if it differs from the committed
file.

Run the API tests (needs a reachable database):

    npm run test:api

## Roles

Three tiers, set per account in the Users panel:

| Stored as | Shown as | Can |
|---|---|---|
| `employee` | Employee | See their own record; raise their own leave requests |
| `admin_view` | View Admin | See everything an admin sees, change nothing |
| `admin` | Super Admin | Everything, including managing accounts |

`admin` has always meant full access, so widening the model did not demote
anyone. Writing is what separates the two admin tiers: the server gates every
write on the role being `admin`, and the dashboard hides the controls a view
admin cannot use so they are not clicking things that only return 403.

The role and the active flag are read from `users` on every API request, so
demoting or disabling an account takes effect on that person's next click, not
at their next sign-in. Resetting a password or disabling an account also ends
that account's other sessions.

Employees are limited by the server, not only by what the page shows:

- Reading shared keys, they get their own entries only (their marks, excuses,
  shifts, join date, requests), the handful of settings every calendar needs
  (holidays, thresholds, company info), and just the signatures their own
  approved day-off forms print with. Salaries, pay rules and everyone else's
  data are not sent.
- Saving `leaveRequests` is merged on the server: they can add a request of
  their own, always as pending, and answer a query on one of their own.
  Everything else in the array stays as stored. An admin's save cannot drop a
  request raised after their copy was loaded, since nothing deletes requests.

## Locked months and history

- **Lock a month** from the Payroll page after its pay run. The server then refuses
  changes to that month's marks, part-days, excuses, manual entries, holidays and
  leave deductions (423), skips its rows in imports and uploads, and a restore
  leaves them as they are. Salaries are one figure per person, not per month, so a
  salary change still shows in a locked month's figures.
- **History**: every shared save records who changed which entry, from what to what
  (`history` table, `GET /api/history`). Admins see a day's changes from the day popup.
- **Save conflicts**: shared values carry a version; a save made from an older copy
  than the server's is refused (409) and the page asks the person to reload.

## Two-step sign-in

Admins can turn on two-step sign-in for their own account: **Users → Your sign-in
→ Turn on**. After the password, sign-in asks for the 6-digit code from an
authenticator app (Google Authenticator, Microsoft Authenticator or similar).

- Turning it on asks for the password, shows a setup key for the app, and is only
  in force once a code from the app confirms it. Other devices are then signed out.
- Ten **recovery codes** are shown once. Each works one time in place of a code.
- A lost phone: another super admin clicks **Reset 2-step** on that account in
  the Users list; the person signs in with the password and sets it up again.
- The only super admin lost both phone and recovery codes: set
  `RESET_TWO_STEP=<their email>` in Render, deploy, sign in, then remove the variable.
  It runs once; the app restarting after sleep does not repeat it.
- Ten wrong codes in a row lock two-step sign-in for that account for 15 minutes,
  from any address. A view admin sets up two-step from the 🔐 Sign-in button.
- Codes are checked on the server (`totp.js`, RFC 6238); a code cannot be reused,
  five wrong codes end the attempt, and recovery codes are stored only as hashes.

## Email

With `RESEND_API_KEY` and `RESEND_FROM` set, two kinds of message go out.

- **Attendance**, daily at the time set in the panel (7:30 pm India time by
  default): the day's figures and a row per person — in, out and what the day
  was — with times as am/pm. Only the employees **shown on the portal** are
  listed; the rest are counted at the foot of the list. Sent from the dashboard
  it also carries the picture the HD Screenshot button makes, of that same
  record.
- **Leave**: what is waiting for a decision and any leave taken without a
  request, each with **Approve** and **Reject**. Sent beside the daily message,
  and again on its own as each request is raised.

Every active Super Admin is written to, plus any address added in the panel.

The controls are on the Attendance Record, under **📧 Email** beside HD
Screenshot. The menu is two things to do — email today's attendance, or send
the leave message — and pressing the first one shows the message exactly as it
will arrive, to be looked at before it goes.

**Settings** (folded under the two buttons) is where the message is written:

- **To** and **Cc**, kept with the rest of the settings. Every active Super
  Admin is written to whatever is listed here.
- **Subject**, where `{date}` `{present}` `{remote}` `{leave}` `{missing}`
  `{late}` `{org}` stand in for the day's figures.
- **A message at the top** and **a note at the foot**, in your own words.
- **What the message shows**: the day's figures, Late today, Shift changed
  today, Working from home, everyone's in and out, and the record as a picture
  — each can be left out.
- When each message goes on its own: the daily time, a note as each request is
  raised, and whether leave taken without a request is included.

The picture of the record is shown **inside** the message as well as attached.
A mail client will not draw an image built into the HTML, so a phone-sized copy
is kept on the server (`mail_shots`, cleared after sixty days) and fetched when
the message is opened; the full-size one travels as the attachment.

**Approve and Reject in an email** are signed links (HMAC over `SESSION_SECRET`),
good for 14 days. Opening one shows a page that asks once and acts on that
button, so a mail scanner following links decides nothing. A link for a request
already decided is refused, a locked month is never touched, and an approval
writes the same marks the dashboard writes — including leaving a day alone when
it already carries a mark from elsewhere. Rejecting leave that was never
requested removes that day from the record, as it does in the dashboard.

Decisions made this way are recorded as `approvedBy: email` and appear in the
history like any other change.

## Bandwidth

The free plan allows 5GB of responses a month, and going over it suspends the
service. Two things used to spend it:

- `index.html` carries the whole dashboard (over a megabyte) and was served
  `no-store`, so every open, reload and second tab downloaded all of it again.
  It is served `no-cache` now: the browser still checks on every load, so a new
  build appears at once, but an unchanged one answers 304 with no body.
- The change feed was polled every two seconds by every open tab. It is five
  seconds now, easing to twenty on a screen nobody is touching, and it stops
  while the tab is in the background.

`/api/dataset` and `/api/kv-all` also revalidate, so a hydrate after someone
else's edit costs a 304 unless something really changed.

## The indicator in the toolbar

Beside the Email button, admins see a dot and a figure: whether the database is
answering, and how much of the month's responses have gone. Opening it shows

- **Sent this month** against the plan's 5GB, with the request count. The dot
  turns amber past 70% and red past 90%, which is the warning nobody had in
  September.
- **Database** size against the free plan's 1GB.
- Attendance rows, employees and changes kept; when the office PC last sent
  anything; and how long the service has been running (a free instance is
  restarted whenever it wakes).
- **When the free database runs out.** Render deletes a free database thirty
  days after it is created. Postgres does not record its own creation date, so
  the first time the app meets a database it writes the date into
  `service_meta`; the expiry is thirty days on from there. Set `DB_EXPIRES_AT`
  (a date) to state the real one, or `DB_FREE_DAYS` for a different term. The
  chip turns amber ten days out and red at three, and counts down instead of
  showing the month's percentage.

Every response is weighed by the server and the month's total kept in
`usage_bytes`, written once a minute rather than once a request. The table is
created on first use, so no migration is needed.

## Security notes

- **Keep the repo private.** Employee names and attendance times are personal data.
- The browser keeps local copies of settings and attendance as a fallback. Signing
  out, and signing in as someone other than the last user on that browser, clears
  them, keeping only display preferences and chosen folders. That makes a shared
  PC safe to hand over.
- `SESSION_SECRET` is generated by Render; never hard-code one.
- Never commit `.env`.
- Passwords are bcrypt (cost 12). Login is rate-limited to 20 attempts / 15 min.
- `npm run test:api` **writes to the database**. It refuses to run against
  `NODE_ENV=production` or a hosted `DATABASE_URL`; override only for a
  throwaway copy with `ALLOW_REMOTE_TEST_DB=1`.
- Never commit real employee names or attendance into `src/` — the dashboard
  source is committed, and only the seed block is stripped by the build.

## How the frontend syncs

`public/hw-sync.js` defines `window.storage` (get/set/delete/list) backed by
`/api/kv`. The dashboard already prefers `window.storage` over its localStorage
fallback, so its existing settings calls route to Postgres unchanged.

`HWLiveSync.start(cb)` polls `/api/changes` every 2s and re-hydrates when
another user edits something, skipping the current user's own echoes.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/login` | email + password, sets session cookie |
| POST | `/api/logout` | |
| GET | `/api/me` | current user |
| POST | `/api/change-password` | |
| POST | `/api/login/two-step` | the code, after a password that answered `twoStep: true` |
| GET | `/api/two-step` | own status |
| POST | `/api/two-step/setup`, `/enable`, `/disable` | admins, own account |
| GET/POST | `/api/client-errors` | page script errors (read: admins) |
| GET | `/api/users` | admin and view-admin |
| POST/PATCH/DELETE | `/api/users` | super admin only |
| GET | `/api/kv-all` | bulk hydrate at boot |
| GET/PUT/DELETE | `/api/kv/:key` | `?shared=true|false` |
| GET | `/api/kv` | list keys by prefix |
| GET | `/api/dataset` | employees + records (`?from=&to=`) |
| POST | `/api/records` | per-row upsert, no clobber |
| POST | `/api/employees` | upsert by name |
| GET | `/api/changes?since=` | change feed for live sync |
| GET | `/healthz` | Render health check |
