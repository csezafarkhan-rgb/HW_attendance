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
  /* Everybody gets a card, whether or not they wrote in it. Those who wrote
     nothing used to be a line of names swept under the last card, which read
     as a footnote about them rather than as their own empty page. */
  check('everybody has a card, including whoever wrote nothing',
    (r.html.match(/border-radius:10px/g) || []).length === 3
      && /Rahul Mishra/.test(r.html), (r.html.match(/border-radius:10px/g) || []).length);
  check('and an empty card says so in itself',
    /Rahul Mishra[\s\S]{0,400}?Nothing written today<\/div>/.test(r.html)
      && !/Nothing written today by/.test(r.html),
    (/Rahul Mishra[\s\S]{0,200}/.exec(r.html) || [])[0]);
  check('an empty card carries no count beside the name',
    !/Rahul Mishra[\s\S]{0,120}?\d+ tasks?</.test(r.html));
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

/* ---- nothing goes out unseen ----
   Both ways of sending the work log by hand used to post straight at the send
   route: one press, and the day's work was on its way to whoever the
   attendance record goes to. That is how it reached four addresses before
   anybody had read it. Both now build the message, show it, and send only on
   a second press - the same two steps the attendance record, the month and
   the holiday reminder take. */
{
  const fs = require('fs');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  const handler = (marker, end) => {
    const i = app.indexOf(marker);
    return i < 0 ? '' : app.slice(i, app.indexOf(end, i));
  };
  const fromMenu = handler("var workBtn = document.getElementById('emSendWork');", "var testBtn");
  const fromPage = handler("var mb = document.getElementById('wlogMail');", "\n  }\n\n  function renderHolidaysPage");

  check('the Share menu shows the work log before sending it',
    /showPreview\(/.test(fromMenu) && /send:'preview'/.test(fromMenu), fromMenu.slice(0, 120));
  check('and so does the Work Log page',
    /showPreview\(/.test(fromPage) && /send:'preview'/.test(fromPage), fromPage.slice(0, 120));
  /* The giveaway of the old way: a post to the route carrying neither a
     request for a preview nor the word that sends one. */
  const blind = [fromMenu, fromPage].filter(h =>
    /\/api\/mail\/tasks/.test(h) && !/send:'preview'/.test(h));
  check('neither of them posts at the send route on the first press', blind.length === 0, blind.length);

  check('there is one preview window, not a copy a caller',
    (app.match(/function showPreview\(/g) || []).length === 1
      && (app.match(/var showPreview = function/g) || []).length === 0,
    (app.match(/showPreview/g) || []).length);

  /* And the server only sends when it is told to, not when it is asked to
     build. Anything else and the preview would send the thing it is showing. */
  const route = server.slice(server.indexOf("app.post('/api/mail/tasks'"),
                             server.indexOf("app.post('/api/mail/leave'"));
  check('the route holds the message rather than sending it',
    /keepPreview\(/.test(route) && /body\.send === 'preview'/.test(route)
      && /sendTasksEmail\([^)]*\{ preview: true \}\)/.test(route), route.slice(0, 80));
}

/* ---- an hour of its own ----
   The work log could only go by itself if the attendance record was going too:
   an office that had turned the record off could not have the work sent at
   all. It now keeps its own checkbox and its own hour, and whichever path
   sends it, it goes once a day. */
{
  const fs = require('fs');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  check('the settings carry a switch and an hour for it',
    /tasks: \{ on: false, auto: false, at: '19:30'/.test(server));
  check('and both are read back, the hour checked before it is trusted',
    /auto: tk\.auto === true/.test(server) && /test\(String\(tk\.at\)\) \? String\(tk\.at\)/.test(server));

  check('the panel offers the checkbox and the hour',
    /id="emWkAuto"/.test(app) && /id="emWkAt"/.test(app));
  check('and saves what was typed in them',
    /auto: document\.getElementById\('emWkAuto'\)\.checked/.test(app)
      && /at: document\.getElementById\('emWkAt'\)\.value/.test(app));

  /* Once a day, however its turn came up. Both paths go through the one
     function that claims the day first. */
  check('the day is claimed before it is sent, so it cannot go twice',
    /async function sendTasksOnce/.test(server)
      && /'tasks-email:' \+ orgId \+ ':' \+ day/.test(server));
  const tick = server.slice(server.indexOf('async function dailyEmailTick'),
                            server.indexOf('index.html carries the whole dashboard'));
  check('its own hour is read before the attendance record decides to stop',
    tick.indexOf('s.tasks.auto && min >= hhmmToMin(s.tasks.at)')
      < tick.indexOf('if (!s.daily || min < hhmmToMin(s.dailyAt)) continue;'));
  check('and both paths send it through the claim',
    (tick.match(/sendTasksOnce\(/g) || []).length === 2
      && !/sendTasksEmail\(org\.id/.test(tick),
    (tick.match(/sendTasksOnce\(/g) || []).length);
  /* A day that sends nothing must not be marked as done, or the first person
     to write something after the hour would never be heard. */
  check('a day that sent nothing gives the claim back',
    /if \(!r\.ok \|\| r\.nothing\) await pool\.query\('DELETE FROM maintenance_done/.test(server));
}

/* ---- what the office calls them ---- */
{
  const one = mailer.tasksEmail({ orgName: 'Co', dateLabel: 'Thu',
    people: [{ name: 'A', count: 1, items: ['x'] }] });
  const many = mailer.tasksEmail({ orgName: 'Co', dateLabel: 'Thu',
    people: [{ name: 'A', count: 4, items: ['w', 'x', 'y', 'z'] }] });
  check('a card counts tasks, not items',
    /1 task</.test(one.html) && /4 tasks</.test(many.html) && !/item/.test(many.html),
    (many.html.match(/\d+ \w+</g) || []).slice(0, 3));
  /* The wording lives with every other message's wording, so the settings
     panel can show it in the box rather than behind a placeholder. */
  check('its wording sits with the rest, and is what the message uses',
    !!mailer.DEFAULT_TEXT.tasks && /Work done/.test(mailer.DEFAULT_TEXT.tasks.subject)
      && many.subject === 'Work done · Thu',
    many.subject);
  check('and it signs off like the others do',
    /Best regards/.test(many.html), many.html.slice(-200));
}

/* ---- the Work tab is laid out like the others ----
   It was built with bare inputs where every other tab wraps them in a row, so
   its boxes came out half the width of the Attendance tab's and the panel read
   as two different panels. The check is structural rather than visual: every
   box on the tab sits in a row, as it does everywhere else. */
{
  const fs = require('fs');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  /* Found by the tab it draws, not by a line of its code, so a pane built some
     other way is still read rather than silently skipped. */
  const paneAt = app.indexOf('data-em-pane="wk"');
  check('the Work tab is there to look at', paneAt > -1);
  const pane = app.slice(paneAt, app.indexOf('data-em-pane="hol"'));

  const boxes = pane.match(/<(?:input|textarea)[^>]*/g) || [];
  check('the Work tab has the boxes the others have', boxes.length >= 7, boxes.length);
  const bare = boxes.filter(b => {
    const at = pane.indexOf(b);
    const before = pane.slice(Math.max(0, at - 160), at);
    return !/em-row[^"]*">\s*(?:\+\s*)?$|em-row[^"]*">[^<]*$/.test(before.replace(/\n\s*/g, ''));
  });
  check('and every one of them sits in a row, as on the Attendance tab',
    bare.length === 0, bare.map(b => b.slice(0, 60)));

  /* The same words over the same boxes - "Message at the top", not "Top line". */
  const att = app.slice(app.indexOf("<div data-em-pane=\"att\">"), app.indexOf('---- the leave message ----'));
  const labels = css => (css.match(/class="em-lab">([^<]*)/g) || []).map(x => x.slice(15).trim());
  const shared = ['To', 'Cc', 'Subject', 'Message at the top', 'Note at the foot', 'When it goes on its own'];
  const mine = labels(pane);
  check('and is labelled with the same words the Attendance tab uses',
    shared.every(w => mine.indexOf(w) > -1), mine);
  check('which are the Attendance tab\u2019s own words',
    shared.every(w => labels(att).indexOf(w) > -1), labels(att));
}

/* ---- a line written under another one ----
   A sub-point carries its mark inside the line rather than nesting the data,
   so the server's merge, every backup already taken and everything else that
   reads a day's work goes on reading a plain list of strings. These checks are
   that the mark survives the round trip and is drawn as nesting at each end. */
{
  const vm = require('vm'), fs = require('fs');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const ctx = { String, Array };
  vm.createContext(ctx);
  ['var TASK_SUB = \'\\u21B3 \';',
   /function taskLevel\(t\)\{[^}]*\}/.exec(app)[0],
   / {2}function taskText\(t\)\{[\s\S]*?\n  \}/.exec(app)[0],
   / {2}function taskLine\(text, level\)\{[\s\S]*?\n  \}/.exec(app)[0],
   / {2}function tidyTasks\(items\)\{[\s\S]*?\n  \}/.exec(app)[0]].forEach(src => vm.runInContext(src, ctx));

  const SUB = '↳ ';
  check('a line marked as a sub-point reads back as one',
    ctx.taskLevel(SUB + 'the detail') === 1 && ctx.taskText(SUB + 'the detail') === 'the detail',
    ctx.taskText(SUB + 'the detail'));
  check('and an ordinary line is untouched',
    ctx.taskLevel('the task') === 0 && ctx.taskText('the task') === 'the task');
  check('writing one puts the mark back on',
    ctx.taskLine('the detail', 1) === SUB + 'the detail' && ctx.taskLine('the task', 0) === 'the task');
  check('an empty line is never marked, so it cannot be stored as a bare mark',
    ctx.taskLine('   ', 1) === '', JSON.stringify(ctx.taskLine('   ', 1)));

  /* A sub-point with nothing above it is not one. Deleting the line it hung
     off would otherwise leave it dangling under the card's edge. */
  check('a sub-point with nothing above it becomes a line of its own',
    JSON.stringify(ctx.tidyTasks([SUB + 'orphan', 'a task'])) === JSON.stringify(['orphan', 'a task']),
    ctx.tidyTasks([SUB + 'orphan', 'a task']));
  check('one that does have a line above it keeps its place',
    JSON.stringify(ctx.tidyTasks(['a task', SUB + 'the detail']))
      === JSON.stringify(['a task', SUB + 'the detail']));
  check('and blank lines are dropped on the way in',
    JSON.stringify(ctx.tidyTasks(['a task', '  ', SUB + ' ', SUB + 'kept']))
      === JSON.stringify(['a task', SUB + 'kept']),
    ctx.tidyTasks(['a task', '  ', SUB + ' ', SUB + 'kept']));

  /* The card: Tab moves a line in and out where it stands, and the page is not
     redrawn to do it - that would take the cursor from under the hand. */
  const card = app.slice(app.indexOf('function renderEmpTasks()'),
                         app.indexOf('The two folded notes on the Leave Record'));
  check('Tab tucks a line under the one above', /ev\.key === 'Tab'/.test(card)
    && /setLevel\(el, ev\.shiftKey \? 0 : 1\)/.test(card));
  check('the first line is never offered a line to sit under',
    /all\.indexOf\(el\) === 0\) return;/.test(card));
  check('a run of sub-points carries on without Tab on every one',
    /TASK_NEXT_LVL = levelOf\(el\)/.test(card));
  check('and the card is read back with the marks on',
    /return taskLine\(el\.value, levelOf\(el\)\);/.test(card));
  check('there is a button for it too, for whoever reaches for the mouse',
    /data-wl-sub/.test(card));

  /* The arrow that cannot move says why, rather than looking broken. */
  check('the forward arrow says tomorrow has not happened',
    /Tomorrow has not happened yet/.test(card));
}

/* ---- and it is drawn as nesting at both ends ---- */
{
  const SUB = '↳ ';
  const m = mailer.tasksEmail({
    orgName: 'Co', dateLabel: 'Thu',
    people: [{ name: 'Zafar Khan', items: ['Wayfair - check the ads', SUB + 'all promos scheduled',
                                           SUB + 'two left for Friday', 'Packing slips'] }]
  });
  check('the message draws a sub-point under the line it belongs to',
    /list-style:circle/.test(m.html)
      && /all promos scheduled[\s\S]{0,200}two left for Friday/.test(m.html),
    (/<ul[^>]*list-style:circle[\s\S]{0,160}/.exec(m.html) || [])[0]);
  check('and the mark itself never reaches the reader',
    m.html.indexOf('↳') === -1, (/.{0,40}↳.{0,40}/.exec(m.html) || [])[0]);
  check('a card counts tasks, not the lines under them',
    /2 tasks</.test(m.html), (/\d+ tasks?</.exec(m.html) || [])[0]);

  const app = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
  const office = app.slice(app.indexOf('function renderWorkLogPage()'), app.indexOf('function renderHolidaysPage'));
  check('the office’s page nests them the same way',
    /wlog-sub/.test(office) && /taskText\(t\)/.test(office), office.slice(0, 60));
}

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
