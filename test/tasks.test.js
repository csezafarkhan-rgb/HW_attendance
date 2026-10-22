// What everybody worked on: written by them, read by the office, sent as one
// message.
//
// The map of days is stored whole and sent whole, so the dangerous case is an
// employee saving their own Tuesday and taking everybody else's week with it -
// their page's copy of it, as they last read it. Leave requests have the same
// shape and the same guard; these checks are that guard, for this key.
'use strict';
const path = require('path');
const mailer = require(path.join(__dirname, '..', 'mailer.js'));

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* ---- the message ---- */
{
  const r = mailer.tasksEmail({
    orgName: 'AllyConnect Pvt. Ltd.', dateLabel: 'Thu, 22 Oct 2026',
    people: [{ name: 'Zafar Khan', count: 2,
               items: ['Closed the JCPenney AR queries', 'Reviewed October payroll'] },
             { name: 'Habib', count: 1, items: ['Packed and dispatched 40 orders'] }],
    silent: ['Rahul Mishra']
  });
  check('the message names everybody who wrote something',
    /Zafar Khan/.test(r.html) && /Habib/.test(r.html), r.subject);
  check('and lists what each of them said',
    (r.html.match(/<li/g) || []).length === 3
      && /Closed the JCPenney AR queries/.test(r.html), (r.html.match(/<li/g) || []).length);
  /* Who wrote nothing is worth saying: an empty card would read as a quiet day
     rather than as a page nobody filled in. */
  check('it says who wrote nothing, rather than leaving them out silently',
    /Nothing written today by Rahul Mishra/.test(r.html));
  check('the subject carries the day', / 22 Oct 2026/.test(r.subject), r.subject);

  /* A day nobody wrote on sends nothing at all - not a message saying so. */
  check('a day nobody wrote on sends no message',
    mailer.tasksEmail({ orgName: 'Co', people: [] }) === null);
  check('and neither does a day of empty lists',
    mailer.tasksEmail({ orgName: 'Co', people: [{ name: 'A', items: [] }] }) === null);

  /* What people type is put into a web page, so it is escaped. */
  const nasty = mailer.tasksEmail({ orgName: 'Co', dateLabel: 'd',
    people: [{ name: '<b>Bold</b>', count: 1, items: ['<script>alert(1)</script>'] }] });
  check('what somebody types is escaped, name and line alike',
    nasty.html.indexOf('<script>') === -1 && /&lt;script&gt;/.test(nasty.html)
      && nasty.html.indexOf('<b>Bold</b>') === -1, nasty.html.slice(0, 0) || 'escaped');
}

/* ---- the merge, which is what keeps one person out of another's day ---- */
{
  const fs = require('fs'), vm = require('vm');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ctx = { console, Date, JSON, String, Array, Object, Number,
                DAY_RE: /^\d{4}-\d{2}-\d{2}$/,
                parseJson: s => { try { return JSON.parse(s); } catch (e) { return null; } } };
  vm.createContext(ctx);
  vm.runInContext(/const TASK_MAX_LINES = [\s\S]*?\n\}/.exec(srv)[0], ctx);
  const merge = (stored, incoming, who) =>
    JSON.parse(ctx.mergeEmployeeTasks(JSON.stringify(stored), JSON.stringify(incoming), who));

  const stored = {
    'Habib|2026-10-22': { items: ['Dispatched 40 orders'], at: 'x' },
    'Zafar Khan|2026-10-22': { items: ['Payroll'], at: 'x' }
  };
  /* Habib saves his own day, and his page carries its copy of Zafar's. */
  const after = merge(stored, {
    'Habib|2026-10-22': { items: ['Dispatched 40 orders', 'Stock count'] },
    'Zafar Khan|2026-10-22': { items: ['Nothing, apparently'] }
  }, 'Habib');
  check('somebody saving their own day keeps their own changes',
    after['Habib|2026-10-22'].items.length === 2
      && after['Habib|2026-10-22'].items[1] === 'Stock count', after['Habib|2026-10-22']);
  check('and cannot write over anybody else\'s',
    after['Zafar Khan|2026-10-22'].items[0] === 'Payroll', after['Zafar Khan|2026-10-22']);

  /* Clearing their own day removes it rather than storing an empty one. */
  const cleared = merge(stored, { 'Habib|2026-10-22': { items: [] } }, 'Habib');
  check('clearing a day takes it away rather than storing an empty one',
    !('Habib|2026-10-22' in cleared) && 'Zafar Khan|2026-10-22' in cleared, cleared);

  /* A name that merely starts the same is not the same person. */
  const lookalike = merge({ 'Aman Gupta|2026-10-22': { items: ['Theirs'], at: 'x' } },
    { 'Aman Gupta|2026-10-22': { items: ['Mine now'] } }, 'Aman');
  check('a name that only starts the same is a different person',
    lookalike['Aman Gupta|2026-10-22'].items[0] === 'Theirs', lookalike);

  /* Lines are trimmed, blanks dropped, and both the line and the list capped,
     so one page cannot post a novel into everybody's inbox. */
  const long = merge({}, {
    'Habib|2026-10-22': { items: ['  spaced  ', '', '   ', 'x'.repeat(400)]
      .concat(Array.from({ length: 50 }, (_, i) => 'line ' + i)) } }, 'Habib');
  const got = long['Habib|2026-10-22'].items;
  check('lines are trimmed and blank ones dropped',
    got[0] === 'spaced' && got.indexOf('') === -1, got.slice(0, 3));
  check('a line has a length, and a day has a number of lines',
    got[1].length === 300 && got.length === 30, { longest: got[1].length, lines: got.length });

  /* A day that is not a day is not stored. */
  const junk = merge({}, { 'Habib|not-a-day': { items: ['x'] },
                           'Habib|2026-10-22': { items: ['ok'] } }, 'Habib');
  check('a key that is not a date is ignored',
    Object.keys(junk).length === 1 && junk['Habib|2026-10-22'], junk);
  check('and something that is not a map at all is refused',
    ctx.mergeEmployeeTasks('{}', JSON.stringify([1, 2, 3]), 'Habib') === null);
}

/* ---- the key is one an employee may write, and read only their own of ---- */
{
  const fs = require('fs');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('an employee may write it',
    /const EMPLOYEE_WRITABLE = \[[^\]]*'dailyTasks'/.test(srv));
  check('and is given back only the days under their own name',
    /const EMP_KEYED_BY_DAY = \[[\s\S]{0,400}'dailyTasks'/.test(srv));
  check('the merge runs on an employee\'s save, not an admin\'s',
    /key === 'dailyTasks' && req\.session\.role === 'employee'/.test(srv));
}

/* ---- the two pages: one that writes it, one that reads it ---- */
{
  const fs = require('fs');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

  check('an employee has somewhere to write their day',
    app.indexOf('id="empTasksCard"') > -1 && /function renderEmpTasks\(\)/.test(app));
  check('and it is drawn with the rest of their page',
    /renderEmpTasks\(\);[\s\S]{0,80}renderMyRequests\(\)/.test(app));
  /* It saves as they leave the box. A Save button is one more thing to forget,
     and a day of work half-typed is worth nothing. */
  check('what they type saves itself',
    /addEventListener\('change', function\(\)\{ keep\(read\(\)\); \}\)/.test(app));

  check('the office has a page of its own for it',
    app.indexOf('id="page-worklog"') > -1 && /function renderWorkLogPage\(\)/.test(app));
  check('which is the office’s to read, not an employee’s',
    /adminOnly = \[[^\]]*'worklog'\]/.test(app), (/adminOnly = \[[^\]]*\]/.exec(app) || [])[0]);
  check('and is redrawn when the page refreshes',
    /currentPage === 'worklog'\) renderWorkLogPage/.test(app));

  /* The office reads these words; it does not write them. Somebody amending
     what another person said they did would make the record worth less than
     the time it took to write. */
  const page = /function renderWorkLogPage\(\)[\s\S]*?\n  \}/.exec(app)[0];
  check('the office can read the log but not write it',
    page.indexOf('setTasks(') === -1, 'renderWorkLogPage writes to it');

  check('a day of work travels in a backup',
    /BACKUP_KEYS[\s\S]{0,700}'dailyTasks'/.test(app));
  /* The Share menu sends it by hand, beside the attendance record and the
     leave message - it is the same day's news told the other way round. */
  check('the Share menu can send it by hand',
    app.indexOf('id="emSendWork"') > -1
      && /workBtn\.onclick[\s\S]{0,120}\/api\/mail\/tasks/.test(app), 'no Share entry');
  check('and says so plainly when nobody has written anything',
    /Nobody has written anything today/.test(app));
  check('and the office can turn the message on and address it',
    app.indexOf('data-em-tab="wk"') > -1 && app.indexOf('id="emWkOn"') > -1
      && /tasks: \{[\s\S]{0,80}emWkOn/.test(app));
}

/* ---- stepping a day ----
   The day buttons were walking with `new Date(day + 'T00:00:00')` and then
   `toISOString().slice(0,10)`. That date is local midnight, and converting it
   to UTC moves it back a day anywhere east of Greenwich. In Gurugram, +05:30,
   "day after" landed on the day it started from - so the button looked dead -
   and "day before" skipped two.

   Run in the office's own timezone, which is the only place it shows. */
{
  const vm = require('vm'), fs = require('fs');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const ctx = { Date, String, Number };
  vm.createContext(ctx);
  vm.runInContext(/ {2}function isoOf\(d\)\{[\s\S]*?\n  \}/.exec(app)[0], ctx);
  vm.runInContext(`
    function step(day, n){
      var d = new Date(day + 'T00:00:00');
      d.setDate(d.getDate() + n);
      return isoOf(d);
    }
    function stepTheOldWay(day, n){
      var d = new Date(day + 'T00:00:00');
      d.setDate(d.getDate() + n);
      return d.toISOString().slice(0, 10);
    }
  `, ctx);

  /* The office is at +05:30. The arithmetic below is checked wherever this
     runs; the fault it fixes can only be shown east of Greenwich, so that part
     stands aside elsewhere rather than failing for the wrong reason. */
  const eastOfGreenwich = new Date('2026-10-21T00:00:00').getTimezoneOffset() < 0;

  check('a day forward is one day forward',
    ctx.step('2026-10-21', 1) === '2026-10-22', ctx.step('2026-10-21', 1));
  check('and a day back is one day back',
    ctx.step('2026-10-21', -1) === '2026-10-20', ctx.step('2026-10-21', -1));
  check('across the end of a month, and a year',
    ctx.step('2026-10-31', 1) === '2026-11-01'
      && ctx.step('2026-12-31', 1) === '2027-01-01'
      && ctx.step('2026-03-01', -1) === '2026-02-28',
    [ctx.step('2026-10-31', 1), ctx.step('2026-12-31', 1), ctx.step('2026-03-01', -1)]);

  /* The way it was done before, which is what made the button look dead. Run
     this with TZ=Asia/Kolkata to see it the way the office does. */
  if (eastOfGreenwich) {
    check('the way it was done before stood still going forward',
      ctx.stepTheOldWay('2026-10-21', 1) === '2026-10-21', ctx.stepTheOldWay('2026-10-21', 1));
    check('and skipped two going back',
      ctx.stepTheOldWay('2026-10-21', -1) === '2026-10-19', ctx.stepTheOldWay('2026-10-21', -1));
  } else {
    console.log('SKIP the old way only misbehaves east of Greenwich; this ran at UTC'
      + (-new Date().getTimezoneOffset() / 60) + '. TZ=Asia/Kolkata shows it.');
  }

  /* And neither page walks a day that way any more. */
  const pages = ['renderWorkLogPage', 'renderEmpTasks'].map(n =>
    new RegExp('function ' + n + '\\(\\)[\\s\\S]*?\\n  \\}').exec(app)[0]);
  check('neither page turns a local date into UTC to walk it',
    pages.every(p => p.indexOf('toISOString().slice(0, 10)') === -1),
    pages.map(p => (p.match(/toISOString\(\)[^;]*/g) || [])).flat());

  /* Opening the tab shows today rather than wherever it was left. */
  check('opening the work log shows today',
    /currentPage === 'worklog'\)\{ WLOG_DAY = null; renderWorkLogPage\(\); \}/.test(app));
}

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
