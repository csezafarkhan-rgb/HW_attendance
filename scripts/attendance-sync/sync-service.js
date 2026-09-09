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
  'https://hw-attendance.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

let running = null;          // the in-flight rebuild, if any

function rebuild() {
  if (running) return running;               // one at a time; latecomers join it
  running = new Promise(resolve => {
    const started = Date.now();
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Days', '30'],
      { cwd: HERE, timeout: 5 * 60 * 1000, windowsHide: true },
      (err, stdout, stderr) => {
        const text = String(stdout || '');
        // The script prints a line per figure; lift the ones worth reporting.
        const pick = re => { const m = text.match(re); return m ? m[1].trim() : null; };
        resolve({
          ok: !err,
          seconds: Math.round((Date.now() - started) / 1000),
          rows: pick(/rows\s*:\s*(\d+)/),
          fromReaders: pick(/straight off the readers:\s*(\d+)/),
          wrote: /written\s*:/.test(text),
          error: err ? String(stderr || err.message).slice(0, 400) : null
        });
      });
  }).finally(() => { running = null; });
  return running;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED.indexOf(origin) > -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cache-Control', 'no-store');

  /*  A page on https calling 127.0.0.1 is not mixed content - loopback counts
      as trustworthy - but Chrome's Private Network Access still preflights it
      and wants the server to say plainly that it accepts a call from a public
      page. Without these it fails before the request is ever made. */
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = (req.url || '').split('?')[0];

  if (url === '/ping') {                      // is the helper here at all?
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'hw-attendance-sync' }));
  }

  if (url === '/sync') {
    return rebuild().then(result => {
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
