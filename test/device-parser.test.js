// The office PC sends punches parsed by the dashboard's own import code, lifted
// out of src/attendance.html at run time. This fails if a rename or an edit
// ever stops that from working, and checks it reads a file as the dashboard does.
'use strict';
const path = require('path');
const { load, lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

// The builder's column layout, made-up people.
const csv = '﻿"Date"," Employee Code ","Employee Name","Company ","Department","Category ","Degination","Grade","Team","Shift"," In Time ","Out Time "," Duration ","Late By ","Early By ","Status ","Punch Records ","Overtime"\r\n'
  + '"9/14/2026","D01","Asha Demo","Default","Default","9:30-6:30","","","","GS","9:35","18:32","8:12","0:05","0:00","Present ","09:35:in(IN) 13:05:out(OUT) 13:40:in(IN) 18:32:out(OUT) ","0:00"\r\n'
  + '"9/14/2026","D02","Ravi, Jr.","Default","Default","9:30-6:30","","","","GS","10:02","","0:00","0:32","0:00","Present (No OutPunch)","10:02:in(IN) ","0:00"\r\n'
  + '"8/31/2026","D01","Asha Demo","Default","Default","9:30-6:30","","","","GS","","","0:00","0:00","0:00","Absent ","","0:00"\r\n'
  + '"not a date","D03","Nobody","Default","Default","","","","","","","","","","","Present ","","0:00"\r\n';

let parser = null;
try { parser = load(); check('dashboard import functions load', true); }
catch (e) { check('dashboard import functions load', false, e.message); }

if (parser) {
  const p = parser.parse(csv);
  const asha = p.records.find(r => r.e === 'Asha Demo' && r.d === '2026-09-14');
  const ravi = p.records.find(r => r.e === 'Ravi, Jr.');
  check('3 real rows, the bad date skipped', p.records.length === 3 && !p.records.some(r => r.e === 'Nobody'), p.records.map(r => r.e + ' ' + r.d));
  check('M/d/yyyy read as the builder writes it', !!asha && !!p.records.find(r => r.d === '2026-08-31'));
  // c and re are the dashboard's own counts for that punch string (one re-entry here).
  check('times, status and punch counts as the dashboard stores them', asha && asha.in === '9:35' && asha.out === '18:32' && asha.st === 'PR' && asha.c === 1 && asha.re === 1 && /13:40:in/.test(asha.praw), asha);
  check('quoted name with a comma kept whole', !!ravi && ravi.no_out === 1, ravi);
  check('employees with code and shift', p.employees['Asha Demo'] && p.employees['Asha Demo'].code === 'D01' && p.employees['Asha Demo'].shift === '9:30-6:30', p.employees);
  check('no Mark column, so no marks touched', p.overrides === null);
}
// The extractor asks the parser where a function ends, so regexes and division cannot confuse it.
const tricky = "var x = 1; function t(a){ var re = /[}{]/g; var h = a / 2 / 1; var s = '}'; return String(a).replace(re, '') + h + s; } function after(){}";
check('extractor ends a function at its real closing brace', lift(tricky, 't').endsWith("+ h + s; }"), lift(tricky, 't'));

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
