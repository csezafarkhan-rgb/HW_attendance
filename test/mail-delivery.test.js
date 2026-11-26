/* Accepted is not arrived.
 *
 * Resend answers the send call the moment it takes the request, and the log
 * wrote that down as ok. An address the account holds back - one that bounced
 * once, or that somebody marked as spam - is dropped in silence, and the
 * answer is still a cheerful id. Four addresses went into the attendance
 * message every morning and two of them were never written to; the panel said
 * it had been sent, because as far as it knew it had.
 *
 * So the log asks Resend afterwards what it actually did, and the row shows
 * the answer. This drives the asking, the comparison, and the line the panel
 * draws from it.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
const mailer = require(path.join(REPO, 'mailer.js'));

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
/* The little lookup tables beside it - taken from the source so the test reads
   the office's own words, not a copy that can drift from them. */
function grabVar(src, name) {
  const m = new RegExp('var ' + name + ' = \\{[\\s\\S]*?\\};').exec(src);
  if (!m) throw new Error('not found: var ' + name);
  return m[0];
}

/* ---------------- asking Resend ---------------- */

const realFetch = global.fetch;
let asked = null, answer = null;
global.fetch = function (url, opts) {
  if (String(url).indexOf('api.resend.com') > -1) {
    asked = { url: String(url), headers: (opts && opts.headers) || {}, method: (opts && opts.method) || 'GET' };
    return Promise.resolve(answer);
  }
  return realFetch(url, opts);
};
process.env.RESEND_API_KEY = 'test-key';
process.env.RESEND_FROM = 'Attendance <a@b.test>';

const ID = '01a21629-890b-75e9-b7b4-b2847473b27a';

(async () => {
  /* The morning the two addresses went missing: four named, two used. */
  asked = null;
  answer = { ok: true, status: 200, json: () => Promise.resolve({
    id: ID,
    to: ['shivani@homeweavers.net', 'nitish@homeweavers.net'],
    cc: ['support@homeweavers.net'],
    last_event: 'delivered'
  }) };
  let got = await mailer.lookup(ID);
  check('the message is asked after by its own id',
    asked && asked.url === 'https://api.resend.com/emails/' + ID && asked.method === 'GET',
    asked);
  check('and asked with the account key',
    asked && asked.headers.Authorization === 'Bearer test-key', asked && asked.headers);
  check('what comes back is the recipients Resend actually used',
    got.ok && got.to.length === 2 && got.to[0] === 'shivani@homeweavers.net'
      && got.cc.length === 1 && got.event === 'delivered', got);

  /* A message id is a message id. Anything else never reaches the network. */
  asked = null;
  got = await mailer.lookup('../emails');
  check('nothing that is not an id is ever asked for', !got.ok && asked === null, { got, asked });

  /* Resend having no record of it is not the same as everyone being dropped. */
  asked = null;
  answer = { ok: false, status: 404, json: () => Promise.resolve({ message: 'Email not found' }) };
  got = await mailer.lookup(ID);
  check('a message Resend does not know is a failed enquiry, not an empty one',
    !got.ok && /not found/i.test(got.error), got);

  /* Held back for testing, the one address is where it really went. */
  delete process.env.MAIL_TEST_TO;
  check('with nothing held back, nothing is held back', !mailer.heldTo(), mailer.heldTo());
  process.env.MAIL_TEST_TO = 'zafar@homeweavers.net';
  check('and the held address is the one the office set',
    mailer.heldTo() === 'zafar@homeweavers.net', mailer.heldTo());
  delete process.env.MAIL_TEST_TO;

  /* ---------------- what the comparison makes of it ---------------- */

  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(grab(SRV, 'addrList'), ctx);
  vm.runInContext(grab(SRV, 'droppedFrom'), ctx);

  const ASKED_FOR = {
    recipients: 'shivani@homeweavers.net, nitish@homeweavers.net, documents@essessexports.net, dutt@essessexports.net',
    cc: 'support@homeweavers.net'
  };
  const row = extra => Object.assign({}, ASKED_FOR, extra);

  check('a message nobody has asked about has dropped nobody',
    ctx.droppedFrom(row({ sent_to: '', sent_cc: '', checked_at: null })).length === 0, null);

  /* Asked, and no answer came. That is not Resend saying it wrote to nobody. */
  check('an enquiry that failed accuses nobody',
    ctx.droppedFrom(row({ sent_to: null, sent_cc: null, checked_at: '2026-11-26T05:00:00Z' })).length === 0,
    null);

  check('all four used, and nothing is flagged',
    ctx.droppedFrom(row({
      sent_to: ASKED_FOR.recipients, sent_cc: ASKED_FOR.cc, checked_at: '2026-11-26T05:00:00Z'
    })).length === 0, null);

  /* The real morning. */
  let dropped = ctx.droppedFrom(row({
    sent_to: 'shivani@homeweavers.net, nitish@homeweavers.net',
    sent_cc: 'support@homeweavers.net',
    checked_at: '2026-11-26T05:00:00Z'
  }));
  check('the two that were never written to are named',
    dropped.length === 2 && dropped[0] === 'documents@essessexports.net'
      && dropped[1] === 'dutt@essessexports.net', dropped);

  check('an address is the same address however it is typed',
    ctx.droppedFrom(row({
      sent_to: 'Shivani@Homeweavers.NET, NITISH@homeweavers.net, documents@essessexports.net, DUTT@essessexports.net',
      sent_cc: 'Support@homeweavers.net', checked_at: '2026-11-26T05:00:00Z'
    })).length === 0, null);

  check('a cc that was dropped counts as dropped too',
    JSON.stringify(ctx.droppedFrom(row({
      sent_to: ASKED_FOR.recipients, sent_cc: '', checked_at: '2026-11-26T05:00:00Z'
    }))) === JSON.stringify(['support@homeweavers.net']), null);

  /* ---------------- and the line the panel draws ---------------- */

  const ui = {
    escapeHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    Date, Object, JSON, console
  };
  vm.createContext(ui);
  ['MAIL_KIND', 'MAIL_EVENT', 'MAIL_EVENT_BAD'].forEach(n => vm.runInContext(grabVar(APP, n), ui));
  vm.runInContext(grab(APP, 'mailLogRow'), ui);
  vm.runInContext(grab(APP, 'mailNeedsAsking'), ui);

  const base = {
    id: 113, at: '2026-11-26T04:42:30Z', kind: 'attendance',
    subject: 'Attendance · Thu, 26 Nov’ 2026',
    recipients: ASKED_FOR.recipients, cc: ASKED_FOR.cc, ok: true, attached: true
  };

  let html = ui.mailLogRow(Object.assign({}, base, { event: 'delivered', dropped: [] }));
  check('a message that reached everyone says so and carries no warning',
    html.indexOf('delivered') > -1 && html.indexOf('ml-drop') === -1
      && html.indexOf('class="ml-row"') > -1, html.slice(0, 200));

  html = ui.mailLogRow(Object.assign({}, base, {
    event: 'delivered', dropped: ['documents@essessexports.net', 'dutt@essessexports.net']
  }));
  check('a message that reached only some of them names the rest',
    html.indexOf('ml-drop') > -1
      && html.indexOf('documents@essessexports.net') > -1
      && html.indexOf('dutt@essessexports.net') > -1, html.slice(0, 400));
  check('and the row is marked as partly gone rather than failed',
    / class="ml-row part"/.test(html) && !/ bad/.test(html), html.slice(0, 200));

  html = ui.mailLogRow(Object.assign({}, base, { event: 'bounced', dropped: [] }));
  check('a bounce is a failure, and reads as one',
    /ml-row bad/.test(html) && html.indexOf('bounced') > -1, html.slice(0, 200));

  /* Asking again, or letting it be. */
  check('a message not yet asked about is asked about',
    ui.mailNeedsAsking({ ok: true, checked_at: null }) === true, null);
  check('a delivered message is never asked about twice',
    ui.mailNeedsAsking({ ok: true, checked_at: 'x', event: 'delivered' }) === false, null);
  check('a bounced message is settled as well',
    ui.mailNeedsAsking({ ok: true, checked_at: 'x', event: 'bounced' }) === false, null);
  check('one still queued is asked again',
    ui.mailNeedsAsking({ ok: true, checked_at: 'x', event: 'queued' }) === true, null);
  check('and one that never went out at all is not worth asking after',
    ui.mailNeedsAsking({ ok: false, checked_at: null }) === false, null);

  /* ---------------- the row has somewhere to keep the answer ---------------- */

  check('the log gains the columns the answer is kept in',
    /ADD COLUMN IF NOT EXISTS event TEXT/.test(SRV)
      && /ADD COLUMN IF NOT EXISTS sent_to TEXT/.test(SRV)
      && /ADD COLUMN IF NOT EXISTS sent_cc TEXT/.test(SRV)
      && /ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ/.test(SRV), null);
  check('and the list hands them to the panel with the comparison already made',
    /event, sent_to, sent_cc, checked_at/.test(SRV)
      && /dropped: droppedFrom\(x\)/.test(SRV), null);
  check('a message Resend has finished with is not asked about again',
    /MAIL_SETTLED = \['delivered', 'bounced', 'complained', 'canceled', 'failed'\]/.test(SRV)
      && /NOT \(event = ANY\(\$2\)\)/.test(SRV), null);
  check('and one Resend has no record of is asked after once, not forever',
    /at > now\(\) - interval '2 days'/.test(SRV)
      && /UPDATE mail_log SET checked_at = now\(\)/.test(SRV), null);

  global.fetch = realFetch;
  console.log(results.every(Boolean) ? '\nALL PASS (' + results.length + ')' : '\nSOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
