/* What is in the workbook, said by name.
 *
 * The monthly message described the attachment instead of naming it: "one
 * sheet with everybody side by side, and one saying how they did over the
 * month". A sentence about two sheets, in a workbook that carries three - and
 * carrying none of the names somebody would be looking for once they opened
 * it.
 *
 * The count is not fixed either. The performance reckoning and the leave
 * ledger are each built inside a try of their own, so a month that cannot
 * reckon one of them goes out with fewer tabs than the sentence promised.
 *
 * So the page that builds the workbook says what went into it, and the
 * message reads the names off that.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const said = names => {
  const t = strip(mailer.monthEmail({
    orgName: 'AllyConnect Pvt. Ltd.', monthLabel: 'October 2026',
    shown: 10, hidden: 2, days: 31, intro: '', footer: '',
    fileName: 'Attendance_Grid_2026-10.xlsx', sheetNames: names
  }).html);
  return t.slice(t.indexOf('Attendance_Grid'), t.indexOf('Attendance_Grid') + 160);
};

/* ---- the names, and the right number of them ---- */
check('all three are named',
  /three sheets: All employees, Performance and Leave record\./
    .test(said(['All employees', 'Performance', 'Leave record'])),
  said(['All employees', 'Performance', 'Leave record']));
check('two are two, not three',
  /two sheets: All employees and Performance\./.test(said(['All employees', 'Performance'])),
  said(['All employees', 'Performance']));
check('one is a sheet, not sheets',
  /one sheet: All employees\./.test(said(['All employees'])), said(['All employees']));
check('and past three it still counts them',
  /4 sheets: A, B, C and D\./.test(said(['A', 'B', 'C', 'D'])), said(['A', 'B', 'C', 'D']));
/* Blank and missing names are not sheets. */
check('an empty name is not counted',
  /two sheets: A and B\./.test(said(['A', '', '  ', 'B'])), said(['A', '', '  ', 'B']));
/* A caller that says nothing about the file cannot have it named, so the
   words it had before stand rather than a sentence with a hole in it. */
check('nothing passed falls back to the words it had',
  /one sheet with everybody side by side/.test(said(null)), said(null));
check('and so does an empty list',
  /one sheet with everybody side by side/.test(said([])), said([]));
check('the file is still named in every case',
  [null, [], ['A'], ['A', 'B']].every(n => /Attendance_Grid_2026-10\.xlsx/.test(said(n))), null);

/* ---- carried from the one place that knows ---- */
check('the page says which sheets it put in',
  /if\(sheets\) facts\.sheetNames = sheets\.map\(function\(sh\)\{ return sh\.name; \}\);/.test(APP),
  null);
check('read off the workbook rather than written beside it',
  APP.indexOf('facts.sheetNames = sheets.map') > APP.indexOf('var sheets = buildGridWorkbook();'),
  null);
check('the server carries it through, and only a list',
  /sheetNames: Array\.isArray\(body\.sheetNames\) \? body\.sheetNames : null,/.test(SRV), null);
check('and hands it to the message',
  /sheetNames: fileSent \? opts\.sheetNames : null,/.test(SRV), null);
/* A message that describes an attachment nobody was sent describes nothing. */
check('nothing is named when no file goes',
  /sheetNames: fileSent \?/.test(SRV), null);

/* The three the workbook actually builds, so the names in the message are the
   names on the tabs rather than a second list that can drift. */
check('the workbook builds the three sheets these names come from',
  /return \{ name:'All employees'/.test(APP)
  && /return \{ name:'Performance'/.test(APP)
  && /return \{ name:'Leave record'/.test(APP), null);
check('and the two that can be left out are each in a try of their own',
  /try\{ sheets\.push\(gridPerformanceSheet\(/.test(APP)
  && /var lv = gridLeaveSheet\(/.test(APP), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
