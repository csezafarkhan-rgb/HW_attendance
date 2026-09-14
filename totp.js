'use strict';
/* Two-step sign-in codes: the 6-digit, 30-second codes that Google
   Authenticator, Microsoft Authenticator and similar apps show (RFC 6238),
   plus one-time recovery codes for when the phone is lost. Node's crypto
   only - no extra package. */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function newSecret() { return base32Encode(crypto.randomBytes(20)); }

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
function stepNow(ms) { return Math.floor((ms == null ? Date.now() : ms) / 1000 / STEP_SECONDS); }

/* The step a code belongs to, or -1. One step either side is accepted for a
   phone clock that is a little off; a step at or before lastStep is refused,
   so a code that was already used cannot be used again. */
function verify(secret, code, lastStep, ms) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return -1;
  const now = stepNow(ms);
  for (const s of [now, now - 1, now + 1]) {
    if (lastStep != null && s <= lastStep) continue;
    const expected = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return -1;
}

function otpauthUri(secret, account, issuer) {
  const label = encodeURIComponent(issuer + ':' + account);
  return 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=6&period=' + STEP_SECONDS;
}

// Recovery codes: xxxx-xxxx without look-alike characters, stored only as hashes.
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function normaliseRecovery(code) { return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function hashRecovery(code) { return crypto.createHash('sha256').update(normaliseRecovery(code)).digest('hex'); }
function newRecoveryCodes(n) {
  const codes = [];
  for (let i = 0; i < (n || 10); i++) {
    let s = '';
    const bytes = crypto.randomBytes(8);
    for (let j = 0; j < 8; j++) s += RC_ALPHABET[bytes[j] % RC_ALPHABET.length];
    codes.push(s.slice(0, 4) + '-' + s.slice(4));
  }
  return codes;
}
/* The hashes left after using code, or null when it matches none. */
function useRecovery(hashes, code) {
  if (!Array.isArray(hashes) || normaliseRecovery(code).length !== 8) return null;
  const h = hashRecovery(code);
  const i = hashes.indexOf(h);
  if (i === -1) return null;
  return hashes.slice(0, i).concat(hashes.slice(i + 1));
}

module.exports = { newSecret, codeAt, stepNow, verify, otpauthUri, newRecoveryCodes, hashRecovery, useRecovery, base32Encode, base32Decode };
