# People who are not on attendance

*Design, 13 November 2026. Small change.*

## What this is for

Some people on the roster do not mark attendance at all — managers and
admins who are on the record because they take leave and approve it, not
because anybody expects them to clock in.

The record has no way to say so, so it treats them as people who clock in
and never do. Nitish Kumar's weekly reminder is seven lines long and every
one of them reads "Nothing on the record", for seven ordinary working days
nobody ever expected him to mark.

## Why it is wrong today

Three places assume every name on the roster clocks in:

- `pendingByEmployee` raises a `job:'absent'` item for every working day
  with no record, so a person who never marks one owes an answer for every
  day of the month.
- `computeEmployeeStats` counts those same days as absences, so their
  attendance percentage is computed from days they were never due for.
- The grid gives them a column of dashes.

This is a gap in the missing-day work of 12 November: it was built for
somebody who forgot to clock in, and never considered somebody for whom
clocking in was never the arrangement.

## Goals

- Mark a person as not on attendance, in one place, as an office decision.
- Such a person is off the attendance grid entirely.
- They are never chased for a day, and never counted absent for one.
- Everything else about them is unchanged: leave, approvals, their account,
  their place in the approval route.

## Non-goals

- Marking them inactive. `is_active` means they have left; these people are
  here, and a leaver's history must keep reading as a leaver's.
- Hiding them from the leave record or the requests list. They take leave
  like anybody else and that still has to be visible.
- Guessing it from the data (never seen a clock-in). That was the rejected
  alternative: it would also silence a genuine new joiner who has not
  started, which is exactly somebody you do want to notice.

## Anti-goals

- A person who does clock in quietly dropping off the grid because a switch
  was set wrong and nothing says so.
- A second list of who counts, disagreeing with the first.

## Constraints

- Per-person stores are keyed by name and listed in `EMP_KEYED_BY_NAME`
  (`server.js:200`), beside `joinDates`, `satPolicy` and `selfMark`.
- The server must honour it too, or the page stops chasing them and the
  Friday reminder goes on doing it.
- The grid's roster comes from `EMPLOYEES` (`src/attendance.html:4612`),
  filtered by `stillHere`; `orderedEmployees` and `visibleEmployees` read
  from it.

## Approaches considered

| | | |
|---|---|---|
| **A — a per-person switch** *(chosen)* | New name-keyed store `offAttendance`. Excluded from the roster the grid builds from, and skipped by the reminder and the figures. | Explicit. One place. Says what it means. |
| B — infer from "never seen a clock-in" | No switch to maintain. | Silences a new joiner who has not started, which is the one person you want to see. Rejected in conversation. |
| C — mark them inactive | Nothing new to build. | `is_active` means *left*. Their history would start reading as a leaver's, and they would drop off leave and approvals too. |

## The design

**Store.** `offAttendance`, keyed by name: `{ "Nitish Kumar": true }`.
Added to `EMP_KEYED_BY_NAME`. A name absent from it is on attendance, so
nothing changes for anybody until somebody is named.

**Set where the other per-person settings are set** — the shift dropdown
panel that already carries the Saturday policy and the rename box, one row
per person, mirroring `satPolicy`'s control at `src/attendance.html:17714`.

**On the page.** `EMPLOYEES` keeps everybody; `orderedEmployees` drops the
named ones, so the grid, the performance table and everything built from
`visibleEmployees` lose the column together rather than one at a time.

**On the server.** `pendingByEmployee` skips a named person when it walks
the roster for missing days, so no reminder is ever built for them.

**Said out loud.** The shift panel row reads "Not on attendance — no grid
column, never chased for a day", so the person setting it can see what it
does without trying it.

## My calls, not theirs

- Leave, requests and approvals are untouched — only attendance.
- Their own employee page still works if they open it; it simply has
  nothing outstanding to show. Hiding the page would be a second rule.
- Historic months are affected too: the switch is about the person, not
  about a date range. A month they were tracked for and are no longer
  would need the switch off, which is the simpler thing to explain.

## Left to the builder

- Exactly where the row sits in the shift panel.
- Whether the name also disappears from the employee filter list, or stays
  there unticked.
