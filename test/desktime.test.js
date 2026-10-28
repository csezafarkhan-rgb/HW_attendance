// Two records of the same day, made by different instruments: the card reader
// says somebody was here, DeskTime says their computer woke and how long it
// was in use. The page sets them side by side and says how far apart they are
// - it does not make one of them the other's judge, because a day on the floor
// is not a day at a keyboard.
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

/* ---- reading what DeskTime sends ---- */
{
  const ctx = { console };
  vm.createContext(ctx);
  ['dtClock', 'dtMinutes', 'dtNameOf'].forEach(n => vm.runInContext(grab(SRV, n), ctx));

  check('a stamped date and time keeps only the time',
    ctx.dtClock('2026-10-28 09:34:12') === '09:34', ctx.dtClock('2026-10-28 09:34:12'));
  check('a bare time is already the time',
    ctx.dtClock('09:34:12') === '09:34');
  check('an afternoon written the way people write it is afternoon',
    ctx.dtClock('5:37 PM') === '17:37', ctx.dtClock('5:37 PM'));
  check('and midnight written that way is not noon',
    ctx.dtClock('12:06 AM') === '00:06', ctx.dtClock('12:06 AM'));
  check('an hour before ten still reads as two digits',
    ctx.dtClock('8:34 AM') === '08:34', ctx.dtClock('8:34 AM'));
  check('nothing at all is nothing, not a guess',
    ctx.dtClock('') === '' && ctx.dtClock(null) === '' && ctx.dtClock('working') === '');

  /* Durations come as seconds. The one reading that must not happen is a
     working day turning into a rounding error. */
  check('a day at the desk in seconds becomes minutes',
    ctx.dtMinutes(29160) === 486, ctx.dtMinutes(29160));
  check('a number too small to be a day of seconds is taken as minutes',
    ctx.dtMinutes(533) === 533, ctx.dtMinutes(533));
  check('nothing, or less than nothing, is no time at all',
    ctx.dtMinutes(0) === 0 && ctx.dtMinutes(-5) === 0 && ctx.dtMinutes('x') === 0);

  /* DeskTime's roll of names is not the record's roll. */
  const map = { 'Karan': 'karan Ahuja', 'rahul': 'Rahul Mishra' };
  check('a name the office has mapped comes back as the record knows it',
    ctx.dtNameOf(map, 'Karan') === 'karan Ahuja');
  check('and the mapping is not case-bound',
    ctx.dtNameOf(map, 'rahul') === 'Rahul Mishra');
  check('a name nobody has mapped stands as DeskTime wrote it, rather than vanishing',
    ctx.dtNameOf(map, 'Keshav Garg') === 'Keshav Garg');
  check('an empty name is not a person',
    ctx.dtNameOf(map, '  ') === '');
}

/* ---- the pull itself ---- */
{
  check('the key is read from the environment before anywhere else',
    /deskTimeKeyOf[\s\S]{0,200}process\.env\.DESKTIME_API_KEY[\s\S]{0,200}sharedKeys\(orgId, \['deskTimeKey'\]\)/.test(SRV));
  check('with no key anywhere, nothing is pulled and nothing breaks',
    /if \(!key\) return \{ ok: false, error: 'no_key' \}/.test(SRV));
  check('a day that is not a day is refused before any call is made',
    SRV.indexOf("if (!DAY_RE.test(String(day || ''))) return { ok: false, error: 'bad_day' }") > -1);
  check('a request that never arrives is reported, not thrown',
    /catch \(e\) \{\s*return \{ ok: false, error: 'unreachable'/.test(SRV));
  check('an answer that is not JSON is not parsed as though it were',
    SRV.indexOf("error: 'not_json'") > -1);
  check('DeskTime refusing is passed on in its own words',
    SRV.indexOf("if (body.error) return { ok: false, error: 'desktime_said'") > -1);
  /* The field names are DeskTime's, and no key exists yet to check them
     against. The result carries what the first record held, so one live call
     settles it rather than a guess. */
  check('what the records actually carried comes back with the result',
    /const fields = list\[0\][\s\S]{0,120}Object\.keys\(list\[0\]\)/.test(SRV));
  check('several spellings of the same field are accepted',
    /e\.arrivedTime \|\| e\.arrived \|\| e\.arrive_time/.test(SRV)
    && /e\.leftTime \|\| e\.left \|\| e\.left_time/.test(SRV));
  check('a person DeskTime tracked nothing for is not written as a blank day',
    SRV.indexOf('if (!who || !arrived) return;') > -1);
  check('nothing is written when nothing came back',
    /if \(wrote\) \{\s*await pool\.query\(/.test(SRV));
  check('it is kept under the one key the page reads',
    /VALUES \(\$1, NULL, 'deskTime', \$2, NULL\)/.test(SRV));

  /* By hand, and by itself. */
  check('pulling by hand is the office\u2019s to do, not anybody\u2019s',
    /app\.post\('\/api\/desktime\/pull', requireRole\('admin'\)/.test(SRV));
  check('a range is capped rather than walked as far as it is asked',
    SRV.indexOf('days.length < 31') > -1);
  check('a backwards range is refused',
    SRV.indexOf("to < from) return res.status(400).json({ error: 'bad_range' })") > -1);
  check('the nightly pull takes yesterday and the day that is running',
    /async function deskTimeTick\(\)[\s\S]{0,900}pullDeskTime\(org\.id, day\)[\s\S]{0,400}pullDeskTime\(org\.id, before\)/.test(SRV));
  check('yesterday is claimed once, and given back if the pull failed',
    /desktime-pull:' \+ org\.id/.test(SRV)
    && /if \(!r\.ok\) await pool\.query\('DELETE FROM maintenance_done/.test(SRV));
  check('an office with no key is skipped rather than asked about',
    SRV.indexOf('if (!(await deskTimeKeyOf(org.id))) continue;') > -1);
  check('and it runs whether or not this office sends any mail',
    /setInterval\(function \(\) \{ deskTimeTick\(\)/.test(SRV)
    && SRV.indexOf('setInterval(deskTimeTick') === -1);
}

/* ---- what an employee may see of it ----
   A key nobody has allowed an employee to read is not readable by one: the
   filter answers with nothing rather than with everybody's day. */
{
  const ctx = { console, parseJson: t => { try { return JSON.parse(t); } catch (e) { return null; } },
                EMP_READABLE: [], EMP_KEYED_BY_DAY: [], EMP_KEYED_BY_NAME: [] };
  vm.createContext(ctx);
  ['EMP_READABLE', 'EMP_KEYED_BY_DAY', 'EMP_KEYED_BY_NAME'].forEach(n => {
    const m = new RegExp('const ' + n + ' = \\[[^\\]]*\\];').exec(SRV);
    if (m) vm.runInContext(m[0].replace('const ', 'var '), ctx);
  });
  vm.runInContext(grab(SRV, 'ownRequests') + grab(SRV, 'valueForEmployee'), ctx);
  const store = JSON.stringify({ 'Asha|2026-10-28': { i: '09:34' }, 'Ravi|2026-10-28': { i: '11:08' } });
  check('an employee asking for everybody\u2019s DeskTime is told nothing',
    ctx.valueForEmployee('deskTime', store, 'Asha', null) === undefined,
    ctx.valueForEmployee('deskTime', store, 'Asha', null));
}

/* ---- the page ---- */
{
  const page = APP.slice(APP.indexOf('function renderDeskTimePage('), APP.indexOf('function dtWire('));
  check('there is a page for it, and a tab to reach it by',
    APP.indexOf('id="page-desktime"') > -1 && APP.indexOf('data-page="desktime"') > -1
    && APP.indexOf("if(currentPage === 'desktime') renderDeskTimePage();") > -1);
  check('it opens on the month the last reading came from',
    /function dtMonthNow\(\)[\s\S]{0,320}Object\.keys\(deskTime\)/.test(APP));
  check('the two readings of a day are shown side by side, both times and the hours',
    /Marked in<\/th><th>DeskTime in/.test(page)
    && /Marked out<\/th><th>DeskTime out/.test(page)
    && /Hours marked<\/th><th>At the computer/.test(page));
  check('the difference is DeskTime measured from the marked time',
    /function dtGap\(marked, seen\)[\s\S]{0,260}return b - a;/.test(APP));
  check('and is said with a sign, so later and earlier cannot be confused',
    /mins > 0 \? '\+' : '(\\\\u2212|−)'/.test(APP));
  /* A day neither record knows about is not a row. */
  check('a day with nothing on either side is left out',
    page.indexOf('if(!seen && !markedIn) return;') > -1);
  check('a day they are still working is said so rather than left blank',
    page.indexOf("'still on'") > -1);
  check('two times that agree say so, rather than reading as an error',
    /if\(mins === 0\) return 'same';/.test(APP));
  /* Somebody at a computer with no mark against them at all is not a
     difference - there is nothing to take a difference from - so it is counted
     on its own rather than passed over. */
  check('a day at the computer with nothing marked is counted separately',
    page.indexOf('if(seen && !markedIn) unmarked++;') > -1
    && page.indexOf('at the computer with nothing marked') > -1);
  check('and the month says how many days the two records both know about',
    page.indexOf('both records know about') > -1);
  check('days far apart are picked out, by a measure said once',
    /var DT_GAP = 15;/.test(APP) && page.indexOf('gIn > DT_GAP') > -1
    && /tr\.dt-off\{ background:#FFF7E8/.test(APP));
  /* The thing this must not become: a machine for accusing people. */
  check('the page says plainly what it is not',
    page.indexOf('not which of them is right') > -1);
  check('and carries the count of days worth asking about beside each name',
    /function dtLateDays\(name, ym\)/.test(APP) && page.indexOf("' to look at'") > -1);
  check('nothing stored yet reads as nothing stored, not as nobody being here',
    page.indexOf('Nothing from DeskTime yet') > -1);
  /* It is kept and backed up like every other setting. */
  check('the two keys are loaded at startup',
    APP.indexOf('loadDeskTime, loadDeskTimeNames,') > -1);
  check('and go into the backup with the rest',
    /BACKUP_KEYS = \[[\s\S]{0,1000}'deskTime','deskTimeNames'/.test(APP));
  check('a stored day is only believed if it has an arrival on it',
    /function deskDay\(name, day\)[\s\S]{0,200}typeof v === 'object' && v\.i\)/.test(APP));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
