// Drive the real renderReqBadge / unrequestedLeave / saveOverrides lifted out of
// the dashboard source, against a stand-in document.
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
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

const el = id => ({ id, textContent: '0', title: '', style: { display: 'none' } });
const els = { reqBadge: el('reqBadge'), reqUntakenBadge: el('reqUntakenBadge') };
const ctx = {
  document: { getElementById: id => els[id] || null },
  parent: { postMessage() {} },
  storage: { set: () => Promise.resolve() },
  console,
  leaveRequests: [
    { empName: 'Asha', status: 'approved', leaveType: 'CL', dateFrom: '2026-09-01', dateTo: '2026-09-02' }
  ],
  overrides: {
    'Asha|2026-09-01': { cat: 'LEAVE' },                   // covered by her request
    'Zafar Khan|2026-09-10': { cat: 'LEAVE', detail: 'Sick' },
    'Ravi|2026-09-03': { cat: 'WFH' }                        // not leave at all
  },
  halfDays: { 'Habib|2026-09-07': { kind: 'SHORT', note: 'Medical Emergency' } }
};
vm.createContext(ctx);
try { vm.runInContext(grab('pad2'), ctx); console.log('pad2: the page\'s own'); }
catch (e) { vm.runInContext("function pad2(n){ return (n < 10 ? '0' : '') + n; }", ctx); console.log('pad2: stand-in (' + e.message + ')'); }
['isPartDay', 'eachDateBetween', 'pendingRequestCount', 'unrequestedLeave', 'renderReqBadge', 'saveOverrides']
  .forEach(n => vm.runInContext(grab(n), ctx));

try { vm.runInContext('unrequestedLeave()', ctx); console.log('unrequestedLeave runs'); }
catch (e) { console.log('unrequestedLeave threw: ' + e.message); }

// A real element stores text; the stand-in keeps whatever it was given.
const show = () => ({ waiting: els.reqBadge.style.display === 'none' ? 'hidden' : String(els.reqBadge.textContent),
                      untaken: els.reqUntakenBadge.style.display === 'none' ? 'hidden' : String(els.reqUntakenBadge.textContent) });
const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  ' + JSON.stringify(got) + (ok ? '' : '  wanted ' + JSON.stringify(want)));
};

vm.runInContext('renderReqBadge()', ctx);
check('screenshot case: 0 waiting, 2 taken without a request', show(), { waiting: 'hidden', untaken: '2' });
check('title explains it', els.reqUntakenBadge.title, '2 leave entries taken without a request');

ctx.leaveRequests.push({ empName: 'Zafar Khan', status: 'pending', leaveType: 'Sick', dateFrom: '2026-09-10', dateTo: '2026-09-10' });
vm.runInContext('renderReqBadge()', ctx);
check('a request filed for it moves it to waiting', show(), { waiting: '1', untaken: '1' });

// Marking a leave in the grid saves overrides - the badge must follow without a reload.
vm.runInContext("overrides['Ravi|2026-09-04'] = {cat:'LEAVE'}; saveOverrides();", ctx);
check('saveOverrides refreshes the badge', show(), { waiting: '1', untaken: '2' });

vm.runInContext("delete overrides['Ravi|2026-09-04']; halfDays = {}; saveOverrides();", ctx);
check('none left: badge hides', show(), { waiting: '1', untaken: 'hidden' });

console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
