/* Sixty questions where one answer would do.
 *
 * The dashboard reads about sixty stored settings as it starts. The adapter
 * holds them all in memory and fetches them in one request - but only once
 * hydrate() has run, and hydrate() was called in the shell alone. Inside the
 * frame nothing called it, so every one of those reads became its own round
 * trip: fifty-eight requests, a second and a half, on every single load.
 *
 * So a read that arrives before hydration asks for everything once and waits
 * for it, instead of asking for its own key; and a frame whose parent has
 * already loaded the lot takes the copy instead of fetching it again.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SYNC = fs.readFileSync(path.join(REPO, 'public', 'hw-sync.js'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* A window with just enough in it to run the adapter: somewhere to fetch
   from, somewhere to put a notice, and a parent (or not). */
function makeWindow(opts) {
  opts = opts || {};
  const asked = [];
  const el = { style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} };
  const win = {
    asked,
    parent: null,
    self: null, top: null,
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    Promise, Object, Array, String, Number, Date, Error, JSON, Math, console,
    AbortController: function () { this.abort = function () {}; this.signal = null; },
    document: {
      hidden: false, addEventListener() {}, getElementById: () => el,
      createElement: () => el, body: { appendChild() {} }
    },
    fetch: (url, init) => {
      asked.push(String(url).split('?')[0]);
      if (init && init.body) { try { win.lastPut = JSON.parse(init.body); } catch (e) {} }
      const answer = opts.answer ? opts.answer(url, init) : null;
      if (answer && answer.fail) {
        return Promise.resolve({ ok: false, status: answer.status || 500,
                                 json: () => Promise.resolve({ error: 'no' }) });
      }
      const reply = { ok: true, status: 200, json: () => Promise.resolve(answer || {}) };
      return opts.gate ? opts.gate.then(() => reply) : Promise.resolve(reply);
    }
  };
  win.self = win; win.top = opts.framed ? {} : win;
  win.parent = opts.parent || win;
  win.window = win;
  return win;
}
function run(win) {
  const ctx = vm.createContext(win);
  vm.runInContext(SYNC, ctx);
  return win;
}

const VALUES = { overrides: '{"a":1}', halfDays: '{}', empNames: '{"x":"y"}',
                 satPolicy: '{}', joinDates: '{}' };
const VERSIONS = { overrides: 7, halfDays: 2 };

(async () => {
  /* ---- the shell, which has nobody to borrow from ---- */
  {
    const win = run(makeWindow({ answer: url => /kv-all/.test(url)
      ? { values: VALUES, versions: VERSIONS } : {} }));
    const keys = Object.keys(VALUES);
    const got = await Promise.all(keys.map(k => win.storage.get(k)));
    check('five reads before hydration ask once, not five times',
      win.asked.length === 1, win.asked);
    check('and the one they ask is the one that answers everything',
      win.asked[0] === '/api/kv-all', win.asked);
    check('every one of them gets its own value back',
      got.every((r, i) => r && r.value === VALUES[keys[i]]), got.map(x => x && x.value));
    /* Hydrated means the cache is the whole truth: a key that is not in it was
       never stored, and asking the server again would only say so again. */
    const miss = await win.storage.get('neverStored');
    check('a key nobody ever stored answers without another request',
      miss === null && win.asked.length === 1, win.asked);
  }

  /* ---- the frame, which has ---- */
  {
    const parent = run(makeWindow({ answer: url => /kv-all/.test(url)
      ? { values: VALUES, versions: VERSIONS } : {} }));
    await parent.HWSync.hydrate();
    const kid = run(makeWindow({ framed: true, parent: parent,
      answer: () => ({ values: {}, versions: {} }) }));
    const r = await kid.storage.get('overrides');
    check('a frame beside a page that has it all asks for nothing',
      kid.asked.length === 0, kid.asked);
    check('and reads the same value its parent holds',
      r && r.value === VALUES.overrides, r);
    /* The version travels with the value, or the first save from the frame
       would be refused as a conflict with a change nobody made. */
    await kid.storage.set('overrides', '{"a":2}');
    const put = (kid.lastPut || {});
    check('the version comes with it, so a save from the frame is not a conflict',
      put.baseVersion === VERSIONS.overrides, put);
  }

  /* ---- the frame built while the page above is still loading ----

     The frame used to be created only once the shell's own request came back,
     which is most of a second of a login spent looking at nothing. It is
     built while that request is still in the air now, so its first read has
     to wait for the request already being made rather than making a second
     one. */
  {
    let open;
    const gate = new Promise(r => { open = r; });
    const parent = run(makeWindow({ gate: gate,
      answer: url => /kv-all/.test(url) ? { values: VALUES, versions: VERSIONS } : {} }));
    const waiting = parent.HWSync.hydrate();          // in flight, not yet answered
    const kid = run(makeWindow({ framed: true, parent: parent,
      answer: () => ({ values: {}, versions: {} }) }));
    const read = kid.storage.get('empNames');
    check('a frame built mid-request makes no request of its own',
      kid.asked.length === 0, kid.asked);
    open();                                            // the shell's answer arrives
    await waiting;
    const r = await read;
    check('and its read is answered by the one that was already in the air',
      r && r.value === VALUES.empNames && kid.asked.length === 0, [r, kid.asked]);
  }

  /* ---- and when the one request fails ---- */
  {
    /* The sign-in page reads a setting before anybody has signed in. kv-all
       answers 401 there, and the read must still behave as it always did
       rather than resolving to nothing for the rest of the session. */
    const win = run(makeWindow({ answer: url => /kv-all/.test(url)
      ? { fail: true, status: 500 } : { key: 'empNames', value: '{"x":"y"}', version: 3 } }));
    const r = await win.storage.get('empNames');
    check('a failed hydration falls back to asking for the one key',
      win.asked.length === 2 && /\/api\/kv\//.test(win.asked[1]), win.asked);
    check('and the read still answers', r && r.value === '{"x":"y"}', r);
  }

  /* ---- asked for before anybody knows there is a session ----

     Signing in asked /api/me, waited, and only then asked for the settings:
     two round trips one after the other, and to Oregon that is six hundred
     milliseconds before anything can be drawn. They go at the same time now,
     which means the second one is sent without knowing whether it will be
     allowed - so being refused has to cost nothing. */
  {
    const win = run(makeWindow({ answer: url => /kv-all/.test(url)
      ? { values: VALUES, versions: VERSIONS } : {} }));
    win.HWSync.prefetch();
    const r = await win.storage.get('overrides');
    check('the early request is the one the first read waits on',
      win.asked.length === 1 && win.asked[0] === '/api/kv-all', win.asked);
    check('and it answers the read', r && r.value === VALUES.overrides, r);
  }
  {
    /* Refused, because nobody had signed in yet. It must leave no copy
       behind: a cache of nothing, treated as the whole truth, would answer
       "not stored" to every read for the rest of the session. */
    const win = run(makeWindow({ answer: url => /kv-all/.test(url)
      ? { fail: true, status: 401 }
      : { key: 'empNames', value: '{"x":"y"}', version: 3 } }));
    win.HWSync.prefetch();
    const r = await win.storage.get('empNames');
    check('a refused early request leaves no copy behind',
      win.HWSync.ready() === false, null);
    check('and the read that follows it still gets its answer',
      r && r.value === '{"x":"y"}', r);
  }

  /* ---- and the attendance, which the frame used to ask for again ---- */
  {
    const parent = run(makeWindow({ answer: url => /dataset/.test(url)
      ? { employees: [{ name: 'A' }], records: [{ e: 'A', d: '2026-11-19' }] }
      : { values: {}, versions: {} } }));
    parent.HWSync.prefetchDataset();
    const kid = run(makeWindow({ framed: true, parent: parent,
      answer: () => ({ employees: [], records: [] }) }));
    const d = await kid.HWSync.bootDataset();
    check('a frame takes the attendance the page above already asked for',
      kid.asked.length === 0, kid.asked);
    check('and it is the attendance, not an empty stand-in',
      d && d.employees.length === 1 && d.records.length === 1, d);
    check('one request for it, not one per asking',
      parent.asked.filter(u => /dataset/.test(u)).length === 1, parent.asked);
  }
  {
    /* No page above, or one that never asked: this one asks, once. */
    const lone = run(makeWindow({ answer: () => ({ employees: [], records: [] }) }));
    await lone.HWSync.bootDataset();
    await lone.HWSync.bootDataset();
    check('a page on its own asks for it itself, and only once',
      lone.asked.filter(u => /dataset/.test(u)).length === 1, lone.asked);
    /* A workspace opened an hour after signing in must not be handed an
       hour-old copy of the attendance. */
    check('and a copy from an hour ago is not handed to anybody',
      /DS_BOOT_GOOD_MS/.test(SYNC) && /Date\.now\(\) - dsBootAt < DS_BOOT_GOOD_MS/.test(SYNC), null);
  }

  /* ---- what the shell does is unchanged ---- */
  {
    const win = run(makeWindow({ answer: url => /kv-all/.test(url)
      ? { values: VALUES, versions: VERSIONS } : {} }));
    await win.HWSync.hydrate();
    await win.HWSync.hydrate();
    check('hydrating twice is one request, not two', win.asked.length === 1, win.asked);
    check('and the cache it hands out is what it loaded',
      Object.keys(win.HWSync.cached()).length === Object.keys(VALUES).length, null);
  }

  /* ---- and the order the three pages actually start things in ---- */
  const AUTH = fs.readFileSync(path.join(REPO, 'public', 'hw-auth.js'), 'utf8');
  const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
  check('the settings are asked for beside the session check, not after it',
    /HWSync\.prefetch\(\);[\s\S]{0,400}fetch\('\/api\/me'/.test(AUTH), null);
  /* Only where somebody has signed in on this browser before: an anonymous
     visitor should not have a refused request made on their behalf. */
  check('but only where there has been a session on this browser',
    /if \(last && window\.HWSync && typeof window\.HWSync\.prefetch/.test(AUTH), null);
  check('the attendance is asked for as the dashboard is built, not by it',
    /prefetchDataset\(\)\.catch/.test(AUTH), null);
  check('and the dashboard waits on that one rather than making its own',
    /window\.HWSync\.bootDataset\s*\?\s*window\.HWSync\.bootDataset\(\)/.test(APP), null);
  /* The names were queued behind the attendance for no reason beyond the
     order the loaders happen to run in. */
  check('the account names go at the same time as the attendance',
    APP.indexOf('accountNamesSoon();\n  loadCustomDataset()') > -1
    || /accountNamesSoon\(\);[\s\S]{0,40}loadCustomDataset\(\)/.test(APP), null);
  check('and the loader that wanted them takes that same answer',
    /function loadAccountNames\(\)\{[\s\S]{0,120}accountNamesSoon\(\)/.test(APP), null);

  console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
