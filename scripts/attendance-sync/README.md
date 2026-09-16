# Attendance sync

These run on the office PC, not on the server. They keep the dashboard supplied
with punch data without anyone exporting a file by hand.

## Why they exist

Attendance used to arrive by exporting a CSV out of eSSL eTimeTrackLite and
copying it into a watched folder. That had two problems. A file exported at
10:38 in the morning froze the day at 10:38 — in-times with no out-times, which
is how 7 September lost half its punches. And eSSL only learns of a punch when
something downloads it from the readers, which nothing was doing on a schedule.

So these read both sources directly: eSSL's own database for the days it has
finished, and the punch readers themselves for anything newer.

## The pieces

| file | what it does |
| --- | --- |
| `Build-AttendanceCsv.ps1` | Writes `DailyAttendanceLogsDetails.csv` into the watched folder. The main job. |
| `Pull-DeviceLogs.ps1` | Reads the punch readers over the network. 32-bit, because the ZKTeco SDK is. |
| `Check-AttendanceHealth.ps1` | Reads the logs once a day and says on screen whether attendance is still flowing. |
| `sync-service.js` | Listens on `127.0.0.1:8765` so the dashboard's Sync button can ask for a fetch on demand. |
| `push-attendance.js` | Sends the built file to the server (`POST /api/device/records`) after every build, so the site is current with nobody signed in. Logs to `push-log.txt`. |
| `dashboard-parser.js` | Lifts the dashboard's own CSV import out of `src/attendance.html`, so an upload lands exactly as an import of the same file would. |
| `backup-db.js` | Nightly full copy of the database (`GET /api/device/backup`) into `db-backups\` in the data folder, keeping 30 days. |

## Sending to the server: the one-time token

The office PC has no user account, so the server trusts it by a shared secret:

1. `sync-token.txt` in the data folder holds a long random token (created once on
   the office PC; never commit it).
2. In Render → the `hw-attendance` service → **Environment**, add `SYNC_TOKEN` with
   exactly that value, and save (Render redeploys).

Until both match, `push-log.txt` says why nothing was sent (`SYNC_TOKEN is not set
in Render yet`, or `refused the token`) and the dashboard's watched folder keeps
working as before. To restore from a backup, the `.json.gz` holds every table
the app uses (users with password hashes, settings, employees, records).

`Build-AttendanceCsv.ps1` runs 64-bit (the Access driver is) and shells out to
`Pull-DeviceLogs.ps1` in 32-bit PowerShell (the reader SDK is). They cannot
share one process, which is why there are two.

## Code here, data elsewhere

Nothing these produce belongs in this repository — punch files and logs carry
employee names and times. Each script takes a `-DataDir` (`-Base` for the health
check) pointing at the folder that holds the attendance data, defaulting to the
office PC's. Only the scripts are tracked; `.gitignore` blocks the data files as
a second line of defence.

## Where they came from

Facts worth not rediscovering:

- `AttendanceLogs.Duration` **is** the figure the exported CSV carries. Checked
  row by row against a day already imported.
- An eSSL row is only trustworthy while it accounts for every punch the readers
  hold. A day processed mid-morning gets an out-time equal to its in-time — one
  punch, in and out at 9:52 — which looks finished and is not.
- Which reader a punch came from is what makes it an arrival or a departure; one
  is mounted as IN and the other as OUT. A punch from an unrecognised reader is
  skipped rather than guessed, because guessing "in" turns somebody's departure
  into a second arrival and loses their day.
- `[int]` in PowerShell rounds rather than truncates, so `[int](475/60)` is 8 and
  7:55 prints as 8:55. Hours are floored.
- `$PSCommandPath` is empty while a param block is binding. Defaults that need it
  are set in the body.

## Scheduled tasks

| task | when |
| --- | --- |
| `HW Attendance - Build CSV` | every 30 min 09:30–18:30, and at logon |
| `HW Attendance - Daily Check` | 10:00 |
| `HW Attendance - Sync Helper` | at logon, and every 5 min 09:30–19:30 to restart it if it has stopped |
| `HW Attendance - Nightly DB Backup` | 17:45, or as soon as the PC is next on if it was asleep |
| `HW Attendance - Keep Server Awake` | every 10 min 09:00–19:00 - the free Render server sleeps after 15 idle minutes, and its slow wake-up is what showed staff an old copy of the data |

The logon run matters: the PC sleeps around 18:45, about when people punch out,
so the last punches of a day can only be collected the next morning.

Both tasks start their program through `conhost.exe --headless`, for example
`conhost.exe --headless "C:\Program Files\nodejs\node.exe" "...\sync-service.js"`.
Started directly, each one opened a console window on the desktop, and closing
that window ended the program with `0xC000013A`. On 11 September the helper
was killed that way within seconds of every start, and two builds died before
writing anything. With `--headless` there is no window to close.
`-WindowStyle Hidden` did not help: it hides the window only after it has
already appeared.

Rules the builder keeps, learned the hard way:

- **One build at a time.** It holds the `Global\HWAttendanceBuild` lock, so a
  scheduled run and a Live Sync press can't both hit the readers or write the
  file at once. A second copy waits up to four minutes for the first.
- **Readers can fail; the build carries on.** Each reader is pulled by its own
  32-bit process, all started together, under one three-minute limit. Readers
  being off, the SDK missing or a stalled transfer costs freshness, not the
  whole run - and one slow reader no longer adds to the wait for the other.
- **Live Sync asks for a quick build.** `/sync?quick=1` rebuilds ten days and
  asks the readers for two, which is all a Sync needs; the scheduled run still
  does thirty days and three. That is what takes a Sync from about a minute to
  roughly half of it.
- **A month's punch table is read or the run stops.** It first lists the tables
  that exist, skips a month with none, and treats any other read error as fatal.
  Failing leaves yesterday's good file in place instead of writing a short one.
  The month loop starts at midnight on the 1st, so the current month is read
  on the 1st too.
- **Files are swapped in, never written in place.** Both CSVs are written to
  `.partial` and then moved over, so the dashboard never imports half a file.
- **The helper only answers the dashboard.** `/sync` needs the dashboard's
  Origin, and every request must be addressed to `127.0.0.1` or `localhost`,
  which blocks drive-by pages and DNS rebinding. A build running past five
  minutes is killed with its whole process tree.

The dashboard keeps itself up to date: with **Keep attendance up to date by
itself** ticked (Update Attendance menu, on by default) an open dashboard asks
the helper every five minutes and imports a new punch file on its own - no Live
Sync press, no Import button. It backs off to half-hourly when the helper does
not answer, and does nothing while the tab is in the background. Every import
still keeps a restore point, so Import history can undo one.

`Pull-DeviceLogs.ps1` writes one file per reader (`device-punches-<ip>.csv`) and
adds to it instead of replacing it. If
a reader can't be reached, or a read stops partway, the punches from earlier
runs stay in the file, so a bad run no longer takes the day's in-times out of
the dashboard.
