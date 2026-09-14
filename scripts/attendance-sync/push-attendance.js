/*
    Send the attendance file the builder just wrote to the server.

    Until this, punches reached the live site only when an admin had the
    dashboard open with the watched folder connected - so the site was as old as
    the last time someone looked. Run after every build (Build-AttendanceCsv.ps1
    calls it), it keeps the site current with nobody signed in.

    It proves itself with the token in sync-token.txt in the data folder, which
    must match SYNC_TOKEN in Render's environment. Without either it says so and
    does nothing. It never exits with an error code: a failed send costs
    freshness, and the next build tries again.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./dashboard-parser');

const DATA_DIR = process.env.HW_DATA_DIR || 'E:\\Drive H- Desktop\\ZAFAR LISTING\\AI Projects\\Attendance backup';
const SITE = process.env.HW_SITE || 'https://hw-attendance.onrender.com';
const CSV = process.env.HW_CSV || path.join(DATA_DIR, '1_Daily Attendace file', 'DailyAttendanceLogsDetails.csv');
const TOKEN_FILE = process.env.HW_TOKEN_FILE || path.join(DATA_DIR, 'sync-token.txt');
const LOG = path.join(DATA_DIR, 'push-log.txt');

function logLine(text) {
  const line = new Date().toISOString().slice(0, 16).replace('T', ' ') + '  ' + text;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\r\n');
    const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length > 400) fs.writeFileSync(LOG, lines.slice(-400).join('\r\n') + '\r\n');
  } catch (e) { /* the log is a convenience */ }
}

async function main() {
  if (!fs.existsSync(TOKEN_FILE)) return logLine('skipped: no sync-token.txt in the data folder');
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (token.length < 32) return logLine('skipped: sync-token.txt is too short to be the real token');
  if (!fs.existsSync(CSV)) return logLine('skipped: no attendance file at ' + CSV);

  let parsed;
  try { parsed = load().parse(fs.readFileSync(CSV, 'utf8')); }
  catch (e) { return logLine('not sent: the file could not be read - ' + e.message); }

  const employees = Object.keys(parsed.employees).map(name => ({
    name, code: parsed.employees[name].code || '', shift: parsed.employees[name].shift || ''
  }));
  let newest = '';
  parsed.records.forEach(r => { if (r.d > newest) newest = r.d; });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);   // a sleeping free-tier server takes a while
  try {
    const res = await fetch(SITE + '/api/device/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ records: parsed.records, employees, newestPunch: newest }),
      signal: controller.signal
    });
    let body = {};
    try { body = await res.json(); } catch (e) {}
    if (res.status === 503 && body.error === 'device_sync_not_configured') {
      return logLine('not sent: SYNC_TOKEN is not set in Render yet');
    }
    if (res.status === 401) return logLine('not sent: the server refused the token - sync-token.txt and SYNC_TOKEN in Render differ');
    if (!res.ok) return logLine('not sent: server answered ' + res.status + ' ' + (body.error || ''));
    logLine('sent rows=' + body.records + ' newPeople=' + body.employeesAdded + ' newestDay=' + newest);
  } catch (e) {
    logLine('not sent: ' + (e.name === 'AbortError' ? 'the server did not answer within 2 minutes' : e.message));
  } finally {
    clearTimeout(timer);
  }
}

main();
