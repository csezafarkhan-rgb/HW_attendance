# People Not On Attendance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Mark a person as not on attendance, so they leave the grid and are never chased for a day they were never expected to mark.

**Architecture:** A name-keyed store `offAttendance`. The page drops those names from `orderedEmployees`, which every roster view is built from; the server skips them when walking the roster for missing days.

**Tech Stack:** ES5 inside `src/attendance.html`, Node/Express in `server.js`, hand-rolled tests under `test/`.

**Spec:** `docs/superpowers/specs/2026-11-13-not-on-attendance-design.md`

## Global Constraints

- Store shape: `{ "Nitish Kumar": true }`. A name absent means on attendance.
- ES5 only in the page: `var`, `function`, no arrows or template literals.
- `python build.py` after any page edit.
- Leave, requests and approvals are untouched.

## Review Focus

1. **A name in the store that is not on the roster** (renamed, left) — must be ignored, not throw.
2. **Everybody switched off** — the grid must say so, not render an empty table.
3. **The store missing entirely** (old browser cache, fresh org) — every function must treat absent as "everybody is on attendance".
4. **Switched off mid-month** — past days stop counting at once; that is the spec's call, pinned by a test so it is deliberate.
5. **An employee opening their own page while switched off** — must not throw; nothing outstanding is the right answer.

---

### Task 1: The store

**Files:** Modify `src/attendance.html` (beside `loadSatPolicy`, ~9155), `server.js:200`. Test: `test/not-on-attendance.test.js` (create).

**Produces:** `offAttendance` (object), `loadOffAttendance()`, `saveOffAttendance()`, `isOffAttendance(name)` → boolean.

- [ ] **Step 1: Write the failing test** — `isOffAttendance('Nitish Kumar')` true when named, false when not, false when the store is `{}` or undefined (Review Focus 3).
- [ ] **Step 2: Run it, watch it fail** — `node test/not-on-attendance.test.js`
- [ ] **Step 3: Add `var offAttendance = {};`, `loadOffAttendance`, `saveOffAttendance`, `isOffAttendance`** mirroring `loadSatPolicy`/`saveSatPolicy`, key `'offAttendance'`.
- [ ] **Step 4: Register at boot** — add `loadOffAttendance` to both loader lists (`:21691`, `:24028`).
- [ ] **Step 5: Add `'offAttendance'` to `EMP_KEYED_BY_NAME`** in `server.js:200`.
- [ ] **Step 6: Run the test** — PASS. **Commit.**

---

### Task 2: Off the grid

**Files:** Modify `src/attendance.html:9340` (`orderedEmployees`). Test: `test/not-on-attendance.test.js`.

**Consumes:** `isOffAttendance` from Task 1.

- [ ] **Step 1: Write the failing test** — lift `orderedEmployees`; with `offAttendance = {'Nitish Kumar': true}` the returned list excludes him and keeps the rest; with `{}` the list is unchanged; a named person who is not on the roster changes nothing (Review Focus 1).
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Filter in `orderedEmployees`** — drop names where `isOffAttendance(name)` before mapping to employee objects. Everything built on `visibleEmployees` follows, so the grid and the performance table lose the column together.
- [ ] **Step 4: Run the test** — PASS. **Commit.**

---

### Task 3: Never chased for a day

**Files:** Modify `server.js` (`pendingByEmployee`, the `roster.rows.forEach` walk). Test: `test/not-on-attendance.test.js`.

- [ ] **Step 1: Write the failing test** — assert the roster walk reads the store and skips a named person, and that the skip sits before any item is added.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Read `offAttendance` in `pendingByEmployee`** — add `'offAttendance'` to its `sharedKeys` call, parse it, and `return` early in the `roster.rows.forEach` for a named person. Nothing else in that function changes: lateness and unfilled forms still come from their own loops, and a person off attendance has no records to produce either.
- [ ] **Step 4: Run the test** — PASS.
- [ ] **Step 5: Confirm against the live record** that Nitish's reminder would now be empty — preview only, nothing sent. **Commit.**

---

### Task 4: The switch

**Files:** Modify `src/attendance.html:17535` (the `shf-row` markup) and `:17706` (its handlers). Test: `test/not-on-attendance.test.js`.

- [ ] **Step 1: Write the failing test** — the row carries `data-off-emp`, the label text "Not on attendance" appears, and the handler saves then redraws (`saveOffAttendance()` followed by `renderTable()`).
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Add the control** to the `shf-row`: a checkbox `data-off-emp="<name>"`, checked from `isOffAttendance`, labelled "Not on attendance" with the title "No grid column, and never chased for a day."
- [ ] **Step 4: Wire it** beside the `data-sat-emp` handler: set or delete the key, `saveOffAttendance()`, then `renderShiftDropdown(); renderTable();`.
- [ ] **Step 5: Guard the empty grid** (Review Focus 2) — when `orderedEmployees()` comes back empty because everybody is switched off, the grid shows the existing empty state rather than a headerless table.
- [ ] **Step 6: Run the tests, build, run the whole suite** — `node test/run-all.js` → all pass. **Commit.**

---

### Task 5: Nitish, on the live record

- [ ] **Step 1: Deploy; confirm the served payload carries it** (decode the base64, not the rendered page).
- [ ] **Step 2: Switch Nitish off** in the shift panel.
- [ ] **Step 3: Confirm** he is off the grid and the performance table, and that his reminder preview reports nothing outstanding where it reported seven.
