// The dashboard's real dataset functions, driven through "the server answered
// late" cases with stand-ins for storage, IndexedDB and the network.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'") { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}
const tick = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 30; i++) await tick(); }

function makeCtx(serverAnswers) {
  const ctx = {
    console, JSON, Promise,
    EMPLOYEES: [], RECORDS: [], employeesByName: {}, recIndex: {}, monthSet: {}, ALL_MONTHS: [],
    DATASET_SOURCE: 'server', localBaseline: null,
    state: { selectedMonths: [] }, defaultMonth: undefined, empCalMonth: undefined, visibleEmpSet: null,
    idbSets: 0, serverSaves: [], redraws: 0, notices: [],
    setTimeout: (fn) => { ctx.timers.push(fn); return 0; }, timers: [],
    idbData: () => { ctx.idbSets++; return Promise.resolve(); },
    storage: { set: () => Promise.resolve() },
    showUploadStatus: (m) => ctx.notices.push(m),
    window: { HWSync: {
      hydrateDataset: () => { const a = serverAnswers.shift(); return a instanceof Error ? Promise.reject(a) : Promise.resolve(a); },
      saveDataset: (d) => { ctx.serverSaves.push(JSON.parse(JSON.stringify(d))); return Promise.resolve(); }
    } }
  };
  vm.createContext(ctx);
  ['applyDataset', 'markLocalDataset', 'adoptServerDataset', 'waitForServerDataset', 'persistDataset']
    .forEach(n => vm.runInContext(grab(n), ctx));
  vm.runInContext('function redrawAfterDataset(){ redraws++; }', ctx);
  return ctx;
}
const emp = n => ({ code: '', name: n, shift: '9:30-6:30' });
const row = (e, d, inT) => ({ e, d, in: inT, out: '18:30', dur: '8:00', st: 'PR' });
const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }
const find = (ctx, e, d) => vm.runInContext('RECORDS', ctx).find(r => r.e === e && r.d === d);

(async () => {
  // 1. Server late, nothing changed here: server copy replaces the stale one, nothing re-saved.
  {
    const server = { employees: [emp('Asha'), emp('Ravi')], records: [row('Asha', '2026-09-01', '09:31'), row('Asha', '2026-09-02', '09:20'), row('Ravi', '2026-09-03', '09:40')] };
    const ctx = makeCtx([]);
    vm.runInContext("applyDataset({employees:[{name:'Asha'}], records:[{e:'Asha',d:'2026-09-01',in:'09:00',st:'PR'}]}); markLocalDataset();", ctx);
    vm.runInContext('persistDataset()', ctx);
    check('while local, a save stays in the browser', ctx.serverSaves.length === 0 && ctx.idbSets === 1, ctx.serverSaves.length);
    ctx.waitForServerDataset(Promise.resolve(server)); await settle();
    check('late server copy is adopted', vm.runInContext('DATASET_SOURCE', ctx) === 'server' && vm.runInContext('RECORDS.length', ctx) === 3 && find(ctx, 'Asha', '2026-09-01').in === '09:31');
    check('no local edits -> nothing pushed', ctx.serverSaves.length === 0, ctx.serverSaves.length);
    check('screen redrawn', ctx.redraws === 1);
  }
  // 2. Rows imported here while waiting are laid over the server data, then saved once.
  {
    const server = { employees: [emp('Asha'), emp('Ravi')], records: [row('Asha', '2026-09-01', '09:31'), row('Ravi', '2026-09-03', '09:40')] };
    const ctx = makeCtx([new Error('timeout'), server]);
    vm.runInContext("applyDataset({employees:[{name:'Asha'}], records:[{e:'Asha',d:'2026-09-01',in:'09:00',st:'PR'},{e:'Asha',d:'2026-09-02',in:'09:05',st:'PR'}]}); markLocalDataset();", ctx);
    vm.runInContext("RECORDS[1] = {e:'Asha',d:'2026-09-02',in:'09:15',out:'18:40',st:'PR'}; RECORDS.push({e:'Neha',d:'2026-09-14',in:'09:25',st:'PR'}); EMPLOYEES.push({name:'Neha'});", ctx);
    ctx.waitForServerDataset(ctx.window.HWSync.hydrateDataset()); await settle();
    check('first failure schedules a retry', ctx.timers.length === 1 && vm.runInContext('DATASET_SOURCE', ctx) === 'local');
    ctx.timers.shift()(); await settle();
    check('retry adopts the server', vm.runInContext('DATASET_SOURCE', ctx) === 'server');
    check("server's own newer row kept", find(ctx, 'Asha', '2026-09-01').in === '09:31');
    check('row edited here wins for that day', find(ctx, 'Asha', '2026-09-02').in === '09:15');
    check("other people's server rows kept", !!find(ctx, 'Ravi', '2026-09-03'));
    check('new person imported here kept', !!find(ctx, 'Neha', '2026-09-14') && vm.runInContext("EMPLOYEES.some(function(e){return e.name==='Neha'})", ctx));
    check('merged result saved to the server once', ctx.serverSaves.length === 1 && ctx.serverSaves[0].records.length === 4, ctx.serverSaves.map(s => s.records.length));
    check('person told what happened', ctx.notices.length === 1 && /2 row/.test(ctx.notices[0]), ctx.notices);
  }
  // 3. Server comes back empty: this browser's copy is the data and is pushed.
  {
    const ctx = makeCtx([]);
    vm.runInContext("applyDataset({employees:[{name:'Asha'}], records:[{e:'Asha',d:'2026-09-01',in:'09:00',st:'PR'}]}); markLocalDataset();", ctx);
    ctx.waitForServerDataset(Promise.resolve({ employees: [], records: [] })); await settle();
    check('empty server -> local copy pushed', vm.runInContext('DATASET_SOURCE', ctx) === 'server' && ctx.serverSaves.length === 1 && ctx.serverSaves[0].records.length === 1);
  }
  // 4. Already on server data: adopt is a no-op, saves go to the server as before.
  {
    const ctx = makeCtx([]);
    vm.runInContext("applyDataset({employees:[{name:'Asha'}], records:[{e:'Asha',d:'2026-09-01',in:'09:00',st:'PR'}]});", ctx);
    ctx.adoptServerDataset({ employees: [], records: [] });
    vm.runInContext('persistDataset()', ctx); await settle();
    check('normal case unchanged: save reaches server', ctx.serverSaves.length === 1 && vm.runInContext('RECORDS.length', ctx) === 1);
  }
  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
