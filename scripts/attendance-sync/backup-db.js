/*
    Nightly copy of the whole database, kept on the office PC.

    The database runs on Render's free plan, which expires, and every other
    backup only ever happened inside someone's browser. This asks the server for
    a full copy (GET /api/device/backup, the same token as push-attendance.js)
    and keeps the last 30 days as dated .json.gz files in db-backups under the
    data folder - outside the repository, because they hold everything.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = process.env.HW_DATA_DIR || 'E:\\Drive H- Desktop\\ZAFAR LISTING\\AI Projects\\Attendance backup';
const SITE = process.env.HW_SITE || 'https://hw-attendance-6qwd.onrender.com';
const TOKEN_FILE = process.env.HW_TOKEN_FILE || path.join(DATA_DIR, 'sync-token.txt');
const DIR = path.join(DATA_DIR, 'db-backups');
const KEEP = 30;
const LOG = path.join(DATA_DIR, 'push-log.txt');

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function logLine(text) {
  const line = stamp() + '  backup: ' + text;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\r\n'); } catch (e) {}
}

async function main() {
  if (!fs.existsSync(TOKEN_FILE)) return logLine('skipped: no sync-token.txt in the data folder');
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(SITE + '/api/device/backup', { headers: { authorization: 'Bearer ' + token }, signal: controller.signal });
    if (!res.ok) return logLine('failed: server answered ' + res.status);
    const gz = Buffer.from(await res.arrayBuffer());
    const dump = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));        // prove it is whole before keeping it
    if (dump._type !== 'hw-attendance-db-backup') return logLine('failed: not a backup');
    fs.mkdirSync(DIR, { recursive: true });
    const name = 'hw-attendance-' + dump.exportedAt.slice(0, 10) + '.json.gz';
    const tmp = path.join(DIR, name + '.partial');
    fs.writeFileSync(tmp, gz);
    fs.renameSync(tmp, path.join(DIR, name));
    const old = fs.readdirSync(DIR).filter(f => /^hw-attendance-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
    old.slice(0, Math.max(0, old.length - KEEP)).forEach(f => fs.unlinkSync(path.join(DIR, f)));
    logLine('saved ' + name + ' (' + dump.records.length + ' records, ' + dump.users.length + ' accounts, '
      + Math.round(gz.length / 1024) + ' KB)');
  } catch (e) {
    logLine('failed: ' + (e.name === 'AbortError' ? 'no answer within 3 minutes' : e.message));
  } finally {
    clearTimeout(timer);
  }
}

main();
