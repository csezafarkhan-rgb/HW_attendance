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

`Pull-DeviceLogs.ps1` adds to `device-punches.csv` instead of replacing it. If
a reader can't be reached, or a read stops partway, the punches from earlier
runs stay in the file, so a bad run no longer takes the day's in-times out of
the dashboard.
