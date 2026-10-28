// The words at the top of a first-approval message are one set of words sent
// to several different people - whoever holds that stage for the person the
// request is about. Written with a name in them ("Dear Karan,") they greeted
// the wrong person the moment a request was routed to somebody else, and the
// message a request raises carried its placeholders through unfilled.
'use strict';
const fs = require('fs'), path = require('path');
const REPO = path.join(__dirname, '..');
const mailer = require(path.join(REPO, 'mailer.js'));
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

const req = { id: 'r1', empName: 'Shyam Lal', leaveType: 'CL',
              dateFrom: '2026-11-03', dateTo: '2026-11-04', createdAt: '2026-10-28T06:00:00Z' };
const links = { approve: 'https://x/a', reject: 'https://x/r' };

/* ---- the digest ---- */
{
  const mine = mailer.leaveEmail({
    orgName: 'Homeweavers', pending: [{ req: req, links: links, heading: 'For you' }],
    intro: 'Dear {approver},\n\nSomething is waiting.', approver: 'Munish Dhamija'
  });
  check('the name of whoever it goes to is filled in',
    /Dear Munish Dhamija,/.test(mine.html), mine.html.slice(0, 0));
  check('and the name it was written with is nowhere in it',
    !/\{approver\}/.test(mine.html));

  /* The same words, sent to somebody else, greet somebody else. */
  const other = mailer.leaveEmail({
    orgName: 'Homeweavers', pending: [{ req: req, links: links, heading: 'For you' }],
    intro: 'Dear {approver},\n\nSomething is waiting.', approver: 'Karan'
  });
  check('one set of words, two approvers, each greeted by their own name',
    /Dear Karan,/.test(other.html) && !/Munish/.test(other.html));

  /* With nobody holding the stage the placeholder is left standing rather
     than greeting an empty name - which is what tells the office the words
     were meant for a stage that is not in use. */
  const none = mailer.leaveEmail({
    orgName: 'Homeweavers', pending: [{ req: req, links: links, heading: 'Waiting' }],
    intro: 'Dear {approver},\n\nSomething is waiting.'
  });
  check('without an approver the placeholder is left alone, not emptied',
    /\{approver\}/.test(none.html) && !/Dear ,/.test(none.html));
}

/* ---- the note each request raises ---- */
{
  const mail = mailer.requestEmail({
    orgName: 'Homeweavers', req: req, links: links, siteUrl: 'https://x',
    intro: 'Dear {approver},\n\n{name} has asked for {kind} on {dates}.',
    footer: 'Best regards,\n{org}', approver: 'Munish Dhamija'
  });
  check('the request note fills its words in too',
    /Dear Munish Dhamija,/.test(mail.html), mail.html.slice(0, 0));
  check('the person who asked is named from the request, not typed in',
    /Shyam Lal has asked for Casual leave/.test(mail.html));
  check('the dates come through as dates',
    /\{dates\}/.test(mail.html) === false && /Nov/.test(mail.html));
  check('the sign-off is filled in as well - it used to carry its braces',
    /Best regards,/.test(mail.html) && !/\{org\}/.test(mail.html));
  check('and nothing is left with braces around it',
    !/\{\w+\}/.test(mail.html), (mail.html.match(/\{\w+\}/g) || []).slice(0, 4));
}

/* ---- the wording it comes with ---- */
{
  const words = mailer.DEFAULT_TEXT ? mailer.DEFAULT_TEXT.leave : null;
  const mail = mailer.leaveEmail({
    orgName: 'Homeweavers', pending: [{ req: req, links: links, heading: 'For you' }],
    approver: 'Munish Dhamija'
  });
  check('the wording it comes with greets by name rather than nobody',
    /Hello Munish Dhamija,/.test(mail.html) || !words, mail.html.slice(0, 0));
}

/* ---- every message that asks for the first word carries the name ---- */
{
  const sites = SRV.match(/approver: [^\n,]+/g) || [];
  check('all three first-approval messages are given the name',
    sites.length >= 3, sites);
  check('the digest gives it the name it seals into its own buttons',
    /intro: \(st === 1 && settings\.leave\.firstIntro\)[\s\S]{0,120}approver: byName/.test(SRV));
  check('the request note looks the name up for whoever holds the stage',
    /approver: who \? await approverName\(orgId, who\) : ''/.test(SRV));
  check('and so does the notice about days taken without a request',
    /intro: \(stage && settings\.leave\.firstIntro\)[\s\S]{0,80}approver: byName/.test(SRV));
}

/* ---- the panel says so ---- */
{
  check('the settings panel says what the placeholder is for',
    /\{approver\} is whoever this copy goes to/.test(APP));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
