// Somebody who arrives late marks the day excused from their own page and
// says why. Nobody is asked: the mark counts at once and a message goes to
// whoever the office named, for reading. It waited for a tick before, and
// nobody was ever told there was anything to tick - eighty excuses on file
// and every one typed by the office.
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

/* ---- what a waiting reason is, and is not ----
   The whole arrangement rests on one distinction: a reason the person gave is
   waiting and changes nothing; a reason the office ticked excuses the day. */
{
  const ctx = { console };
  vm.createContext(ctx);
  ctx.lateExcuses = {
    'Asha|2026-10-05': { note: 'train was cancelled', at: '2026-10-05T04:10:00Z', by: 'self', pending: true },
    'Ravi|2026-10-05': { note: 'approved - client call ran over', at: '2026-10-05T05:00:00Z' }
  };
  vm.runInContext(grab(APP, 'lateIsOwned'), ctx);
  vm.runInContext(grab(APP, 'getLateExcuse'), ctx);
  vm.runInContext(grab(APP, 'getLatePlea'), ctx);

  check('a reason still waiting excuses nothing',
    ctx.getLateExcuse('Asha', '2026-10-05') === null);
  check('but it can still be read, in their words',
    (ctx.getLatePlea('Asha', '2026-10-05') || {}).note === 'train was cancelled');
  check('one the office ticked does excuse the day',
    (ctx.getLateExcuse('Ravi', '2026-10-05') || {}).note === 'approved - client call ran over');
  check('and is not shown as something still waiting',
    ctx.getLatePlea('Ravi', '2026-10-05') === null);
  check('a day nobody has said anything about is neither',
    ctx.getLateExcuse('Asha', '2026-10-06') === null
    && ctx.getLatePlea('Asha', '2026-10-06') === null);
}

/* ---- the page: saying it, and what saying it claims ---- */
{
  check('the mark counts from the moment it is made, with nothing waiting on it',
    APP.indexOf("{ note: note, at: new Date().toISOString(), by: 'self' }") > -1
    && APP.indexOf("by: 'self', pending: true }") === -1);
  check('and the person is told it has counted and that the office knows',
    APP.indexOf('Marked excused. The office has been told.') > -1);
  check('a mark of their own can be taken off again',
    APP.indexOf('id="edExcOff"') > -1
    && APP.indexOf('Taken off. The day counts as late, with nothing said about it.') > -1);
  /* The other answer: their own lateness, written down, which excuses nothing
     and so may be given with nothing written at all. */
  check('their own lateness is kept apart from work having made them late',
    APP.indexOf("if(picked === 'late') entry.kind = 'late';") > -1
    && APP.indexOf('Saved. The day still counts as late.') > -1);
  check('and it alone may be given without a word',
    APP.indexOf("if(picked === 'exc' && !note)") > -1);
  /* Once it is given it is on the record - the minutes are off the day or they
     are not, and the office has already been told which. So it is shown as
     settled rather than left in a half-open form that invites a stray
     keystroke, and changing it is a decision of its own. */
  check('a mark already given is shown as settled, not as a form',
    APP.indexOf('class="ed-set"') > -1
    && /mine && LATE_EDIT_DAY !== day/.test(APP));
  check('it says which of the two it was, and what that did to the day',
    APP.indexOf("'Late \u2014 personal'") > -1
    && APP.indexOf('The minutes are off this day, and the office has been told.') > -1);
  check('their own words are shown back, and a blank note says it is blank',
    /shotEsc\(mine\.note\)/.test(APP) && APP.indexOf('No reason written.') > -1);
  /* A browser's own confirm box cannot be read inside this frame on a phone,
     and says nothing about what is at stake. The card says it. */
  check('changing it asks first, in the card rather than in a browser box',
    APP.indexOf('id="edLateEdit"') > -1 && APP.indexOf('id="edLateAsk"') > -1
    && APP.indexOf('Go on?') > -1
    && APP.slice(APP.indexOf('id="edLateEdit"'), APP.indexOf('id="edLateEdit"') + 2500)
         .indexOf('confirm(') === -1);
  check('and the asking says what it will cost',
    /Changing this changes the day again/.test(APP)
    && /the office is told again/.test(APP));
  check('saying no leaves it exactly as it was',
    /id="edLateNo"[\s\S]{0,40}Leave it/.test(APP));
  check('saying yes opens that one day and no other',
    /lateGo[\s\S]{0,120}LATE_EDIT_DAY = day;/.test(APP));
  check('and once saved or taken off it settles again',
    (APP.match(/LATE_EDIT_DAY = null;/g) || []).length >= 2);
  check('an empty box is not a reason',
    APP.indexOf('Say what the reason was first.') > -1);
  /* The office ticking it writes an entry with no `pending` on it, which is
     what turns a reason into an excuse. */
  const tick = APP.slice(APP.indexOf("var lateExcuseSaveBtn"), APP.indexOf('var dayShiftSaveBtn'));
  const written = /lateExcuses\[key\] = \{[^}]*\}/.exec(tick);
  check('the office ticking it leaves no waiting mark behind',
    !!written && written[0].indexOf('pending') === -1
    && written[0].indexOf('at:new Date().toISOString()') > -1,
    written && written[0]);
  check('and unticking takes the waiting reason away with it, rather than leaving it to re-grant',
    tick.indexOf('else { delete lateExcuses[key]; }') > -1);
}

/* ---- the office hears it ---- */
{
  check("the day's own card shows what was said, before deciding",
    APP.indexOf('plea-wait') > -1 && APP.indexOf('Still counting as late') > -1);
  check('and the month grid says a day was answered for rather than silent',
    /plN \? ' .{0,8} said why'/.test(APP));
  /* The gap this closes: the evening message said how late somebody was and
     never that they had answered for it, so the only way to find a waiting
     reason was to open that one day by hand. */
  check('the evening message carries a waiting reason',
    SRV.indexOf('they say:') > -1 && SRV.indexOf('marked late by them') > -1);
  check('it reads the waiting ones, which the counting deliberately drops',
    SRV.indexOf('const said = allExcuses[key];') > -1
    && SRV.indexOf("said.pending === true") > -1);
  check('a reason that is only blank space is not reported as a reason',
    SRV.indexOf("&& String(said.note || '').trim()) ? String(said.note).trim() : ''") > -1);
  check('a very long one is cut rather than left to run',
    SRV.indexOf('plea.slice(0, 160)') > -1);
  check('and an excused day still reads as excused, not as waiting',
    /excuses\[key\] \? ' \\u2014 excused'\s*\n\s*: \(plea \?/.test(SRV));
  /* It still must not change the arithmetic: saying so is not granting it. */
  check('saying so does not stop the minutes counting',
    SRV.indexOf('if (rows[i] && !excuses[key]) { rows[i].late = came - start; }') > -1);
  check('and the tally still drops the waiting ones before counting',
    SRV.indexOf("(v.pending === true || v.kind === 'late')) return;") > -1);
}

/* ---- nobody can answer for anybody else ---- */
{
  check('an employee writing a reason is merged, not taken at its word',
    /key === 'lateExcuses' && req\.session\.role === 'employee'/.test(SRV)
    && SRV.indexOf('mergeEmployeeExcuses(') > -1);
  check('and the key is one an employee is allowed to write at all',
    /const EMPLOYEE_WRITABLE = \[[^\]]*'lateExcuses'/.test(SRV));
}

/* ---- who is told, and that it is only telling ---- */
{
  const ctx = { console, parseJson: t => { try { return JSON.parse(t); } catch (e) { return null; } },
                DAY_RE: /^\d{4}-\d{2}-\d{2}$/ };
  vm.createContext(ctx);
  vm.runInContext(grab(SRV, 'newlySelfExcused'), ctx);
  const was = JSON.stringify({
    'Asha|2026-10-27': { note: 'train', at: 'x', by: 'self' },
    'Ravi|2026-10-27': { note: 'approved by me', at: 'x' }
  });
  const now = JSON.stringify({
    'Asha|2026-10-27': { note: 'train', at: 'x', by: 'self' },        // unchanged
    'Asha|2026-10-28': { note: 'tyre', at: 'x', by: 'self' },          // new
    'Ravi|2026-10-27': { note: 'approved by me', at: 'x' },            // the office's, untouched
    'Ravi|2026-10-28': { note: 'allowed', at: 'x' },                   // the office's, new
    'Neha|2026-10-28': { note: 'waiting one', at: 'x', by: 'self', pending: true }
  });
  const fresh = ctx.newlySelfExcused(was, now);
  const names = fresh.map(f => f.empName + '|' + f.day).sort();
  check('a mark somebody just made for themselves is news',
    names.indexOf('Asha|2026-10-28') > -1, names);
  check('one they made before and have not touched is not news again',
    names.indexOf('Asha|2026-10-27') === -1, names);
  check('nothing the office wrote is reported back to the office',
    names.every(n => n.indexOf('Ravi') !== 0), names);
  check('and an old-style waiting one is left alone',
    names.indexOf('Neha|2026-10-28') === -1, names);
  check('the words go with it',
    (fresh[0] || {}).note === 'tyre', fresh);

  /* Changing their mind is worth hearing about, and saying so. */
  const after = JSON.stringify({ 'Asha|2026-10-27': { note: 'tyre, not the train', at: 'y', by: 'self' } });
  const again = ctx.newlySelfExcused(was, after);
  check('changing what they said is news too',
    again.length === 1 && again[0].note === 'tyre, not the train', again);
  check('and the message can say it was a change',
    again[0].changed === true, again[0]);

  check('a key with no day on it is ignored rather than guessed at',
    ctx.newlySelfExcused('{}', JSON.stringify({ 'Asha': { note: 'x', by: 'self' } })).length === 0);
  check('and so is a day that is not a day',
    ctx.newlySelfExcused('{}', JSON.stringify({ 'Asha|last tuesday': { note: 'x', by: 'self' } })).length === 0);
  check('rubbish in place of a map says nothing rather than throwing',
    ctx.newlySelfExcused('not json', 'also not json').length === 0);
}

/* ---- the message, and the addresses it goes to ---- */
{
  const mailer = require(path.join(REPO, 'mailer.js'));
  const mail = mailer.excusedEmail({
    orgName: 'Homeweavers', siteUrl: 'https://x/',
    items: [{ name: 'Asha', day: '2026-10-28', note: 'train was cancelled',
              came: '10:05', shift: '9:30-6:30', late: 35, changed: false }]
  });
  const text = mail.html.replace(/<[^>]+>/g, ' ');
  check('the message names who, when, and how late they were',
    /Asha/.test(text) && /28 Oct/.test(text) && /35 min/.test(text), text.slice(0, 0));
  check('and carries their own words',
    /train was cancelled/.test(text));
  check('it says plainly that nothing is being asked',
    /nothing is being asked of you/.test(text));
  /* The one thing it must not be is a decision to make: no approve, no
     reject, nothing that writes anything. */
  check('there is nothing on it to approve or reject',
    !/Approve|Reject/i.test(mail.html), (mail.html.match(/Approve|Reject/gi) || []).slice(0, 3));
  check('nothing to send at all means no message',
    mailer.excusedEmail({ orgName: 'x', items: [] }) === null);

  /* Who it goes to is the office's own list and nothing else: this is not a
     message anybody falls back into receiving. */
  const notify = SRV.slice(SRV.indexOf('async function notifySelfExcused'),
                           SRV.indexOf('/* A day marked as leave on the grid'));
  /* Either the people who give the final word on leave, read from that list as
     it stands rather than copied, or addresses the office sets here. Not both,
     and never a list nobody chose. */
  check('it can go to the people who give the final word on leave',
    notify.indexOf('settings.excused.final') > -1
    && notify.indexOf("mailRecipients(orgId, settings, 'leave')") > -1);
  check('or to addresses of its own where the office would rather',
    notify.indexOf('(settings.excused.to || []).slice()') > -1);
  check('and with nobody on either, nothing is sent at all',
    notify.indexOf('if (!to.length) return;') > -1);
  check('nobody is copied twice',
    notify.indexOf('.filter(a => to.indexOf(a) < 0)') > -1);
  check('how late they were is read off the record, not taken from the page',
    notify.indexOf('FROM records WHERE org_id = $1 AND day = ANY($2)') > -1);
  check('and the message is kept like every other',
    notify.indexOf("logMail(orgId, 'excused'") > -1);
  check('a message that fails leaves the mark standing',
    notify.indexOf('the excused mark stands but its message failed') > -1);
  /* The setting is a real setting, kept and validated like the rest. */
  check('the addresses are validated like every other address box',
    /s\.excused = \{\s*final: ex\.final !== false,\s*to: \(Array\.isArray\(ex\.to\)/.test(SRV));
  check('and the panel has the choice, with somewhere to type the other one',
    APP.indexOf('id="emExcFinal"') > -1 && APP.indexOf('id="emExcTo"') > -1
    && APP.indexOf('id="emExcCc"') > -1
    && APP.indexOf("final: !!(document.getElementById('emExcFinal') || {}).checked") > -1);
  check('the box of addresses is shut while the first choice is taken',
    APP.indexOf('box.disabled = fin.checked;') > -1);
  /* It lived at the foot of the attendance pane, below everything that pane is
     about, and was not found. A late day answered for is its own message to
     its own people, so it has a tab of its own. */
  check('the setting has a tab of its own rather than a footnote on another',
    APP.indexOf('data-em-tab="lt">Late &amp; Shift<') > -1
    && APP.indexOf('data-em-pane="lt"') > -1);
  /* The tab carries two things somebody can put on their own day, and says so
     before it asks who hears about them. */
  check('and the tab says what it covers before asking who hears',
    /data-em-pane="lt"[\s\S]{0,420}a late arrival answered for, and the hours they are working/.test(APP));
  check('each of the two is told in its own words, to the same people',
    APP.indexOf('id="emShSubject"') > -1 && APP.indexOf('id="emShIntro"') > -1
    && APP.indexOf('id="emShFooter"') > -1
    && APP.indexOf('the same people, a different message') > -1);
  check('and the shift words are stored under the same setting',
    /shift: \{ subject: document\.getElementById\('emShSubject'\)/.test(APP)
    && /shift: \(function \(\) \{[\s\S]{0,260}clip\(sh\.subject, 200\)/.test(SRV));
  /* The wording, which every other message here lets the office set. */
  check('its words can be set like every other message’s',
    APP.indexOf('id="emExcSubject"') > -1 && APP.indexOf('id="emExcIntro"') > -1
    && APP.indexOf('id="emExcFooter"') > -1
    && /subject: clip\(ex\.subject, 200\), intro: clip\(ex\.intro, 2000\)/.test(SRV));
  check('and the message carries them, falling back to the ones it comes with',
    /subject: settings\.excused\.subject, intro: settings\.excused\.intro/.test(SRV));
  /* A test used to say "email is working" whichever tab was open. */
  check('a test sends the message of the tab being looked at',
    APP.indexOf("post('/api/mail/test', { kind: kind }") > -1
    && /const kind = String\(\(req\.body && req\.body\.kind\)/.test(SRV));
  check('and builds it from a real mark where there is one, an example where there is not',
    SRV.indexOf("x.v.by === 'self'") > -1
    && SRV.indexOf('A name from the record') > -1);
  /* Shown in the boxes rather than behind them: what is on screen is what
     goes out, and it can be edited from there. */
  check('the wording it comes with is in the boxes, not a placeholder',
    /id="emExcSubject" value="'\s*\+\s*mailEscape\(text\(ex\.subject, \(W\.excused \|\| \{\}\)\.subject\)\)/.test(APP)
    && APP.indexOf('mailEscape(text(ex.intro, (W.excused || {}).intro))') > -1
    && APP.indexOf('mailEscape(text(ex.footer, (W.excused || {}).footer))') > -1);
  check('and those words are the ones the message itself falls back to',
    /excused: \{[\s\S]{0,120}subject: 'Late excused/.test(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'mailer.js'), 'utf8')));
  check('the panel says what the message is for',
    APP.indexOf('for reading, not for deciding') > -1);
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
