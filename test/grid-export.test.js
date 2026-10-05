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
  getLateExcuse: (e, d) => (e === 'Zafar Khan' && d === '2026-10-05')
    ? { note: 'client meeting ran over', at: '2026-10-05T04:00:00Z' } : null,
  getEarlyExcuse: (e, d) => (e === 'Rahul Mishra' && d === '2026-10-05')
    ? { note: '', at: '2026-10-05T04:00:00Z' } : null,
  getMispunch: () => null,
  isLate: (e, r) => !!(r && r['in'] && r['in'] >= '9:40'),
  isEarly: () => false,
  computeDurations: r => ({ totalMin: r && r.dur ? 544 : null, inMin: 540, outMin: 4 }),
  workedMinutes: (e, d) => (e === 'Zafar Khan' && d === '2026-10-03') ? 240
    : ((RECS[e + '|' + d] && RECS[e + '|' + d].dur) ? 544 : 0),
  /* 3 October is a Saturday and a full day off here, so it asks for nothing and
     everything worked on it counts as given over. */
  owedMinutes: (e, d) => (new Date(d + 'T00:00:00').getDay() === 6 ? 0 : 540),
  /* Zafar and Rahul have Saturday off - Zafar came in on one anyway, Rahul did
     not. karan is due in on Saturdays, so one he works is simply attendance. */
  getSatPolicy: e => ({ mode: e === 'karan Ahuja' ? 'FULL' : 'OFF', hours: 4 }),
  wfhCellDuration: () => '9:00',
  hdMark: () => '',
  fmtTime: t => t || '',
  fmtMin: m => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'),
  monthLabel: ym => 'October 2026',
  monthLabelShort: ym => 'Oct 2026',
  weekdayName: d => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(d + 'T00:00:00').getDay()],
  pad2: n => String(n).padStart(2, '0'),
  /* Two weeks in the stand-in month: the first ran 90 minutes over, the second
     45 minutes under. Netted off that is 45 minutes to the good, which is not
     at all the same as two steady weeks - which is why the sheet states the two
     apart. */
  mondayOf: d => (d <= '2026-10-04' ? '2026-09-28' : '2026-10-05'),
  computeWeeklyShortHours: () => ({ weekTotals: { '2026-09-28': 90, '2026-10-05': -45 },
                                    weekDays: { '2026-09-28': 5, '2026-10-05': 5 }, weekOpen: {} }),
  dispName: n => n,
  /* The Dashboard page's own reckoning, stood in for: the sheet is tested on
     what it does with the figures, not on how they are arrived at. */
  /* owedMin is what the days asked for - the figure the hours are measured
     against. 1080 minutes is two nine-hour days. */
  computeEmployeeStats: name => ({
    'Zafar Khan':   { owedMin: 1080, attendancePct: 96, onTimePct: 90, workedMin: 1088, presentDays: 2, absentDays: 0,
                      lateDays: 1, totalLateMin: 13, earlyDays: 0, totalEarlyMin: 0, wfhDays: 0,
                      visitDays: 0, leaveDays: 0, netMin: 45, extraDays: 1, extraMin: 230 },
    'Rahul Mishra': { owedMin: 1080, attendancePct: 80, onTimePct: 60, workedMin: 1088, presentDays: 2, absentDays: 0,
                      lateDays: 2, totalLateMin: 44, earlyDays: 1, totalEarlyMin: 20, wfhDays: 0,
                      visitDays: 0, leaveDays: 1, netMin: -90 },
    'karan Ahuja':  { owedMin: 1080, attendancePct: 50, onTimePct: 40, workedMin: 480, presentDays: 2, absentDays: 1,
                      lateDays: 0, totalLateMin: 0, earlyDays: 0, totalEarlyMin: 0, wfhDays: 2,
                      visitDays: 0, leaveDays: 0, netMin: 0 }
  }[name]),
  perfScore: st => Math.round(0.6 * st.attendancePct + 0.4 * st.onTimePct)
};
vm.createContext(ctx);

/* the palette, the edge table and the number formats are plain declarations */
[/ {2}var XLF = \{[\s\S]*?\n {2}\};/, / {2}var XL_EDGES = \[[^\]]*\];/,
 / {2}var XL_FMTS = \[[^\]]*\];/, / {2}var XL_FMT_ID = \{[^}]*\};/
].forEach(re => vm.runInContext(re.exec(src)[0], ctx));
vm.runInContext('var XLKEYS = Object.keys(XLF);', ctx);
/* the CRC table the zip writer leans on */
vm.runInContext(/var _CRC=\(function\(\)[\s\S]*?\}\)\(\);/.exec(src)[0], ctx);
['_colLetter', '_refParts', '_commentsXml', '_vmlXml',
 '_xesc', '_safeSheetName', 'xlEdgeIdx', 'xlStyleIdx', '_stylesXml', '_sheetXmlStyled',
 '_crc32', '_zipStore', 'buildStyledXlsxMulti', 'gridDayCells', 'gridWeekVerdict', 'gridDateLabel',
 'gridAllSheet', 'gridWeekSummary', 'gridPerformanceSheet', 'buildGridWorkbook'
].forEach(n => vm.runInContext(lift(src, n), ctx));
vm.runInContext('var GRID_COLS = ' + JSON.stringify(['IN', 'OUT', 'TOTAL', 'IN DUR', 'OUT DUR', 'PUN']) + ';', ctx);

const sheets = ctx.buildGridWorkbook();

/* ---- the shape of the workbook ---- */
check('two sheets: everyone side by side, and how they did',
  sheets.length === 2 && sheets[0].name === 'All employees' && sheets[1].name === 'Performance',
  sheets.map(s => s.name));
check('and none of its own for any one person',
  !sheets.some(s => EMPS.some(e => e.name === s.name)), sheets.map(s => s.name));
check('the wide sheet freezes the date column and the headers',
  sheets[0].freeze.col === 1 && sheets[0].freeze.row === 5 && sheets[0].repeatRows === 5, sheets[0].freeze);



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

/* ---- why a lateness was let pass ---- */
{
  const wide = sheets[0];
  const notes = wide.notes || [];
  const late = notes.find(n => /Late, excused/.test(n.title));
  check('an excused lateness is noted on the cell it explains',
    !!late && /client meeting ran over/.test(late.text), notes);
  /* The in time is the first column of a block, so the note belongs on it. */
  const monRow = wide.rows.findIndex(r => r[0] && /Oct 05/.test(r[0].v || ''));
  check('and the note sits on the in time, not somewhere near it',
    !!late && late.ref === 'B' + (monRow + 1), { ref: late && late.ref, row: monRow + 1 });
  const early = notes.find(n => /Left early, excused/.test(n.title));
  check('an excuse with nothing written down still says so',
    !!early && /No reason was written down/.test(early.text), early);
  check('and sits on the out time of the person it belongs to',
    !!early && early.ref === 'J' + (monRow + 1), early && early.ref);
  check('a day nobody excused carries no note',
    notes.every(n => n.ref !== 'B' + (wide.rows.findIndex(r => r[0] && /Oct 01/.test(r[0].v || '')) + 1)),
    notes.map(n => n.ref));
}

/* ---- how people did: the one sheet of figures ---- */
const sum = sheets[1];
const headCells = sum.rows[1].map(c => c.v);
const col = name => headCells.indexOf(name);
/* The title and the "working from home" line are single merged cells; the
   header and one row a person are the full width. */
check('it heads its columns and holds a row per person',
  headCells[0] === 'Employee'
    && sum.rows.filter(r => r.length > 1).length === 1 + EMPS.length,
  sum.rows.map(r => r.length));
check('and carries what the summary sheet used to',
  ['Shift', 'Weeks completed', 'Hours worked', 'Late days', 'Early-leave days',
   'Leave days', 'Days from home', 'Days visiting'].every(h => col(h) > -1), headCells);
check('every heading says what it holds, with no bare words left',
  headCells.every(h => !['Score', 'Weeks', 'Worked', 'Present', 'Late', 'Early',
                         'WFH', 'Visits', 'Leave'].includes(h)), headCells);
check('the shift is stated beside the name',
  sum.rows[2][col('Shift')].v === '9:30-6:30', sum.rows[2][col('Shift')]);
const weekCell = sum.rows[2][col('Weeks completed')];
check('how the weeks went is stated, and coloured by the worst of them',
  /1 of 2 not completed/.test(weekCell.v) && weekCell.s === 'bad', weekCell);

{
  const p = sum, ph = headCells, at = col;
  check('and ranks them, best first',
    p.rows[2][0].v === 'Zafar Khan' && p.rows[3][0].v === 'Rahul Mishra',
    p.rows.slice(2).map(r => r[0].v + ':' + (r[at('Score /100')] || {}).n));

  /* Somebody whose every day in was a day at home has no punches behind the
     figures, so they are set out under a line of their own rather than ranked
     against people the machines measured. */
  const bandRow = p.rows.findIndex(r => r.length === 1 && /Working from home/.test(r[0].v || ''));
  check('those working from home are set apart, under a line that says why',
    bandRow > -1 && /not read off the punch machines/.test(p.rows[bandRow][0].v),
    bandRow > -1 ? p.rows[bandRow][0].v : p.rows.map(r => r.length));
  check('and they come after the people who were measured',
    p.rows[bandRow + 1][0].v === 'karan Ahuja'
      && p.rows.slice(2, bandRow).every(r => r[0].v !== 'karan Ahuja'),
    p.rows.map(r => r[0].v));
  check('a person the machines did measure stays above that line',
    p.rows.slice(2, bandRow).some(r => r[0].v === 'Zafar Khan'), bandRow);
  check('the line spans the sheet, so it reads as a heading',
    p.merges.some(m => m.indexOf('A' + (bandRow + 1) + ':') === 0), p.merges);
  check('and each block gets its own bars, so the band is not barred',
    p.bars.length === 4
      && p.bars.every(b => !/:[A-Z]+' + (bandRow + 1)/.test(b.ref)),
    p.bars.map(b => b.ref));
  /* Rows move as blocks are added, so look people up by name. */
  const who = n => p.rows.find(r => r.length > 1 && r[0].v === n);
  const zafar = who('Zafar Khan'), rahul = who('Rahul Mishra'), karan = who('karan Ahuja');
  check('the score is a figure, coloured by the band it falls in',
    typeof zafar[at('Score /100')].n === 'number' && zafar[at('Score /100')].s === 'ok'
      && karan[at('Score /100')].s === 'bad',
    [zafar, rahul, karan].map(r => r[at('Score /100')].n + '=' + r[at('Score /100')].s));
  check('percentages go in as percentages, not as the word',
    Math.abs(zafar[at('Attendance %')].n - 0.96) < 1e-9
      && /\|p$/.test(zafar[at('Attendance %')].s), zafar[at('Attendance %')]);
  check('spans of time go in as spans',
    Math.abs(zafar[at('Hours worked')].n - 1088 / 1440) < 1e-9
      && /\|t$/.test(zafar[at('Hours worked')].s), zafar[at('Hours worked')]);
  check('counts go in as counts, so they can be totalled',
    typeof zafar[at('Days present')].n === 'number' && karan[at('Leave days')].n === 0,
    { present: zafar[at('Days present')], leave: karan[at('Leave days')] });
  /* Absent is never marked here - a day missed is recorded as leave - so the
     column said nothing and has gone. */
  check('there is no column for absences', at('Absent') === -1 && at('Days absent') === -1, ph);
  check('what the days asked for stands beside what was put in',
    at('Target hours') === at('Hours worked') - 1
      && Math.abs(zafar[at('Target hours')].n - 1080 / 1440) < 1e-9,
    { target: zafar[at('Target hours')], worked: zafar[at('Hours worked')] });
  /* The style is a fill and a number format; it is the fill that carries the
     verdict. */
  const fillOf = c => String(c.s).split('|')[0];
  check('and the hours colour themselves against that target',
    fillOf(zafar[at('Hours worked')]) === 'ok' && fillOf(karan[at('Hours worked')]) === 'bad',
    { met: zafar[at('Hours worked')].s, short: karan[at('Hours worked')].s });
  /* A Saturday worked, a weekly off come in on: time given over and above what
     the days asked for. */
  check('time worked on days that asked for none is shown, and shown in green',
    zafar[at('Days worked on offs')].n === 1 && zafar[at('Days worked on offs')].s === 'ok'
      && Math.abs(zafar[at('Extra hours')].n - 230 / 1440) < 1e-9
      && /^ok\|\|t$/.test(zafar[at('Extra hours')].s),
    { days: zafar[at('Days worked on offs')], time: zafar[at('Extra hours')] });
  check('a Saturday worked is counted on its own, with what it gave past target',
    zafar[at('Saturdays worked')].n === 1
      && Math.abs(zafar[at('Saturday extra')].n - 240 / 1440) < 1e-9
      && String(zafar[at('Saturday extra')].s).split('|')[0] === 'ok',
    { days: zafar[at('Saturdays worked')], extra: zafar[at('Saturday extra')] });
  /* A Saturday given up is worth marking; a Saturday you are due in on is not. */
  check('a worked Saturday reads green only where Saturday was theirs to keep',
    zafar[at('Saturdays worked')].s === 'ok', zafar[at('Saturdays worked')]);
  check('somebody whose Saturday is off and who worked none is told so, not nought',
    rahul[at('Saturdays worked')].v === 'Saturday off'
      && rahul[at('Saturdays worked')].n === undefined, rahul[at('Saturdays worked')]);
  check('and somebody due in on Saturdays who worked none stands at nought',
    karan[at('Saturdays worked')].n === 0
      && String(karan[at('Saturday extra')].s).split('|')[0] !== 'ok',
    { days: karan[at('Saturdays worked')], extra: karan[at('Saturday extra')] });
  check('and left plain for somebody who worked none',
    karan[at('Days worked on offs')].n === 0 && karan[at('Days worked on offs')].s !== 'ok',
    karan[at('Days worked on offs')]);
  /* The net of over and short used to close the row; Weekly extra and Weekly
     short say the same thing and say which way round it was. */
  check('there is no netted hours-vs-target column any more',
    at('Hours vs target') === -1 && ph[ph.length - 1] === 'Leave days', ph);
  check('and the last column still closes the row off',
    /\|R$/.test(zafar[ph.length - 1].s), zafar[ph.length - 1]);
  check('a lateness and a day from home each keep their colour',
    rahul[at('Late days')].s === 'late' && karan[at('Days from home')].s === 'wfh',
    { late: rahul[at('Late days')].s, wfh: karan[at('Days from home')].s });
  check('with a bar along the score and another along the hours worked',
    p.bars[0].ref === 'C3:C4' && p.bars[1].ref === 'I3:I4', p.bars.map(b => b.ref));
  /* What the weeks ran short by. The hours they ran over are said by the
     extra-hours and Saturday columns, so the weeks only report the shortfall. */
  check('the weeks say what they ran short by',
    at('Weekly short') > -1 && Math.abs(zafar[at('Weekly short')].n - 45 / 1440) < 1e-9
      && /\|t$/.test(zafar[at('Weekly short')].s), ph);
  check('and it reads red where there is any',
    String(zafar[at('Weekly short')].s).split('|')[0] === 'bad',
    zafar[at('Weekly short')].s);
  check('with no column for the hours they ran over',
    at('Weekly extra') === -1, ph);
}
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
  xfCount === ctx.XLKEYS.length * ctx.XL_EDGES.length * ctx.XL_FMTS.length + 1, { declared: xfCount });
check('and an hours-and-minutes format for the figures that need one',
  /<numFmt numFmtId="164" formatCode="\[h\]:mm"\/>/.test(styleXml));
const borderCount = parseInt((/<borders count="(\d+)"/.exec(styleXml) || [])[1], 10);
check('a border exists for every combination of heavy edges',
  borderCount === ctx.XL_EDGES.length + 1
    && (styleXml.match(/<border>/g) || []).length === ctx.XL_EDGES.length, { declared: borderCount });
check('the heavy rule is a medium dark line, the rest hairline',
  /style="medium"><color rgb="FF334155"/.test(styleXml) && /style="thin"><color rgb="FFC9CFD8"/.test(styleXml));

const names2 = Object.keys(zip);
check('a sheet with notes brings the three parts a note needs',
  names2.indexOf('xl/comments1.xml') > -1
    && names2.indexOf('xl/drawings/vmlDrawing1.vml') > -1
    && names2.indexOf('xl/worksheets/_rels/sheet1.xml.rels') > -1, names2);
check('the notes are declared in the content types, vml and all',
  /Extension="vml"/.test(zip['[Content_Types].xml'].toString())
    && /comments1\.xml/.test(zip['[Content_Types].xml'].toString()),
  zip['[Content_Types].xml'].toString().slice(0, 400));
const cmt = zip['xl/comments1.xml'].toString();
check('and the text of the excuse is in them',
  /client meeting ran over/.test(cmt) && /<comment ref="B\d+"/.test(cmt), cmt.slice(0, 400));
const vml = zip['xl/drawings/vmlDrawing1.vml'].toString();
check('with a shape to draw each one, anchored to its cell',
  /ObjectType="Note"/.test(vml)
    && (vml.match(/<v:shape /g) || []).length === (sheets[0].notes || []).length, vml.slice(0, 200));

const sheet1 = zip['xl/worksheets/sheet1.xml'].toString();
check('the wide sheet freezes its panes',
  /<pane xSplit="1" ySplit="5" topLeftCell="B6"[^>]*state="frozen"/.test(sheet1), sheet1.slice(0, 500));
check('and is set up to print landscape, fitted to the page width',
  /<pageSetup orientation="landscape"[^>]*fitToWidth="1"/.test(sheet1) && /fitToPage="1"/.test(sheet1));
check('the sheet points at the shape that draws its notes, last of all',
  /<legacyDrawing r:id="rId1"\/><\/worksheet>$/.test(sheet1)
    && /xmlns:r=/.test(sheet1), sheet1.slice(-200));
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
