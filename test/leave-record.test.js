// An approver deciding from an email has the dates and nothing else. What
// turns that into a decision is the year behind them: what is left of each
// kind of leave, what has gone already, when, and who else is off those days.
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

const REC = {
  record: {
    year: '2026',
    cl: { left: 3.08, used: 5.25, of: 8.33 },
    sl: { left: 7.33, used: 1, of: 8.33 },
    all: { left: 10.41, used: 6.25, of: 16.66 },
    months: [[0,0],[1,0],[0,0],[0,0],[0,0.5],[0,0],[2,0],[1,0],[0,0.5],[1,0],[0,0],[0,0]],
    days: [{ d: '2026-02-14', k: 'CL', n: 1 }, { d: '2026-05-03', k: 'SL', n: 0.5 },
           { d: '2026-07-08', k: 'CL', n: 1 }, { d: '2026-07-09', k: 'CL', n: 1 },
           { d: '2026-08-14', k: 'CL', n: 1 }, { d: '2026-09-02', k: 'SL', n: 0.5 },
           { d: '2026-10-12', k: 'CL', n: 1 }]
  },
  asOf: '2026-10-29T06:00:00Z',
  away: ['Rahul Mishra'],
  alsoWaiting: [{ dates: '20 Nov 2026', kind: 'Casual leave', raised: '2026-10-27' }]
};

/* ---- what is left, out of what ----
   A figure on its own says nothing: 3.08 is generous or nearly spent depending
   on what it is out of, and on how much of the year has gone. */
{
  const html = mailer.leaveRecordBlock(REC);
  check('every balance says what it is left of',
    /3\.08<\/span><span[^>]*> left of 8\.33/.test(html)
    && /7\.33<\/span><span[^>]*> left of 8\.33/.test(html)
    && /10\.41<\/span><span[^>]*> left of 16\.66/.test(html));
  check('and how much has gone already',
    /5\.25 used so far/.test(html) && /6\.25 used so far/.test(html));
  /* The bar is the part used, so the ratio is read before either number. */
  check('the part used is drawn as well as counted',
    /width="63%"/.test(html), (html.match(/width="\d+%"/g) || []).slice(0, 3));
  check('a bar is a table cell with a colour, which is what Outlook can draw',
    /<td width="\d+%" bgcolor="#2F6FE4"/.test(html));
}

/* ---- the year: the glance, then the figures ---- */
{
  const html = mailer.leaveRecordBlock(REC);
  check('all twelve months are shown, not only the ones with something in them',
    ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
      .every(mo => html.indexOf('>' + mo.charAt(0) + mo.slice(1).toLowerCase() + '<') > -1
                || html.toUpperCase().indexOf('>' + mo + '<') > -1));
  check('a month with nothing in it reads as nothing, not as a nought',
    (html.match(/&ndash;/g) || []).length >= 6);
  check('half a day is shown as half, not rounded away',
    /&frac12;/.test(html) && />0\.5</.test(html));
  /* The heading says the year; repeating it in every cell is noise. */
  check('dates are the day and the month, without the year on each one',
    /14 Feb/.test(html) && !/14 Feb[^<]*2026/.test(html));
  check('the table has a row for every month anything happened in, and no others',
    (html.match(/<b>(January|February|March|April|May|June|July|August|September|October|November|December)<\/b>/g) || []).length === 6);
  check('and adds up to what the cards said',
    /<b>Year so far<\/b>[\s\S]{0,400}<b>6<\/b>/.test(html)
    && /of 16\.66 earned/.test(html));
  check('a year with nothing taken says so rather than drawing an empty table',
    /No leave taken this year/.test(mailer.leaveRecordBlock({
      record: { year: '2026', cl: { left: 8.33, used: 0, of: 8.33 },
                sl: { left: 8.33, used: 0, of: 8.33 },
                all: { left: 16.66, used: 0, of: 16.66 },
                months: [], days: [] }, asOf: '2026-10-29T06:00:00Z' })));
}

/* ---- the two things the request itself cannot say ---- */
{
  const html = mailer.leaveRecordBlock(REC);
  check('who else is already off those days',
    /Rahul Mishra is already off then/.test(html));
  check('and anything else of their own still waiting',
    /Also waiting from them: 20 Nov 2026, casual leave/.test(html));
  const many = mailer.leaveRecordBlock(Object.assign({}, REC,
    { away: ['A','B','C','D','E','F','G','H'] }));
  check('a long list of them is cut rather than left to run',
    /and 2 more are already off then/.test(many), (many.match(/>[^<]*more[^<]*</) || [])[0]);
  check('one person reads as one person',
    /Rahul Mishra is already/.test(html) && !/Rahul Mishra are already/.test(html));
}

/* ---- where the figures come from ---- */
{
  check('the record says when it was taken, so a stale one says so',
    /Balances as the dashboard had them on 29 Oct/.test(mailer.leaveRecordBlock(REC)));
  check('nothing to say means nothing is drawn',
    mailer.leaveRecordBlock({ record: null, away: [], alsoWaiting: [] }) === '');
  /* The arithmetic belongs to the dashboard. Writing it again on the server
     would be two versions of the truth, and one of them quietly wrong. */
  check('the page publishes what it already worked out',
    /function leaveRecordSnapshot\(\)/.test(APP)
    && /computeLeaveMatrix\(e\.name, \{ allMonths: true \}\)/.test(APP));
  check('for everybody still here, under the name the record files them by',
    /\(ALL_EMPLOYEES \|\| \[\]\)\.filter\(stillHere\)/.test(APP));
  check('only the days that moved the balance go in it',
    /x\.type === 'leave'/.test(APP));
  check('it is written when it has changed and not oftener',
    /if\(sig === LEAVE_REC_SENT\) return Promise\.resolve\(false\);/.test(APP));
  check('and only by somebody who may write it',
    /if\(!\(viewRole && viewRole\.role === 'admin'\)\) return Promise\.resolve\(false\);/.test(APP));
  check('it goes into the backup with the rest',
    /'leaveRecord',/.test(APP));
}

/* ---- the server reads it rather than recomputing it ---- */
{
  check('the record is read from the key the page writes',
    /sharedKeys\(orgId, \['leaveRecord'/.test(SRV));
  check('the days around the request are worked out here, being about everybody',
    /const away = \{\};/.test(SRV) && /r\.status !== 'approved'/.test(SRV));
  check('a visit or a day from home is not somebody being away',
    /r\.leaveType === 'WFH' \|\| r\.leaveType === 'VISIT'/.test(SRV));
  check('their own other requests are not counted as a clash with themselves',
    /r\.empName === empName\) return;/.test(SRV));
  check('and a failure to build it loses the record, not the message',
    /leave record for the message failed/.test(SRV)
    && /return null;\s*\/\/ a message without it is better than none/.test(SRV));
  check('it is carried into the request as it is raised',
    /leaveRecord: await leaveRecordFor\(orgId, r\.empName, r\)/.test(SRV));
  check('and into the one that passes a recommendation on',
    /leaveRecord: await leaveRecordFor\(orgId, req\.empName, req\)/.test(SRV));
  /* A digest of several people would be one of these each. */
  check('the card draws it only where the message carries one',
    /req\.leaveRecord \? leaveRecordBlock\(req\.leaveRecord\) : ''/.test(
      fs.readFileSync(path.join(REPO, 'mailer.js'), 'utf8')));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
