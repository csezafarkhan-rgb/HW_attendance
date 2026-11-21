/* Where a sample message goes.
 *
 * Every test send addressed itself to whoever pressed the button, which is
 * right until the office wants to see how a message lands in somebody else's
 * inbox - the person who actually receives the real one. So it may be named.
 *
 * Named, not typed freely: a test that could be addressed anywhere is a way
 * to send mail from the company's own address to a stranger. It goes to an
 * account in this office or it does not go.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

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

const ACCOUNTS = {
  'zafar@homeweavers.net': 'Zafar Khan',
  'support@homeweavers.net': 'Portal Admin'
};
let asked = [];
const ctx = {
  console, String, Object, Promise,
  EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  pool: { query: async (sql, args) => {
    asked.push(args[1]);
    const hit = Object.prototype.hasOwnProperty.call(ACCOUNTS, args[1]);
    return { rows: hit ? [{ email: args[1] }] : [] };
  } }
};
vm.createContext(ctx);
vm.runInContext('async ' + grab(SRV, 'sampleBox'), ctx);

const req = (body, me) => ({ body: body, session: { orgId: 1 }, user: { email: me } });

(async () => {
  /* Nobody named: the person who pressed it, as before. */
  let r = await ctx.sampleBox(req({}, 'support@homeweavers.net'), '');
  check('with nobody named it goes to whoever asked for it',
    r.box === 'support@homeweavers.net', r);

  /* Named: that person, because they are the one who gets the real thing. */
  asked = [];
  r = await ctx.sampleBox(req({ to: 'zafar@homeweavers.net' }, 'support@homeweavers.net'), '');
  check('and where somebody is named, to them instead',
    r.box === 'zafar@homeweavers.net', r);
  check('which is checked against the accounts of this office',
    asked.length === 1 && asked[0] === 'zafar@homeweavers.net', asked);

  /* A stranger: nothing is sent, and the refusal says why. */
  r = await ctx.sampleBox(req({ to: 'someone@elsewhere.example' }, 'support@homeweavers.net'), '');
  check('a stranger gets nothing', !r.box && !!r.error, r);
  check('and the refusal says what the rule is',
    /only goes to somebody who already gets the real thing/.test(r.error || ''), r.error);
  /* Case and stray spaces are how an address is typed, not a different
     address. */
  r = await ctx.sampleBox(req({ to: '  Zafar@Homeweavers.net ' }, 'support@homeweavers.net'), '');
  check('a name typed with capitals is the same address',
    r.box === 'zafar@homeweavers.net', r);

  /* An account signed in by username has no address to fall back on. */
  r = await ctx.sampleBox(req({}, 'admin'), 'nitish@homeweavers.net');
  check('an account with no address falls back to the office’s own',
    r.box === 'nitish@homeweavers.net', r);
  r = await ctx.sampleBox(req({}, 'admin'), '');
  check('and with nothing to fall back on, says so rather than guessing',
    !r.box && /no email address/.test(r.error || ''), r);

  /* Every sample send goes through it, or one of them still mails whoever
     pressed the button while the rest obey. */
  const sends = (SRV.match(/\(req\.body && req\.body\.send\) === 'test'/g) || []).length;
  const picks = (SRV.match(/await sampleBox\(req,/g) || []).length;
  check('every test send asks the same question about where it goes',
    picks === sends + 1, [sends, picks]);     // the three samples, and the mail test
  check('and nothing addresses itself from the session any more',
    !/let to = String\(\(req\.user && req\.user\.email\)/.test(SRV), null);

  console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
