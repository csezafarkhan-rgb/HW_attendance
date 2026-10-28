// Somebody who arrives late can say why from their own page, and the office
// accepts it or does not. The saying worked; the hearing did not. A reason
// went into a box that told nobody, so a day could be answered for and the
// answer never read - which is the same as not being able to answer at all.
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
  check('the reason is sent as waiting, not as granted',
    APP.indexOf("{ note: note, at: new Date().toISOString(), by: 'self', pending: true }") > -1);
  check('and the person is told plainly that it has not counted yet',
    APP.indexOf('Sent to the office. The minutes count until they accept it.') > -1);
  check('a reason already sent can be changed rather than sent twice',
    APP.indexOf('id="edPleaEdit"') > -1);
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
  check('and the month grid marks the day as sent rather than silent',
    APP.indexOf("(plN ? ' \\u00b7 sent' : '')") > -1 || APP.indexOf("' · sent'") > -1);
  /* The gap this closes: the evening message said how late somebody was and
     never that they had answered for it, so the only way to find a waiting
     reason was to open that one day by hand. */
  check('the evening message carries a waiting reason',
    SRV.indexOf('reason waiting:') > -1);
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
    SRV.indexOf('if (v && typeof v === \'object\' && v.pending === true) return;') > -1);
}

/* ---- nobody can answer for anybody else ---- */
{
  check('an employee writing a reason is merged, not taken at its word',
    /key === 'lateExcuses' && req\.session\.role === 'employee'/.test(SRV)
    && SRV.indexOf('mergeEmployeeExcuses(') > -1);
  check('and the key is one an employee is allowed to write at all',
    /const EMPLOYEE_WRITABLE = \[[^\]]*'lateExcuses'/.test(SRV));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
