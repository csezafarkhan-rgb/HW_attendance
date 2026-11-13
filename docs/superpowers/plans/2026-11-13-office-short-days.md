# Office Short Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the office mark a date as an agreed short day — everybody owes four hours instead of a full shift — so that day stops being counted short against the week.

**Architecture:** A new office-wide shared store `shortDays` (date → hours + reason), read by `owedMinutes`. `computeWeeklyShortHours` stops working out a day's requirement itself and asks `owedMinutes`, which is what carries the new rule into the weekly band and ends an existing split between the band and the dashboard.

**Tech Stack:** Plain ES5 JavaScript inside `src/attendance.html` (built into `public/index.html` by `python build.py`), Node + Express in `server.js`, hand-rolled Node test files under `test/` run by `node test/run-all.js`.

**Spec:** `docs/superpowers/specs/2026-11-13-office-short-days-design.md`

## Global Constraints

- Shape of a stored entry: `{ "2026-11-11": { "hours": "4:00", "reason": "..." } }`. `hours` is an `H:MM` duration string.
- `getOfficialLeave` must keep meaning "nobody is due in". A short day never routes through it.
- The page is ES5: `var`, `function`, no arrow functions, no `const`/`let`, no template literals.
- After any edit to `src/attendance.html`, run `python build.py` before the browser sees it.
- A short day beats the Saturday policy; leave and holidays beat a short day.
- Employees must be able to read the store: `shortDays` goes in `EMP_READABLE` in `server.js`.

## Review Focus

1. **Malformed `hours` ("abc", "4", "")** — `owedMinutes` must not return `NaN`; one NaN poisons the whole week's total. Test in Task 2.
2. **`hours` longer than the shift** — a typo of `14:00` on a nine-hour day must not hand somebody five hours of credit. Clamped to the shift in Task 2.
3. **A short day falling on a holiday or a Sunday** — the holiday and Sunday checks come first and must still win, returning 0. Test in Task 2.
4. **`hours` of `0:00`** — the day owes nothing; the weekly band's existing zero-owed skip must swallow it rather than dividing by it. Test in Task 3.
5. **A date in the store that nobody has a shift for** — `parseShift` fallback must still apply and the day must not throw. Test in Task 2.

---

### Task 1: The store, and reading it back

**Files:**
- Modify: `src/attendance.html` (near `loadOfficialLeaves`, ~line 12001; boot loader lists at ~21691 and ~24028)
- Modify: `server.js:202` (`EMP_READABLE`)
- Test: `test/short-days.test.js` (create)

**Interfaces:**
- Produces: `shortDays` (object, module-scope), `loadShortDays()` → Promise, `saveShortDays()` → Promise, `getShortDay(dateStr)` → `{hours, reason}` or `null`.

- [ ] **Step 1: Write the failing test** in `test/short-days.test.js`, lifting `getShortDay` with the `grab` helper copied from `test/week-from-home.test.js:22`:

```js
ctx.shortDays = { '2026-11-11': { hours: '4:00', reason: 'Approved WFH' } };
check('a date on the list comes back with its hours',
  ctx.getShortDay('2026-11-11').hours === '4:00');
check('a date not on it is nothing, not an empty shape',
  ctx.getShortDay('2026-11-12') === null);
check('a bare string entry is read as hours, for a hand-edited store',
  (ctx.shortDays['2026-11-13'] = '4:00', ctx.getShortDay('2026-11-13').hours === '4:00'));
check('and the employee page may read the store',
  /'shortDays'/.test(SRV_EMP_READABLE_LINE));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node test/short-days.test.js`
Expected: FAIL — `not found: getShortDay`

- [ ] **Step 3: Add the store and its three functions** in `src/attendance.html`, directly after `saveOfficialLeaves` (~line 12008), mirroring that pair exactly:
  - `var shortDays = {};`
  - `loadShortDays()` / `saveShortDays()` — copies of `loadOfficialLeaves` / `saveOfficialLeaves` with the key `'shortDays'`.
  - `getShortDay(d)` — returns `null` when absent; accepts a bare string as `{hours: s, reason: ''}` the way `getOfficialLeave` accepts a bare name.

- [ ] **Step 4: Register it at boot** — add `loadShortDays` to both loader lists (`src/attendance.html:21691` and `:24028`), beside `loadOfficialLeaves`.

- [ ] **Step 5: Let employees read it** — add `'shortDays'` to `EMP_READABLE` in `server.js:202`.

- [ ] **Step 6: Run the test**

Run: `node test/short-days.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/attendance.html server.js test/short-days.test.js
git commit -F <message file>
```

---

### Task 2: A short day is worth its agreed hours

**Files:**
- Modify: `src/attendance.html:9222` (`owedMinutes`)
- Test: `test/short-days.test.js`

**Interfaces:**
- Consumes: `getShortDay(dateStr)` from Task 1.
- Produces: `owedMinutes(emp, dateStr)` returns the agreed minutes on a listed date.

- [ ] **Step 1: Write the failing tests** (shift `9:30-6:30` = 540 minutes; 11 Nov 2026 is a Wednesday, 14 Nov a Saturday):

```js
check('a short day is worth its agreed hours, not the shift',
  ctx.owedMinutes('Rahul Mishra', '2026-11-11') === 240);
check('an ordinary day is untouched',
  ctx.owedMinutes('Rahul Mishra', '2026-11-12') === 540);
/* Review Focus 1: one NaN would poison the whole week's total. */
check('hours that do not parse fall back to the full shift',
  ['abc', '4', '', ':30'].every(function(bad){
    ctx.shortDays['2026-11-12'] = { hours: bad, reason: '' };
    return ctx.owedMinutes('Rahul Mishra', '2026-11-12') === 540;
  }));
/* Review Focus 2: a typo must not hand out credit. */
check('hours longer than the shift are clamped to it',
  (ctx.shortDays['2026-11-12'] = { hours: '14:00', reason: '' },
   ctx.owedMinutes('Rahul Mishra', '2026-11-12') === 540));
/* Review Focus 3: a holiday is still a day nobody is due in. */
check('a holiday on the same date still owes nothing',
  (ctx.holidays['2026-11-11'] = { name: 'Diwali' },
   ctx.owedMinutes('Rahul Mishra', '2026-11-11') === 0));
check('and so does a Sunday',
  ctx.owedMinutes('Rahul Mishra', '2026-11-15') === 0);
/* The spec: explicit beats standing default. */
check('a short day beats the Saturday policy',
  (ctx.shortDays['2026-11-14'] = { hours: '2:00', reason: '' },
   ctx.owedMinutes('Rahul Mishra', '2026-11-14') === 120));
/* Review Focus 5. */
check('a person with no shift on file does not throw',
  typeof ctx.owedMinutes('Nobody', '2026-11-11') === 'number');
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node test/short-days.test.js`
Expected: FAIL — the short-day cases return 540

- [ ] **Step 3: Add the branch** to `owedMinutes` in `src/attendance.html:9222`, after the holiday check and before the Saturday block. Read `getShortDay(dateStr)`, parse `hours` with the page's existing `toMin`, and use it only when it is a finite number greater than zero; clamp to `full`. Anything else falls through to the shift, so a bad value costs nothing rather than breaking the week.

- [ ] **Step 4: Run the tests**

Run: `node test/short-days.test.js`
Expected: PASS

- [ ] **Step 5: Pin the spec's claim about attendance** — a short day is still a day somebody was due in, so it must not start reading as a day off. Add to `test/dashboard-days.test.js`, in the block that already exercises `computeEmployeeStats` with no records:

```js
/* owedMinutes returns a non-zero figure on a short day, so the day is still
   expected and an empty one is still an absence. */
check('a short day is still a day they were due in',
  ctx.shortDays = { '2026-06-08': { hours: '4:00', reason: '' } },
  ctx.computeEmployeeStats('Gap', DATES).absentDays === 9);
```

Add `shortDays: {}` and `getShortDay` to that file's context so the lifted `owedMinutes` can read them.

- [ ] **Step 6: Run both files**

Run: `node test/short-days.test.js && node test/dashboard-days.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

---

### Task 3: The weekly band asks what a day is worth

This is the task that fixes the reported fault.

**Files:**
- Modify: `src/attendance.html:11820` (`computeWeeklyShortHours`)
- Test: `test/week-from-home.test.js`

**Interfaces:**
- Consumes: `owedMinutes(emp, dateStr)` from Task 2.

- [ ] **Step 1: Extend the test context** in `test/week-from-home.test.js:41` — add `owedMinutes` and `getShortDay` to the lifted list at line 54, and `shortDays: {}` plus `getSatPolicy: function(){ return {mode:'OFF', hours:4}; }` to `ctx`.

- [ ] **Step 2: Write the failing tests**

```js
/* The reported day: four hours agreed, four hours worked, nothing short. */
check('an agreed short day worked in full leaves the week level',
  shortDayWeek({ hours: '4:00', worked: 240 }).shortMin === 0);
check('and the same day without the agreement is counted short',
  shortDayWeek({ hours: null, worked: 240 }).shortMin > 0);
check('working past the agreed hours banks the surplus',
  shortDayWeek({ hours: '4:00', worked: 300 }).extraMin === 60);
/* Review Focus 4. */
check('a short day of nothing is skipped, not divided by',
  isFinite(shortDayWeek({ hours: '0:00', worked: 0 }).shortMin));
/* The spec: leave is checked first and still takes the day out. */
check('somebody on leave that day is untouched by the agreement',
  shortDayWeek({ hours: '4:00', worked: 0, cat: 'LEAVE' }).shortMin
    === shortDayWeek({ hours: null, worked: 0, cat: 'LEAVE' }).shortMin);
```

`shortDayWeek` takes an optional `cat` so the Wednesday override can be `LEAVE` instead of `WFH`.

Write `shortDayWeek(o)` beside the existing `fromHome` helper (`test/week-from-home.test.js:57`): one WFH override on the Wednesday with DeskTime showing `o.worked`, `ctx.shortDays` set from `o.hours`, the other four days worked in full.

- [ ] **Step 3: Run them and watch them fail**

Run: `node test/week-from-home.test.js`
Expected: FAIL — the agreed day still reads short by 300 minutes

- [ ] **Step 4: Replace the line** `var required = sh.endMin - sh.startMin;` at `src/attendance.html:11820` with a call to `owedMinutes(empName, dateStr)`. Keep `sh` — the lines below still use `sh.startMin` for arrival. A day the function values at zero is already skipped by the weekend and holiday checks above it; leave those as they are.

- [ ] **Step 5: Run the whole suite, not just this file** — the band feeds the grid, the dashboard and the reminders.

Run: `node test/run-all.js`
Expected: `all 57 test files passed`

- [ ] **Step 6: Commit**

---

### Task 4: Setting a short day

**Files:**
- Modify: `src/attendance.html:4181-4200` (the `page-holidays` markup), `:17142` (`renderHolidaysPage`)
- Test: `test/short-days.test.js`

**Interfaces:**
- Consumes: `shortDays`, `saveShortDays`, `getShortDay` from Task 1.

- [ ] **Step 1: Write the failing tests** against the page source, the way `test/dashboard-days.test.js` checks markup:

```js
check('the page has a box for the date, the hours and the reason',
  ['sdDate', 'sdHours', 'sdReason'].every(function(id){
    return new RegExp('id="' + id + '"').test(APP);
  }));
check('and a list of its own, separate from the holidays',
  /id="shortDaysList"/.test(APP));
check('removing one saves and redraws the grid, as removing a holiday does',
  /saveShortDays\(\)\.then\(function\(\)\{[^}]*renderTable\(\);/.test(APP));
check('a view-only admin gets the list without the buttons',
  /data-del-sd=/.test(APP) && /canEdit\(\)/.test(grab(APP, 'renderShortDaysPage')));
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Add the markup** under the holiday form in `#page-holidays`: a heading saying what a short day is ("everybody owes these hours instead of a full day"), then `sdDate` (date), `sdHours` (text, placeholder `4:00`), `sdReason` (text), an Add button, and `<div id="shortDaysList">`.

- [ ] **Step 4: Add `renderShortDaysPage()`** beside `renderHolidaysPage` (`:17142`), built from it: same `req-card` markup, same `canEdit()` gate on the buttons, `data-del-sd` for remove. Call it everywhere `renderHolidaysPage()` is called.

- [ ] **Step 5: Wire Add and Remove** — refuse a date that is already on the holiday list (the two mean different things on one date) and an `hours` that `toMin` cannot read, saying so through `showUploadStatus`. Save, then `renderShortDaysPage(); renderTable();`.

- [ ] **Step 6: Run the tests, then build**

Run: `node test/short-days.test.js && python build.py`
Expected: PASS, then `built public/index.html`

- [ ] **Step 7: Commit**

---

### Task 5: The day says so on the grid

**Files:**
- Modify: `src/attendance.html:19415` (the row class line) and the holiday band markup beside it
- Test: `test/short-days.test.js`

- [ ] **Step 1: Write the failing test**

```js
check('a short day marks its row and says what it is',
  /short-day-row/.test(APP) && /Short day/.test(APP));
check('and it is not drawn as a holiday',
  !/holiday-row[^']*short/.test(APP));
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Add the row class and the band.** At `:19415` add `' short-day-row'` when `getShortDay(dateStr)` returns something and there is no holiday. Draw a band across the row reading `Short day · 4h` with the reason beside it, mirroring the holiday band's markup. Add a `tr.short-day-row .date-col` rule near the holiday rule at `:2085`, in a colour that is not the holiday purple.

- [ ] **Step 4: Run the test and build**

- [ ] **Step 5: Run the whole suite**

Run: `node test/run-all.js`
Expected: `all 57 test files passed`

- [ ] **Step 6: Commit**

---

### Task 6: 11 November, on the live record

**Files:** none — this is the acceptance check.

- [ ] **Step 1: Deploy and confirm the served build carries it** (the browser caches aggressively; check the decoded payload, not the rendered page).

- [ ] **Step 2: Add 11 Nov 2026 as a short day of `4:00`** on the Official Leaves page.

- [ ] **Step 3: Read the week band for the week of 9 Nov** and confirm it no longer reports the shortfall the screenshot showed (`118m`, `221m`, `238m`, `325m`, `292m`, `276m` short for the six people). Each should fall by the difference between their shift and four hours for that one day.

- [ ] **Step 4: Confirm the dashboard agrees** — Hours owed for November drops by the same amount per person, because both now ask one function.
