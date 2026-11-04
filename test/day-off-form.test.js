/* The day-off form is the one thing in this system that leaves it on paper:
   somebody signs it and it goes in a file. So the names on it have to be
   names. "Request Approved By: support@homeweavers.net" is a sentence about a
   mailbox, and it was also what the form signed off with. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}

function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; k++;
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
      continue;
    }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* The two lookups the form leans on, run for real. */
const ctx = { authAccounts: {}, empNames: {}, Object, String, console };
vm.createContext(ctx);
vm.runInContext(grab(APP, 'approverLabel'), ctx);
vm.runInContext(grab(APP, 'dispName'), ctx);

ctx.authAccounts = {
  'support@homeweavers.net': { role: 'admin', emp: 'Portal Admin' },
  'KARAN@homeweavers.net':   { role: 'admin', emp: 'karan Ahuja' },
  'nobody@homeweavers.net':  { role: 'admin' }            // a login with no person behind it
};
ctx.empNames = { 'karan Ahuja': 'Karan Ahuja' };

/* ---- the lookup itself ---- */
check('an address with a person behind it reads as that person',
  ctx.approverLabel('support@homeweavers.net') === 'Portal Admin', null);
check('and the spelling of the address does not matter',
  ctx.approverLabel('karan@homeweavers.net') === 'karan Ahuja', null);
check('an address with nobody behind it stays an address',
  ctx.approverLabel('nobody@homeweavers.net') === 'nobody@homeweavers.net', null);
check('and so does one the record has never heard of',
  ctx.approverLabel('stranger@example.com') === 'stranger@example.com', null);
/* The name shown on the form is the name shown everywhere else. */
check('the name is the one the office has chosen to show',
  ctx.dispName(ctx.approverLabel('karan@homeweavers.net')) === 'Karan Ahuja', null);

/* ---- and the order the form picks in ----
   A signature name beats the account, the account beats the address, and the
   same answer goes on the approval line and the sign-off: they are the same
   person, and the form said one of them twice over as an address. */
{
  const src = grab(APP, 'printDayOffForm');
  check('the form asks the account who the address belongs to',
    /var byAcct = byEmail \? '' : approverLabel\(req\.approvedBy\);/.test(src), null);
  check('and shows that person the way the record shows them',
    /if\(byAcct && byAcct !== req\.approvedBy\) byAcct = dispName\(byAcct\);/.test(src), null);
  check('a signature name comes first, the account second, the address last',
    /var signName = \(byParts\[0\] \|\| ''\)\.trim\(\) \|\| byAcct \|\| \(byEmail \? '' : \(req\.approvedBy \|\| ''\)\);/
      .test(src), null);
  check('the approval line and the sign-off name the same person',
    /var approver = byEmail \? 'Approved by email' : signName;/.test(src), null);
  /* A decision taken from a button in an email is stored as the word "email",
     which is not an address and not a person. */
  check('a decision taken from a message still says so',
    src.indexOf("'Approved by email'") > -1, null);
  check('and the approval line is still the field it always was',
    /field\('Request Approved By:', approver, 205\)/.test(src), null);

  /* The address is not on the approval line and is in the sign-off. The line
     above says who agreed to this; the sign-off is what somebody holding the
     paper a year later writes to. */
  check('the address is kept for the sign-off',
    /var approverMail = \(!byEmail && String\(req\.approvedBy \|\| ''\)\.indexOf\('@'\) > -1\)/
      .test(src), null);
  check('and goes beside the name there, not instead of it',
    /<span class="dof-sigmail">' \+ \(signName \? ' .{1,8} ' : ''\)/.test(src), null);
  check('a name that is already the address is not printed twice',
    /approverMail && approverMail !== signName/.test(src), null);
  /* Beside and not under: a line of its own would push the company and the
     title down an A4 sheet that has a printed foot waiting at the bottom. */
  check('the sign-off still ends with the company where it always did',
    /dof-sigln big" style="top:751.7pt">' \+ shotEsc\(coName/.test(src), null);
}

console.log(fail ? ('FAILED (' + fail + ' of ' + (pass + fail) + ')')
                 : ('ALL PASS (' + pass + ' checks)'));
process.exit(fail ? 1 : 0);
