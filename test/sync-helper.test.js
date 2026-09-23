// The office-PC helper's access rules, on a copy listening on a spare port with
// a stand-in build script, so a real helper and the real build are untouched.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const PORT = 8766;
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'sync-service.js'), 'utf8')
  .replace('const PORT = 8765;', 'const PORT = ' + PORT + ';');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-sync-test-'));
fs.writeFileSync(path.join(dir, 'sync-service.js'), src);
fs.writeFileSync(path.join(dir, 'Build-AttendanceCsv.ps1'),
  "Write-Output 'rows                : 7  (2 people)'\nWrite-Output '  straight off the readers: 3 punch(es)'\nWrite-Output 'written             : x'\n");

function req(method, pathName, headers) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: pathName, headers }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', e => resolve({ status: 0, body: String(e) }));
    r.end();
  });
}
const results = [];
const check = (name, ok, got) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got))); };
const DASH = 'https://hw-attendance-6qwd.onrender.com';
const H = { host: '127.0.0.1:' + PORT };

(async () => {
  const child = spawn(process.execPath, [path.join(dir, 'sync-service.js')], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  try {
    let r = await req('GET', '/ping', Object.assign({ origin: DASH }, H));
    check('dashboard ping ok, CORS + PNA headers for it', r.status === 200 && r.headers['access-control-allow-origin'] === DASH && r.headers['access-control-allow-private-network'] === 'true', r.status);
    r = await req('GET', '/sync', H);
    check('/sync with no Origin (img drive-by) refused', r.status === 403, r.status);
    r = await req('GET', '/sync', Object.assign({ origin: 'https://evil.example' }, H));
    check('/sync from another site refused, no CORS/PNA headers', r.status === 403 && !r.headers['access-control-allow-origin'] && !r.headers['access-control-allow-private-network'], r.status);
    r = await req('OPTIONS', '/sync', Object.assign({ origin: 'https://evil.example', 'access-control-request-private-network': 'true' }, H));
    check('preflight from another site refused', r.status === 403, r.status);
    r = await req('OPTIONS', '/sync', Object.assign({ origin: DASH, 'access-control-request-private-network': 'true' }, H));
    check('preflight from dashboard allowed', r.status === 204 && r.headers['access-control-allow-private-network'] === 'true', r.status);
    r = await req('GET', '/ping', { host: 'rebind.evil.example:' + PORT, origin: DASH });
    check('DNS-rebinding Host refused', r.status === 403, r.status);
    // Running the stand-in build needs PowerShell, which only the office PC has.
    if (process.platform === 'win32') {
      r = await req('GET', '/sync', Object.assign({ origin: DASH }, H));
      let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
      check('/sync from dashboard runs the build and reports', r.status === 200 && j.ok === true && j.rows === '7' && j.fromReaders === '3' && j.wrote === true, r.body);
    }
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
