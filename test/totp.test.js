// totp.js against the RFC 6238 SHA-1 test vectors, and the recovery codes.
'use strict';
const path = require('path');
const totp = require(path.join(__dirname, '..', 'totp.js'));

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
check('base32 of the RFC secret', secret === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', secret);
check('base32 round trip', totp.base32Decode(secret).toString() === '12345678901234567890');
const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
check('RFC 6238 codes', vectors.every(([t, c]) => totp.codeAt(secret, Math.floor(t / 30)) === c),
  vectors.map(([t]) => totp.codeAt(secret, Math.floor(t / 30))));

const ms = 1234567890 * 1000, step = Math.floor(1234567890 / 30);
check('the current code is accepted, and says its step', totp.verify(secret, '005924', null, ms) === step);
check('a code one step old is accepted (slow phone clock)', totp.verify(secret, totp.codeAt(secret, step - 1), null, ms) === step - 1);
check('a code two steps old is not', totp.verify(secret, totp.codeAt(secret, step - 2), null, ms) === -1);
check('a code at or before the last used step is refused', totp.verify(secret, '005924', step, ms) === -1);
check('spaces are ignored', totp.verify(secret, '005 924', null, ms) === step);
check('not six digits is refused', totp.verify(secret, '5924', null, ms) === -1 && totp.verify(secret, 'abcdef', null, ms) === -1);
check('new secrets are 32 base32 characters', /^[A-Z2-7]{32}$/.test(totp.newSecret()));

const codes = totp.newRecoveryCodes(10);
check('10 recovery codes, xxxx-xxxx, all different', codes.length === 10 && codes.every(c => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(c)) && new Set(codes).size === 10, codes);
const hashes = codes.map(totp.hashRecovery);
const left = totp.useRecovery(hashes, codes[3].toUpperCase().replace('-', ' '));
check('a recovery code is used up, typed in any case', Array.isArray(left) && left.length === 9 && left.indexOf(hashes[3]) === -1);
check('a used or unknown recovery code is refused', totp.useRecovery(left, codes[3]) === null && totp.useRecovery(hashes, 'aaaa-aaaa') === null);
check('app link carries the key and issuer', /^otpauth:\/\/totp\/HW%20Attendance%3Aa%40b\.com\?secret=GEZ.*&issuer=HW%20Attendance/.test(totp.otpauthUri(secret, 'a@b.com', 'HW Attendance')));

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
