// Real functions lifted from the dashboard, driven with stand-ins.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'attendance.html'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'") { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '/' && /[=(,:!&|?{};\s]/.test(src[k - 1] || '') && src[k + 1] !== '/' && src[k + 1] !== '*') {
      // a regex literal: skip to its closing slash
      k++; let inClass = false;
      while (k < src.length && (src[k] !== '/' || inClass)) { if (src[k] === '\\') k++; else if (src[k] === '[') inClass = true; else if (src[k] === ']') inClass = false; k++; }
      continue;
    }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}
const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

(async () => {
  // ---------------- dates ----------------
  {
    const ctx = { console };
    vm.createContext(ctx);
    vm.runInContext(grab('pad2'), ctx);
    vm.runInContext("var MONTH_NUM = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};", ctx);
    vm.runInContext(grab('toISODate'), ctx);
    const t = (s, o) => ctx.toISODate(s, o);
    check('M/d/yyyy (helper file)', t('9/14/2026', 'mdy') === '2026-09-14');
    check('d/M/yyyy with dmy order', t('14/09/2026', 'dmy') === '2026-09-14');
    check('ISO passes', t('2026-09-14') === '2026-09-14');
    check('trailing time stripped', t('9/14/2026 00:00', 'mdy') === '2026-09-14', t('9/14/2026 00:00', 'mdy'));
    check('trailing 12h time stripped', t('9/14/2026 9:05 AM', 'mdy') === '2026-09-14', t('9/14/2026 9:05 AM', 'mdy'));
    check('month name 10-Sep-2026', t('10-Sep-2026') === '2026-09-10', t('10-Sep-2026'));
    check('month name 10 September 2026', t('10 September 2026') === '2026-09-10', t('10 September 2026'));
    check('2-digit year', t('9/14/26', 'mdy') === '2026-09-14');
    check('impossible date refused (31 Sep)', t('9/31/2026', 'mdy') === '', t('9/31/2026', 'mdy'));
    check('garbage refused', t('Total', 'mdy') === '' && t('', 'mdy') === '', [t('Total'), t('')]);
  }

  // ---------------- approve / revert ----------------
  {
    const notices = [];
    const ctx = {
      console, overrides: {}, halfDays: {},
      saveOverrides: () => Promise.resolve(), saveHalfDays: () => Promise.resolve(),
      showUploadStatus: m => notices.push(m), dispName: n => n
    };
    vm.createContext(ctx);
    ['pad2', 'eachDateBetween', 'isPartDay', 'applyApprovedRequestToAttendance', 'revertApprovedRequest'].forEach(n => vm.runInContext(grab(n), ctx));
    vm.runInContext("overrides['Asha|2026-09-12'] = {cat:'VISIT', detail:'Panipat', duration:'7:30'};", ctx);
    const reqA = { id: 'req_a', empName: 'Asha', dateFrom: '2026-09-10', dateTo: '2026-09-12', leaveType: 'CL', message: 'trip' };
    await ctx.applyApprovedRequestToAttendance(reqA);
    check('approval writes leave on free days, stamped', ctx.overrides['Asha|2026-09-10'].cat === 'LEAVE' && ctx.overrides['Asha|2026-09-10'].reqId === 'req_a');
    check('hand-set visit kept', ctx.overrides['Asha|2026-09-12'].cat === 'VISIT' && ctx.overrides['Asha|2026-09-12'].duration === '7:30');
    check('person told a day was left alone', notices.length === 1 && /1 day/.test(notices[0]), notices);
    const reqB = { id: 'req_b', empName: 'Asha', dateFrom: '2026-09-11', dateTo: '2026-09-11', leaveType: 'Sick', message: '' };
    await ctx.applyApprovedRequestToAttendance(reqB);   // 11th is already A's: left as it is
    check("a day another request wrote is not taken over", ctx.overrides['Asha|2026-09-11'].reqId === 'req_a');
    await ctx.revertApprovedRequest(reqA);
    check("undoing A removes A's own day", !ctx.overrides['Asha|2026-09-10']);
    check("undoing A removes the day B was refused", !ctx.overrides['Asha|2026-09-11']);
    check('undoing A keeps the visit', ctx.overrides['Asha|2026-09-12'] && ctx.overrides['Asha|2026-09-12'].cat === 'VISIT');
    vm.runInContext("overrides['Ravi|2026-09-01'] = {cat:'LEAVE', detail:'CL'};", ctx);   // marked by hand, no id
    const keptOld = await ctx.revertApprovedRequest({ id: 'req_old', empName: 'Ravi', dateFrom: '2026-09-01', dateTo: '2026-09-01', leaveType: 'CL' });
    check('a mark made by hand is kept, not deleted by kind', !!ctx.overrides['Ravi|2026-09-01'] && keptOld === 1, keptOld);
    const half = { id: 'req_h', empName: 'Neha', dateFrom: '2026-09-15', dateTo: '2026-09-15', leaveType: 'HALF', half: 'PM', message: '' };
    vm.runInContext("halfDays['Neha|2026-09-15'] = {kind:'SHORT', note:'by hand'};", ctx);
    await ctx.applyApprovedRequestToAttendance(half);
    check('hand-set short leave not overwritten by a half-day approval', ctx.halfDays['Neha|2026-09-15'].kind === 'SHORT');
  }

  // ---------------- restore ----------------
  async function restoreCtx(opts) {
    const ls = {}, sets = [], statuses = [], reloads = [], replaced = [];
    const ctx = {
      console, JSON, Promise,
      localStorage: { setItem: (k, v) => { ls[k] = v; }, getItem: k => ls[k] || null, removeItem: k => { delete ls[k]; } },
      storage: { set: (k, v) => { sets.push(k); return opts.failKey === k ? Promise.reject(new Error('payload_too_large')) : Promise.resolve(); } },
      idbData: () => Promise.resolve(),
      bkStatus: (m, err) => statuses.push((err ? 'ERR ' : '') + m),
      showUploadStatus: (m, err) => statuses.push((err ? 'ERR ' : '') + m),
      setTimeout: fn => { reloads.push(fn); return 0; },
      location: { reload: () => {} },
      window: { HWSync: { replaceDataset: d => { replaced.push(d); return Promise.resolve(); } } }
    };
    vm.createContext(ctx);
    vm.runInContext("var BACKUP_SKIP_KEYS = ['preImportRestore', 'importLog', 'hasBackupDir', 'json', 'fname', 'n'];", ctx);
    vm.runInContext(grab('unwrapLegacySnapshot'), ctx);
    vm.runInContext(grab('restoreFullBackup'), ctx);
    return { ctx, ls, sets, statuses, reloads, replaced };
  }
  {
    const r = await restoreCtx({});
    const snap = {
      _preImport: { file: 'x.csv' },
      attDashboard_customDataset: JSON.stringify({ employees: [{ name: 'Asha' }], records: [{ e: 'Asha', d: '2026-09-01', st: 'PR' }] }),
      attDashboard_overrides: '{"Asha|2026-09-02":{"cat":"LEAVE"}}',
      attDashboard_preImportRestore: '{"huge":"nested snapshot"}',
      attDashboard_importLog: '[]',
      attDashboard_hw_leave_hidden: '["2026-01"]'
    };
    const done = await r.ctx.restoreFullBackup(snap);
    check('restore resolves true and schedules reload', done === true && r.reloads.length === 1, { done, reloads: r.reloads.length, statuses: r.statuses });
    check('attendance sent to the server as a replacement', r.replaced.length === 1 && r.replaced[0].records.length === 1);
    check('attendance not written as one shared key', r.sets.indexOf('customDataset') === -1, r.sets);
    check('settings written to shared store', r.sets.indexOf('overrides') > -1);
    check('restore points and import log not restored', r.sets.indexOf('preImportRestore') === -1 && r.sets.indexOf('importLog') === -1 && !r.ls['attDashboard_preImportRestore']);
    check('browser setting back under its own name', r.ls['hw_leave_hidden'] === '["2026-01"]' && !r.ls['attDashboard_hw_leave_hidden'], Object.keys(r.ls));
  }
  {
    const r = await restoreCtx({});
    await r.ctx.restoreFullBackup({
      attDashboard_lockedMonths: '{"2026-08":{"by":"boss"}}',
      attDashboard_overrides: '{"Asha|2026-08-02":{"cat":"LEAVE"}}',
      attDashboard_customDataset: JSON.stringify({ employees: [{ name: 'Asha' }], records: [{ e: 'Asha', d: '2026-08-01', st: 'PR' }] })
    });
    check('month locks are put back last, after the marks and the attendance', r.sets[r.sets.length - 1] === 'lockedMonths' && r.sets.indexOf('overrides') > -1 && r.replaced.length === 1, r.sets);
  }
  {
    const r = await restoreCtx({ failKey: 'overrides' });
    const done = await r.ctx.restoreFullBackup({ attDashboard_overrides: '{}' });
    check('a refused write -> resolves false, no reload, says so', done === false && r.reloads.length === 0 && r.statuses.some(s => /^ERR .*not fully restored/.test(s)), r.statuses);
  }
  /* ---- the Share menu ----
     The full-month entry asks a question back - which month - so it sits last,
     under the three that go straight out, with its shelf of months beneath it. */
  {
    const menu = grab('renderEmailDropdown');
    const at = id => menu.indexOf("id=\"" + id + "\"");
    const order = ['emShot', 'emSendDay', 'emSendLeave', 'emSendHol', 'emSendMonth', 'emMonthPick'];
    /* The settings tabs read in the same order as the things they settle, with
       the month last - it is the one sent by hand. */
    const tabs = ['att', 'lv', 'hol', 'mo'].map(k => menu.indexOf('data-em-tab="' + k + '"'));
    check('the settings tabs read Attendance, Leave, Holiday, Month',
      tabs.every(p => p > -1) && tabs.every((p, i) => i === 0 || p > tabs[i - 1]), tabs);
    const panes = ['att', 'lv', 'hol', 'mo'].map(k => menu.indexOf('data-em-pane="' + k + '"'));
    check('and the panes are written in that order too',
      panes.every(p => p > -1) && panes.every((p, i) => i === 0 || p > panes[i - 1]), panes);
    const pos = order.map(at);
    check('the Share menu reads screenshot, today, leave, holiday, then the month',
      pos.every(p => p > -1) && pos.every((p, i) => i === 0 || p > pos[i - 1]),
      order.map((id, i) => id + '@' + pos[i]));
    check('and the month shelf sits with the month button, folded away',
      /id="emMonthPick"[^>]*style="display:none"/.test(menu));
  }
  {
    /* Choosing a month sends that month, whatever the grid is showing. The
       workbook is read out of the data, not off the screen, so the month only
       has to be the selected one while it is built - and the selection is put
       back whatever happens, including when the build throws. */
    const send = grab('sendMonth');
    check('the month chosen is the one built, not the one in view',
      /var swap = !\(was\.length === 1 && was\[0\] === ym\)/.test(send)
        && /if\(swap\) state\.selectedMonths = \[ym\]/.test(send), send.slice(0, 400));
    check('and the selection is put back even when the build throws',
      /\}finally\{\s*\n\s*if\(swap\) state\.selectedMonths = was;/.test(send), send.slice(0, 1400));
    check('nothing is redrawn for it',
      send.indexOf('renderTable()') === -1 && send.indexOf('renderShotCanvas') === -1);
    check('the file and the figures are named for the month chosen, not the view',
      /'Attendance_Grid_' \+ ym \+ '\.xlsx'/.test(send) && /monthLabel: monthLabel\(ym\)/.test(send)
        && /slug: ym/.test(send), send.indexOf('Attendance_Grid_'));
    check('and the workbook is the only thing it sends',
      /xlsx:b64, preview:true/.test(send) && send.indexOf('png:') === -1
        && send.indexOf('inline:') === -1, send.indexOf('png:'));
  }

  /* ---- the days nobody is due in on ----
     The punch file carries only the days somebody attended, so a weekly off
     arrives as no row at all. Said out loud rather than left blank - but only
     where nothing was recorded: a Sunday somebody actually worked keeps what it
     was given. */
  {
    const ctx = { console, Date, getSatPolicy: e => ({ mode: e === 'Habib' ? 'OFF' : 'FULL', hours: 4 }) };
    vm.createContext(ctx);
    vm.runInContext(grab('weeklyOffDay'), ctx);
    const off = ctx.weeklyOffDay;

    const SUN = '2026-09-13', SAT = '2026-09-12', MON = '2026-09-14';
    check('a Sunday with nothing recorded is a weekly off',
      off('Asha', SUN, null).st === 'WO', off('Asha', SUN, null));
    check('every Sunday, not just the one the reader sent a row for',
      ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27']
        .every(d => off('Asha', d, null).st === 'WO'));
    const worked = { e: 'Asha', d: SUN, 'in': '10:05', out: '14:00', dur: '3:55', st: 'PR', c: 2 };
    check('but a Sunday somebody worked keeps its punches',
      off('Asha', SUN, worked) === worked, off('Asha', SUN, worked));
    check('and a Sunday marked absent with no punch is still a weekly off',
      off('Asha', SUN, { st: 'AB', 'in': '' }).st === 'WO');
    check('a Saturday is a weekly off only for whoever has it set that way',
      off('Habib', SAT, null).st === 'WO' && off('Asha', SAT, null) === null,
      { habib: off('Habib', SAT, null), asha: off('Asha', SAT, null) });
    check('and an ordinary weekday with no row stays as it was',
      off('Asha', MON, null) === null);
  }

  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
