// The Excel (grid) export: one workbook holding everyone side by side with each
// person walled off, a summary, and a sheet each. Built here from stand-in
// attendance and taken apart again as a real .xlsx - every sheet reachable, the
// styles it names actually declared, and the walls where they belong.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* ---- the dashboard's own pieces, on a stand-in month ---- */
const EMPS = [{ name: 'Zafar Khan' }, { name: 'Rahul Mishra' }, { name: 'karan Ahuja' }];
const DATES = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
const RECS = {
  'Zafar Khan|2026-10-01': { 'in': '9:32', out: '18:36', dur: '9:04', st: 'PR', c: 1 },
  'Zafar Khan|2026-10-05': { 'in': '9:43', out: '18:40', dur: '8:57', st: 'PR', c: 1 },
  'Rahul Mishra|2026-10-01': { 'in': '9:22', out: '18:32', dur: '9:10', st: 'PR', c: 2 },
  'Rahul Mishra|2026-10-05': { 'in': '9:51', out: '18:44', dur: '8:53', st: 'PR', c: 1 },
  'karan Ahuja|2026-10-01': { st: 'AB' },
  'karan Ahuja|2026-10-04': { st: 'WO' }
};
const OVER = { 'Rahul Mishra|2026-10-05': null, 'karan Ahuja|2026-10-05': { cat: 'WFH', detail: '' } };
const HOLS = { '2026-10-02': { name: 'Gandhi Jayanti', note: 'Emaar Building Closed' } };

const ctx = {
  console, Math, Date, String, Number, Object, Array, JSON, isNaN, parseInt,
  Uint8Array, DataView, ArrayBuffer, TextEncoder, Blob: class { constructor(p) { this.parts = p; } },
  EMPLOYEES: EMPS,
  state: { selectedMonths: ['2026-10'], showWeekStatus: true },
  weeklyLeverageMin: 30,
  coNameEl: { textContent: 'AllyConnect Pvt. Ltd.' },
  OV_CATS: {
    LEAVE: { label: 'Leave', tag: d => 'Leave' + (d ? ' · ' + d : '') },
    WFH: { label: 'From home', tag: d => 'Work from home' },
    VISIT: { label: 'Visit', tag: d => 'Visit' + (d ? ' · ' + d : '') },
    OTHER: { label: 'Other', tag: d => d || 'Other' }
  },
  visibleEmployees: () => EMPS,
  allSelectedDates: () => DATES,
  getShift: () => '9:30-6:30',
  getRecord: (e, d) => RECS[e + '|' + d] || null,
  getOverride: (e, d) => OVER[e + '|' + d] || null,
  getOfficialLeave: d => HOLS[d] || null,
  getHalfDay: () => null,
  getLateExcuse: () => null,
  getEarlyExcuse: () => null,
  isLate: (e, r) => !!(r && r['in'] && r['in'] >= '9:40'),
  isEarly: () => false,
  computeDurations: r => ({ totalMin: r && r.dur ? 544 : null, inMin: 540, outMin: 4 }),
  workedMinutes: (e, d) => (RECS[e + '|' + d] && RECS[e + '|' + d].dur) ? 544 : 0,
  wfhCellDuration: () => '9:00',
  hdMark: () => '',
  fmtTime: t => t || '',
  fmtMin: m => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'),
  monthLabel: ym => 'October 2026',
  monthLabelShort: ym => 'Oct 2026',
  weekdayName: d => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(d + 'T00:00:00').getDay()],
  pad2: n => String(n).padStart(2, '0'),
  mondayOf: d => '2026-09-28',
  computeWeeklyShortHours: () => ({ weekTotals: { '2026-09-28': -45 }, weekDays: { '2026-09-28': 5 }, weekOpen: {} })
};
vm.createContext(ctx);

/* the palette and the edge table are plain declarations, not functions */
['var XLF = ', 'var XL_EDGES = '].forEach(decl => {
  const i = src.indexOf('  ' + decl);
  const j = src.indexOf('];', i) > -1 && decl === 'var XL_EDGES = ' ? src.indexOf('];', i) + 2 : src.indexOf('};', i) + 2;
  vm.runInContext(src.slice(i, j), ctx);
});
vm.runInContext('var XLKEYS = Object.keys(XLF);', ctx);
/* the CRC table the zip writer leans on */
vm.runInContext(/var _CRC=\(function\(\)[\s\S]*?\}\)\(\);/.exec(src)[0], ctx);
['_colLetter', '_xesc', '_safeSheetName', 'xlEdgeIdx', 'xlStyleIdx', '_stylesXml', '_sheetXmlStyled',
 '_crc32', '_zipStore', 'buildStyledXlsxMulti', 'gridDayCells', 'gridWeekVerdict', 'gridDateLabel',
 'gridAllSheet', 'gridOneSheet', 'gridSummarySheet', 'buildGridWorkbook'
].forEach(n => vm.runInContext(lift(src, n), ctx));
vm.runInContext('var GRID_COLS = ' + JSON.stringify(['IN', 'OUT', 'TOTAL', 'IN DUR', 'OUT DUR', 'PUN']) + ';', ctx);

const sheets = ctx.buildGridWorkbook();

/* ---- the shape of the workbook ---- */
check('a sheet for everyone, a summary, and one per employee',
  sheets.length === 2 + EMPS.length && sheets[0].name === 'All employees' && sheets[1].name === 'Summary'
    && sheets[2].name === 'Zafar Khan', sheets.map(s => s.name));
check('the wide sheet freezes the date column and the headers',
  sheets[0].freeze.col === 1 && sheets[0].freeze.row === 5 && sheets[0].repeatRows === 5, sheets[0].freeze);
check('a person\'s own sheet is seven columns wide',
  sheets[2].widths.length === 7 && sheets[2].rows[2].length === 7, sheets[2].widths);

/* ---- the walls ---- */
const headRow = sheets[0].rows[4];                       // the column headers
const styles = headRow.map(c => (c && c.s) || '');
check('each block opens with a heavy left wall and closes with a right one',
  styles[1] === 'colHdr|BL' && styles[6] === 'colHdr|BR' && styles[7] === 'gap'
    && styles[8] === 'colHdr|BL', styles.slice(0, 10));
check('a lane of its own sits between two people',
  sheets[0].widths[7] === 1.2 && sheets[0].rows[5][7].s === 'gap', sheets[0].widths.slice(0, 9));
const nameBand = sheets[0].rows[2];
check('the employee name sits on a dark band, walled and merged',
  nameBand[1].v === 'Zafar Khan' && /empBand/.test(nameBand[1].s) && /L/.test(nameBand[1].s)
    && sheets[0].merges.indexOf('B3:G3') > -1, { s: nameBand[1].s, merges: sheets[0].merges.slice(0, 4) });

/* ---- what the cells say ---- */
const holRow = sheets[0].rows.find(r => r[0] && /Oct 02/.test(r[0].v));
check('a holiday is written across the block, once',
  /Gandhi Jayanti/.test(holRow[1].v) && /holiday/.test(holRow[1].s), holRow[1]);
const monRow = sheets[0].rows.find(r => r[0] && /Oct 05/.test(r[0].v));
check('a late arrival keeps its colour', /late/.test(monRow[1].s), monRow[1]);
check('work from home is written across its block',
  /Work from home/.test(monRow[15].v) && /wfh/.test(monRow[15].s), monRow[15]);
const absRow = sheets[0].rows.find(r => r[0] && /Oct 01/.test(r[0].v));
check('an absence is called an absence', /Absent/.test(absRow[15].v) && /alert/.test(absRow[15].s), absRow[15]);

/* ---- the summary ---- */
const sum = sheets[1];
check('the summary heads its columns and holds a row per person',
  sum.rows[1][0].v === 'Employee' && sum.rows.length === 2 + EMPS.length
    && sum.rows[2][0].v === 'Zafar Khan', sum.rows[1].map(c => c.v));
check('and counts what it found',
  sum.rows[2][3].v === '2' && sum.rows[4][9].v === '1', { days: sum.rows[2][3].v, absent: sum.rows[4][9].v });

/* ---- the file itself ---- */
const parts = [];
ctx.Blob = class { constructor(p) { parts.push(...p); } };
vm.runInContext('var __blobOut = buildStyledXlsxMulti(__sheets);', Object.assign(ctx, { __sheets: sheets }));
const zipped = Buffer.concat(parts.map(p => Buffer.from(p.buffer ? p : p)));

/* read it back the way a spreadsheet would */
function entries(buf) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no end-of-archive record: not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30);
    const commLen = buf.readUInt16LE(off + 32), local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString();
    const lN = buf.readUInt16LE(local + 26), lE = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lN + lE, local + 30 + lN + lE + compSize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    off += 46 + nameLen + extraLen + commLen;
  }
  return out;
}
const zip = entries(zipped);
const names = Object.keys(zip);
check('the file is a zip holding a workbook, styles and every sheet',
  names.indexOf('xl/workbook.xml') > -1 && names.indexOf('xl/styles.xml') > -1
    && names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length === sheets.length, names);

const wb = zip['xl/workbook.xml'].toString();
const wbr = zip['xl/_rels/workbook.xml.rels'].toString();
check('every sheet is named in the workbook and has a relationship to its file',
  sheets.every(sh => wb.indexOf('name="' + sh.name.replace(/&/g, '&amp;') + '"') > -1)
    && (wbr.match(/worksheets\/sheet\d+\.xml/g) || []).length === sheets.length,
  wb.slice(0, 400));
check('styles are related too, or Excel opens the file without any colour',
  /Target="styles\.xml"/.test(wbr), wbr);

const styleXml = zip['xl/styles.xml'].toString();
const xfCount = parseInt((/<cellXfs count="(\d+)"/.exec(styleXml) || [])[1], 10);
const xfActual = (styleXml.match(/<xf /g) || []).length - (styleXml.match(/<cellStyleXfs[^>]*>\s*<xf /g) || []).length;
check('the style table declares as many entries as it holds',
  xfCount === ctx.XLKEYS.length * ctx.XL_EDGES.length + 1, { declared: xfCount });
const borderCount = parseInt((/<borders count="(\d+)"/.exec(styleXml) || [])[1], 10);
check('a border exists for every combination of heavy edges',
  borderCount === ctx.XL_EDGES.length + 1
    && (styleXml.match(/<border>/g) || []).length === ctx.XL_EDGES.length, { declared: borderCount });
check('the heavy rule is a medium dark line, the rest hairline',
  /style="medium"><color rgb="FF334155"/.test(styleXml) && /style="thin"><color rgb="FFC9CFD8"/.test(styleXml));

const sheet1 = zip['xl/worksheets/sheet1.xml'].toString();
check('the wide sheet freezes its panes',
  /<pane xSplit="1" ySplit="5" topLeftCell="B6"[^>]*state="frozen"/.test(sheet1), sheet1.slice(0, 500));
check('and is set up to print landscape, fitted to the page width',
  /<pageSetup orientation="landscape"[^>]*fitToWidth="1"/.test(sheet1) && /fitToPage="1"/.test(sheet1));
check('its parts come in the order a spreadsheet insists on',
  sheet1.indexOf('<sheetPr>') < sheet1.indexOf('<sheetViews>')
    && sheet1.indexOf('<sheetViews>') < sheet1.indexOf('<cols>')
    && sheet1.indexOf('<cols>') < sheet1.indexOf('<sheetData>')
    && sheet1.indexOf('<sheetData>') < sheet1.indexOf('<mergeCells')
    && sheet1.indexOf('<mergeCells') < sheet1.indexOf('<pageMargins'));
check('every style a cell names exists in the table',
  (sheet1.match(/ s="(\d+)"/g) || []).every(m => parseInt(m.slice(4, -1), 10) < xfCount));
check('the header rows repeat on every printed page',
  /_xlnm\.Print_Titles/.test(wb) && /\$1:\$5/.test(wb), wb.slice(wb.indexOf('definedNames'), wb.indexOf('definedNames') + 300));

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
