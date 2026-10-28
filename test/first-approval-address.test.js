// Pick a name in the first-approval pane and it says who the office's own
// approver is, in a box that looks like the one you would type their address
// into. Somebody checking where Zafar's leave goes read support@ and believed
// it, while his requests had been going to karan@ all along.
//
// And the address named against one person could be written to and never
// copied: the Cc beneath it belongs to the office's own line.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

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
    if (c === '"' || c === "'") { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* ---- where one person's first message goes ---- */
{
  const ctx = { console, EMAIL_RE: /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/ };
  vm.createContext(ctx);
  vm.runInContext(grab(SRV, 'legFor'), ctx);
  const settings = { leave: { firstTo: ['support@hw.net'], firstCc: ['office@hw.net', 'support@hw.net'] } };
  const FALL = 'support@hw.net';

  /* The office's own line is shared by everybody who has nobody named against
     them, so it keeps the To and Cc it was configured with. */
  const office = ctx.legFor(settings, FALL, FALL, {});
  check('the office’s own approver keeps the line the panel sets',
    office.to.join() === 'support@hw.net' && office.cc.join() === 'office@hw.net', office);

  /* An address named against one person gets a message about them alone - and
     now a copy list of its own, which it never had. */
  const named = ctx.legFor(settings, 'karan@hw.net', FALL,
    { 'karan@hw.net': ['hr@hw.net', 'nitish@hw.net'] });
  check('somebody named against one person is written to on their own',
    named.to.join() === 'karan@hw.net', named.to);
  check('and the office’s copy list is not quietly borrowed for them',
    named.cc.indexOf('office@hw.net') === -1, named.cc);
  check('their own copy list is used instead',
    named.cc.join() === 'hr@hw.net,nitish@hw.net', named.cc);
  check('with none set, nobody is copied',
    ctx.legFor(settings, 'karan@hw.net', FALL, {}).cc.length === 0);
  check('and a missing map is not an error',
    ctx.legFor(settings, 'karan@hw.net', FALL).cc.length === 0);

  /* It is a stored map that decides who a message reaches, so it is read
     rather than believed. */
  const messy = ctx.legFor(settings, 'karan@hw.net', FALL,
    { 'karan@hw.net': ['  HR@hw.net ', 'not an address', '', 'hr@hw.net', 'karan@hw.net', null] });
  check('rubbish in the list is dropped rather than handed to the mailer',
    messy.cc.indexOf('not an address') === -1 && messy.cc.indexOf('') === -1, messy.cc);
  check('the same address twice is one copy',
    messy.cc.length === 1 && messy.cc[0] === 'hr@hw.net', messy.cc);
  check('and the approver is not copied on their own message',
    messy.cc.indexOf('karan@hw.net') === -1, messy.cc);
}

/* ---- it is read wherever a first-stage message is addressed ----
   Three places build one: the nightly summary, a request as it is raised, and
   leave marked on the grid without a request. A copy list honoured in one of
   them and forgotten in the others is worse than none. */
{
  check('the map is read from its own shared key',
    /async function approverCcOf\(orgId\) \{[\s\S]{0,260}sharedKeys\(orgId, \['approverCc'\]\)/.test(SRV));
  check('a map is required of it, not whatever was stored',
    /approverCc[\s\S]{0,200}typeof map === 'object' && !Array\.isArray\(map\)/.test(SRV));
  const calls = (SRV.match(/(function )?legFor\([^)]*\)/g) || [])
    .filter(c => c.indexOf('function ') !== 0);                        // not the declaration
  check('every first-stage message is addressed with it in hand',
    calls.length === 3 && calls.every(c => /, (ccMap|markCc)\)$/.test(c)), calls);
  check('and it is fetched once rather than once per message',
    (SRV.match(/await approverCcOf\(orgId\)/g) || []).length === 3, SRV.match(/await approverCcOf\(orgId\)/g));
}

/* ---- the pane says it, instead of leaving it to be inferred ---- */
{
  const pane = APP.slice(APP.indexOf('function lvWhoRender('), APP.indexOf('function lvWhoSharing('));
  check('the person’s own To is shown with them',
    pane.indexOf('id="emLvWhoTo"') > -1);
  check('and is not typed here, because it is whoever was chosen above',
    /id="emLvWhoTo" readonly/.test(pane));
  check('it reads the address named against them, not the office’s line',
    pane.indexOf('mailEscape(lvWhoTo(own))') > -1);
  check('and a Cc sits beside it',
    pane.indexOf('id="emLvWhoCc"') > -1);
  check('which is their approver’s own list where one is named',
    pane.indexOf("mailEscape(own ? ccFor(own).join(', ') : lvFirstCcText())") > -1);
  /* The office's own line is further down the same pane: picking somebody who
     goes through it must show what is in those boxes now, not what was saved
     before the last keystroke. */
  const helpers = APP.slice(APP.indexOf('function lvFirstToText('), APP.indexOf('function lvWhoSharing('));
  check('the office’s line is read from the boxes as they stand',
    helpers.indexOf("getElementById('emLvFirstTo')") > -1
    && helpers.indexOf("getElementById('emLvFirstCc')") > -1);
  check('and falls back to the approver the office named',
    helpers.indexOf('usual.email') > -1);
  check('with nobody named at all, it says so rather than showing an empty box',
    helpers.indexOf('nobody named yet') > -1);
  check('the pane says which of the two lines is being shown',
    pane.indexOf('named against ') > -1 && pane.indexOf('own line, further down') > -1);
}

/* ---- typing in it ---- */
{
  const wire = APP.slice(APP.indexOf('function lvWhoWire('), APP.indexOf('var pick = document.getElementById(\'emLvWho\')'));
  check('an address that is not an address is not stored',
    /filter\(function\(a\)\{ return \/\^\[\^@\\s\]\+@/.test(wire), wire.slice(wire.indexOf('cc.onchange'), wire.indexOf('cc.onchange') + 400));
  check('against a named approver it is kept against that address',
    /approverCc\[k\] = list; else delete approverCc\[k\]/.test(wire));
  check('and saved as it is typed, like the wording beside it',
    /saveApproverCc\(\)\.then\(function\(\)\{ lvWhoRender\(name\); \}\)/.test(wire));
  /* The other case is the office's own Cc, which already has a box. A second
     copy of it here could disagree with the first. */
  check('for the office’s own approver it writes into that one box instead',
    wire.indexOf("var box = document.getElementById('emLvFirstCc');") > -1
    && wire.indexOf('box.value = list.join') > -1);
  check('and does not also keep a copy of its own',
    /if\(!own\)\{[\s\S]{0,220}return;/.test(wire));

  check('the map is loaded with everything else at startup',
    APP.indexOf('loadApprovalRoute, loadApproverIntro, loadApproverCc,') > -1);
  check('and goes into the backup like every other setting',
    /BACKUP_KEYS = \[[\s\S]{0,900}'approverCc'/.test(APP));
  check('nothing but an array is taken as a list of addresses',
    /function ccFor\(email\)\{[\s\S]{0,200}Array\.isArray\(v\) \? v\.slice\(\) : \[\]/.test(APP));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
