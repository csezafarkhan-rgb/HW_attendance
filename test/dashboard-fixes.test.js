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

  /* ---- the two stages of a leave grant, under the Leave tab ----
     Two messages to two sets of people; the pane splits so neither set of
     boxes can be taken for the other. */
  {
    const menu = grab('renderEmailDropdown');
    /* The tab names the stage, not the person: whoever holds the first word can
       change in Users, and a tab labelled with yesterday's name is worse than
       one labelled with what it is for. */
    check('the tabs are named for the stages, not for whoever holds them',
      menu.indexOf('1. First approval') > -1 && menu.indexOf('2. Final approval') > -1
        && menu.indexOf("'1. ' + mailEscape(fa.name)") === -1, menu.indexOf('1. First approval'));
    check('the Leave tab offers a stage each, in order',
      menu.indexOf('data-lv-tab="first"') > -1
        && menu.indexOf('data-lv-tab="first"') < menu.indexOf('data-lv-tab="final"'),
      [menu.indexOf('data-lv-tab="first"'), menu.indexOf('data-lv-tab="final"')]);
    check('each stage keeps its own addresses',
      ['emLvFirstTo', 'emLvFirstCc', 'emLvFirstIntro'].every(id => menu.indexOf(id) > -1)
        && ['emLvTo', 'emLvCc', 'emLvIntro'].every(id => menu.indexOf(id) > -1), menu.length);
    check('the final stage is the one folded away to begin with',
      /data-lv-pane="final"' \+ \(MAIL_CFG\.firstApprover \? ' style="display:none;"'/.test(menu));
    /* Both tabs are always there. The first is where somebody is named as the
       one who looks at every request; hide it when nobody is and there is
       nowhere left to name them. */
    check('both stages are offered whether or not anybody is named',
      menu.indexOf("if(!fa) return ''") === -1
        && /Leave is granted in one stage/.test(menu)
        && /Put an address under/.test(menu), menu.indexOf('one stage'));

    /* Switching between the stages must not disturb the panel's own tabs. */
    const wiring = menu.slice(menu.indexOf('data-lv-tab]'));
    check('switching stages reaches only the stage panes',
      wiring.indexOf('data-lv-pane]') > -1 && wiring.slice(0, 400).indexOf('data-em-pane]') === -1,
      wiring.slice(0, 300));

    /* Saving from a pane that has no first-stage boxes must not wipe what is
       stored for the next time somebody is marked. */
    const save = grab('renderEmailDropdown');
    check('saving with nobody marked keeps the first stage\'s settings',
      /firstTo: document\.getElementById\('emLvFirstTo'\)\s*\n?\s*\? list\('emLvFirstTo'\) : \(\(\(MAIL_CFG/.test(save)
        || save.indexOf("(((MAIL_CFG.settings || {}).leave || {}).firstTo || [])") > -1,
      save.indexOf('firstTo:'));
  }

  /* ---- the break allowance ----
     Lunch and two breaks, set on the Options panel. It decides one thing only:
     when the time-out figure is marked red. The hours owed, when somebody is due
     to leave and the score are all measured from the shift, which already has
     these breaks inside it. */
  {
    const panel = src.slice(src.indexOf('id="viewOptsDropdown"'),
                            src.indexOf('id="viewOptsDropdown"') + 2500);
    const boxes = ['lunchBreakInput', 'break1Input', 'break2Input'];
    check('the panel offers lunch and two breaks',
      boxes.every(id => panel.indexOf('id="' + id + '"') > -1), boxes.filter(id => panel.indexOf(id) === -1));

    /* Each box has to be wired, and to remember what it was set to. */
    const wired = boxes.every(id => src.indexOf("'" + id + "'") > -1);
    const keys = ['lunchBreakMin', 'break1Min', 'break2Min'];
    check('each box is wired and remembered under its own key',
      wired && keys.every(k => src.indexOf("'" + k + "'") > -1),
      keys.filter(k => src.indexOf("'" + k + "'") === -1));
    check('and every one of them travels in a backup',
      keys.every(k => new RegExp("BACKUP_KEYS[\\s\\S]{0,900}'" + k + "'").test(src)), keys);

    /* The total is worked out from the three, never written down. */
    check('the allowance is the three added up, not a figure of its own',
      /var BREAK_ALLOW_MIN = LUNCH_BREAK_MIN \+ BREAK1_MIN \+ BREAK2_MIN;/.test(src)
        && /function recalcBreakAllow\(\)/.test(src),
      (/var BREAK_ALLOW_MIN = [^;]*;/.exec(src) || [])[0]);
    check('and changing a box works it out again',
      /recalcBreakAllow\(\);\s*\n\s*storage\.set\(b\[1\]/.test(src), 'the change handler');
    check('the single tea break it replaced is gone',
      src.indexOf('TEA_BREAK_MIN') === -1);

    /* Nothing may recite the old fixed hour: it is the office's to change. */
    const saysHour = src.split('\n')
      .map((l, i) => ({ n: i + 1, l }))
      .filter(x => /1:00/.test(x.l) && !/->\s*2\s+out twice/.test(x.l));
    check('nothing still says "1:00" where the figure is now the office\'s',
      saysHour.length === 0, saysHour.map(x => x.n + ': ' + x.l.trim().slice(0, 70)));

    /* The two tables of metric definitions are built once, at load, long before
       the stored settings arrive - so a figure baked into a label there would be
       wrong for the rest of the session. They name the allowance instead. */
    const once = [/t:'Days within the break allowance'/, /t:'Breaks Over Allowance'/];
    check('the tables built once name the allowance rather than numbering it',
      once.every(re => re.test(src)), once.map(String));
    /* Everywhere that is written out on each render may state it. */
    check('while what is drawn each time states the figure set',
      /'Breaks within '\+fmtMin\(BREAK_ALLOW_MIN\)/.test(src)
        && /breakAllowWords\(\)/.test(src), 'the rendered labels');

    /* A break set to nothing is left out of the wording rather than written
       as "0 min", which is what the second break reads until it is set. */
    const words = grab('breakAllowWords');
    check('a break set to nothing is not recited',
      /if\(BREAK1_MIN > 0\)/.test(words) && /if\(BREAK2_MIN > 0\)/.test(words), words);

    /* The boxes are filled from the variables when the panel is wired, and a
       `var` read before its line has run is undefined - which emptied all three
       on the live page while every test here still passed. The figures have to
       be declared before the panel that reads them. */
    const declAt = src.indexOf('var LUNCH_BREAK_MIN');
    const wireAt = src.indexOf("var lt = document.getElementById('lateThreshInput')");
    check('the figures are declared before the panel that fills itself from them',
      declAt > -1 && wireAt > -1 && declAt < wireAt, { declAt, wireAt });
    /* And what the markup starts at has to be what the variables start at, or
       the panel lies until something is saved. */
    const decl = /var LUNCH_BREAK_MIN = (\d+), BREAK1_MIN = (\d+), BREAK2_MIN = (\d+);/.exec(src);
    const markup = ['lunchBreakInput', 'break1Input', 'break2Input'].map(id => {
      const m = new RegExp('id="' + id + '"[^>]*value="(\\d+)"').exec(panel);
      return m ? m[1] : null;
    });
    check('and the boxes start at the same figures the variables do',
      !!decl && markup.join(',') === [decl[1], decl[2], decl[3]].join(','),
      { markup, decl: decl && decl.slice(1, 4) });

    /* And it must not have reached the things it has no business in. */
    ['owedMinutes', 'getLateEarly', 'perfScore'].forEach(fn => {
      check(fn + ' is untouched by the allowance',
        grab(fn).indexOf('BREAK_ALLOW_MIN') === -1, fn);
    });
  }

  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
