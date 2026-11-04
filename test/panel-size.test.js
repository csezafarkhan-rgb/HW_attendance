// The settings panel as a window somebody can resize.
//
// It holds a table of a dozen people and five boxes of wording, and the height
// worked out for it is a guess at what one screen can spare. So the corner can
// be dragged, and the size is kept - in this browser, because it is this
// person's screen and not the office's arrangement.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

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

/* ---- the grip itself ---- */
check('the panel can be taken hold of by its corner',
  /\.em-dropdown\{[\s\S]{0,220}resize:both;/.test(APP));
/* A browser draws no grip on an element whose overflow is visible, which is
   the whole reason the rule carries one. */
check('and carries the overflow a grip needs to be drawn at all',
  /\.em-dropdown\{[\s\S]{0,220}overflow:auto;/.test(APP));
/* Dragged to nothing it would be unreachable, so there is a floor under it. */
check('it cannot be dragged away to nothing',
  /min-height:220px/.test(APP) && /min-width:330px/.test(APP));

/* ---- and the size outliving the visit ---- */
{
  const store = {};
  const ctx = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    JSON, Math, console,
  };
  vm.createContext(ctx);
  ['sizeKeyOf', 'savedSize', 'rememberSize'].forEach(n => vm.runInContext(grab(APP, n), ctx));
  const panel = { id: 'emailDropdown', offsetWidth: 820, offsetHeight: 640 };

  check('nothing is remembered until somebody drags something',
    ctx.savedSize(panel) === null);
  ctx.rememberSize(panel);
  check('a dragged size is kept against that one panel',
    store['hw.panelSize.emailDropdown'] === '{"w":820,"h":640}',
    store['hw.panelSize.emailDropdown']);
  check('and comes back on the next visit',
    JSON.stringify(ctx.savedSize(panel)) === '{"w":820,"h":640}', ctx.savedSize(panel));
  /* Each panel its own size: the month picker and the settings window are not
     the same shape and should not inherit each other's. */
  check('each panel keeps its own',
    ctx.sizeKeyOf({ id: 'shiftDropdown' }) !== ctx.sizeKeyOf(panel));
  /* Rubbish in storage - a hand-edited value, a half-written one - is ignored
     rather than drawn. */
  store['hw.panelSize.emailDropdown'] = 'not json at all';
  check('rubbish in storage is ignored rather than drawn',
    ctx.savedSize(panel) === null);
  store['hw.panelSize.emailDropdown'] = '{"w":10,"h":4}';
  check('and so is a size too small to find again',
    ctx.savedSize(panel) === null);

  /* Storage can be shut off, or throw in a private window. The panel opens at
     its ordinary size then; it does not fail to open. */
  const shut = Object.assign({}, ctx, {
    localStorage: { getItem: () => { throw new Error('denied'); },
                    setItem: () => { throw new Error('denied'); } } });
  vm.createContext(shut);
  ['sizeKeyOf', 'savedSize', 'rememberSize'].forEach(n => vm.runInContext(grab(APP, n), shut));
  check('a browser with storage shut off still opens the panel',
    shut.savedSize(panel) === null);
  let threw = false;
  try { shut.rememberSize(panel); } catch (e) { threw = true; }
  check('and dragging it there fails quietly rather than loudly', !threw);
}

/* ---- what the saved size may not do ---- */
{
  const place = grab(APP, 'place');
  /* A panel dragged tall on a big monitor must not open below the bottom of a
     small one. */
  check('a saved size is clamped to the screen it is opened on',
    /Math\.min\(want\.h, room\)/.test(place) && /Math\.min\(want\.w, window\.innerWidth - 16\)/.test(place),
    null);
  /* The panel is measured for placement after its size is applied, or it is
     put where it was a moment ago rather than where it now is. */
  check('and the panel is placed after its size is set, not before',
    place.indexOf('dd.style.width = Math.min(want.w') < place.indexOf('var w = dd.offsetWidth'),
    null);
  /* Saving on every mouse release would write back whatever the clamp had
     just cut the panel down to, and a tall panel opened once on a short screen
     would stay short on every screen after. */
  check('a size is only written when the drag actually moved it',
    /if\(was && Math\.abs\(was\.w - dd\.offsetWidth\) < 2 && Math\.abs\(was\.h - dd\.offsetHeight\) < 2\) return;/
      .test(APP), null);
  check('and what was placed is recorded so that can be told',
    /dd\.__hwPlaced = \{ w: dd\.offsetWidth, h: dd\.offsetHeight \};/.test(APP), null);
}

const bad = results.filter(x => !x).length;
/* ---- and the settings fill the panel rather than keeping a height of
       their own inside it ----
   52vh, never more than 560px, was right while the panel had a fixed height
   too. The panel can be dragged now, and the settings went on keeping their
   560px inside it - so the Leave card, the longest of the six by a street,
   scrolled in a small window with the panel half empty around it, and two
   scrollbars side by side to say so. */
{
  const css = APP.slice(APP.indexOf('.em-dropdown{'), APP.indexOf('.em-appr-wrap{'));
  check('the settings box no longer carries a height of its own',
    !/\.em-set\{[^}]*height:52vh/.test(APP) && !/\.em-set\{[^}]*max-height:560px/.test(APP),
    null);
  check('it stretches to whatever the panel has been dragged to',
    /\.em-dropdown \.em-set\{ flex:1 1 auto;/.test(APP), null);
  /* The rule that pins everything else has to say "everything else". It said
     `> *`, which is two classes and an element against the one class naming
     the settings - so flex:none won and nothing stretched. */
  check('and the rule pinning the rest leaves the settings out of it',
    /\.em-dropdown \.em-pane > \*:not\(\.em-set\)\{ flex:none; \}/.test(APP), null);
  check('with the settings named at least as strongly as the rule that pins',
    /\.em-dropdown \.em-set\{/.test(APP) && !/^\.em-set\{ flex/m.test(APP), null);
  check('the panel is a column for it to stretch in',
    /\.month-dropdown\.em-dropdown\.open\{ display:flex; flex-direction:column; \}/.test(APP),
    null);
  /* Named by both its classes on purpose: `.month-dropdown.open{display:block}`
     is declared further down the sheet, and with one class each the later rule
     wins on order alone and quietly undoes the column - which is exactly what
     it did, leaving the settings at their full height and the panel scrolling
     around them instead. */
  check('and says so by both its classes, so a later rule cannot undo it',
    APP.indexOf('.month-dropdown.em-dropdown.open{') <
      APP.indexOf('.month-dropdown.open{display:block;}')
    && /\.month-dropdown\.em-dropdown\.open/.test(APP), null);

  /* A flex child will not scroll inside its parent unless it is allowed to be
     smaller than its content. */
  check('the pane may be shorter than what is in it',
    /\.em-dropdown \.em-pane\{[^}]*min-height:0;/.test(APP), null);
  check('and the settings still scroll when they are longer than the panel',
    /\.em-dropdown \.em-set\{[^}]*overflow-y:auto;/.test(APP), null);
}

console.log(bad ? ('FAILED ' + bad + ' of ' + results.length)
                : ('ALL PASS (' + results.length + ' checks)'));
process.exit(bad ? 1 : 0);
