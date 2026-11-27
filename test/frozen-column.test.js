/* The first column stays put, all the way to the top of it.
 *
 * The date column is sticky, and the dates themselves never moved - so it read
 * as frozen until you looked at the header. There the same column was drawn on
 * the same layer as the cells sliding underneath it: `.emp-header-row th`,
 * `.shift-row th` and `.subhead-row th` each set z-index 30, `th.date-col`
 * asked for 50 above them with the same weight, and every one of them took it
 * back down. Equal layer, so the later cell in the markup won - scroll
 * sideways and an employee's banner was painted straight over the Date header
 * while the dates below it stayed where they were.
 *
 * The body never had the problem because a body row's own cells claim no layer
 * at all: a sticky cell with a z-index beats them without trying.
 *
 * This resolves the cascade the way a browser would - every rule that matches,
 * by specificity then by order - and asks what the column actually ends up
 * with, rather than reading the rule that was meant to win.
 */
'use strict';
const fs = require('fs'), path = require('path');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* ---- the stylesheet, as rules ---- */
function styleText(src) {
  let out = '', i = 0;
  for (;;) {
    const a = src.indexOf('<style', i);
    if (a < 0) break;
    const open = src.indexOf('>', a);
    const b = src.indexOf('</style>', open);
    if (open < 0 || b < 0) break;
    out += src.slice(open + 1, b) + '\n';
    i = b + 8;
  }
  return out;
}
/* Comments and at-rule blocks out of the way. A @media block is lifted out
   whole and kept to one side, so a rule inside one cannot be mistaken for a
   rule that always applies - and so the test can still ask what is in there. */
function rulesOf(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const flat = [], media = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace < 0) break;
    const head = css.slice(i, brace).trim();
    let depth = 1, k = brace + 1;
    while (k < css.length && depth > 0) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      k++;
    }
    const body = css.slice(brace + 1, k - 1);
    if (head.charAt(0) === '@') {
      if (/^@media/.test(head)) rulesOf(body).flat.forEach(r => media.push(r));
    } else if (head) {
      head.split(',').forEach(sel => flat.push({ sel: sel.trim(), body }));
    }
    i = k;
  }
  return { flat, media };
}
/* a.b.c, tag.a, #id - and descendants. Anything else in a selector that could
   match one of the cells below is a selector this test does not understand,
   and it says so rather than quietly ignoring it. */
const SIMPLE = /^[a-zA-Z]*(?:[.#][A-Za-z0-9_-]+)*$/;
function parseCompound(c) {
  const tag = (/^[a-zA-Z]+/.exec(c) || [''])[0];
  const classes = (c.match(/\.[A-Za-z0-9_-]+/g) || []).map(x => x.slice(1));
  const ids = (c.match(/#[A-Za-z0-9_-]+/g) || []).map(x => x.slice(1));
  return { tag, classes, ids };
}
function compoundMatches(c, el) {
  if (c.tag && c.tag.toLowerCase() !== el.tag) return false;
  if (c.ids.length && c.ids.some(id => id !== el.id)) return false;
  return c.classes.every(cl => el.classes.indexOf(cl) > -1);
}
/* The element, plus its ancestors outermost first. Descendant combinator only,
   which is all these selectors use. */
function selectorMatches(sel, el) {
  if (/[>+~:[]/.test(sel)) return null;              // not understood
  const parts = sel.split(/\s+/).filter(Boolean);
  if (!parts.every(p => SIMPLE.test(p))) return null;
  const want = parts.map(parseCompound);
  const last = want.pop();
  if (!compoundMatches(last, el)) return false;
  let ai = el.ancestors.length - 1;
  for (let wi = want.length - 1; wi >= 0; wi--) {
    let found = false;
    while (ai >= 0) {
      if (compoundMatches(want[wi], el.ancestors[ai])) { found = true; ai--; break; }
      ai--;
    }
    if (!found) return false;
  }
  return true;
}
function specificity(sel) {
  const ids = (sel.match(/#[A-Za-z0-9_-]+/g) || []).length;
  const cls = (sel.match(/\.[A-Za-z0-9_-]+/g) || []).length;
  const tags = (sel.replace(/[.#][A-Za-z0-9_-]+/g, '').match(/[a-zA-Z]+/g) || []).length;
  return ids * 10000 + cls * 100 + tags;
}
function declare(body, prop) {
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:([^;]+)', 'g');
  let m, last = null;
  while ((m = re.exec(body))) last = m[1].trim();
  return last;
}
function resolve(rules, el, prop) {
  let best = null, unknown = 0;
  /* A selector this test cannot read only matters when it could land on this
     cell at all - which means naming one of the classes the cell carries. */
  const mine = el.classes.concat(el.ancestors.reduce((a, x) => a.concat(x.classes), []));
  rules.forEach((r, order) => {
    const hit = selectorMatches(r.sel, el);
    if (hit === null) {
      if (new RegExp('\\b' + prop + '\\s*:').test(r.body)
          && mine.some(c => r.sel.indexOf('.' + c) > -1)) unknown++;
      return;
    }
    if (!hit) return;
    const v = declare(r.body, prop);
    if (v === null) return;
    const bang = /!important/.test(v);
    const rank = [bang ? 1 : 0, specificity(r.sel), order];
    if (!best || rank[0] > best.rank[0]
        || (rank[0] === best.rank[0] && rank[1] > best.rank[1])
        || (rank[0] === best.rank[0] && rank[1] === best.rank[1] && rank[2] > best.rank[2])) {
      best = { value: v.replace('!important', '').trim(), rank, sel: r.sel };
    }
  });
  return { value: best && best.value, from: best && best.sel, unknown };
}

const CSS = rulesOf(styleText(APP));
const TABLE = [{ tag: 'table', classes: ['att'], id: 'attTable' }];
const cell = (tag, classes, rowClasses) => ({
  tag, classes, id: '',
  ancestors: TABLE.concat([{ tag: 'tr', classes: rowClasses, id: '' }])
});

const BANDS = [
  ['the employee banner', 'emp-header-row', ['emp-block-start']],
  ['the shift line', 'shift-row', ['emp-block-start']],
  ['the column headings', 'subhead-row', ['emp-block-start']]
];

/* ---------------- it is frozen at all ---------------- */
BANDS.concat([['the days themselves', 'week-start', ['att-cell', 'in-cell', 'emp-block-start']]])
  .forEach(([said, row, mateCls]) => {
    const isHead = row !== 'week-start';
    const date = cell(isHead ? 'th' : 'td', ['date-col'], [row]);
    const pos = resolve(CSS.flat, date, 'position');
    const left = resolve(CSS.flat, date, 'left');
    check('the date column is pinned in ' + said,
      pos.value === 'sticky' && left.value === '0', { pos: pos.value, left: left.value });
    check('and no rule this test cannot read touches its layer in ' + said,
      resolve(CSS.flat, date, 'z-index').unknown === 0, null);
  });

/* ---------------- and it is drawn over what slides under it ---------------- */
BANDS.concat([['the days themselves', 'week-start', ['att-cell', 'in-cell', 'emp-block-start']]])
  .forEach(([said, row, mateCls]) => {
    const isHead = row !== 'week-start';
    const date = cell(isHead ? 'th' : 'td', ['date-col'], [row]);
    const mate = cell(isHead ? 'th' : 'td', mateCls, [row]);
    const dz = resolve(CSS.flat, date, 'z-index').value;
    const mz = resolve(CSS.flat, mate, 'z-index').value;
    const d = dz === null || dz === 'auto' ? 0 : Number(dz);
    const m = mz === null || mz === 'auto' ? 0 : Number(mz);
    check('and it is drawn over ' + said + ', which scrolls under it',
      d > m, { date: dz, scrolling: mz, from: resolve(CSS.flat, date, 'z-index').from });
  });

/* ---------------- the corner, where the two freezes meet ---------------- */
{
  const head = cell('th', ['date-col'], ['emp-header-row']);
  const body = cell('td', ['date-col'], ['week-start']);
  const hz = Number(resolve(CSS.flat, head, 'z-index').value);
  const bz = Number(resolve(CSS.flat, body, 'z-index').value);
  check('the corner outranks the column below it, so a date never covers the heading',
    hz > bz, { head: hz, body: bz });
  const top = resolve(CSS.flat, head, 'top');
  check('and it is held at the top as well as the left',
    top.value === '0px' || top.value === '0', top.value);
}

/* ---------------- the three header bands do not land on each other -------
   Not a question the stylesheet answers: the bands are different heights in
   different months, so each one is pushed down past the measured height of the
   ones above it when the table is drawn. The sheet only holds the fallback. */
{
  check('each header band is pushed below the measured height of the ones above it',
    /querySelectorAll\('\.shift-row th'\)[\s\S]{0,80}th\.style\.top = h1 \+ 'px'/.test(APP)
      && /subhead-row:not\(\.leave-head\) th'\)[\s\S]{0,90}th\.style\.top = \(h1\+h2\) \+ 'px'/.test(APP),
    null);
}

/* ---------------- and nothing in a media query quietly undoes it --------- */
{
  const risky = CSS.media.filter(r => /date-col/.test(r.sel) && /z-index|position|left/.test(r.body));
  check('no narrow-screen rule takes the column back out of its place',
    risky.length === 0, risky.map(r => r.sel));
}

/* ---------------- the rule says why, in the file ---------------- */
check('the fix is written where the rules it beats are, and after them',
  APP.indexOf('.subhead-row th{') < APP.indexOf('.subhead-row th.date-col{ z-index:60; }'), null);

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
