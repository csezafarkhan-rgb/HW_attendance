/*
    The dashboard's own CSV import, usable from Node.

    Punches are sent to the server by the office PC, and they must land exactly
    as they would if someone imported the same file in the dashboard: same date
    reading, same status codes, same punch counts. Rather than write that logic
    a second time and let the two drift apart, the functions are lifted out of
    src/attendance.html when this runs. test/device-push.test.js fails if a
    rename ever breaks that.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const NEEDED = ['pad2', 'parseCSVText', 'findCol', 'detectDateOrder', 'toISODate',
                'computePunchCount', 'computeReentries', 'csvStatusCode', 'parseAttendanceCSV'];

/* The source text of one function declaration, by name. Its end is the first
   closing brace at which the text so far parses as a complete function - asked
   of the JavaScript parser itself, so strings, comments, regexes and division
   can never be mistaken for one another the way a hand-written scan can. */
function lift(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('dashboard function not found: ' + name);
  const limit = Math.min(src.length, start + 200000);
  for (let k = src.indexOf('}', start); k > -1 && k < limit; k = src.indexOf('}', k + 1)) {
    const text = src.slice(start, k + 1);
    try { new vm.Script(text); return text; } catch (e) { /* not complete yet */ }
  }
  throw new Error('dashboard function could not be read: ' + name);
}

function load(dashboardPath) {
  const file = dashboardPath || path.join(__dirname, '..', '..', 'src', 'attendance.html');
  const src = fs.readFileSync(file, 'utf8');
  const month = /var MONTH_NUM\s*=\s*\{[^}]*\};/.exec(src);
  if (!month) throw new Error('dashboard MONTH_NUM not found');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(month[0], ctx);
  NEEDED.forEach(n => vm.runInContext(lift(src, n), ctx));
  return {
    /* {records, employees, overrides} - employees keyed by name, as the dashboard has it. */
    parse: text => ctx.parseAttendanceCSV(String(text).replace(/^﻿/, ''))
  };
}

module.exports = { load, lift };
