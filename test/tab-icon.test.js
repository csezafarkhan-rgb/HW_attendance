/* The company's mark in the browser tab.
 *
 * The tab carried the browser's own grey globe. The obvious fix - a file in
 * the repo - is the wrong one: the office uploads its logo on the dashboard,
 * so a file here is somebody else's logo the day they change theirs.
 *
 * And the logo itself is a letterhead: a mark above the company's name. At
 * sixteen pixels the name is a grey smudge, so the mark is cut out of it and
 * the name left behind. That cut is what this measures.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SHELL = fs.readFileSync(path.join(REPO, 'src', 'shell.template.html'), 'utf8');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(REPO, 'public', 'hw-auth.js'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(grab(SHELL, 'hwMarkBox'), ctx);

/* A picture drawn in words: '#' is ink, '.' is paper. */
const pic = rows => {
  const W = Math.max.apply(null, rows.map(r => r.length));
  const grid = rows.map(r => r.padEnd(W, '.'));
  return { W: W, H: grid.length, inked: (x, y) => grid[y][x] === '#' };
};
const box = p => ctx.hwMarkBox(p.inked, p.W, p.H);

/* ---- a letterhead: a mark, a gap, and the company's name ---- */
{
  const p = pic([
    '..........',     // 0
    '....##....',     // 1   the mark
    '...####...',     // 2
    '..######..',     // 3
    '.########.',     // 4
    '..........',     // 5   the gap
    '..........',     // 6
    '##########',     // 7   the name
    '##########',     // 8
    '..........'      // 9
  ]);
  const b = box(p);
  check('the mark is what is taken', b && b.y0 === 1 && b.y1 === 4, b);
  check('and the name under it is left behind', b && b.y1 < 7, b);
  check('with the mark measured across as well as down',
    b && b.x0 === 1 && b.x1 === 8, b);
}

/* ---- the real one, which has a stray row of antialiasing above the mark ---- */
{
  const rows = ['..........', '....#.....', '..........'];
  for (let i = 0; i < 12; i++) rows.push('..######..');    // the mark, 12 rows
  rows.push('..........');
  rows.push('#########.');                                  // the name, 2 rows
  rows.push('#########.');
  const b = box(pic(rows));
  check('a stray row above the mark is not mistaken for it', b && b.y0 === 3, b);
  check('and neither is the name below it', b && b.y1 === 14, b);
}

/* ---- a logo that is only a mark is left whole ---- */
{
  const b = box(pic(['....', '.##.', '.##.', '....']));
  check('a logo with nothing to drop keeps all of itself',
    b && b.y0 === 1 && b.y1 === 2 && b.x0 === 1 && b.x1 === 2, b);
}
/* ---- and a blank one is not cut into nothing ---- */
{
  check('a picture with no ink in it yields no mark',
    box(pic(['....', '....'])) === null, null);
}

/* ---- the paper behind the mark ----

   An uploaded logo is a picture of a printed thing: the mark sits on white,
   and that white is only white because paper is. Left there, it becomes a
   white tile around the mark the moment the mark is put on anything else -
   which is exactly what the dark tab tile and the dark bar in a message are.
   So near-white is turned to nothing, and the edge faded rather than cut. */
const cut = grab(SHELL, 'hwMarkCut');
check('paper behind the mark is taken out, not kept',
  /if\(low >= 250\)\{ p\[i\+3\] = 0;/.test(cut), null);
check('and the edge is faded rather than cut, so no white rind is left',
  /if\(low > 215\) p\[i\+3\] = Math\.round\(p\[i\+3\] \* \(250 - low\) \/ 35\);/.test(cut), null);
check('what comes back is a canvas, because a picture would have to load first',
  /return c;\s+\/\/ a canvas/.test(cut), null);

/* ---- and the tile, which is what a tab expects ---- */
const tile = grab(SHELL, 'hwMarkTile');
check('the tile has rounded corners, like every other icon in the row',
  /size \* 0\.22/.test(tile), null);
check('and is dark, because a tab bar is usually light',
  /fillStyle = HW_TILE_INK/.test(tile) && /HW_TILE_INK = '#1B2330'/.test(SHELL), null);
check('with the mark inside it rather than filling it',
  /size \* 0\.17/.test(tile), null);
check('drawn from the canvas, so nothing has to be waited for',
  /drawImage\(markCanvas/.test(tile), null);

/* ---- what the page does with it ---- */
const maker = grab(SHELL, 'hwMarkFromLogo');
check('the tab gets the tile', /link\.href = tile/.test(maker), null);
/* Two pictures, because two things are wanted: the tile where it stands
   alone, the mark where there is already a shape around it. */
check('and both are kept - the tile and the mark on its own',
  /keep\('companyIcon', tile\);/.test(maker) && /keep\('companyMark', bare\);/.test(maker), null);
check('the sign-in heading takes the mark, which sits on white already',
  /id="lgMark"[^>]*src="\/mark\.png"/.test(SHELL), null);
check('the mark is squared off, so the tab does not stretch it',
  /Math\.max\(mw, mh\)/.test(cut), null);
check('and given a little room, so it is not jammed against the edges',
  /hwMarkCut\(img, box, 64, 0\.05\)/.test(maker), null);
check('the same logo is not cut twice', /__hwMarkFrom === src/.test(maker), null);
/* A logo loaded from another origin taints the canvas and reading it throws.
   That is not a fault worth a broken page over - the tab simply keeps the
   icon the server gave it. */
check('a picture that cannot be read leaves the tab as it was',
  /catch\(_\)\{ return; \}/.test(maker) && /tainted/.test(maker), null);
check('it is put on the tab',
  /getElementById\('hwTabIcon'\)[\s\S]{0,80}link\.href = tile/.test(maker), null);
/* Only the office stores it: an employee's save would be refused, and a
   refusal notice about a tab icon is noise about something nobody asked
   for. */
check('and only the office stores it for next time',
  /window\.HW_ROLE === 'admin'/.test(maker), null);
check('which the sign-in says once, rather than being asked again',
  /window\.HW_ROLE = user\.role;/.test(AUTH), null);
check('and it is not written again when it has not changed',
  /res\.value === png/.test(maker), null);
check('the mark alone is served too, for what already has a shape around it',
  /app\.get\('\/mark\.png'/.test(SRV), null);
check('the tab asks for it before anybody signs in',
  /<link id="hwTabIcon" rel="icon" type="image\/png" href="\/favicon\.png">/.test(SHELL), null);
check('and the logo arriving is what sets it off',
  /hwMarkFromLogo\(e\.data\.logo\)/.test(SHELL), null);
/* The sign-in page had a ball of wool beside its title, which is nobody's
   logo. It carries the same mark the tab does, from the same place. */
check('the sign-in page wears the mark too',
  /<h1><img id="lgMark" class="lg-mark" src="\/mark\.png"/.test(SHELL), null);
check('and says the words alone where there is no logo to show',
  /onerror="this\.style\.display='none'"/.test(SHELL), null);
check('nothing is left of the emoji that was there', !/🧶/.test(SHELL), null);

/* ---- and what the server hands back ---- */
const route = SRV.slice(SRV.indexOf('async function orgForMark'),
                        SRV.indexOf('app.use(express.static'));
check('the icon is served without a session, for the login page',
  route.length > 200 && !/requireAuth/.test(route), null);
/* Whose mark it is, is the session's answer where there is one. Where there
   is not, it can only be the one office on the server; with more than one and
   nobody signed in there is no honest answer, so none is given. */
check('a signed-in page gets its own office’s mark',
  /req\.session\.orgId/.test(route), null);
check('and a stranger gets one only where there is one office to mean',
  /rows\.length === 1\) \? r\.rows\[0\]\.id : 0/.test(route), null);
check('nothing but an image is ever served from it',
  /\^data:image\\\/\(png\|jpeg\|gif\|webp\|x-icon\);base64,/.test(route), null);
check('and nothing enormous',
  /body\.length > 512 \* 1024/.test(route), null);
check('a tab icon is allowed to be cached, but not forever',
  /max-age=3600, must-revalidate/.test(route), null);
check('and where no logo has been uploaded it simply says there is none',
  (route.match(/status\(404\)/g) || []).length >= 3, null);

/* ---- and the same mark at the top of every message ---- */
{
  const mailer = require(path.join(REPO, 'mailer.js'));
  const MARK = 'https://attendance.example.net/mark.png?org=1&v=4';
  const build = mark => mailer.remindEmail({
    orgName: 'AllyConnect Pvt. Ltd.', name: 'Rahul Mishra', day: '2026-11-21',
    footer: 'x', mark: mark,
    items: [{ job: 'late', day: '2026-11-21', mins: 18, came: '09:48' }]
  }).html;

  const withMark = build(MARK);
  check('the message carries the mark, fetched from the site',
    withMark.indexOf('src="' + mailer.esc(MARK) + '"') > -1, null);
  /* A picture built into the message is not drawn at all by most clients,
     which is why it is a link and not an attachment. */
  check('and not built into the message, which clients refuse to draw',
    withMark.indexOf('src="data:') === -1, null);
  /* The logo offices upload is a mark on white paper. Dropped straight onto
     the dark bar it reads as a sticker; on a chip the white is deliberate. */
  check('it sits on a white chip rather than loose on the dark bar',
    /bgcolor="#ffffff"[^>]*style="background:#fff;border-radius:10px;"/.test(withMark), null);
  check('the name and the date still sit beside it',
    /AllyConnect Pvt\. Ltd\./.test(withMark), null);
  /* Outlook shows pictures only when asked, so everything the header says
     must be said in text as well. */
  const noPics = withMark.replace(/<img[^>]*>/g, '');
  check('a client with pictures turned off still reads the header',
    /AllyConnect Pvt\. Ltd\./.test(noPics), null);

  const plain = build('');
  check('an office with no logo gets no empty picture',
    plain.indexOf('<img') === -1 || plain.indexOf('mark.png') === -1, null);
  check('and its header is as it always was',
    /font-size:16px;font-weight:700/.test(plain), null);
}

/* ---- every message, not some of them ---- */
{
  const calls = (SRV.match(/mailer\.[a-zA-Z]*Email\(\{/g) || []).length;
  const marked = (SRV.match(/mailer\.[a-zA-Z]*Email\(\{\r?\n\s*mark: await markUrlFor\(/g) || []).length;
  check('every message built on the server asks for the mark',
    calls > 15 && marked === calls, [calls, marked]);
  /* The link names the office, because a message has no session to ask with,
     and the version, because a mail client that has drawn a picture once will
     go on drawing that one. */
  check('and the link says which office, and which version of its logo',
    /'\/mark\.png\?org=' \+ orgId \+ '&v=' \+ Number\(r\.rows\[0\]\.version \|\| 0\)/.test(SRV), null);
  check('an office that has uploaded nothing gets no link at all',
    /if \(!r\.rows\.length\) return '';/.test(SRV), null);
}
/* The mailer passes it through on every message it knows how to build. */
{
  const MAILER = fs.readFileSync(path.join(REPO, 'mailer.js'), 'utf8');
  const layouts = (MAILER.match(/layout\(/g) || []).length - 1;      // less the definition
  const passed = (MAILER.match(/o\.mark\)/g) || []).length;
  check('and every message the mailer builds passes it on',
    layouts > 10 && passed === layouts, [layouts, passed]);
}

console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
