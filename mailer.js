'use strict';
/* Email, through Resend.
 *
 * Three things go out: a daily attendance summary, a note when somebody raises
 * a leave request, and a note when leave was taken with no request behind it.
 * The last two carry Approve and Reject buttons, so a decision can be made from
 * the phone without signing in.
 *
 * A button is a signed link, not a session: the link says which request, which
 * decision, which organisation and when it expires, and it is signed with
 * SESSION_SECRET. It opens a page that asks once and acts on the button there,
 * so a mail scanner following links cannot approve anything. The link also
 * carries the request's state at the time it was sent, so a link for a decision
 * already made is refused rather than quietly redoing it.
 *
 * Settings live in the kv key `mailSettings`; nothing here is sent unless
 * RESEND_API_KEY and RESEND_FROM are set.
 */
const crypto = require('crypto');

const API = 'https://api.resend.com/emails';

function conf() {
  return {
    key: String(process.env.RESEND_API_KEY || '').trim(),
    from: String(process.env.RESEND_FROM || '').trim(),
    replyTo: String(process.env.RESEND_REPLY_TO || '').trim()
  };
}
function ready() { const c = conf(); return !!(c.key && c.from); }

/* Where the site is, for the links in an email. Render sets the first one. */
function baseUrl() {
  return String(process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '').replace(/\/+$/, '');
}

/* Resend's API. Returns {ok, id} or {ok:false, error} - a failed email must
   never take a request or a scheduled job down with it. */
async function send(msg) {
  const c = conf();
  if (!c.key || !c.from) return { ok: false, error: 'RESEND_API_KEY or RESEND_FROM is not set' };
  const to = (Array.isArray(msg.to) ? msg.to : [msg.to]).filter(Boolean);
  if (!to.length) return { ok: false, error: 'no recipients' };
  const body = {
    from: c.from,
    to: to,
    subject: String(msg.subject || '(no subject)'),
    html: msg.html || '',
    text: msg.text || stripHtml(msg.html || '')
  };
  if (c.replyTo) body.reply_to = c.replyTo;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal
    }).finally(() => clearTimeout(t));
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: (j && (j.message || j.name)) || ('Resend answered ' + r.status) };
    return { ok: true, id: j && j.id };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ---------------- signed action links ---------------- */

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }

function signAction(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', String(secret || '')).update(body).digest());
  return body + '.' + mac;
}
/* Returns the payload, or null: a bad signature, a malformed token and an
   expired one are all simply "no". */
function verifyAction(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const want = b64url(crypto.createHmac('sha256', String(secret || '')).update(parts[0]).digest());
  const a = Buffer.from(parts[1]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload = null;
  try { payload = JSON.parse(unb64url(parts[0])); } catch (e) { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
const ACTION_DAYS = 14;
function actionToken(payload, secret) {
  return signAction(Object.assign({ exp: Date.now() + ACTION_DAYS * 86400000 }, payload), secret);
}

/* ---------------- HTML ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function stripHtml(h) {
  return String(h).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

const INK = '#1B2330', SOFT = '#5B6675', LINE = '#E6EBF4', BLUE = '#2F6FE4';

function layout(title, subtitle, blocks) {
  return '<!doctype html><html><body style="margin:0;padding:0;background:#F3F6FB;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F6FB;padding:24px 12px;">'
    + '<tr><td align="center">'
    + '<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#fff;'
    +   'border:1px solid ' + LINE + ';border-radius:14px;overflow:hidden;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
    + '<tr><td style="padding:18px 22px;background:' + INK + ';color:#fff;">'
    +   '<div style="font-size:16px;font-weight:700;letter-spacing:.2px;">' + esc(title) + '</div>'
    +   (subtitle ? ('<div style="font-size:12.5px;opacity:.75;margin-top:3px;">' + esc(subtitle) + '</div>') : '')
    + '</td></tr>'
    + '<tr><td style="padding:18px 22px;color:' + INK + ';font-size:14px;line-height:1.5;">' + blocks.join('') + '</td></tr>'
    + '<tr><td style="padding:14px 22px;border-top:1px solid ' + LINE + ';color:' + SOFT + ';font-size:11.5px;">'
    +   'Sent by the attendance dashboard. Buttons in this email ask once before they do anything.'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function button(href, label, kind) {
  const bg = kind === 'approve' ? '#137A3B' : kind === 'reject' ? '#B3261E' : '#33415C';
  return '<a href="' + esc(href) + '" style="display:inline-block;padding:9px 18px;margin:0 6px 6px 0;border-radius:8px;'
    + 'background:' + bg + ';color:#fff;font-size:13px;font-weight:600;text-decoration:none;">' + esc(label) + '</a>';
}
function pill(text, colour) {
  return '<span style="display:inline-block;padding:1px 8px;border-radius:20px;font-size:11.5px;font-weight:600;'
    + 'background:' + colour + '22;color:' + colour + ';">' + esc(text) + '</span>';
}
function dateRange(from, to) { return from === to ? from : (from + ' → ' + to); }

const KIND_NAME = {
  CL: 'Casual leave', Sick: 'Sick leave', Other: 'Leave', WFH: 'Work from home',
  VISIT: 'Client visit', HALF: 'Half day', SHORT: 'Short leave', THREEQ: 'Three-quarter day',
  PUNCH: 'Punch correction'
};
function kindName(t) { return KIND_NAME[t] || String(t || 'Leave'); }

/* One request, with its two buttons. `links` is {approve, reject}. */
function requestCard(req, links, heading) {
  return '<div style="border:1px solid ' + LINE + ';border-left:3px solid ' + BLUE + ';border-radius:10px;padding:12px 14px;margin:0 0 12px;">'
    + (heading ? ('<div style="font-size:11.5px;color:' + SOFT + ';margin-bottom:4px;">' + esc(heading) + '</div>') : '')
    + '<div style="font-weight:700;">' + esc(req.empName) + '</div>'
    + '<div style="color:' + SOFT + ';font-size:13px;margin:2px 0 8px;">'
    +   esc(kindName(req.leaveType || req.type)) + (req.half ? (' · ' + esc(req.half)) : '')
    +   ' · ' + esc(dateRange(req.dateFrom, req.dateTo))
    +   (req.message ? ('<br>“' + esc(String(req.message).slice(0, 300)) + '”') : '')
    + '</div>'
    + (links ? (button(links.approve, 'Approve', 'approve') + button(links.reject, 'Reject', 'reject')) : '')
    + '</div>';
}

/* The daily summary. rows: {name, in, out, state} already worked out by the
   caller, so this file stays free of attendance rules. */
function dailyEmail(o) {
  const rows = o.rows || [];
  const count = function (st) { return rows.filter(function (r) { return r.state === st; }).length; };
  const tally = [
    ['Present', count('present'), '#137A3B'],
    ['From home / visiting', count('remote'), '#2F6FE4'],
    ['On leave', count('leave'), '#B45309'],
    ['No punch yet', count('missing'), '#B3261E']
  ].map(function (t) {
    return '<td style="padding:8px 10px;border:1px solid ' + LINE + ';border-radius:10px;">'
      + '<div style="font-size:19px;font-weight:700;color:' + t[2] + ';">' + t[1] + '</div>'
      + '<div style="font-size:11.5px;color:' + SOFT + ';">' + esc(t[0]) + '</div></td>';
  }).join('<td style="width:8px;"></td>');

  const body = [];
  body.push('<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;text-align:center;margin-bottom:16px;"><tr>' + tally + '</tr></table>');

  body.push('<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;">'
    + '<tr><th align="left" style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';color:' + SOFT + ';font-weight:600;">Name</th>'
    + '<th align="left" style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';color:' + SOFT + ';font-weight:600;">In</th>'
    + '<th align="left" style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';color:' + SOFT + ';font-weight:600;">Out</th>'
    + '<th align="left" style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';color:' + SOFT + ';font-weight:600;">Day</th></tr>'
    + rows.map(function (r) {
      const colour = r.state === 'present' ? '#137A3B' : r.state === 'remote' ? '#2F6FE4'
                   : r.state === 'leave' ? '#B45309' : '#B3261E';
      return '<tr><td style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';">' + esc(r.name) + '</td>'
        + '<td style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';">' + esc(r['in'] || '—') + '</td>'
        + '<td style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';">' + esc(r.out || '—') + '</td>'
        + '<td style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';">' + pill(r.label || '', colour) + '</td></tr>';
    }).join('')
    + '</table>');

  if ((o.pending || []).length) {
    body.push('<h3 style="font-size:14px;margin:22px 0 10px;">Waiting for a decision</h3>');
    o.pending.forEach(function (p) { body.push(requestCard(p.req, p.links, p.heading)); });
  }
  if ((o.unrequested || []).length) {
    body.push('<h3 style="font-size:14px;margin:22px 0 4px;">Taken without a request</h3>'
      + '<div style="font-size:12.5px;color:' + SOFT + ';margin-bottom:10px;">'
      + 'Marked on the record but never approved. Rejecting removes the day.</div>');
    o.unrequested.forEach(function (p) { body.push(requestCard(p.req, p.links, p.heading)); });
  }
  if (o.siteUrl) {
    body.push('<div style="margin-top:20px;">' + button(o.siteUrl, 'Open the dashboard', 'plain') + '</div>');
  }
  return {
    subject: 'Attendance · ' + o.dateLabel + (count('missing') ? (' · ' + count('missing') + ' with no punch') : ''),
    html: layout(o.orgName || 'Attendance', o.dateLabel, body)
  };
}

/* One new request, sent as it is raised. */
function requestEmail(o) {
  const r = o.req;
  return {
    subject: (r.leaveType === 'PUNCH' ? 'Punch correction' : kindName(r.leaveType)) + ' · ' + r.empName
             + ' · ' + dateRange(r.dateFrom, r.dateTo),
    html: layout(o.orgName || 'Attendance', 'A request is waiting for a decision', [
      requestCard(r, o.links, 'Raised ' + (r.createdAt ? String(r.createdAt).slice(0, 10) : 'just now')),
      o.siteUrl ? ('<div style="margin-top:8px;">' + button(o.siteUrl, 'Open the dashboard', 'plain') + '</div>') : ''
    ])
  };
}

/* The page a button opens: it states what will happen and asks once. */
function confirmPage(o) {
  const act = o.action === 'approve' ? 'Approve' : 'Reject';
  const warn = o.action === 'reject' && o.unrequested
    ? '<p style="color:#B3261E;">Rejecting removes the day from the attendance record.</p>' : '';
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(act) + ' · Attendance</title>'
    + '<body style="margin:0;background:#F3F6FB;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:' + INK + ';">'
    + '<div style="max-width:460px;margin:40px auto;background:#fff;border:1px solid ' + LINE + ';border-radius:14px;padding:22px;">'
    + '<h2 style="margin:0 0 10px;font-size:17px;">' + esc(act) + ' this request?</h2>'
    + '<p style="color:' + SOFT + ';font-size:14px;line-height:1.5;margin:0 0 14px;">' + esc(o.summary) + '</p>'
    + warn
    + '<form method="POST" action="' + esc(o.postTo) + '">'
    + '<button type="submit" style="border:0;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;color:#fff;'
    + 'background:' + (o.action === 'approve' ? '#137A3B' : '#B3261E') + ';cursor:pointer;">Yes, ' + esc(act.toLowerCase()) + '</button>'
    + '</form></div></body>';
}
function resultPage(title, detail, ok) {
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title>'
    + '<body style="margin:0;background:#F3F6FB;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:' + INK + ';">'
    + '<div style="max-width:460px;margin:40px auto;background:#fff;border:1px solid ' + LINE + ';border-radius:14px;padding:22px;">'
    + '<h2 style="margin:0 0 10px;font-size:17px;color:' + (ok ? '#137A3B' : '#B3261E') + ';">' + esc(title) + '</h2>'
    + '<p style="color:' + SOFT + ';font-size:14px;line-height:1.5;margin:0;">' + esc(detail) + '</p>'
    + '</div></body>';
}

module.exports = {
  conf, ready, baseUrl, send,
  signAction, verifyAction, actionToken, ACTION_DAYS,
  esc, stripHtml, layout, button, kindName, dateRange,
  dailyEmail, requestEmail, requestCard, confirmPage, resultPage
};
