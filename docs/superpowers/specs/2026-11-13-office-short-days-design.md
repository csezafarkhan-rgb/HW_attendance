# Office short days

*Design, 13 November 2026. Small change.*

## What this is for

Some days the office agrees that everybody works a shorter day — approved to
be out of the office and to work from home for four hours. 11 November 2026
was one. The record has no way to say so, so the week asks those days for a
full nine hours and reports everyone short.

On 11 Nov the office marked every person WFH individually (seven entries
within a minute, each with `duration: ""`). The marking worked; the agreed
hours had nowhere to live.

## Why it is wrong today

The weekly band works out what a day is worth by itself:

```
required = shift end − shift start          // always the full shift
fromHome = ov.duration or what DeskTime saw
delta    = fromHome − required
```

So Rahul's 4:58 at home is measured against 9:00 and comes out 242 minutes
short. The band's "total 239m short" is that, across the week. The day is not
being ignored — it is being asked for a full day.

`ov.duration` cannot carry the agreed figure: it already means *hours worked
from home*, not *hours owed*.

## Goals

- One office-wide decision per date, set once, applying to everyone.
- That date asks for the agreed hours instead of the full shift, in the
  weekly band and everywhere else that asks what a day is worth.
- Hours worked past the agreed figure count as given over, exactly as they
  would on any other day.

## Non-goals

- Per-person short days. The office decides this for the date; a person who
  needs their own shorter day already has leave and part-day leave.
- Changing what a holiday means. A holiday is a day nobody is due in; a
  short day is a day everybody owes less.
- Touching lateness. People are still due in at their usual start.

## Anti-goals

- A short day that silently reads as a holiday, so nobody owes anything.
- A second place that decides what a day is worth, disagreeing with the
  first. This change removes one of those; it must not add another.

## Constraints

- `getOfficialLeave` means "nothing owed" in 20 places on the page and 6 on
  the server. None of them may start meaning something else.
- Employee pages must be able to read it, or a person's own calendar and the
  office's will disagree. That means `EMP_READABLE`.
- A shared key is admin-writable by default; nothing to add for that.

## Approaches considered

| | | |
|---|---|---|
| **A — a short-day list of its own** *(chosen)* | New office-wide store, date → hours + reason. `owedMinutes` answers for it; the weekly band asks `owedMinutes` instead of working the requirement out itself. | Keeps "holiday" meaning what it means. Removes an existing second answer. One new store. |
| B — holidays gain an hours figure | One store, one list. | 26 call sites would each have to learn the difference between nobody being due in and everybody owing four hours. Missing one gives a day that reads as free or as full. |
| C — a field on each person's WFH override | No new store. | Ruled out: the office decides this once, not once per person. 11 Nov cost seven entries. |

## The design

**Store.** A new shared key `shortDays`, shaped like `officialLeaves`:

```
{ "2026-11-11": { "hours": "4:00", "reason": "Approved WFH, building access" } }
```

`hours` is a duration string so it reads the way every other duration in the
record reads. Added to `EMP_READABLE`.

**What a day is worth.** `owedMinutes(emp, date)` gains one branch, after the
holiday check and before the Saturday policy: a date in `shortDays` returns
its minutes. It beats the Saturday policy, because it is an explicit decision
about that date and the policy is a standing default.

**The weekly band.** `computeWeeklyShortHours` stops computing `required =
shift end − shift start` and asks `owedMinutes` for it. This is the part that
fixes the reported fault, and it also ends an existing divergence: the band
and the dashboard have been answering "what is this day worth" separately.

A day worth nothing (`owedMinutes` returns 0) is already skipped by the band's
own weekend and holiday checks, so the change does not alter those.

**Setting it.** A second list on the Official Leaves page, under the holidays:
date, hours, reason, add and remove — mirroring the holiday editor beside it,
saved the same way.

**On the grid.** A short day gets a band across the date row like the holiday
band, reading `Short day · 4h` with the reason beside it, so somebody reading
the week can see why the day asked for less.

## My calls, not theirs

- A short day on a Saturday beats the Saturday policy (explicit beats
  standing default).
- Somebody on leave that day is unaffected — leave is checked first and still
  takes the day out of the reckoning.
- Working past the agreed hours banks the surplus, because once `required` is
  four hours the existing arithmetic does that without being asked.
- Attendance percentage still counts the day as a day due in, since
  `owedMinutes` returns a non-zero figure.

## Left to the builder

- Where exactly the band sits in the grid row, matching the holiday band's
  markup.
- Validation of the hours box: a duration that parses, and not longer than
  the shift.
