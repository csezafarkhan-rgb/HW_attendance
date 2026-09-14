// public/hw-sync.js in a stand-in browser, against a tiny versioned store that
// behaves like PUT/GET /api/kv: saves queue per key, stale saves are refused.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'hw-sync.js'), 'utf8');

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

function makeBrowser() {
  const store = {};                         // key -> {value, version}
  const log = [];
  const notices = [];
  const elements = {};
  const document = {
    hidden: false,
    getElementById: id => elements[id] || null,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, set textContent(t) { notices.push(t); }, get textContent() { return notices[notices.length - 1]; } }),
    body: { appendChild(el) { elements.hwSaveFailed = el; } }
  };
  function respond(status, body, delay) {
    return new Promise(res => setTimeout(() => res({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) }), delay || 0));
  }
  const fetch = (url, opts) => {
    const m = /\/api\/kv\/([^?]+)/.exec(url);
    const key = m && decodeURIComponent(m[1]);
    const method = (opts && opts.method) || 'GET';
    if (method === 'GET' && key) {
      const r = store[key];
      return respond(200, r ? { key, value: r.value, shared: true, version: r.version } : null);
    }
    if (method === 'PUT' && key) {
      const body = JSON.parse(opts.body);
      log.push({ key, base: body.baseVersion });
      const r = store[key];
      if (body.baseVersion != null && r && r.version !== body.baseVersion) return respond(409, { error: 'conflict', version: r.version }, 5);
      const version = r ? r.version + 1 : 1;
      store[key] = { value: body.value, version };
      return respond(200, { key, value: body.value, shared: true, version }, 20);   // slow enough for saves to overlap
    }
    return respond(404, { error: 'not_found' });
  };
  const window = {};
  const ctx = { window, document, fetch, setTimeout, clearTimeout, AbortController, console, Object, JSON, Promise, String, Error, setInterval() {} };
  window.document = document;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { storage: window.storage, store, log, notices, otherTabSaves: (key, value) => { const r = store[key]; store[key] = { value, version: (r ? r.version : 0) + 1 }; } };
}

(async () => {
  {
    const b = makeBrowser();
    b.store.overrides = { value: '{}', version: 4 };
    await b.storage.get('overrides', true);
    const p1 = b.storage.set('overrides', '{"a":1}', true);
    const p2 = b.storage.set('overrides', '{"a":1,"b":2}', true);   // straight after, before p1 answers
    const r = await Promise.allSettled([p1, p2]);
    check('two quick saves of one key both succeed', r.every(x => x.status === 'fulfilled'), r.map(x => x.status));
    check('second save sent the version the first returned', b.log[0].base === 4 && b.log[1].base === 5, b.log);
    check('server holds the last value', b.store.overrides.value === '{"a":1,"b":2}' && b.store.overrides.version === 6);
    check('no notice shown', b.notices.length === 0, b.notices);
  }
  {
    const b = makeBrowser();
    b.store.satPolicy = { value: '{}', version: 2 };
    await b.storage.get('satPolicy', true);
    b.otherTabSaves('satPolicy', '{"Ravi":{"mode":"OFF"}}');           // someone else, after this page loaded it
    let err = null;
    try { await b.storage.set('satPolicy', '{"Asha":{"mode":"WFH"}}', true); } catch (e) { err = e; }
    check('save from a stale copy is rejected (409)', err && err.status === 409, err && err.status);
    check("the other person's change is kept", b.store.satPolicy.value === '{"Ravi":{"mode":"OFF"}}');
    check('person told someone else changed it', b.notices.some(t => /someone else changed the Saturday settings/.test(t)), b.notices);
    await b.storage.get('satPolicy', true);                              // reload the value
    let ok = true;
    try { await b.storage.set('satPolicy', '{"Ravi":{"mode":"OFF"},"Asha":{"mode":"WFH"}}', true); } catch (e) { ok = false; }
    check('after re-reading, the save goes through', ok && b.store.satPolicy.version === 4, b.store.satPolicy);
  }
  {
    const b = makeBrowser();
    b.store.newKey = undefined; delete b.store.newKey;
    let ok = true;
    try { await b.storage.set('newKey', '1', true); } catch (e) { ok = false; }
    check('a key never read saves without a version (as before)', ok && b.log[0].base === undefined, b.log);
  }
  {
    // The error reporter, with a window that can hold listeners.
    const listeners = {}, posts = [];
    const window = { addEventListener: (t, f) => { listeners[t] = f; } };
    window.self = window.top = window;
    const ctx = { window, document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {} }), body: { appendChild() {} } },
      fetch: (url, o) => { if (url === '/api/client-errors') posts.push(JSON.parse(o.body)); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); },
      setTimeout, clearTimeout, AbortController, console, Object, JSON, Promise, String, Error, setInterval() {} };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    const boom = { target: window, message: "TypeError: Cannot read properties of null (reading 'value')", filename: 'about:srcdoc', lineno: 812, error: { stack: 'at renderX' } };
    listeners.error(boom); listeners.error(boom);
    check('an uncaught error is reported once, with where', posts.length === 1 && posts[0].line === 812 && posts[0].page === 'shell', posts);
    listeners.error({ target: { tagName: 'IMG' } });
    listeners.unhandledrejection({ reason: new Error('Failed to fetch') });
    check('image load failures and network drop-outs are not reported', posts.length === 1, posts);
    listeners.unhandledrejection({ reason: new Error('x is not defined') });
    check('a rejected promise is reported', posts.length === 2 && /^Unhandled: x is not defined/.test(posts[1].message), posts);
    for (let i = 0; i < 20; i++) listeners.error({ target: window, message: 'Error ' + i, filename: 'a', lineno: i });
    check('at most ten per page', posts.length === 10, posts.length);
  }
  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
