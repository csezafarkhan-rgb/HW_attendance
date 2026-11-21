/* What the office has now, without reloading the page.
 *
 * Everything on this screen is read once, as it starts. Somebody else marking
 * a day, answering a request or moving a shift happened in another browser,
 * and this one went on showing what it read in the morning. The change feed
 * was already running and already said so - but only the attendance came back
 * from it, and the settings, which are most of what the office edits, were
 * left exactly as they were.
 *
 * So: one list of what the page reads, read again on a press or on a change;
 * and nothing redrawn under somebody who is mid-form.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
const SYNC = fs.readFileSync(path.join(REPO, 'public', 'hw-sync.js'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* ---- one list, read twice ---- */
const loaders = grab(APP, 'settingLoaders');
check('the page has one list of what it reads',
  /function settingLoaders\(again\)/.test(loaders), null);
check('and the first read uses it',
  /settingLoaders\(false\)\.map\(safeLoad\)/.test(APP), null);
check('and so does the reading again',
  /settingLoaders\(true\)\.map\(safeLoad\)/.test(APP), null);
/* The boot list used to be written out in full inside the boot chain. Anything
   added there and not here would be read once and never again. */
check('there is no second list anywhere',
  (APP.match(/loadOverrides, loadShiftAssignments/g) || []).length === 1, null);
/* Who is signed in is not a setting that changes under somebody. */
['loadViewRole', 'loadAuthAccounts', 'loadAccountNames'].forEach(function (n) {
  check('reading again leaves ' + n + ' alone',
    new RegExp('f !== ' + n).test(loaders), null);
});

/* ---- the read itself ---- */
const refresh = grab(APP, 'refreshFromServer');
/* Settings are served from memory now, so a loader asked to read them again
   hands back the copy it already had unless the memory is refilled first. */
const askedAt = refresh.indexOf('HWSync.refresh');
const loadedAt = refresh.indexOf('settingLoaders(true)');
check('it asks the server again before the loaders read anything',
  askedAt > -1 && loadedAt > askedAt, [askedAt, loadedAt]);
check('and takes in the attendance as well as the settings',
  /hydrateDataset/.test(refresh), null);
check('and redraws once both are in', /redrawAfterDataset\(\)/.test(refresh), null);
check('one read at a time, however many times it is asked for',
  /if\(OFFICE_SYNC_BUSY\) return/.test(refresh), null);
check('a read that fails says so rather than looking like a success',
  /Could not reach the server just now/.test(refresh), null);
/* The employee's own sync re-runs its loaders too, and had the same trap. */
const emp = grab(APP, 'empSync');
check('the employee’s own sync refills the memory before its loaders too',
  emp.indexOf('HWSync.refresh') > -1
  && emp.indexOf('HWSync.refresh') < emp.indexOf('loadOverrides'), null);

/* ---- and DeskTime, which the server holds a copy of ----
   Re-reading what the server holds is not the same as asking DeskTime what
   has happened since. Somebody presses this to see now. */
const ask = grab(APP, 'askDeskTimeNow');
check('the press asks DeskTime itself, not only the copy of it',
  /\/api\/desktime\/pull/.test(ask), null);
check('for the two days that can still change',
  /from\.setDate\(from\.getDate\(\) - 1\)/.test(ask), null);
/* DeskTime being slow, refusing the key or being unreachable must not hold
   up the reading of the record. */
check('and does not wait on it for ever',
  /Promise\.race\(\[ask,[\s\S]{0,90}8000\)/.test(ask), null);
check('a refusal from DeskTime is not a failed refresh',
  /r\.ok \? r\.json\(\)[\s\S]{0,80}: null/.test(ask), null);
check('the two are asked at the same time, not one after the other',
  /Promise\.all\(\[kv\.catch\(function\(\)\{\}\), desk\.then/.test(refresh), null);
check('and a press that brought days in says so',
  /DeskTime added ' \+ brought\.wrote/.test(refresh), null);

/* ---- what a change from somebody else does ---- */
check('a change from the feed brings the settings back, not just the attendance',
  /if\(e\.data\.dataset\) applyRemote\(e\.data\.dataset\);[\s\S]{0,400}officeChanged\(\);/.test(APP), null);
check('and the feed itself asks for a fresh copy rather than the one it holds',
  /\? window\.HWSync\.hydrateDataset\(\)\s*:\s*window\.HWSync\.refresh\(\)/.test(SYNC), null);

/* ---- but not under somebody's hands ---- */
{
  const ctx = {
    console, Date, Math, Object,
    OFFICE_SYNC_BUSY: false, OFFICE_SYNC_AT: 0, OFFICE_SYNC_WAITING: false,
    refreshed: 0,
    refreshFromServer: function () { ctx.refreshed++; },
    document: {
      activeElement: null,
      _open: false,
      querySelector: function (s) { return (ctx.document._open && /modal-overlay\.open/.test(s)) ? {} : null; },
      getElementById: function () { return ctx.btn; }
    },
    btn: { classList: { add: function () { ctx.btn.lit = true; }, remove: function () { ctx.btn.lit = false; } },
           lit: false },
    officeSyncLabel: function () {}
  };
  vm.createContext(ctx);
  ['midSomething', 'officeChanged'].forEach(n => vm.runInContext(grab(APP, n), ctx));

  ctx.officeChanged();
  check('an idle screen takes the change straight away', ctx.refreshed === 1, ctx.refreshed);

  ctx.document.activeElement = { tagName: 'TEXTAREA' };
  ctx.officeChanged();
  check('a half-typed box is not redrawn underneath', ctx.refreshed === 1, ctx.refreshed);
  check('the button says there is something waiting instead',
    ctx.OFFICE_SYNC_WAITING === true && ctx.btn.lit === true, [ctx.OFFICE_SYNC_WAITING, ctx.btn.lit]);

  ctx.document.activeElement = null;
  ctx.document._open = true;
  ctx.officeChanged();
  check('and an open form is left alone the same way', ctx.refreshed === 1, ctx.refreshed);
}

/* ---- the clock on the button ---- */
{
  const el = { textContent: '' };
  const ctx = {
    console, Date, Math,
    OFFICE_SYNC_BUSY: false, OFFICE_SYNC_AT: 0, OFFICE_SYNC_WAITING: false,
    document: { getElementById: () => el }
  };
  vm.createContext(ctx);
  vm.runInContext(grab(APP, 'officeSyncLabel'), ctx);

  ctx.OFFICE_SYNC_AT = Date.now();
  ctx.officeSyncLabel();
  check('a reading just done says so', el.textContent === 'Just now', el.textContent);
  ctx.OFFICE_SYNC_AT = Date.now() - 5 * 60000;
  ctx.officeSyncLabel();
  check('and an older one says how old', el.textContent === '5m ago', el.textContent);
  ctx.OFFICE_SYNC_AT = Date.now() - 125 * 60000;
  ctx.officeSyncLabel();
  check('in hours once minutes stop meaning anything', el.textContent === '2h ago', el.textContent);
  ctx.OFFICE_SYNC_WAITING = true;
  ctx.officeSyncLabel();
  check('something waiting outranks how long ago it was',
    el.textContent === 'New changes', el.textContent);
  ctx.OFFICE_SYNC_BUSY = true;
  ctx.officeSyncLabel();
  check('and a reading in progress says that first', el.textContent === 'Reading…', el.textContent);
}

/* ---- and it is on the page, next to Share ---- */
check('the button is in the toolbar', /id="officeSyncBtn"/.test(APP), null);
check('with the clock inside it', /id="officeSyncWhen"/.test(APP), null);
check('and a press reads everything again',
  /officeSyncBtn[\s\S]{0,400}refreshFromServer\(false\)/.test(APP), null);
/* A tab left open all afternoon is the likeliest to be stale and the least
   likely to be noticed. */
check('coming back to a stale tab reads again',
  /visibilitychange[\s\S]{0,300}OFFICE_SYNC_AT > 60000\) officeChanged\(\)/.test(APP), null);

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
