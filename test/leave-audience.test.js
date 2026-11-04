// Who a leave message is addressed to.
//
// There used to be two stages: somebody looked at a request first and passed
// it on, a second word granted it, and almost everything here was machinery
// for working out which stage a message belonged to - who held it, whose
// people they held it for, what each stage was allowed to see. One word
// settles a request now, so none of that is a question any more.
//
// What is left is the question the office was actually asking all along: who
// may decide this. TO is everybody who may; CC is everybody else; and a CC
// copy carries no buttons, which is the only thing that makes "they cannot
// approve it" true rather than a convention. The buttons are the authority,
// so the way to withhold the authority is to withhold the buttons.
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
    if (c === '"' || c === "'" || c === '`') { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* The office's own arrangement, which is the thing worth testing: the owners
   on every message, the Gurgaon office through its manager, the Panipat
   factory through its own and the Gurgaon one both. */
const MGMT = ['nitish@homeweavers.net', 'shivani@homeweavers.net'];
const KARAN = 'karan@homeweavers.net';
const MUNISH = 'munish@homeweavers.net';
const ADDR = {
  'Nitish Kumar': 'nitish@homeweavers.net', 'Shivani Dutt': 'shivani@homeweavers.net',
  'karan Ahuja': KARAN, 'Munish Dhamija': MUNISH,
  'Rahul Mishra': 'rahul@homeweavers.net', 'Aman Chandra': 'amanc@homeweavers.net',
  'Keshav Garg': 'keshav@homeweavers.net', 'Zafar Khan': 'zafar@homeweavers.net',
  'Himanshu': 'himanshu@homeweavers.net', 'Aman Gupta': 'amang@homeweavers.net',
  'Shyam Lal ESS': 'shyam@homeweavers.net',
};
const ROUTE = {
  'Rahul Mishra': [KARAN], 'Aman Chandra': [KARAN], 'Keshav Garg': [KARAN],
  'Zafar Khan': [KARAN], 'Himanshu': [KARAN], 'Aman Gupta': [KARAN],
  'Shyam Lal ESS': [MUNISH, KARAN],
  'karan Ahuja': [], 'Munish Dhamija': [], 'Nitish Kumar': [],
};

const ctx = {
  EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  mailRecipients: async () => MGMT.slice(),
  employeeAddress: async (org, name) => ADDR[name] || '',
  mailCc: (settings) => ((settings.leave || {}).cc || []),
  Object, Array, String, console,
};
vm.createContext(ctx);
['approversOf', 'allApprovers'].forEach(n => vm.runInContext(grab(SRV, n), ctx));
vm.runInContext('async ' + grab(SRV, 'leaveAudience'), ctx);

const audience = (name, route, cc) =>
  ctx.leaveAudience(1, { leave: { cc: cc || [] } }, route === undefined ? ROUTE : route, name);
const sorted = a => a.slice().sort();

(async () => {
  /* ---- whoever is named, and nobody else ----
     The management used to be added to every leave email whether or not they
     were named. They are a column on the table now, the same as anybody else,
     and they get the message where they are ticked. */
  let a = await audience('Keshav Garg');
  check('somebody in the Gurgaon office: the manager named against them decides',
    JSON.stringify(sorted(a.to)) === JSON.stringify([KARAN]), a.to);
  check('and an owner nobody named against them is not on it at all',
    MGMT.every(m => a.to.indexOf(m) === -1 && a.cc.indexOf(m) === -1), [a.to, a.cc]);
  check('and they are told of it themselves, without a say in it',
    JSON.stringify(a.cc) === JSON.stringify(['keshav@homeweavers.net']), a.cc);

  a = await audience('Shyam Lal ESS');
  check('somebody at the factory: both the managers named against them',
    JSON.stringify(sorted(a.to)) === JSON.stringify(sorted([MUNISH, KARAN])), a.to);
  check('two names against one person are both read, not just the first',
    a.to.indexOf(MUNISH) > -1 && a.to.indexOf(KARAN) > -1, a.to);

  /* ---- and a row with nobody on it ----
     The one rule kept without being asked for. An empty row otherwise leaves
     somebody's leave with nobody able to answer it, and a request that can
     never be decided is worse than one decided by the wrong person. */
  a = await audience('Aman Chandra', { 'Aman Chandra': [] });
  check('nobody named at all: the management decide',
    JSON.stringify(sorted(a.to)) === JSON.stringify(sorted(MGMT)), a.to);
  a = await audience('Aman Chandra', {});
  check('and a row that was never written reads the same way',
    JSON.stringify(sorted(a.to)) === JSON.stringify(sorted(MGMT)), a.to);
  /* An owner ticked against somebody is in TO because they were ticked, not
     because they are an owner - which looks the same until nobody else is
     ticked and they are the only name on it. */
  a = await audience('Aman Chandra', { 'Aman Chandra': [MGMT[0]] });
  check('an owner ticked alone decides alone',
    JSON.stringify(a.to) === JSON.stringify([MGMT[0]]), a.to);

  /* ---- and nobody decides their own ---- */
  a = await audience('karan Ahuja');
  check('a manager asking for leave is asking, not granting',
    JSON.stringify(sorted(a.to)) === JSON.stringify(sorted(MGMT)), a.to);
  check('his own copy is the one that cannot decide it',
    JSON.stringify(a.cc) === JSON.stringify([KARAN]), a.cc);
  a = await audience('Munish Dhamija');
  check('and the same for the factory’s manager',
    JSON.stringify(sorted(a.to)) === JSON.stringify(sorted(MGMT))
    && JSON.stringify(a.cc) === JSON.stringify([MUNISH]), [a.to, a.cc]);
  /* The hard case: an owner's own leave. They are on every message by
     standing, so this is the one place the rule has to beat the standing. */
  a = await audience('Nitish Kumar');
  check('an owner’s own leave does not come addressed to himself',
    JSON.stringify(a.to) === JSON.stringify(['shivani@homeweavers.net'])
    && JSON.stringify(a.cc) === JSON.stringify(['nitish@homeweavers.net']), [a.to, a.cc]);

  /* ---- somebody the office has not placed ---- */
  a = await audience('Habib', {});
  check('nobody named against them means the owners, and nothing silently else',
    JSON.stringify(sorted(a.to)) === JSON.stringify(sorted(MGMT)), a.to);
  /* 'final' meant "no first stage" while there were stages. It means the same
     thing now - nobody else named - so an office that never opens the panel
     keeps the arrangement it already had. */
  check('a row still reading “final” from the old arrangement means the same thing',
    JSON.stringify(ctx.approversOf({ x: 'final' }, 'x')) === '[]');
  check('and a row holding one bare address, as the old one did, still reads',
    JSON.stringify(ctx.approversOf({ x: KARAN }, 'x')) === JSON.stringify([KARAN]));
  check('rubbish in a row is dropped rather than written to',
    JSON.stringify(ctx.approversOf({ x: ['not-an-address', KARAN, KARAN] }, 'x'))
      === JSON.stringify([KARAN]));

  /* ---- the office's standing copy list ---- */
  a = await audience('Keshav Garg', ROUTE, ['watch@homeweavers.net']);
  check('an address in the Cc box is told, never asked',
    a.to.indexOf('watch@homeweavers.net') === -1
    && a.cc.indexOf('watch@homeweavers.net') > -1, [a.to, a.cc]);
  /* Somebody who may decide does not also get a second copy that cannot. */
  a = await audience('Keshav Garg', ROUTE, [KARAN, 'watch@homeweavers.net']);
  check('somebody who may decide is not also sent a copy that cannot',
    a.to.indexOf(KARAN) > -1 && a.cc.indexOf(KARAN) === -1, [a.to, a.cc]);
  /* Case and stray spacing are the office's, not the rule's. */
  a = await audience('Keshav Garg', { 'Keshav Garg': ['  KARAN@Homeweavers.NET '] });
  check('an address typed in capitals is the same address',
    JSON.stringify(a.to) === JSON.stringify([KARAN]), a.to);

  /* ---- every address that may decide anything, for the panel to show ---- */
  check('the panel can be told who is named anywhere',
    JSON.stringify(sorted(ctx.allApprovers(ROUTE))) === JSON.stringify(sorted([KARAN, MUNISH])),
    ctx.allApprovers(ROUTE));

  /* ---- one message, and only some of the people on it can act ----

     This used to be two messages: the deciding copy carried links and the
     told copy carried null, and withholding the buttons was the whole of
     "CC cannot approve". It had to be, because a signed link decided a
     request for whoever was holding it.

     That is no longer where the authority sits. One message goes to everybody
     now, buttons and all, and whether a press counts is decided from the
     account pressing it. So the thing to check is no longer who was handed
     what, but who the gate lets through. */
  const raised = grab(SRV, 'notifyNewRequests');
  check('the message carries the buttons',
    /links: linksFor\(\{ k: 'req', org: orgId, id: r\.id, s: 0 \}\)/.test(raised), null);
  check('and there is one of it',
    (raised.match(/await mailer\.send\(/g) || []).length === 1, null);
  check('to the people who may decide, with the people who are only told on Cc',
    /const toMsg = \{ to: aud\.to, cc: aud\.cc, subject: decide\.subject/.test(raised), null);
  const gate = grab(SRV, 'decidableBy');
  check('a press is weighed against the account, not against the link',
    /SELECT email FROM users WHERE id = \$1/.test(gate), null);
  check('and it counts only if that account is one the message went TO',
    /if \(aud\.to\.indexOf\(mine\) > -1\) return \{ how: 'yes' \};/.test(gate), null);
  check('which is the list nobody is on for their own leave',
    /if \(!EMAIL_RE\.test\(k\) \|\| k === own \|\| seen\[k\]\) return;/.test(SRV), null);
  check('signed out, nothing is decided',
    /if \(!req\.session \|\| !req\.session\.userId\) return \{ how: 'signin' \};/.test(gate), null);
  check('the card still draws no buttons when it is handed none',
    /\(links \? \('<div style="margin-top:12px;">'/.test(
      fs.readFileSync(path.join(REPO, 'mailer.js'), 'utf8')), null);

  /* ---- the digest asks the same question ---- */
  const digest = grab(SRV, 'leaveDigests');
  check('the digest is gathered by who may decide, not by who is senior',
    /aud\.to\.forEach\(a => \{/.test(digest), null);
  check('and each message holds only what that person may answer',
    /out\.push\(\{ to: \[addr\], cc: \[\], subject: mail\.subject/.test(digest), null);
  /* The name is sealed into the link, so the record can say who approved it
     without trusting anything a browser sends. */
  check('the button carries the name of whoever it was sent to',
    /links: linksFor\(\{ k: 'req', org: orgId, id: r\.id, s: 1, by: byName \}\)/.test(digest), null);

  /* ---- and the machinery that is gone is gone ----
     Dead code in a system this heavily commented is not merely unused, it is
     misleading: it describes an arrangement the office no longer has. */
  ['stageOwns', 'stageOwnsUnreq', 'legFor', 'firstApprovers', 'firstWords',
   'approverIntroOf', 'approverCcOf', 'needsFirstApproval', 'firstApproverOf',
   'approverFor', 'ownersIfAlone', 'requestLinks'].forEach(n => {
    check('nothing is left of ' + n, SRV.indexOf('function ' + n + '(') === -1);
  });
  check('and the settings have no first-stage lines left to fill in',
    !/firstTo|firstCc|firstIntro/.test(SRV), null);

  /* ---- what is taken and what is asked for is the office's to decide ----
     It used to be settled in the code: both were taken. Now each kind is one
     or the other, and the two sides of that rule read the same setting - so
     nothing can be both, and nothing can be neither. */
  check('the merge refuses a request for a kind that is taken',
    /if \(\(selfKinds \|\| \[\]\)\.indexOf\(String\(r\.leaveType \|\| ''\)\.toUpperCase\(\)\) > -1\) return;/
      .test(grab(SRV, 'mergeEmployeeRequests')), null);
  check('and is told which those are rather than deciding for itself',
    /mergeEmployeeRequests\(stored, value, \(req\.user && req\.user\.name\) \|\| '',\s*selfKindsOf\(await leavePolicy\(req\.session\.orgId\)\)\)/
      .test(SRV), null);
  check('the route that grants one refuses a kind that is asked for',
    /if \(kind && \(await leavePolicy\(orgId\)\)\[kind\] !== 'self'\)/.test(grab(SRV, 'takePartDay')), null);
  check('anything already asked for before still stands',
    /Only new ones: anything already asked for stands/.test(SRV), null);

  /* ---- the table the office reads it off ----
     The page has to read a row exactly as the server does, or the screen will
     describe an arrangement the messages do not follow. */
  {
    const p = { approvalRoute: {}, MAIL_CFG: { settings: { leave: { approvers: [] } } },
                accountNames: {}, authAccounts: {}, Object, String, console };
    vm.createContext(p);
    ['approversFor', 'managementAddrs', 'approverColumns', 'approverLabel']
      .forEach(n => vm.runInContext(grab(APP, n), p));
    p.approvalRoute = { 'Keshav Garg': [KARAN], 'Shyam Lal ESS': [MUNISH, KARAN],
                        'karan Ahuja': [], 'Old Hand': KARAN, 'Older Hand': 'final' };
    check('the page reads a row the same way the server does',
      JSON.stringify(p.approversFor('Shyam Lal ESS')) === JSON.stringify([MUNISH, KARAN]),
      p.approversFor('Shyam Lal ESS'));
    check('including the two shapes a row used to come in',
      JSON.stringify(p.approversFor('Old Hand')) === JSON.stringify([KARAN])
      && JSON.stringify(p.approversFor('Older Hand')) === JSON.stringify([]),
      [p.approversFor('Old Hand'), p.approversFor('Older Hand')]);
    check('and somebody nobody has placed has nobody named',
      JSON.stringify(p.approversFor('Nobody At All')) === JSON.stringify([]));
    check('the columns are everybody named anywhere, each once',
      JSON.stringify(p.approverColumns().sort()) === JSON.stringify([KARAN, MUNISH].sort()),
      p.approverColumns());
    /* Nominated but not yet given anybody: still a column, or there would be
       no box to tick. */
    p.MAIL_CFG.settings.leave.approvers = ['newboss@homeweavers.net'];
    check('an approver nominated but not yet named against anybody is a column too',
      p.approverColumns().indexOf('newboss@homeweavers.net') > -1, p.approverColumns());
    /* A column headed with a person rather than a mailbox, where the server
       knows whose account the address is. It used to ask authAccounts, which
       is the old local-login file and has never held any of these - so every
       column was headed with an address and so was the day-off form. */
    p.accountNames = { [KARAN]: 'karan Ahuja' };
    check('a column is headed with the person where an account knows them',
      p.approverLabel(KARAN) === 'karan Ahuja' && p.approverLabel(MUNISH) === MUNISH);
  }

  /* ---- and the form asks for exactly what is not taken ---- */
  {
    const form = APP.slice(APP.indexOf('<select id="reqLeaveType">'),
                           APP.indexOf('id="reqDateFrom"'));
    /* Nothing part-day is written into the form by hand. Both are put there,
       or left out, by the one function that reads the setting - so the form
       cannot drift out of step with the card. */
    check('the request form hard-codes no part day either way',
      form.indexOf('value="SHORT"') === -1 && form.indexOf('value="HALF"') === -1, form.length);
    const sync = grab(APP, 'syncRequestTypes');
    check('it offers the ones that must be asked for',
      /if\(!askedFor\(k\.v\)\) return;/.test(sync), null);
    check('and says where the others are taken instead',
      /take it on your[\s\S]{0,40}attendance card/.test(sync), null);
    /* The whole-day kinds are untouched: a day away is still somebody else's
       day to plan around. */
    check('a day of leave is still asked for',
      form.indexOf('value="CL"') > -1 && form.indexOf('value="Sick"') > -1
      && form.indexOf('value="WFH"') > -1, null);
    /* The office still marks them on the grid, for anybody, which is how an
       admin takes one. */
    check('the office can still mark one on the grid',
      /value="HALF"'\+\(hdCur&&hdCur\.kind==='HALF'\?' selected':''\)/.test(APP), null);
    /* And the card still takes one at once. */
    check('and the card still takes one at once',
      /fetch\('\/api\/part-day'/.test(APP), null);
  }

  /* ---- what counts as still waiting ----
     A request carrying a first approval from before leave took one word is
     still undecided, and the list has always shown it so. The two counts had
     their own older idea of it, which left the one request that needed an
     answer shown by the list and counted by neither: Waiting 0 directly above
     the card, and no badge in the sidebar at all. It sat four days. */
  {
    const fn = new Function(grab(APP, 'reqIsWaiting') + '\nreturn reqIsWaiting;')();
    check('a request nobody has answered is waiting', fn({ status: 'pending' }));
    check('one that was asked a question back is waiting', fn({ status: 'query' }));
    check('and one carrying a first approval from the old two-word flow is waiting',
      fn({ status: 'recommended' }));
    check('a settled one is not', !fn({ status: 'approved' }) && !fn({ status: 'rejected' }));
    check('the sidebar badge asks this and nothing of its own',
      /return !r\.archived && reqIsWaiting\(r\);/.test(APP));
    check('the Waiting tab counts by the same question',
      /waiting:  live\.filter\(reqIsWaiting\)\.length,/.test(APP));
    check('and the list it sits above is filtered by it too',
      /if\(REQ_VIEW === 'live'\)     return reqIsWaiting\(r\);/.test(APP));
    check('and no reading of “waiting” is left spelled out beside it',
      APP.split("status === 'pending' || ").length === 2);
    check('and the server waits on the same three',
      /const WAITING = \['pending', 'query', 'recommended'\];/.test(SRV));
  }

  const bad = results.filter(x => !x).length;
  console.log(bad ? ('FAILED ' + bad + ' of ' + results.length)
                  : ('ALL PASS (' + results.length + ' checks)'));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
