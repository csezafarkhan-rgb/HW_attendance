'use strict';
/* Email, through Resend.
 *
 * Two kinds of message go out. The daily one is attendance alone: the day's
 * figures, the people shown on the portal and their times, with the same
 * picture the HD Screenshot button makes attached. The other is leave: what is
 * waiting for a decision and what was taken without a request, each with
 * Approve and Reject buttons, so a decision can be made from the phone without
 * signing in. A request raised during the day is sent on its own the same way.
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
  const cc = (Array.isArray(msg.cc) ? msg.cc : (msg.cc ? [msg.cc] : [])).filter(Boolean);
  if (cc.length) body.cc = cc;
  /* Resend takes an attachment as base64 in `content`. The daily message
     carries the same picture the HD Screenshot button makes. */
  /* A daily report to the same people, every day, reads to a spam filter as
     bulk mail unless it says how to stop it. These two headers are what Gmail
     and Yahoo ask for, and they cost nothing: the address they point at is the
     one that already receives replies. */
  const unsub = c.replyTo || c.from.replace(/^.*<|>.*$/g, '');
  if (unsub) {
    body.headers = Object.assign({
      'List-Unsubscribe': '<mailto:' + unsub + '?subject=unsubscribe>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }, msg.headers || {});
  } else if (msg.headers) {
    body.headers = msg.headers;
  }
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    body.attachments = msg.attachments.slice(0, 3).map(function (a) {
      return { filename: String(a.filename || 'attachment'), content: String(a.content || '') };
    });
  }
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
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
/* Dates as the office writes them: 24 Sep' 2026, with the weekday in front
   where a message is about one particular day. */
function fmtDay(iso, withWeekday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = (+m[3]) + ' ' + MONTHS[+m[2] - 1] + '’ ' + m[1];
  return withWeekday ? (WEEKDAYS[d.getUTCDay()] + ', ' + day) : day;
}
function dateRange(from, to) {
  return from === to ? fmtDay(from) : (fmtDay(from) + ' → ' + fmtDay(to));
}
/* Times are read at a glance on a phone, so they carry am/pm as the grid does:
   9:33 reads as 9:33 AM, 16:17 as 4:17 PM. */
function clock(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return String(t || '');
  let h = +m[1];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m[2] + ' ' + ap;
}

/* What each message says before anybody changes it. The same braces work in
   the subject, the greeting and the sign-off, so a name or a date can be
   written into any of them. */
const DEFAULT_TEXT = {
  daily: {
    subject: 'Attendance \u00b7 {date}',
    intro: 'Hello,\n\nPlease find today\u2019s attendance record below.',
    footer: 'Best regards,\n{org}'
  },
  leave: {
    subject: 'Leave \u00b7 {n} waiting for a decision',
    intro: 'Hello,\n\nThe leave below is waiting for a decision. Approve or reject it from the buttons \u2014 each asks once before it does anything.',
    footer: 'Best regards,\n{org}'
  },
  holiday: {
    subject: 'Holiday \u00b7 {name} \u00b7 {date}',
    intro: 'Hello,\n\nA holiday is coming up. Please plan your work around it.',
    footer: 'Best regards,\n{org}'
  }
};
/* {name} {date} {days} {org} and the rest, wherever they are written. */
function fillText(text, values) {
  return String(text || '').replace(/\{(\w+)\}/g, function (m, k) {
    return (k in values) ? String(values[k]) : m;
  });
}

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

/* One of the day's lists - late, shift changed, from home - drawn the way the
   banner above the record draws them. */
function noticeList(title, items, colour) {
  if (!items || !items.length) return '';
  return '<div style="margin:16px 0 0;">'
    + '<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' + SOFT + ';'
    +   'padding-bottom:6px;border-bottom:1px solid ' + LINE + ';">' + esc(title) + '</div>'
    + items.map(function (it) {
        return '<div style="display:block;padding:6px 0;border-bottom:1px solid #F1F4F9;font-size:13px;">'
          + '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + colour + ';margin-right:8px;"></span>'
          + '<b>' + esc(it.name) + '</b>'
          + (it.detail ? ('<span style="color:' + SOFT + ';"> — ' + esc(it.detail) + '</span>') : '')
          + '</div>';
      }).join('')
    + '</div>';
}

/* The daily attendance message. Everything above the table can be turned off
   or reworded from the portal: the note at the top, the three lists the banner
   shows, the picture of the record, and the line at the foot. */
function dailyEmail(o) {
  const rows = o.rows || [];
  const words = DEFAULT_TEXT.daily;
  const on = Object.assign({ tally: true, late: true, shifts: true, wfh: true, visits: true,
                            table: true, shot: true }, o.sections || {});
  const count = function (st) { return rows.filter(function (r) { return r.state === st; }).length; };
  const body = [];

  const say = { date: o.dateLabel, org: o.orgName || 'Attendance',
                present: count('present'), remote: count('remote'),
                leave: count('leave'), missing: count('missing'), late: (o.late || []).length };
  const intro = fillText(o.intro || words.intro, say);
  if (intro) {
    body.push('<div style="margin:0 0 16px;font-size:13.5px;line-height:1.55;white-space:pre-line;">'
      + esc(intro) + '</div>');
  }

  if (on.tally) {
    /* One card a kind, all on one line, with the names under the number: "3
       from home" says less than knowing which three. Work from home and a
       customer visit are different days, so they are counted apart, and a kind
       nobody is on is left out rather than standing there as a nought. */
    const kindOf = function (r) { return r.kind || (r.state === 'remote' ? 'wfh' : r.state); };
    /* In the order they arrived: first in, first on the card. Anyone with no
       time yet follows, by name, so the list is still steady between sends. */
    const who = function (k) {
      return rows.filter(function (r) { return kindOf(r) === k; }).sort(function (a, b) {
        const x = (a.inMin == null) ? Infinity : a.inMin, y = (b.inMin == null) ? Infinity : b.inMin;
        return x === y ? String(a.name).localeCompare(String(b.name)) : x - y;
      });
    };
    const kinds = [
      ['Present', who('present'), '#137A3B'],
      ['From home', who('wfh'), '#2F6FE4'],
      ['Visiting', who('visit'), '#7C3AED'],
      ['On leave', who('leave'), '#B45309'],
      ['No punch', who('missing'), '#B3261E']
    ].filter(function (k) { return k[1].length; });
    if (kinds.length) {
      const w = Math.floor(100 / kinds.length);
      const cells = kinds.map(function (k) {
        return '<td width="' + w + '%" valign="top" style="padding:0 3px;">'
          + '<div style="border:1px solid ' + LINE + ';border-radius:10px;padding:8px 6px;text-align:center;">'
          + '<div style="font-size:18px;font-weight:700;color:' + k[2] + ';line-height:1.1;">' + k[1].length + '</div>'
          + '<div style="font-size:10.5px;font-weight:600;color:' + SOFT + ';padding-bottom:4px;">' + esc(k[0]) + '</div>'
          + '<div style="font-size:11px;line-height:1.45;color:' + INK + ';">'
          /* Numbered, so a card can be counted down at a glance and read back
             over the phone without losing the place. */
          /* With the time they came in beside the name, the card answers "who
             is in and when did they get here" on its own. Somebody with no
             punch yet is simply named. */
          +   k[1].map(function (r, i) {
                const at = (r.inMin != null) ? clock(r['in']) : '';
                return (i + 1) + '_' + esc(r.name)
                     + (at ? ('<span style="color:' + SOFT + ';"> (' + esc(at) + ')</span>') : '');
              }).join('<br>')
          + '</div></div></td>';
      }).join('');
      body.push('<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;margin-bottom:6px;">'
        + '<tr>' + cells + '</tr></table>');
    }
  }

  /* The day's exceptions, as the banner over the record states them. */
  if (on.late) body.push(noticeList('Late today', o.late, '#E8B931'));
  if (on.shifts) body.push(noticeList('Shift changed today', o.shifts, '#D97706'));
  if (on.wfh) body.push(noticeList('Working from home', o.wfh, '#93A4BC'));
  if (on.visits) body.push(noticeList('Visiting today', o.visits, '#7C3AED'));

  if (on.table) {
    body.push('<div style="height:16px;"></div>');
    body.push('<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;">'
      + '<tr><th align="left" style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';color:' + SOFT + ';font-weight:600;">Name</th>'
      + '<th align="left" style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';color:' + SOFT + ';font-weight:600;">In</th>'
      + '<th align="left" style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';color:' + SOFT + ';font-weight:600;">Out</th>'
      + '<th align="left" style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';color:' + SOFT + ';font-weight:600;">Day</th></tr>'
      + rows.map(function (r) {
        const colour = r.state === 'present' ? '#137A3B' : r.state === 'remote' ? '#2F6FE4'
                     : r.state === 'leave' ? '#B45309' : '#B3261E';
        return '<tr><td style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';">' + esc(r.name) + '</td>'
          + '<td style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';white-space:nowrap;">' + esc(clock(r['in']) || '—') + '</td>'
          + '<td style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';white-space:nowrap;">' + esc(clock(r.out) || '—') + '</td>'
          + '<td style="padding:6px 8px;border-bottom:1px solid ' + LINE + ';">' + pill(r.label || '', colour) + '</td></tr>';
      }).join('')
      + '</table>');

    if (o.hidden) {
      body.push('<div style="margin-top:10px;font-size:12px;color:' + SOFT + ';">'
        + esc(o.hidden + ' more on the roster ' + (o.hidden === 1 ? 'is' : 'are') + ' hidden on the portal and left out of this list.')
        + '</div>');
    }
  }

  /* The record itself, in the message rather than only clipped to it. Mail
     clients will not render a picture built into the HTML, so it is served
     from the site and fetched when the message is opened; the full-size copy
     is attached as well. */
  if (on.shot && o.shotUrl) {
    body.push('<div style="margin:20px 0 0;">'
      + '<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' + SOFT + ';margin-bottom:8px;">The record</div>'
      + '<a href="' + esc(o.shotUrl) + '" style="display:block;">'
      + '<img src="' + esc(o.shotUrl) + '" alt="The attendance record" '
      +   'style="width:100%;max-width:100%;border:1px solid ' + LINE + ';border-radius:10px;display:block;"></a>'
      + '<div style="margin-top:6px;font-size:11.5px;color:' + SOFT + ';">'
      + 'Tap the picture to open it large enough to read'
      + (o.attached ? ', or use the attachment.' : '.') + '</div></div>');
  } else if (o.attached) {
    body.push('<div style="margin-top:12px;font-size:12.5px;color:' + SOFT + ';">'
      + 'The record is attached as a picture, exactly as the portal shows it.</div>');
  }

  const footer = fillText(o.footer || words.footer, say);
  if (footer) {
    body.push('<div style="margin-top:18px;padding-top:12px;border-top:1px solid ' + LINE + ';'
      + 'font-size:12px;color:' + SOFT + ';white-space:pre-line;">' + esc(footer) + '</div>');
  }
  if (o.siteUrl) {
    body.push('<div style="margin-top:18px;">' + button(o.siteUrl, 'Open the dashboard', 'plain') + '</div>');
  }

  const subject = fillText((o.subject && o.subject.trim()) ? o.subject : words.subject, say);

  /* Gmail threads messages that share a subject and hides whatever repeats the
     one before - the greeting and the figures came through as "..." when a
     second message went out the same day. The time it was sent is on the
     header, so no two are ever quite the same. */
  const stamp = o.dateLabel + (o.sentAt ? (' \u00b7 as at ' + o.sentAt) : '');
  return { subject: subject, html: layout(o.orgName || 'Attendance', stamp, body) };
}

function leaveEmail(o) {
  const pending = o.pending || [], unreq = o.unrequested || [];
  if (!pending.length && !unreq.length) return null;   // nothing to say: no message
  const words = DEFAULT_TEXT.leave;
  const say = { n: pending.length + unreq.length, waiting: pending.length,
                unrequested: unreq.length, org: o.orgName || 'Attendance' };
  const body = [];
  const intro = fillText(o.intro || words.intro, say);
  if (intro) {
    body.push('<div style="margin:0 0 14px;font-size:13.5px;line-height:1.55;white-space:pre-line;">'
      + esc(intro) + '</div>');
  }
  if (pending.length) {
    body.push('<h3 style="font-size:14px;margin:0 0 10px;">Waiting for a decision</h3>');
    pending.forEach(function (p) { body.push(requestCard(p.req, p.links, p.heading)); });
  }
  if (unreq.length) {
    body.push('<h3 style="font-size:14px;margin:' + (pending.length ? '22px' : '0') + ' 0 4px;">Taken without a request</h3>'
      + '<div style="font-size:12.5px;color:' + SOFT + ';margin-bottom:10px;">'
      + 'Marked on the record but never approved. Rejecting removes the day.</div>');
    unreq.forEach(function (p) { body.push(requestCard(p.req, p.links, p.heading)); });
  }
  const footer = fillText(o.footer || words.footer, say);
  if (footer) {
    body.push('<div style="margin-top:18px;padding-top:12px;border-top:1px solid ' + LINE + ';'
      + 'font-size:12px;color:' + SOFT + ';white-space:pre-line;">' + esc(footer) + '</div>');
  }
  if (o.siteUrl) body.push('<div style="margin-top:18px;">' + button(o.siteUrl, 'Open the dashboard', 'plain') + '</div>');
  /* {n} everything waiting, {waiting} the requests, {unrequested} the days
     taken without one. */
  const subject = fillText((o.subject && o.subject.trim()) ? o.subject : words.subject, say);
  return {
    subject: subject,
    html: layout(o.orgName || 'Attendance', o.dateLabel || 'Leave waiting for a decision', body)
  };
}

/* The holiday reminder: what is closed, when, and how far off it is. */
function holidayEmail(o) {
  const list = o.holidays || [];
  if (!list.length) return null;
  const words = DEFAULT_TEXT.holiday;
  const first = list[0];
  const say = { name: first.name || 'Holiday', date: first.when,
                days: String(first.away == null ? '' : first.away), org: o.orgName || 'Attendance' };
  const body = [];
  const intro = fillText(o.intro || words.intro, say);
  if (intro) {
    body.push('<div style="margin:0 0 14px;font-size:13.5px;line-height:1.55;white-space:pre-line;">'
      + esc(intro) + '</div>');
  }
  list.forEach(function (h) {
    body.push('<div style="border:1px solid ' + LINE + ';border-left:3px solid #B45309;border-radius:10px;'
      + 'padding:12px 14px;margin:0 0 10px;">'
      + '<div style="font-size:15px;font-weight:700;">' + esc(h.name || 'Holiday') + '</div>'
      + '<div style="font-size:13px;color:' + SOFT + ';margin-top:3px;">' + esc(h.when)
      +   (h.away != null ? (' \u00b7 ' + (h.away === 0 ? 'today' : h.away === 1 ? 'tomorrow'
                             : ('in ' + h.away + ' days'))) : '') + '</div>'
      + (h.note ? ('<div style="font-size:12.5px;margin-top:6px;">' + esc(h.note) + '</div>') : '')
      + '</div>');
  });
  const footer = fillText(o.footer || words.footer, say);
  if (footer) {
    body.push('<div style="margin-top:16px;padding-top:12px;border-top:1px solid ' + LINE + ';'
      + 'font-size:12px;color:' + SOFT + ';white-space:pre-line;">' + esc(footer) + '</div>');
  }
  if (o.siteUrl) body.push('<div style="margin-top:16px;">' + button(o.siteUrl, 'Open the dashboard', 'plain') + '</div>');
  const subject = fillText((o.subject && o.subject.trim()) ? o.subject : words.subject, say);
  return { subject: subject, html: layout(o.orgName || 'Attendance', 'A holiday is coming up', body) };
}

/* One new request, sent as it is raised. */
function requestEmail(o) {
  const r = o.req;
  return {
    subject: (r.leaveType === 'PUNCH' ? 'Punch correction' : kindName(r.leaveType)) + ' · ' + r.empName
             + ' · ' + dateRange(r.dateFrom, r.dateTo),
    html: layout(o.orgName || 'Attendance', 'A request is waiting for a decision', [
      o.intro ? ('<div style="margin:0 0 14px;font-size:13.5px;line-height:1.55;white-space:pre-line;">'
                 + esc(o.intro) + '</div>') : '',
      requestCard(r, o.links, 'Raised ' + (r.createdAt ? fmtDay(String(r.createdAt).slice(0, 10)) : 'just now')),
      o.footer ? ('<div style="margin-top:16px;padding-top:12px;border-top:1px solid ' + LINE + ';'
                  + 'font-size:12px;color:' + SOFT + ';white-space:pre-line;">' + esc(o.footer) + '</div>') : '',
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
  esc, stripHtml, layout, button, kindName, dateRange, fmtDay,
  dailyEmail, leaveEmail, holidayEmail, requestEmail, requestCard, confirmPage, resultPage, clock,
  DEFAULT_TEXT, fillText
};
