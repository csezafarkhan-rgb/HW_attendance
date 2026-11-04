/* One set of words, several different people.
 *
 * Leave is gathered by whoever may decide it - a message each - and a new
 * request goes to everybody who may decide that one. So the office's wording
 * is read by people it was not written for, and "Hello Shivani ma'am / Nitish
 * Sir" arrives on Karan's copy.
 *
 * {approver} is whoever the copy in hand is going to.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

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

const REQ = { id: 'r1', empName: 'Keshav Garg', dateFrom: '2026-11-10', dateTo: '2026-11-11',
              leaveType: 'CL', message: 'family', status: 'pending' };
const INTRO = 'Hello {approver},\n\nThe leave below is waiting for a decision.';

/* ---- the digest: one person, named ---- */
{
  const mail = mailer.leaveEmail({
    orgName: 'Test Co', intro: INTRO, footer: 'Regards', approver: 'karan Ahuja',
    pending: [{ req: REQ, links: { approve: 'https://x/a', reject: 'https://x/r' } }],
    unrequested: [], siteUrl: 'https://x'
  });
  check('the copy going to Karan greets Karan',
    mail.html.indexOf('Hello karan Ahuja,') > -1, null);
  check('and the placeholder is gone from it',
    mail.html.indexOf('{approver}') === -1, null);
}
/* Two of them on one message are both named, and read as a sentence. */
{
  const mail = mailer.leaveEmail({
    orgName: 'Test Co', intro: INTRO, footer: 'Regards',
    approver: 'Shivani Dutt and Nitish Kumar',
    pending: [{ req: REQ, links: { approve: 'https://x/a', reject: 'https://x/r' } }],
    unrequested: [], siteUrl: 'https://x'
  });
  check('two people on one message are both greeted',
    mail.html.indexOf('Hello Shivani Dutt and Nitish Kumar,') > -1, null);
}
/* Wording with no token in it is left exactly as the office wrote it. */
{
  const mail = mailer.leaveEmail({
    orgName: 'Test Co', intro: 'Dear all,\n\nPlease look.', footer: 'Regards',
    approver: 'karan Ahuja',
    pending: [{ req: REQ, links: { approve: 'https://x/a', reject: 'https://x/r' } }],
    unrequested: [], siteUrl: 'https://x'
  });
  check('wording without the token is untouched',
    mail.html.indexOf('Dear all,') > -1 && mail.html.indexOf('karan Ahuja,') === -1, null);
}
/* ---- a new request: the same words, the two copies ---- */
{
  const decide = mailer.requestEmail({
    orgName: 'Test Co', req: REQ, siteUrl: 'https://x', intro: INTRO, footer: 'Regards',
    approver: 'karan Ahuja, Shivani Dutt and Nitish Kumar',
    links: { approve: 'https://x/a', reject: 'https://x/r' },
    heading: 'A request is waiting for a decision'
  });
  check('the deciding copy greets everybody who may decide it',
    decide.html.indexOf('Hello karan Ahuja, Shivani Dutt and Nitish Kumar,') > -1, null);
  const told = mailer.requestEmail({
    orgName: 'Test Co', req: REQ, siteUrl: 'https://x', intro: INTRO, footer: 'Regards',
    approver: 'Keshav Garg', links: null, heading: 'A request has been raised'
  });
  check('and the copy that only tells them greets the person who asked',
    told.html.indexOf('Hello Keshav Garg,') > -1, null);
  check('which is a different name from the one on the deciding copy',
    told.html.indexOf('karan Ahuja') === -1, null);
}

/* ---- what the person typed, which is what the decision turns on ---- */
{
  const mail = mailer.leaveEmail({
    orgName: 'Test Co', intro: INTRO, footer: 'Regards', approver: 'karan Ahuja',
    pending: [{ req: REQ, links: { approve: 'https://x/a', reject: 'https://x/r' } }],
    unrequested: [], siteUrl: 'https://x'
  });
  /* It used to be a second grey line inside the grey line carrying the kind
     and the dates, reading as more of the same bookkeeping. */
  check('the reason is picked out rather than left in the grey',
    /background:#FFF7DF[^"]*"[^>]*>&ldquo;family&rdquo;/.test(mail.html)
    || /background:#FFF7DF/.test(mail.html) && /&ldquo;family&rdquo;/.test(mail.html), null);
  check('and it is no longer part of the dates line',
    !/dateRange[\s\S]{0,40}family/.test(mail.html)
    && mail.html.indexOf('<br>“family') === -1, null);
  check('a request with nothing typed carries no empty block',
    (function(){
      const bare = mailer.leaveEmail({
        orgName: 'Test Co', intro: INTRO, footer: 'Regards', approver: 'x',
        pending: [{ req: Object.assign({}, REQ, { message: '' }),
                    links: { approve: 'https://x/a', reject: 'https://x/r' } }],
        unrequested: [], siteUrl: 'https://x' });
      return bare.html.indexOf('#FFF7DF') === -1;
    })(), null);
}

/* ---- how much time is being asked for ----
   Two dates say when it starts and when it ends, and leave whoever is
   deciding to count the days between them - which is the one number they are
   weighing. */
{
  const card = (over) => mailer.leaveEmail({
    orgName: 'Test Co', intro: INTRO, footer: 'Regards', approver: 'karan Ahuja',
    pending: [{ req: Object.assign({}, REQ, over),
                links: { approve: 'https://x/a', reject: 'https://x/r' } }],
    unrequested: [], siteUrl: 'https://x' }).html;
  check('a range says how many days it is',
    /&middot; 2 days|· 2 days/.test(card({ dateFrom: '2026-11-10', dateTo: '2026-11-11' })),
    null);
  check('one day is a day, not 1 days',
    / · 1 day</.test(card({ dateFrom: '2026-11-10', dateTo: '2026-11-10' })), null);
  check('and a week reads as six',
    / · 6 days</.test(card({ dateFrom: '2026-11-10', dateTo: '2026-11-15' })), null);
  /* A half day says how much it is in its own name, so counting it again
     would print "Half day · ½ day". */
  ['HALF', 'SHORT', 'THREEQ'].forEach(t => {
    check('a ' + t + ' does not say it twice',
      !/ · \d+ days?</.test(card({ leaveType: t, dateFrom: '2026-11-10', dateTo: '2026-11-10' })),
      null);
  });
  check('a request with no dates at all says nothing rather than NaN',
    !/NaN/.test(card({ dateFrom: '', dateTo: '' })), null);
}

/* ---- the names, as the server says them ---- */
{
  const ctx = { Object, Array, String, console };
  vm.createContext(ctx);
  ctx.approverName = async (org, a) => ({
    'karan@x': 'karan Ahuja', 'shivani@x': 'Shivani Dutt', 'nitish@x': 'Nitish Kumar'
  }[a] || a);
  vm.runInContext('async ' + grab(SRV, 'approverNames'), ctx);
  (async () => {
    check('one address is one name',
      (await ctx.approverNames(1, ['karan@x'])) === 'karan Ahuja', null);
    check('two are joined with "and", not a comma',
      (await ctx.approverNames(1, ['shivani@x', 'nitish@x'])) === 'Shivani Dutt and Nitish Kumar',
      null);
    check('three read as a sentence rather than a list',
      (await ctx.approverNames(1, ['karan@x', 'shivani@x', 'nitish@x']))
        === 'karan Ahuja, Shivani Dutt and Nitish Kumar', null);
    check('nobody is nobody, not the word undefined',
      (await ctx.approverNames(1, [])) === '', null);

    /* ---- and both copies are given a name to use ---- */
    const n = grab(SRV, 'notifyNewRequests');
    check('the deciding copy is told who it is going to',
      /approver: await approverNames\(orgId, greetedOf\(aud\.to, mgmt\)\),/.test(n), null);
    check('and the told copy is given the person who asked',
      /approver: r\.empName,/.test(n), null);
    /* The digest already knew; this is only that it still does. */
    const d = grab(SRV, 'leaveDigests');
    check('a digest greets the one person it is for',
      /approver: byName/.test(d), null);

    /* ---- and the office is told the token exists ---- */
    check('the settings card names the token',
      /Message at the top <span>\{approver\} \{org\}<\/span>/.test(APP), null);
    check('and says what it does',
      /copy greets whoever it is going to/.test(APP), null);
    /* The wording it comes with uses it, so a company that never edits the box
       still gets a greeting with a name in it. */
    check('the wording it comes with uses it',
      /intro: 'Hello \{approver\},/.test(fs.readFileSync(path.join(REPO, 'mailer.js'), 'utf8')),
      null);

    /* ---- and whose name the greeting carries ----
       The owners are on most leave messages. One going to the manager who
       actually decides it, opening by naming the owners, reads as though it
       were written for them and copied to him. */
    vm.runInContext(grab(SRV, 'greetedOf'), ctx);
    const MG = ['shivani@x', 'nitish@x'];
    check('the manager named against somebody is the one greeted',
      JSON.stringify(ctx.greetedOf(['karan@x', 'shivani@x', 'nitish@x'], MG)) ===
        JSON.stringify(['karan@x']), null);
    check('two of them are both greeted',
      JSON.stringify(ctx.greetedOf(['karan@x', 'munish@x', 'shivani@x'], MG)) ===
        JSON.stringify(['karan@x', 'munish@x']), null);
    /* A row nobody else is named against IS the management's, so there they
       are greeted - otherwise the message opens with nobody's name. */
    check('where only the owners decide it, the owners are greeted',
      JSON.stringify(ctx.greetedOf(['shivani@x', 'nitish@x'], MG)) ===
        JSON.stringify(['shivani@x', 'nitish@x']), null);
    check('and case is not the rule’s business',
      JSON.stringify(ctx.greetedOf(['karan@x', ' SHIVANI@X '], MG)) ===
        JSON.stringify(['karan@x']), null);
    check('nobody at all stays nobody',
      JSON.stringify(ctx.greetedOf([], MG)) === JSON.stringify([]), null);
    /* Who it GOES to is untouched: this is the first line, not the To line. */
    check('the greeting is narrowed, the audience is not',
      /approver: await approverNames\(orgId, greetedOf\(aud\.to, mgmt\)\),/.test(SRV)
      && /const toMsg = \{ to: aud\.to, cc: \[\],/.test(SRV), null);

    /* ---- and reading it before anybody asks for leave ----
       The only way to see this message used to be to wait for somebody to
       want a day off, which is a poor moment to find the wording greets the
       wrong person or the wrong people are on it. */
    const sample = SRV.slice(SRV.indexOf("app.post('/api/mail/leave-sample'"),
                             SRV.indexOf("app.post('/api/mail/test'"));
    check('a sample is built for one named person',
      /const name = String\(\(req\.body && req\.body\.emp\) \|\| ''\)\.trim\(\);/.test(sample), null);
    /* Somebody who is still here. A sample for a leaver is a message about
       a day nobody will ever ask for. */
    check('and only for somebody who is still on the roster',
      /SELECT 1 FROM employees WHERE org_id = \$1 AND name = \$2 AND is_active = TRUE LIMIT 1/
        .test(sample), null);
    check('it is addressed the way that person\u2019s leave really would be',
      /const aud = await leaveAudience\(orgId, settings, route, name, mgmt\);/.test(sample)
      && /approver: await approverNames\(orgId, greetedOf\(aud\.to, mgmt\)\)/.test(sample), null);
    check('and uses the office\u2019s own wording, not a stand-in',
      /intro: settings\.leave\.intro, footer: settings\.leave\.footer,/.test(sample), null);
    /* The request behind it does not exist, so it carries no buttons and says
       on its face that nobody has asked for the day. */
    /* The buttons are the thing the message exists to carry, and where they
       sit is half of what there is to look at - so a preview without them is
       not a preview of this message. They lead to the dashboard: the request
       behind a sample does not exist, so a real link would be a button that
       fails when pressed. */
    check('a sample shows the buttons',
      /links: \{ approve: mailer\.baseUrl\(\), reject: mailer\.baseUrl\(\) \},/.test(sample),
      null);
    check('and they decide nothing',
      sample.indexOf("linksFor(") === -1, null);
    check('and says on the request itself that it is one',
      /Sample only - nobody has asked for this day\./.test(sample), null);
    check('nothing is saved for it',
      sample.indexOf('INSERT INTO kv') === -1 && sample.indexOf('leaveRequests') === -1, null);
    /* Nothing goes out unless the test is asked for, and a test has only ever
       gone to the account asking for it. */
    check('nothing is sent unless a test is asked for',
      /if \(\(req\.body && req\.body\.send\) === 'test'\) \{/.test(sample), null);
    check('and the test goes to the account asking, not to the real audience',
      /const msg = \{ to: \[to\], cc: \[\], subject: '\[Sample\] ' \+ mail\.subject/.test(sample),
      null);

    /* The page offers it where the settings end, and asks who first. */
    /* At the foot with Save and the test, because reading the message is the
       last thing done on this card rather than a setting in the middle of it -
       and the foot is one row under all six tabs, so it comes and goes with
       the tab it belongs to. */
    check('the button is on the foot beside Save',
      /id="emTest"[\s\S]{0,600}?id="emLvSample"/.test(APP), null);
    /* The names serve both per-person tabs, so they sit outside either of
       them - beside the foot, which is under all six. */
    check('the names are not shut inside one tab',
      APP.indexOf('id="emLvWho"') > APP.indexOf("data-em-pane=\"mo\""), null);
    /* Every tab has it, and it does whatever that tab's message needs. Four
       of them send one message to one list of people, and the button that
       sends it already shows it first - so previewing those is pressing that
       button and stopping at the window it opens. */
    check('four of the tabs borrow their own send button',
      /var BY_TAB = \{ att:'emSendDay', hol:'emSendHol', wk:'emSendWork', mo:'emSendMonth' \};/
        .test(APP), null);
    /* The other two are about one person at a time, so they ask which. */
    check('and the two about one person ask which person',
      /tab === 'lv' \|\| tab === 'lt'/.test(grab(APP, 'previewLabel'))
      && /Preview for an employee/.test(grab(APP, 'previewLabel')), null);
    check('the self-marked tab asks for its own kind of message',
      /\(on && on\.getAttribute\('data-em-tab'\) === 'lt'\) \? 'part' : 'leave'/.test(APP), null);
    check('the names shut when the tab changes',
      /if\(who\) who\.style\.display = 'none';/.test(grab(APP, 'showLeaveTools')), null);
    check('and the label is set for whichever tab opens',
      /showLeaveTools\('att'\);/.test(APP) && /showLeaveTools\(which\);/.test(APP), null);
    check('which opens a list of the people on the table',
      /data-lv-who="/.test(APP), null);
    check('and the window it opens says what its button will do',
      /sendLabel: 'Send this sample to me'/.test(APP)
      && /wrap\.querySelector\('\[data-em-send\]'\)\.textContent = pv\.sendLabel/.test(APP), null);

    console.log(fail ? ('FAILED (' + fail + ' of ' + (pass + fail) + ')')
                     : ('ALL PASS (' + pass + ' checks)'));
    process.exit(fail ? 1 : 0);
  })();
}
