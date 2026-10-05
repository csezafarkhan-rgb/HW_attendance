// Every helper the dashboard's own code calls must actually exist.
//
// A function can be deleted without breaking the parse: the call site is still
// valid JavaScript, the syntax check still passes, and the button simply throws
// the moment somebody presses it. That is how "Email the full month" came to sit
// under "Building September 2026..." for good - blobBase64 had been removed by
// an edit to its neighbour, and nothing noticed until it was pressed.
//
// This walks the named functions below and checks that every plain call they
// make - not a method, not a local, not a builtin - is defined somewhere in the
// file.
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* The body of a named function, by brace counting, skipping strings, comments
   and regex literals so a brace inside one of those does not end it early. */
function body(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; k++;
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
      continue;
    }
    /* A regex literal. /'/g carries a quote that would otherwise read as the
       start of a string and run away with the rest of the file - which is how
       this first reported that buildStyledXlsxMulti calls ESI().
       Told apart from division by what comes before it, ignoring spaces: after
       a name, a number or a closing bracket a slash divides; anywhere else it
       opens a pattern. "worked / 1440" is a division, and reading it as a
       pattern swallowed the rest of gridSummarySheet. */
    if (c === '/' && (function () {
      let p = k - 1;
      while (p >= 0 && /\s/.test(src[p])) p--;
      const prev = src[p] || '';
      return !/[\w$)\]]/.test(prev);
    })()) {
      k++;
      let inClass = false;
      while (k < src.length && (src[k] !== '/' || inClass)) {
        if (src[k] === '\\') k++;
        else if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        k++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* Anything declared in the file: a function, a var holding one, a parameter. */
const declared = new Set();
for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
for (const m of src.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*function\s*\(/g)) declared.add(m[1]);

const BUILTIN = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'delete',
  'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'case', 'await', 'yield',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'Math', 'JSON', 'Promise', 'Error',
  'RegExp', 'Map', 'Set', 'WeakMap', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'escape', 'unescape', 'atob', 'btoa', 'fetch', 'alert', 'confirm',
  'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'FileReader', 'Blob', 'File', 'FormData', 'URL', 'Image', 'Uint8Array', 'Uint16Array',
  'Int8Array', 'Float32Array', 'Float64Array', 'DataView', 'ArrayBuffer', 'TextDecoder',
  'TextEncoder', 'AbortController', 'Intl', 'structuredClone', 'queueMicrotask', 'DOMParser',
  'XMLHttpRequest', 'CustomEvent', 'Event', 'MutationObserver', 'IntersectionObserver',
  'OffscreenCanvas', 'ImageData', 'Notification', 'Worker', 'indexedDB', 'crypto'
]);

/* The entry points worth guarding: everything a button in the Share menu or the
   export path reaches. */
const WATCHED = [
  'sendMonth', 'exportGridExcel', 'exportLeaveExcel', 'buildGridWorkbook',
  'gridAllSheet', 'gridOneSheet', 'gridSummarySheet', 'gridWeekSummary', 'gridDayCells',
  'gridDateLabel', 'gridWeekVerdict', 'gridPerformanceSheet', 'buildStyledXlsxMulti', 'buildStyledXlsx',
  'blobBase64', 'runFolderSync', 'checkImportFolder', 'takeImportFile'
];

const missingFns = WATCHED.filter(n => !body(n));
check('every watched function is still in the file', missingFns.length === 0, missingFns);

const bad = [];
for (const name of WATCHED) {
  const text = body(name);
  if (!text) continue;
  /* Locals and parameters of this function are not expected to be declared at
     file level, so gather them first. */
  const local = new Set();
  for (const m of text.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of text.matchAll(/function\s*\(([^)]*)\)/g)) {
    m[1].split(',').map(x => x.trim()).filter(Boolean).forEach(p => local.add(p));
  }
  for (const m of text.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    m[1].split(',').map(x => x.trim()).filter(Boolean).forEach(p => local.add(p));
  }
  /* A plain call: an identifier followed by "(", with no "." before it. */
  for (const m of text.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const id = m[2];
    if (BUILTIN.has(id) || local.has(id) || declared.has(id)) continue;
    bad.push(name + ' calls ' + id + '()');
  }
}
check('and every helper they call is declared somewhere', bad.length === 0, bad);

/* The particular one that bit: the month button must reach a real function. */
const month = body('sendMonth') || '';
check('the month button calls a helper that exists',
  /blobBase64\(/.test(month) && !!body('blobBase64'), { calls: /blobBase64\(/.test(month), defined: !!body('blobBase64') });
check('and it cannot be left disabled by a throw on the way out',
  /\}catch\(e\)\{[\s\S]{0,220}monthBtn\.disabled = false;/.test(month), month.slice(-700));

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
