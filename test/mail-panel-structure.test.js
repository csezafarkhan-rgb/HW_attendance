/* The mail panel is built as one long run of string concatenation, and the
   browser silently repairs whatever comes out of it. A single </div> too many
   in the middle of it cost nothing at parse time and three faults on screen:
   the settings box closed early, so Work, Holiday and Month fell out of it and
   landed below everything - Month looked blank, because its fields were a
   screenful further down than the panel showed - the Save button went with
   them and so stood there even when the settings were shut, and the three
   "when it goes on its own" boxes, left in no pane at all, showed under every
   tab.

   Nothing in a test that reads the rendered page would have caught it, because
   the rendered page was valid HTML. So this reads the markup as written: every
   tag the panel opens, it closes, and the things that must sit inside the
   settings box are at the depth that puts them there. */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

let pass = 0, fail = 0;
function ok(what, cond) {
  if (cond) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what); }
}

/* ---- the function, lifted out whole ------------------------------------ */
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
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
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* Every string literal in the function, in the order it is written. Comments
   are skipped, so a </div> described in prose is not counted as one. */
function literals(src) {
  const out = [];
  for (let k = 0; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); if (k < 0) break; continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c !== '"' && c !== "'") continue;
    const q = c; let s = '';
    k++;
    while (k < src.length && src[k] !== q) {
      if (src[k] === '\\') { s += src[k] + src[k + 1]; k += 2; continue; }
      s += src[k]; k++;
    }
    out.push(s);
  }
  return out;
}

const FN = grab(SRC, 'renderEmailDropdown');
const HTML = literals(FN).join('');

/* ---- every tag it opens, it closes ------------------------------------- */
function count(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) > -1) { n++; i += needle.length; }
  return n;
}
['div', 'label', 'table', 'tr', 'td', 'th', 'span', 'button', 'textarea'].forEach(function (tag) {
  const open = count(HTML, '<' + tag + ' ') + count(HTML, '<' + tag + '>');
  const shut = count(HTML, '</' + tag + '>');
  ok('every <' + tag + '> the panel opens, it closes (' + open + '/' + shut + ')', open === shut);
});

/* ---- and the pieces sit where they belong ------------------------------ */
/* Depth counted in <div>s alone, walking the markup as written. A marker that
   sits in a div's own opening tag counts that div, so a pane and the things
   directly inside it read the same depth. */
function depthAt(marker) {
  const at = HTML.indexOf(marker);
  if (at < 0) return null;
  let depth = 0;
  for (let k = 0; k < at; k++) {
    if (HTML.startsWith('</div>', k)) { depth--; k += 5; continue; }
    if (HTML.startsWith('<div', k) && (HTML[k + 4] === ' ' || HTML[k + 4] === '>')) { depth++; k += 3; }
  }
  return depth;
}

const pane = depthAt('class="em-pane"');
ok('the panel itself is the outermost box', pane === 1);

const set = depthAt('id="emSet"');
ok('the settings box is inside the panel', set === pane + 1);

/* A pane is a direct child of the settings box - all six of them, not three. */
['att', 'lt', 'lv', 'wk', 'hol', 'mo'].forEach(function (k) {
  ok('the ' + k + ' pane is inside the settings box',
     depthAt('data-em-pane="' + k + '"') === set + 1);
});

/* The Save button and the test button live in a row inside the settings box.
   Outside it they stand there with the settings shut, which is what they did. */
ok('Save is inside the settings box', depthAt('id="emSave"') === set + 1);
ok('the test button is inside the settings box', depthAt('id="emTest"') === set + 1);

/* The three that send themselves are leave settings, so they are in the leave
   pane. In no pane at all they showed under Attendance, Work, Month and the
   rest, each of which has nothing to do with a leave request. */
const lv = depthAt('data-em-pane="lv"');
['emReq', 'emUnreq', 'emConfirm'].forEach(function (id) {
  ok(id + ' is inside the leave pane', depthAt('id="' + id + '"') === lv);
});

/* And the tabs are the settings box's own, above the panes. */
ok('the tab strip is inside the settings box', depthAt('class="em-tabs"') === set + 1);

console.log(fail ? ('FAILED (' + fail + ' of ' + (pass + fail) + ')')
                 : ('ALL PASS (' + pass + ' checks)'));
process.exit(fail ? 1 : 0);
