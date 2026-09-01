#!/usr/bin/env python3
"""Assemble public/index.html for the server-backed app.

Takes the existing shell + attendance dashboard and rewires them:
  - injects hw-sync.js INSIDE the dashboard, before its main script, so the
    dashboard's `var storage = window.storage || <localStorage shim>` picks up
    the API-backed version instead of localStorage;
  - injects hw-auth.js into the shell and neutralises the old client-side
    login gate so the server decides who gets in;
  - strips the embedded attendance seed, because records now come from Postgres
    (and because employee data should not sit in a git repo).
"""
import base64, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / 'src'
PUB = ROOT / 'public'

def read(p):
    return p.read_text(encoding='utf-8')

def main():
    shell = read(SRC / 'shell.template.html')
    dash = read(SRC / 'attendance.html')
    sync = read(PUB / 'hw-sync.js')
    auth = read(PUB / 'hw-auth.js')

    # ---- dashboard: storage adapter must exist before the main script runs ----
    marker = '<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>'
    if marker not in dash:
        sys.exit('FATAL: html2canvas marker not found in dashboard')
    dash = dash.replace(marker, '<script>\n' + sync + '\n</script>\n' + marker, 1)

    # ---- drop the embedded seed + dataset (records live in Postgres now) ----
    seed = re.search(r'<script>\(function\(\)\{try\{var s=JSON\.parse\(decodeURIComponent.*?</script>', dash, re.S)
    if seed:
        dash = dash.replace(seed.group(0), '<!-- seed removed: settings now load from /api/kv -->')
    else:
        print('WARN: seed block not found')

    dh = re.search(r'(<script id="data-holder" type="application/json">)(.*?)(</script>)', dash, re.S)
    if dh:
        dash = dash[:dh.start(2)] + '{"employees":[],"records":[]}' + dash[dh.end(2):]
    else:
        print('WARN: data-holder not found')

    # ---- shell: disable the old gate, use the server one ----
    # The original is a function declaration; declarations hoist, so simply
    # appending a replacement would be overwritten by it. Rename the original
    # and let hw-auth.js define window.initLoginGate instead.
    if 'function initLoginGate(startWorkspace){' not in shell:
        sys.exit('FATAL: initLoginGate not found in shell')
    shell = shell.replace(
        'function initLoginGate(startWorkspace){',
        'function __legacyInitLoginGate_UNUSED(startWorkspace){', 1)

    # hw-auth.js sets window.initLoginGate; load it before the shell script runs.
    head_end = shell.index('</head>')
    shell = shell[:head_end] + '<script>\n' + auth + '\n</script>\n' + shell[head_end:]

    # ---- embed the dashboard ----
    b64 = base64.b64encode(dash.encode('utf-8')).decode('ascii')
    if '@@B64:attendance@@' not in shell:
        sys.exit('FATAL: attendance placeholder not found')
    out = shell.replace('@@B64:attendance@@', b64)

    (PUB / 'index.html').write_text(out, encoding='utf-8')
    print('built public/index.html  (%d bytes)' % len(out))

if __name__ == '__main__':
    main()
