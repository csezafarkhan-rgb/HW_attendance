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
  /* Two durations, and not the same thing: the span from arriving to leaving,
     and the part of it the computer was in use. The second is what DeskTime's
     own page leads with and what the office reads as the day's work, so
     keeping only the first would have answered a question nobody asked. */
  check('both of DeskTime’s durations are kept, not only the span',
    /w: dtMinutes\(pick\('atWorkTime'/.test(SRV) && /d: dtMinutes\(pick\('desktimeTime'/.test(SRV));
  check('and each accepts the spellings it might arrive under',
    /pick\('atWorkTime', 'atWork', 'at_work_time'/.test(SRV)
    && /pick\('desktimeTime', 'deskTimeTime', 'desktime_time'/.test(SRV));
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
  /* What a day comes to is worked out in dtFacts and drawn in two places -
     a month of days, and a year of months - so the reading is checked where
     it lives rather than where it happens to be printed. */
  const facts = grab(APP, 'dtFacts');
  check('there is a page for it, and a tab to reach it by',
    APP.indexOf('id="page-desktime"') > -1 && APP.indexOf('data-page="desktime"') > -1
    && APP.indexOf("if(currentPage === 'desktime') renderDeskTimePage();") > -1);
  check('it opens on the month the last reading came from',
    /function dtMonthNow\(\)[\s\S]{0,320}Object\.keys\(deskTime\)/.test(APP));
  check('the two readings of a day are shown side by side, both times and the hours',
    /Marked in<\/th><th>DeskTime in/.test(page)
    && /Marked out<\/th><th>DeskTime out/.test(page)
    && /Hours marked<\/th><th>DeskTime time/.test(page));
  check('the figure DeskTime leads with is shown, and said to be the one it leads with',
    page.indexOf("class=\"dt-desk\"") > -1 && page.indexOf('seen.d') > -1
    && page.indexOf('the computer was actually in use') > -1);
  /* A row of dashes in the marked columns is not an accusation: it may be a
     Sunday, a day of leave, or somebody who simply does not punch. The record's
     own word for the day sits beside it so it can be read that way. */
  check('the record’s own word for the day is shown beside it',
    page.indexOf('The record says') > -1 && facts.indexOf('STATUS_LABEL[rec.st]') > -1
    && facts.indexOf('OV_CATS[ov.cat].label') > -1);
  check('and the hour they were due in, which is what late is measured from',
    page.indexOf('>Due in<') > -1 && /getShift\(name, day\)/.test(facts));
  /* Three durations, which are three different things. Productive time and
     idle time were a fourth and a fifth, and the office found them noise: what
     it reads a day by is how long somebody was here and how much of that the
     computer was in use. */
  /* Two figures and what they come to. DeskTime's own span from arriving to
     leaving was a third: it measures the same thing the record already
     measures, and worse - it is the machine's day, not the person's. */
  check('the day is measured by the record and by the computer, and nothing else',
    /<th class="dt-sep">Hours marked<\/th><th>DeskTime time<\/th>/.test(page)
    && page.indexOf('At work') === -1
    && page.indexOf('Productive') === -1 && page.indexOf('Idle') === -1);
  check('and the group above them counts them and the share they come to',
    /colspan="3">How long/.test(page)
    && page.indexOf('<th>At the computer</th>') > -1);
  check('each is explained, because none of them is obvious',
    page.indexOf('this record’s own day, in to out') > -1
    && page.indexOf('how long the computer was actually in use') > -1);
  /* Fourteen columns are four questions. */
  check('the columns are grouped under what they answer',
    /The day[\s\S]{0,300}Arriving[\s\S]{0,220}Leaving[\s\S]{0,240}How long/.test(page));
  check('with a hairline between the groups, in the header and down the rows',
    /\.dt-table-cmp \.dt-sep\{ border-left:1px solid/.test(APP)
    && (page.match(/class="dt-sep"/g) || []).length >= 8);
  /* Two figures side by side make the reader do the division. The bar does it,
     and the eye finds the short ones without reading a number at all. */
  check('the share of the day spent at the computer is drawn as well as counted',
    /function dtUse\(work, desk\)/.test(APP) && /function dtUseBar\(pct\)/.test(APP)
    && page.indexOf('dtUseBar(dtUse(markedMin, seen && seen.d))') > -1);
  check('it is the computer’s time as a share of the marked day',
    /Math\.round\(desk \/ work \* 100\)/.test(APP)
    && page.indexOf('dtUseBar(dtUse(markedMin, seen && seen.d))') > -1);
  check('a day missing either figure has no share to show',
    /if\(!work \|\| !desk\) return null;/.test(APP));
  check('under half is picked out, and the bands are said in the stylesheet',
    /pct >= 75 \? 'hi' : \(pct >= 50 \? 'mid' : 'lo'\)/.test(APP)
    && /\.dt-use\.lo \.dt-use-bar > span\{ background:#C9594F/.test(APP));
  /* A day worked from home has no punches to measure, and read as a dash it
     looked like a day that counted for nothing - next to a share of the
     computer's time it could never be a share of. */
  check('a day with no punches is credited the shift the record credits it',
    facts.indexOf('var worked = workedMinutes(name, day);') > -1
    && facts.indexOf('markedMin = worked; credited = true;') > -1);
  check('and says it was credited rather than measured',
    page.indexOf('class="dt-credited"') > -1
    && page.indexOf('Credited to the shift') > -1);
  check('the figure comes from the same place the totals take it',
    /function workedMinutes\(emp, dateStr\)[\s\S]{0,700}return owedMinutes\(emp, dateStr\);/.test(APP));
  check('which is the whole shift on a weekday and the Saturday policy on a Saturday',
    /function owedMinutes\(emp, dateStr\)[\s\S]{0,420}sp\.mode === 'WFH'\)  return Math\.round\(\(sp\.hours\|\|0\) \* 60\)/.test(APP));
  check('a day nobody worked at all is still a dash',
    facts.indexOf('if(worked > 0)') > -1);

  /* The thing it must not become. */
  check('and the page says it is a question rather than a finding',
    page.indexOf('a question rather than a finding') > -1
    && page.indexOf('the keyboard to show for it') > -1);
  check('the week says its own share too',
    page.indexOf('dtUseBar(dtUse(wkMarked, wkDesk))') > -1);

  /* A week is the unit the office counts in - hours owed, hours over - and the
     attendance record is read that way. Thirty rows with nothing between them
     is a wall to scan. */
  check('the days are grouped into weeks, as the record is',
    page.indexOf('class="dt-week"') > -1 && page.indexOf('Week of ') > -1);
  check('a week is bounded the same way the record bounds one',
    page.indexOf('mondayOf(day)') > -1);
  /* It used to close on drawing a Sunday, and Sunday is nobody's working day
     here, so there was almost never a Sunday row to close on: a month came out
     as one long week with a single total under it. */
  check('and closes where the next day belongs to another week, not on a Sunday',
    /if\(wkFrom && mon !== wkFrom\) closeWeek\(\);/.test(page) && !/dow === 0/.test(page));
  check('and the last week of a month is closed even though it ends mid-week',
    /closeWeek\(\);\s*$/m.test(page) || page.lastIndexOf('closeWeek();') > page.indexOf('days.forEach'));
  check('each week says what it came to, in the columns that measure it',
    /wkMarked \+= markedMin/.test(page) && /wkDesk \+= seen\.d/.test(page));
  check('an empty week is not drawn at all',
    page.indexOf('if(!wkDays) return;') > -1);
  check('and the table scrolls inside the page rather than widening it',
    page.indexOf('<div class="dt-scroll">') > -1 && /\.dt-scroll\{ overflow-x:auto/.test(APP));
  check('the difference is DeskTime measured from the marked time',
    /function dtGap\(marked, seen\)[\s\S]{0,260}return b - a;/.test(APP));
  check('and is said with a sign, so later and earlier cannot be confused',
    /mins > 0 \? '\+' : '(\\\\u2212|−)'/.test(APP));
  /* A day neither record knows about is not a row. */
  check('a day with nothing on either side is left out',
    facts.indexOf('if(!seen && !markedIn && !hol) return null;') > -1);
  /* Except a company holiday, which is the answer to “why is there nothing
     here” - and dropping the row dropped the answer. */
  check('unless the office closed that day, which is a thing worth saying',
    /var hol = getOfficialLeave\(day\);/.test(facts)
    && /if\(hol\) said = hol\.name/.test(facts)
    && /tr\.dt-hol td{ background:#F1EBFB/.test(APP));
  check('and it is picked out in the violet the attendance record files it under',
    /tr\.holiday-row \.date-col{background:#6E4BB8/.test(APP)
    && /tr\.dt-hol \.dt-day{ box-shadow:inset 3px 0 0 #6E4BB8/.test(APP));
  check('a day somebody worked through the closure says both things',
    /hol\.name \+ \(ov && OV_CATS\[ov\.cat\]/.test(facts));
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
    /var DT_GAP = 15;/.test(APP) && facts.indexOf('gIn > DT_GAP') > -1
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

/* ---- reading a DeskTime export in ----
   The account owner's API key has not been given, so until it is the figures
   come the way the office can actually get them: DeskTime's own "Time at work"
   export, read off a file. Two things such a file cannot settle on its own -
   whose name is whose, and what an empty row means - and both are answered
   here rather than guessed at. */
{
  const api = (() => {
    const src = ['parseCSVText', 'findCol', 'dtCsvClock', 'dtCsvMins', 'dtReadExport']
      .map(n => grab(APP, n)).join('\n');
    return new Function(src + '\nreturn { read: dtReadExport, clock: dtCsvClock, mins: dtCsvMins };')();
  })();
  /* DeskTime's own header, verbatim from an export of this account. */
  const HEAD = 'Date,"User name",Email,Team,"Arrival time","Left time",'
    + '"Productive time (sum)","Unproductive time (sum)","Neutral time (sum)",'
    + '"Offline time","Private time (sum)","Idle time (sum)","Total DeskTime",'
    + '"Total time at work","Productivity %","Effectiveness %","Late (sum)",'
    + '"Extra hours before work (sum)","Extra hours after work (sum)"';
  const row = (d, who, i, o, desk, work) =>
    [d, '"' + who + '"', 'x@y.z', '"T"', i, o, '', '', '', '', '', '',
     desk, work, '', '', '', '', ''].join(',');
  const CSV = [HEAD,
    row('2026-10-01', 'Zafar', '9:39:29', '18:36:48', '8:22:43', '8:57:19'),
    row('2026-10-02', 'Zafar', '14:04:36', '15:22:57', '1:18:21', '1:18:21'),
    /* A day DeskTime tracked nothing: every figure on the row is empty. */
    row('2026-10-03', 'Zafar', '', '', '', ''),
    row('2026-10-01', 'Himanshu jain', '10:02:00', '19:00:00', '7:00:30', '8:58:00'),
    /* Somebody with the agent installed and nothing tracked all month. */
    row('2026-10-01', 'Nitish Kumar', '', '', '', '')].join('\n');

  const r = api.read(CSV, 'hw-2026-10.csv');
  check('an export is read as days, one per person per date',
    r.ok && r.rows.length === 3, r.ok ? r.rows.length : r.why);
  check('a clock is read as a clock, to the minute',
    api.clock('9:39:29') === '09:39' && api.clock('18:36:48') === '18:36',
    [api.clock('9:39:29'), api.clock('18:36:48')]);
  /* 8:22:43 is a length and 18:36:48 a time of day, and the two look alike. */
  check('and a length as minutes, rounding the half minute up',
    api.mins('8:22:43') === 503 && api.mins('1:18:21') === 78
    && api.mins('14:30:59') === 871,
    [api.mins('8:22:43'), api.mins('1:18:21'), api.mins('14:30:59')]);
  check('the two durations are kept apart: the span at work, and the time in use',
    r.rows[0].v.w === 537 && r.rows[0].v.d === 503, r.rows[0].v);
  /* The one that would quietly poison the page: a row with nothing on it is a
     day DeskTime tracked nothing, and written in as nought it would draw a bar
     saying none of the day was spent at the computer. */
  check('a row with no arrival is left out, not stored as a day of nothing',
    r.skipped === 2 && !r.rows.some(x => x.day === '2026-10-03'), r.skipped);
  check('and a name with no tracked day at all is not a name to be asked about',
    !('Nitish Kumar' in r.people) && r.people['Zafar'] === 2, r.people);
  check('the file says what stretch it covers, which is what the panel leads with',
    r.from === '2026-10-01' && r.to === '2026-10-02', [r.from, r.to]);
  /* The wrong file is the likeliest mishap, and it must change nothing. */
  check('a file that is not a DeskTime export is refused, by name',
    (() => { const bad = api.read('a,b,c\n1,2,3', 'x.csv');
      return !bad.ok && /Time at work/.test(bad.why); })());
  check('and an export with rows but no arrival on any of them says so',
    (() => { const none = api.read([HEAD,
        row('2026-10-01', 'Zafar', '', '', '', '')].join('\n'), 'x.csv');
      return !none.ok && /not one of them has an arrival/.test(none.why); })());

  /* Names. DeskTime says Karan where the record says karan Ahuja, and a name
     settled once is remembered, so the next file needs no asking. */
  check('a name the record already knows needs no asking',
    /function dtRecName\(raw\)[\s\S]{0,400}deskTimeNames\[k\]/.test(APP));
  check('one it does not is guessed at for the panel, never acted on',
    /function dtGuessName\(raw\)/.test(APP)
    && APP.indexOf('Leave this one out') > -1);
  check('what the office settles is remembered against the DeskTime name',
    /deskTimeNames\[raw\] = to; mapped\+\+;/.test(APP));
  check('and saved on its own, so a name stays settled even if the figures do not',
    /\(mapped \? saveDeskTimeNames\(\) : Promise\.resolve\(\)\)/.test(APP));
  check('a name left unmapped is left out and said so, not silently dropped',
    APP.indexOf("'Left out: '") > -1
    && /if\(!who\){ left\[r\.who\] = true; return; }/.test(APP));
  /* Nothing is written until the office has seen what the file said. */
  check('the file is read into a panel first and written only on a press',
    /var DT_IMP = null;/.test(APP) && /if\(go\) go\.onclick = dtImportWrite;/.test(APP));
  check('the button is the office’s, not everybody’s',
    /\+ \(canEdit\(\)[\s\S]{0,200}id="dtImpBtn/.test(APP));
  check('and takes a csv and nothing else',
    APP.indexOf('accept=".csv,text/csv"') > -1);
  /* A year does not come in one file: DeskTime refuses the range, so it comes
     as twelve. Twelve presses and twelve panels would be the obvious way and
     the wrong one. */
  check('the picker takes several files at once',
    APP.indexOf('multiple ') > -1
    && /function dtImportFiles\(list\)/.test(APP)
    && /dtImportFiles\(file\.files\)/.test(APP));
  check('and they are read as one stretch, not one panel each',
    /Promise\.all\(files\.map\(one\)\)/.test(APP));
  /* The same month exported twice is the ordinary case, not an error: the
     later file is the corrected one. */
  check('a day two files both carry is kept once, the later file winning',
    /if\(seen\[k\] === undefined\){ seen\[k\] = rows\.length; rows\.push\(x\); }/.test(APP)
    && /else rows\[seen\[k\]\] = x;/.test(APP));
  check('a file in the pile that cannot be read is named rather than passed over',
    APP.indexOf('could not be read and nothing from ') > -1);
  /* After it is in, the page is redrawn on the month the file ended in rather
     than the one that happened to be open. */
  check('the page comes back on what was just read in',
    /DT_IMP = null;[\s\S]{0,80}DT_MONTH = null;[\s\S]{0,80}renderDeskTimePage\(\);/.test(APP));
}

/* ---- the screenshots, which are not ours to draw ----
   DeskTime keeps the day's screenshots behind its own sign-in, so nothing here
   can show one. A frame with a broken picture in it would be worse than a door,
   and the door at least opens on the right day. */
{
  const page = APP.slice(APP.indexOf('function renderDeskTimePage('),
                         APP.indexOf('function dtWire('));
  const link = grab(APP, 'dtShotLink');
  check('there is a column for the day\u2019s screenshots',
    page.indexOf('>Screenshots<') > -1 && page.indexOf('What it saw') > -1);
  check('and it opens DeskTime on the day being read, not on today',
    /desktime\.com\/app\/screenshots\/' \+ shotEsc\(day\)/.test(link));
  check('in a tab of its own, with nothing of this page handed over',
    link.indexOf('target="_blank" rel="noopener noreferrer"') > -1);
  check('it names whose screenshots to look for, the page not taking a name',
    /shotEsc\(dispName\(name\)\)/.test(link));
  /* DeskTime takes no screenshots on a day it tracked nothing, and a link to an
     empty page is a wasted press. */
  check('only on a day DeskTime saw at all',
    /seen \? dtShotLink\(day, DT_WHO\) : '/.test(page));
  check('and the page says plainly why the picture is not here',
    page.indexOf('behind that sign-in, so they cannot be drawn here') > -1);
}

/* ---- the week as a block, and the two things a reader can put away ---- */
{
  const page = APP.slice(APP.indexOf('function renderDeskTimePage('),
                         APP.indexOf('function dtWire('));
  const wire = APP.slice(APP.indexOf('function dtWire('), APP.indexOf('var WLOG_DAY'));
  check('a week is drawn as a block, with a hairline round it',
    page.indexOf('rows += \'<tbody class="dt-wk">\'') > -1
    && /tbody\.dt-wk\{ border:1px solid/.test(APP));
  check('and air between it and the next',
    page.indexOf('dt-wkgap') > -1 && /tbody\.dt-wkgap td\{ height:9px/.test(APP));
  /* Put away, not thrown away: the block stays drawn, the total stops. */
  check('the week totals can be put away without losing the grouping',
    /\.dt-noweeks \.dt-table-cmp tr\.dt-week\{ display:none; \}/.test(APP)
    && page.indexOf('id="dtWeekChk"') > -1);
  check('and the month\u2019s own line is a second thing to ask for',
    page.indexOf('id="dtMonthChk"') > -1
    && /\.dt-nomonth \.dt-table-cmp tbody\.dt-mth\{ display:none; \}/.test(APP));
  /* Neither redraws the month: the rows are the same rows either way, and a
     redraw would lose where the reader was. */
  check('both are a class on the wrapper rather than a redraw',
    /function dtWrapClass\(\)\{/.test(APP)
    && wire.indexOf('box.className = dtWrapClass();') > -1
    && !/dtWeekChk[\s\S]{0,320}renderDeskTimePage\(\);/.test(wire));
  check('and each is remembered in this browser, being one reader\u2019s own',
    /localStorage\.setItem\('hw\.dt\.weeks'/.test(APP)
    && /localStorage\.setItem\('hw\.dt\.month'/.test(APP)
    && /function dtPref\(key, dflt\)\{/.test(APP));
  check('the month total is off until it is asked for, the week totals on',
    /var DT_WEEKS = dtPref\('weeks', true\);/.test(APP)
    && /var DT_MONTHSUM = dtPref\('month', false\);/.test(APP));
}

/* ---- the year, a month to a row ----
   A month answers "what happened on the eighth". A year answers "which months
   were thin", and that is twelve rows rather than three hundred. */
{
  const page = APP.slice(APP.indexOf('function renderDeskTimePage('),
                         APP.indexOf('function dtWire('));
  const wire = APP.slice(APP.indexOf('function dtWire('), APP.indexOf('var WLOG_DAY'));
  const body = grab(APP, 'dtYearBody');
  const tally = grab(APP, 'dtTally');
  const span = grab(APP, 'dtSpanRow');
  check('the page can be read a year at a time',
    /var DT_SCALE = 'month';/.test(APP) && page.indexOf('id="dtScale"') > -1);
  check('and the picker then steps years, not months',
    /if\(DT_SCALE === 'year'\)\{[\s\S]{0,200}DT_YEAR = String/.test(wire));
  check('a month with nothing in it is left out, not drawn as twelve dashes',
    /if\(!t\.days\) continue;/.test(body));
  check('and the year\u2019s own line closes it',
    /'All of ' \+ year/.test(body) && body.indexOf('tbody class="dt-yr"') > -1);
  /* A sum of clock times means nothing; a sum of durations is the figure. */
  check('arriving and leaving are averaged, how long is added up',
    /t\.marked \+= f\.markedMin/.test(tally)
    && /t\.inSum \+= mi/.test(tally)
    && /function dtAvg\(sum, n\)\{ return n \? \(sum \/ n\) : null; \}/.test(APP));
  /* Averaging a gap over days that had no gap would flatter it. */
  check('a difference is averaged only over days both records knew about',
    /if\(f\.gIn !== null\)\{ t\.both\+\+; t\.gInN\+\+; t\.gInSum \+= f\.gIn; \}/.test(tally));
  check('the year reads the same columns as the month, which is the point',
    /dt-usecell[\s\S]{0,140}dtUseBar\(dtUse\(t\.marked, t\.desk\)\)/.test(span)
    && /Arriving'[\s\S]{0,90}on average/.test(page));
  check('and the count beside a name follows the scale it is shown at',
    /year \? dtLateYear\(e\.name, yr\) : dtLateDays\(e\.name, ym\)/.test(page));
  /* The week and month controls belong to a month view; in a year view they
     would point at rows that are not there. */
  check('the month\u2019s own controls are not offered in the year view',
    page.indexOf('+ (year ? \'\' : (\'<label class="dt-chk"') > -1);
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
