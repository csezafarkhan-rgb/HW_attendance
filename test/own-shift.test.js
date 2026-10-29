// The hours somebody is working today, set by the person working them.
//
// A shift is the measure every other figure on the day is taken against -
// late, early, how much of the day is owed - so a day whose hours moved and
// were never recorded reads as a day somebody was late for. Only the office
// could move them, which meant asking, and being asked after the fact about a
// morning that had already happened.
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
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/* ---- what one person may write, and what they may not ---- */
{
  const ctx = { console, JSON, Object, String,
    parseJson: t => { try { return JSON.parse(t); } catch (e) { return null; } } };
  vm.createContext(ctx);
  ['parseShiftSpan', 'ownDays', 'mergeEmployeeDayShifts'].forEach(n => vm.runInContext(grab(SRV, n), ctx));
  vm.runInContext('var IST_MS = 5.5 * 3600 * 1000;', ctx);
  const merge = (stored, incoming, name) =>
    JSON.parse(ctx.mergeEmployeeDayShifts(JSON.stringify(stored), JSON.stringify(incoming), name, '9:30-6:30'));

  check('they may set the hours of the day they are in',
    merge({}, { ['Asha|' + today]: '11:00-8:00' }, 'Asha')['Asha|' + today] === '11:00-8:00');
  check('and take them off again by not sending them',
    Object.keys(merge({ ['Asha|' + today]: '11:00-8:00' }, {}, 'Asha')).length === 0);
  /* The page sends the whole map, and their copy of everybody else's is only
     as fresh as their last read. */
  check('somebody else’s day is left exactly as stored',
    merge({ 'Ravi|2026-10-02': '8:00-5:00' }, { 'Ravi|2026-10-02': '2:00-11:00' }, 'Asha')['Ravi|2026-10-02']
      === '8:00-5:00');
  check('and cannot be removed by leaving it out',
    merge({ 'Ravi|2026-10-02': '8:00-5:00' }, {}, 'Asha')['Ravi|2026-10-02'] === '8:00-5:00');
  check('a day that is not theirs to set is not set',
    merge({}, { 'Asha|2026-01-02': '11:00-8:00' }, 'Asha')['Asha|2026-01-02'] === undefined);
  /* A shift is a pair of times. Anything else would be measured against. */
  check('something that is not a pair of times is not a shift',
    merge({}, { ['Asha|' + today]: 'whenever' }, 'Asha')['Asha|' + today] === undefined);
  check('and neither is a blank',
    merge({}, { ['Asha|' + today]: '   ' }, 'Asha')['Asha|' + today] === undefined);
  check('rubbish in place of a map is refused outright',
    ctx.mergeEmployeeDayShifts('{}', '"not a map"', 'Asha', '') === null);
}

/* ---- which days changed hands, for the message that follows ---- */
{
  const ctx = { console, JSON, Object, String, DAY_RE: /^\d{4}-\d{2}-\d{2}$/,
    parseJson: t => { try { return JSON.parse(t); } catch (e) { return null; } } };
  vm.createContext(ctx);
  vm.runInContext(grab(SRV, 'newlyOwnShifts'), ctx);
  const moved = ctx.newlyOwnShifts(
    JSON.stringify({ 'Asha|2026-10-29': '9:30-6:30', 'Ravi|2026-10-29': '8:00-5:00' }),
    JSON.stringify({ 'Asha|2026-10-29': '11:00-8:00', 'Ravi|2026-10-29': '2:00-11:00' }),
    'Asha');
  check('their own change is news, with both the old hours and the new',
    moved.length === 1 && moved[0].from === '9:30-6:30' && moved[0].to === '11:00-8:00', moved);
  check('and somebody else’s change is not',
    moved.every(m => m.empName === 'Asha'));
  const off = ctx.newlyOwnShifts(JSON.stringify({ 'Asha|2026-10-29': '11:00-8:00' }), '{}', 'Asha');
  check('putting it back to their usual hours is news too',
    off.length === 1 && off[0].to === '', off);
  check('a day nothing happened to is not reported',
    ctx.newlyOwnShifts(JSON.stringify({ 'Asha|2026-10-29': '9:30-6:30' }),
                       JSON.stringify({ 'Asha|2026-10-29': '9:30-6:30' }), 'Asha').length === 0);
  check('a key with no day on it is ignored rather than guessed at',
    ctx.newlyOwnShifts('{}', JSON.stringify({ 'Asha': '9:30-6:30' }), 'Asha').length === 0);
}

/* ---- the write itself ---- */
{
  check('the key is one an employee may write at all',
    /EMPLOYEE_WRITABLE = \['leaveRequests', 'dailyTasks', 'manualRecords', 'lateExcuses',\s*'overrides', 'dayShifts'\]/.test(SRV));
  check('and is merged rather than taken at its word',
    /key === 'dayShifts' && req\.session\.role === 'employee'/.test(SRV)
    && SRV.indexOf('mergeEmployeeDayShifts(') > -1);
  check('a night shift’s day turns over at its own start here too',
    /\['manualRecords', 'overrides', 'lateExcuses', 'dayShifts'\]\.indexOf\(key\) > -1/.test(SRV));
  check('the office is told after the save, not before it',
    /if \(shared && key === 'dayShifts' && shiftsBefore !== null\)[\s\S]{0,200}notifyShiftChange/.test(SRV));
}

/* ---- the message ---- */
{
  const mailer = require(path.join(REPO, 'mailer.js'));
  const mail = mailer.shiftEmail({
    orgName: 'Homeweavers', siteUrl: 'https://x/',
    items: [{ name: 'Asha', day: '2026-10-29', from: '9:30-6:30', to: '11:00-8:00' }]
  });
  const text = mail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check('it says whose day, which day, and which hours',
    /Asha/.test(text) && /29 Oct/.test(text) && /11:00-8:00/.test(text));
  /* The thing the office would otherwise have to go and look up. */
  check('and what the hours were before',
    /was 9:30-6:30/.test(text), text.slice(0, 0));
  check('a day put back to the usual hours says that in words',
    /back to their usual hours/.test(
      mailer.shiftEmail({ orgName: 'x', items: [{ name: 'Asha', day: '2026-10-29', from: '11:00-8:00', to: '' }] }).html));
  check('there is nothing on it to approve or reject',
    !/Approve|Reject/i.test(mail.html));
  check('nothing to tell means no message',
    mailer.shiftEmail({ orgName: 'x', items: [] }) === null);
  check('the office’s own words are used where it has written any',
    /Hours moved today/.test(mailer.shiftEmail({ orgName: 'x', intro: 'Hours moved today',
      items: [{ name: 'A', day: '2026-10-29', to: '8:00-5:00' }] }).html));
  check('and the wording it comes with is a real default, not a blank',
    /Shift changed/.test(mailer.DEFAULT_TEXT.shiftChange.subject)
    && mailer.DEFAULT_TEXT.shiftChange.intro.length > 40);

  /* Same addresses as the excused mark - it is the same kind of news, made by
     the same person about their own day. */
  const notify = SRV.slice(SRV.indexOf('async function notifyShiftChange'),
                           SRV.indexOf('async function notifyShiftChange') + 2000);
  check('it goes to the people the late setting names',
    notify.indexOf('settings.excused.final') > -1
    && notify.indexOf('(settings.excused.to || []).slice()') > -1);
  check('with nobody named, nothing is sent',
    notify.indexOf('if (!to.length) return;') > -1);
  check('and it is worded from the shift half of that setting',
    notify.indexOf('settings.excused.shift') > -1);
  check('where the day carried no hours of its own, the standing shift is what changed',
    notify.indexOf("shiftFor(assigned, m.empName)") > -1);
  check('a message that fails leaves the hours standing',
    notify.indexOf('the shift stands but its message failed') > -1);
}

/* ---- the card ---- */
{
  const row = APP.slice(APP.indexOf('function shiftRow('), APP.indexOf('function visitRow('));
  check('it is offered on the day they are in, and no other',
    row.indexOf('if(day !== todayISO_full) return ') > -1);
  check('their usual hours are the first thing offered',
    row.indexOf("'<option value=\"\">My usual'") > -1);
  check('and the shifts the office already uses are the rest',
    row.indexOf('allShifts()') > -1);
  check('a day already set says what it now counts as',
    row.indexOf('Today counts as ') > -1 && row.indexOf('your usual hours are unchanged') > -1);
  check('and can be put back to the usual ones',
    row.indexOf('id="edShiftClear"') > -1);
  check('the card says nobody has to agree to it',
    row.indexOf('nobody has ') > -1 && row.indexOf('the office is told') > -1);
  const wire = APP.slice(APP.indexOf("var shPick = document.getElementById('edShiftPick');"),
                         APP.indexOf("var vSave = document.getElementById('edVisitSave');"));
  check('saving writes the day and nothing else',
    wire.indexOf("dayShifts[name + '|' + day] = v;") > -1
    && wire.indexOf("delete dayShifts[name + '|' + day];") > -1);
  check('and picking the same hours again is not a save',
    wire.indexOf('if(v === had)') > -1);
  check('a save that does not reach the server says so',
    wire.indexOf('That did not save (') > -1);
  check('the day’s own hours are watched by the page that keeps itself up to date',
    /var marks = \['overrides', 'manualRecords', 'halfDays', 'lateExcuses', 'earlyExcuses', 'dayShifts'\]/.test(APP));
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
