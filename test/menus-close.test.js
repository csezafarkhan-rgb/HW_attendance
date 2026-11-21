/* Menus that stayed open over the grid.
 *
 * Every dropdown on the toolbar closes when something else is clicked -
 * something else meaning anywhere in the dashboard's own page. But that page
 * is a frame inside another one, which has a bar of its own above it and
 * space beside it. A click there never reaches the frame, so the menu sat
 * open over the record until something inside was clicked.
 *
 * Two ways in: the frame losing focus, which is what a click outside looks
 * like from in there, and the page around it saying so, for the case where
 * the frame never had the focus to lose.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
const SHELL = fs.readFileSync(path.join(REPO, 'src', 'shell.template.html'), 'utf8');
const flat = APP.replace(/\r/g, ''), shell = SHELL.replace(/\r/g, '');

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

/* ---- what closing means ---- */
{
  const open = [];
  const made = n => ({ classList: { remove(c) { open.push('closed:' + n); } } });
  let selxClosed = false;
  const ctx = {
    console, Array,
    document: { querySelectorAll: s => (/month-dropdown\.open/.test(s) ? [made('menu1'), made('menu2')] : []) },
    window: { __selxClose: () => { selxClosed = true; } }
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(grab(APP, 'closeFloatingMenus'), ctx);
  ctx.closeFloatingMenus();
  check('every menu left open is closed', open.length === 2, open);
  /* The list a custom select opens is torn down by its own closer, so its
     listeners go with it rather than being left behind on the document. */
  check('and the list a select opened is closed by its own closer',
    selxClosed === true, null);
  check('which that enhancer now hands out',
    /window\.__selxClose = closePop;/.test(flat), null);
}

/* ---- the two ways a click outside gets in ---- */
check('the frame closes its menus when it loses the focus',
  /window\.addEventListener\('blur', closeFloatingMenus\);/.test(flat), null);
check('and when the page around it says somebody clicked out there',
  /e\.data\.type === 'hw-outside-click'\) closeFloatingMenus\(\);/.test(flat), null);
check('which that page says on any click of its own',
  /document\.addEventListener\('click', function\(\)\{[\s\S]{0,320}type:'hw-outside-click'/.test(shell), null);
/* Captured, so it is heard even where something inside the bar stops the
   click getting any further. */
check('heard on the way down, so nothing can swallow it first',
  /postMessage\(\{ type:'hw-outside-click' \}, '\*'\);[\s\S]{0,120}\}, true\);/.test(shell), null);
check('and said to every frame, not only the one in front',
  /var frames = document\.querySelectorAll\('#frames iframe'\);/.test(shell), null);

/* ---- and what it must not do ---- */
const fn = grab(APP, 'closeFloatingMenus');
/* A form somebody is halfway through typing into is not a thing to shut
   because they reached for the window behind it. */
check('a form in the middle of being filled in is left alone',
  !/modal/.test(fn), fn.slice(0, 120));
check('nor is anything removed from the page by hand',
  !/\.remove\(\)/.test(fn), null);

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
