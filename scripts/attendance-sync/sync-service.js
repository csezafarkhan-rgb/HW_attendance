/*
    A small listener on this PC so the dashboard's Sync button can actually
    fetch from the punch readers.

    The dashboard is a web page served from Render. It cannot run a program on
    this machine and it cannot open a socket to a reader on the office LAN, so
    on its own "Sync" could only ever re-read whatever file was last written -
    which is what it did, and why it kept saying "Nothing newer".

    This closes that gap. It listens on 127.0.0.1 only, and answers one request:
    GET /sync runs Build-AttendanceCsv.ps1, which reads the two readers and the
    eTimeTrackLite database and rewrites the CSV in the watched folder. The page
    then picks that file up the way it always has.

    Notes on the shape of it:

      * Bound to 127.0.0.1, so nothing off this machine can reach it. A page
        served over https may still call http://127.0.0.1 - browsers treat
        loopback as trustworthy - so no certificate is needed.
      * It takes no input. There is one action, on a fixed script, and nothing
        from the request reaches a shell.
      * Reading the readers takes the better part of a minute, so a second
        request while one is running joins the first rather than starting
        another.
*/
'use strict';

const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 8765;
const HERE = __dirname;
const SCRIPT = path.join(HERE, 'Build-AttendanceCsv.ps1');

// Only the dashboard, and a local copy of it for testing.
const ALLOWED = [
  'https://hw-attendance-6qwd.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

let running = null;          // the in-flight rebuild, if any

/*  Live Sync asks for a quick build: a fortnight rebuilt instead of thirty
    days, and the readers skipped only when they were read under eight minutes
    ago. (Freshness in eSSL's database is no longer taken as proof there is
    nothing to fetch: one of the two readers stopped feeding it in September,
    so a recent punch there says nothing about the other one's in-punches.) A reader answers one session at a time, so
    asking it every five minutes would crowd out eSSL's own downloader (which
    is how a reader stopped feeding the database in September); every eight
    leaves it room while keeping an arrival on screen within minutes, and the
    rebuild in between still picks up whatever the downloader has put in.
    A pressed Sync ignores all of this and reads the readers there and then.

    The dashboard can ask for a different window: /sync?quick=1&days=15 rebuilds
    the last fifteen days and asks the readers for the same fifteen. Asking a
    reader for more days costs nothing - it hands over its whole log either way
    and the filtering happens here - so the window is only about how far back
    the file is rewritten. That is what brings a day back when its punches
    arrive late, as 16 September's did. */
const QUICK = { days: '14', pullDays: '14', pullTimeout: '120000', skipPullMin: '0', pulledWithin: '8' };
const FULL  = { days: '30', pullDays: '30', pullTimeout: '180000', skipPullMin: '0', pulledWithin: '0' };
const MAX_DAYS = 60;

function rebuild(quick, days, force) {
  if (running) return running;               // one at a time; latecomers join it
  const mode = Object.assign({}, quick ? QUICK : FULL);
  /*  Someone pressed Sync. Then the readers are read, whatever was read a
      moment ago: that press means "show me what the machine has now", and
      somebody standing at the desk after punching in is the whole point of it.
      The five-minute automatic check is the one that spaces its pulls out. */
  if (force) { mode.skipPullMin = '0'; mode.pulledWithin = '0'; }
  const asked = Math.round(Number(days));
  if (Number.isFinite(asked) && asked >= 1) {
    const d = String(Math.min(MAX_DAYS, asked));
    mode.days = d;
    mode.pullDays = d;
  }
  running = new Promise(resolve => {
    const started = Date.now();
    const child = execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
       '-Days', mode.days, '-PullDays', mode.pullDays, '-PullTimeoutMs', mode.pullTimeout,
       '-SkipPullIfDbFresherThanMin', mode.skipPullMin, '-SkipPullIfPulledWithinMin', mode.pulledWithin],
      { cwd: HERE, windowsHide: true },
      (err, stdout, stderr) => {
        clearTimeout(limit);
        const text = String(stdout || '');
        // The script prints a line per figure; lift the ones worth reporting.
        const pick = re => { const m = text.match(re); return m ? m[1].trim() : null; };
        resolve({
          ok: !err,
          seconds: Math.round((Date.now() - started) / 1000),
          days: Number(mode.days),
          rows: pick(/rows\s*:\s*(\d+)/),
          fromReaders: pick(/straight off the readers:\s*(\d+)/),
          wrote: /written\s*:/.test(text),
          error: err ? String(stderr || err.message).slice(0, 400) : null
        });
      });
    /* Five minutes, then the whole process tree. execFile's own timeout killed
       only this powershell.exe: the 32-bit reader pull it started kept running,
       and a kill during the database read left the temp .mdb copy behind. */
    const limit = setTimeout(() => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    }, 5 * 60 * 1000);
  }).finally(() => { running = null; });
  return running;
}

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  /*  Only requests addressed to this machine by name. A hostile domain that
      resolves to 127.0.0.1 (DNS rebinding) arrives with its own name in Host,
      and would otherwise be able to read what /sync returns. */
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== '127.0.0.1:' + PORT && host !== 'localhost:' + PORT) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'wrong host' }));
  }

  const origin = req.headers.origin || '';
  const allowed = ALLOWED.indexOf(origin) > -1;
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    /*  A page on https calling 127.0.0.1 is not mixed content - loopback counts
        as trustworthy - but Chrome's Private Network Access still preflights it
        and wants the server to say plainly that it accepts a call from a public
        page. Without these it fails before the request is ever made. Said only
        to the dashboard, not to every site that asks. */
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }

  const url = (req.url || '').split('?')[0];

  /*  Rebuilding reads both readers and rewrites the watched file, so only the
      dashboard may ask for it. Any other page could trigger it with a plain
      <img src="http://127.0.0.1:8765/sync"> - which sends no Origin at all. */
  if (url === '/sync' && !allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'not from the dashboard' }));
  }

  if (url === '/ping') {                      // is the helper here at all?
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'hw-attendance-sync' }));
  }

  if (url === '/sync') {
    const q = (req.url || '').split('?')[1] || '';
    const quick = /(^|&)quick=1(&|$)/.test(q);
    const days = (/(^|&)days=(\d{1,3})(&|$)/.exec(q) || [])[2];
    const force = /(^|&)force=1(&|$)/.test(q);
    return rebuild(quick, days, force).then(result => {
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 400) }));
    });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

/*  Another copy is already up. That is the normal case for a task that gets
    re-run every few minutes to make sure the helper is alive, so it is not an
    error - step aside quietly and let the running one carry on. */
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('already running on ' + PORT + '; nothing to do');
    process.exit(0);
  }
  console.error('could not listen on ' + PORT + ':', err && err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('attendance sync helper listening on http://127.0.0.1:' + PORT);
});
