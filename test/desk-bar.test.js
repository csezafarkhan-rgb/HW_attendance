/* The time the computer was in use, under the day it belongs to.
 *
 * The record says when somebody arrived and when they left. DeskTime says how
 * much of that the computer was actually in use - and the office had to open
 * another page to see it, which means in practice that nobody saw it beside
 * the day it was about.
 *
 * It is a bar under the day now. The things worth holding still: what it is a
 * share OF, that a day with nothing to compare draws nothing at all, that past
 * a full day is its own colour rather than just a full bar, and that the bar
 * is the same bar the DeskTime page draws.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

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

const DESK = {
  'Zafar Khan|2026-11-02': { i: '09:44', o: '19:00', w: 556, d: 470 },   // 85% of 9:16
  'Rahul Mishra|2026-11-02': { i: '12:41', o: '18:38', w: 357, d: 160 }, // under half
  'Himanshu|2026-11-02': { i: '10:06', o: '19:06', w: 540, d: 560 },     // past the day
  'Keshav Garg|2026-11-02': { i: '09:25', o: '18:30', w: 545, d: 350 },  // the middle
  'Habib|2026-11-02': { i: '09:00', o: '18:00', w: 540, d: 0 }           // seen, but nothing
};
const ctx = {
  console, Math, String, Number, Object, Array,
  deskTime: DESK,
  state: { deskBar: true },
  fmtMin: m => Math.floor(m / 60) + ':' + ('0' + (m % 60)).slice(-2)
};
vm.createContext(ctx);
['deskSeenMinutes', 'deskShare', 'deskBand', 'deskBarCell', 'deskBarRow']
  .forEach(n => vm.runInContext(grab(APP, n), ctx));
vm.runInContext('var DESK_TRACK = 125;', ctx);

/* ---- the figure ---- */
check('the minutes are the ones DeskTime saw at the computer',
  ctx.deskSeenMinutes('Zafar Khan', '2026-11-02') === 470, null);
check('a day it saw nothing on has no figure, not a zero',
  ctx.deskSeenMinutes('Habib', '2026-11-02') === null, null);
check('nor has a day it never saw at all',
  ctx.deskSeenMinutes('Nobody', '2026-11-02') === null, null);
/* One definition: the hours a day from home is worth and the bar under the
   day must be the same number, or the screen argues with itself. */
check('and the hours a day from home is worth ask the same question',
  /function wfhSeenMinutes\(emp, dateStr\)\{\s*return deskSeenMinutes\(emp, dateStr\);/
    .test(APP.replace(/\r/g, '')), null);

/* ---- what it is a share of ---- */
const share = ctx.deskShare('Zafar Khan', '2026-11-02', 556);
check('the share is of the day the record credits', share && share.pct === 85, share);
check('with both figures kept, for the words on hover',
  share && share.desk === 470 && share.marked === 556, share);
check('a day with no marked hours has nothing to be a share of',
  ctx.deskShare('Zafar Khan', '2026-11-02', 0) === null, null);
check('and a day DeskTime missed has nothing to share',
  ctx.deskShare('Habib', '2026-11-02', 540) === null, null);
/* The bar is a share of the figure in the row above it. */
check('it is taken against the total that row has just shown',
  /deskByEmp\[emp\.name\] = deskShare\(emp\.name, dateStr, durs\.totalMin\);/.test(APP), null);

/* ---- the four colours, which are the DeskTime page's own ---- */
check('past a full day has a colour of its own', ctx.deskBand(101) === 'over', null);
check('three quarters and over is the good one', ctx.deskBand(75) === 'hi', null);
check('half to three quarters is the middle', ctx.deskBand(50) === 'mid', null);
check('under half is the one worth asking about', ctx.deskBand(49) === 'lo', null);
check('a day exactly matched is not "past" it', ctx.deskBand(100) === 'hi', null);
/* Same bar, same page: these are the colours the DeskTime tab already uses. */
['#2F6FD0', '#2E7D5B', '#E0A93B', '#C9594F'].forEach(c => {
  check('the colour ' + c + ' is the one that page already draws',
    (APP.match(new RegExp(c.replace('#', '#'), 'g')) || []).length >= 2, null);
});
check('and the bar is the same height as that page’s',
  /\.desk-bar\{[^}]*height:\s*7px/.test(APP) && /\.dt-use-bar\{[^}]*height:\s*7px/.test(APP), null);

/* ---- the cell ---- */
const cell = ctx.deskBarCell(share, true);
check('the bar sits in a cell six columns wide, like the day above it',
  /colspan="6"/.test(cell), cell.slice(0, 80));
check('and carries the rule between people, so the column is not broken',
  /class="desk-cell emp-block-start"/.test(cell), null);
check('the fill is the share, on a track a quarter longer than the day',
  /width="?68\.0%/.test(cell) || /width:68\.0%/.test(cell), cell);
check('with the mark where a full day reaches', /<u><\/u>/.test(cell), null);
check('and the figures in words for anybody who hovers',
  /title="At the computer 7:50 of 9:16 marked/.test(cell), cell.slice(0, 140));
const over = ctx.deskBarCell(ctx.deskShare('Himanshu', '2026-11-02', 540), false);
check('a day past the mark says so in words as well as colour',
  /longer than the day this record credits/.test(over), null);
/* 104% of the day is 83% of a track that runs to 125, which is past the
   mark and short of the end - the bar says 'over' by crossing the mark, not
   by filling. */
check('and its fill crosses the mark without filling the track',
  /width:83\.2%/.test(over), over.slice(0, 140));
check('a person with no figure gets an empty cell, not a bar of nothing',
  ctx.deskBarCell(null, true) === '<td class="desk-cell emp-block-start" colspan="6"></td>',
  ctx.deskBarCell(null, true));

/* ---- the line, and when there is none ---- */
const emps = [{ name: 'Zafar Khan' }, { name: 'Rahul Mishra' }, { name: 'Habib' }];
const by = { 'Zafar Khan': share, 'Rahul Mishra': ctx.deskShare('Rahul Mishra', '2026-11-02', 357) };
const row = ctx.deskBarRow(emps, by);
check('one cell per person on the line, whether or not they have a bar',
  (row.match(/<td /g) || []).length === 3, row.length);
/* An empty line under every day would double the height of a month to say
   nothing at all. */
check('a day nobody has a figure for draws no line',
  ctx.deskBarRow(emps, {}) === '', null);
ctx.state.deskBar = false;
check('and the switch turned off draws none either',
  ctx.deskBarRow(emps, by) === '', null);
ctx.state.deskBar = true;

/* ---- the row it goes under ---- */
const flat = APP.replace(/\r/g, '');
check('the date cell covers both lines, so nothing sits beside the bar empty',
  /'<td class="date-col"'\+\(deskBars \? ' rowspan="2"' : ''\)\+'>'\+label\+'<\/td>'/.test(flat), null);
check('the line is coloured as the day above it - a Saturday, a holiday, today',
  /<tr class="desk-row '\+rowCls\+'">/.test(flat), null);
/* The cells have to be built before the row is opened, because whether the
   date cell covers one line or two is not known until they are. */
check('the day is drawn before its row is opened',
  flat.indexOf("var cells = '', deskByEmp = {};") > -1
  && flat.indexOf("var cells = '', deskByEmp = {};") < flat.indexOf('var deskBars = deskBarRow('), null);

/* ---- the switch ---- */
check('there is a switch for it, under Hide Sunday',
  /id="hideSundayToggle"[\s\S]{0,400}id="deskBarToggle"/.test(flat), null);
check('on unless somebody turns it off', /deskBar:true/.test(flat.replace(/\s/g, '')), null);
check('kept for the person who set it, like the two above it',
  /storage\.set\('deskBar', String\(e\.target\.checked\), false\)/.test(flat), null);
check('and read back the same way',
  /storage\.get\('deskBar', false\)[\s\S]{0,200}res\.value === 'false'/.test(flat), null);
check('the grid is drawn again when it is switched',
  /state\.deskBar = e\.target\.checked;[\s\S]{0,160}renderTable\(\);/.test(flat), null);
check('it travels with the backup, like every other thing this account chose',
  /'showWeekStatus','hideSunday','deskBar'/.test(flat), null);
check('and the settings sheet says whether it is on',
  /\['DeskTime bar', state\.deskBar \? 'on' : 'off'\]/.test(flat), null);

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
