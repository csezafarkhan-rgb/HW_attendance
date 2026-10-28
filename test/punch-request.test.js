// Forgot-to-punch requests: the dashboard's real request functions, driven with stand-ins.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { lift } = require(path.join(__dirname, '..', 'scripts', 'attendance-sync', 'dashboard-parser.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
function check(name, ok, detail) { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

(async () => {
  const notices = [];
  const ctx = {
    console, manualRecords: {}, overrides: {}, halfDays: {}, leaveRequests: [],
    recIndex: { 'Asha|2026-09-10': { e: 'Asha', d: '2026-09-10', in: '9:35', out: '', st: 'PR' } },
    saveManualRecords: () => Promise.resolve(), saveOverrides: () => Promise.resolve(), saveHalfDays: () => Promise.resolve(),
    showUploadStatus: m => notices.push(m), dispName: n => n
  };
  vm.createContext(ctx);
  vm.runInContext("var REQ_TYPE_LABEL = {CL:'Casual leave', PUNCH:'Punch correction'};", ctx);
  ['pad2', 'eachDateBetween', 'isPartDay', 'reqTypeName', 'reqTypeText', 'applyPunchCorrection',
   'applyApprovedRequestToAttendance', 'revertApprovedRequest', 'requestUnmarkedDays', 'unrequestedLeave']
    .forEach(n => vm.runInContext(lift(src, n), ctx));

  const req = { id: 'req_p1', empName: 'Asha', dateFrom: '2026-09-10', dateTo: '2026-09-10', leaveType: 'PUNCH', punchIn: '', punchOut: '18:40', status: 'approved' };
  check('label shows the corrected time', ctx.reqTypeText(req) === 'Punch correction (out 18:40)', ctx.reqTypeText(req));
  await ctx.applyApprovedRequestToAttendance(req);
  const m = ctx.manualRecords['Asha|2026-09-10'];
  check('approval writes a manual entry: reader in + corrected out, present', m && m.in === '9:35' && m.out === '18:40' && m.st === 'PR' && m.reqId === 'req_p1', m);
  check('no leave mark written for a punch correction', Object.keys(ctx.overrides).length === 0 && Object.keys(ctx.halfDays).length === 0);
  check('not listed as "no longer marked"', ctx.requestUnmarkedDays(req).length === 0);
  vm.runInContext("overrides['Asha|2026-09-10'] = {cat:'LEAVE', detail:'CL'};", ctx);
  ctx.leaveRequests.push(req);
  check('a punch correction does not count as a request for leave taken that day', ctx.unrequestedLeave().length === 1, ctx.unrequestedLeave());
  await ctx.revertApprovedRequest(req);
  check('undoing it removes its manual entry', !ctx.manualRecords['Asha|2026-09-10']);
  check('then it reads as no longer marked', ctx.requestUnmarkedDays(req).length === 1);

  vm.runInContext("manualRecords['Ravi|2026-09-11'] = {in:'10:00', out:'19:00', st:'PR'};", ctx);   // typed in by hand
  const req2 = { id: 'req_p2', empName: 'Ravi', dateFrom: '2026-09-11', dateTo: '2026-09-11', leaveType: 'PUNCH', punchIn: '9:30', punchOut: '', status: 'approved' };
  await ctx.applyApprovedRequestToAttendance(req2);
  check('a manual entry typed by hand is not overwritten', ctx.manualRecords['Ravi|2026-09-11'].in === '10:00' && notices.some(n => /already has a manual entry/.test(n)), ctx.manualRecords['Ravi|2026-09-11']);
  const kept = await ctx.revertApprovedRequest(req2);
  check("and undoing the request leaves the hand entry", !!ctx.manualRecords['Ravi|2026-09-11'] && kept === 1, kept);

  /* ---- the order the form asks in ----
     What is being asked for decides what the rest of the form is: a part-day
     closes the To box and copies the From date into it, a forgotten punch
     takes the day-back question away and puts two times in its place. Asked
     last, it rewrote boxes that had already been filled in. */
  {
    const form = src.slice(src.indexOf('id="requestModalOverlay"'), src.indexOf('id="modalOverlay"'));
    const at = s => form.indexOf(s);
    check('the form asks what before it asks when',
      at('id="reqLeaveType"') < at('id="reqDateFrom"')
      && at('id="reqDateFrom"') < at('id="reqDateTo"'),
      { type: at('id="reqLeaveType"'), from: at('id="reqDateFrom"'), to: at('id="reqDateTo"') });
    check('and the questions only some kinds ask come after the dates',
      at('id="reqDateTo"') < at('id="reqPunchWrap"') && at('id="reqPunchWrap"') < at('id="reqHalfWrap"'));
    check('the day back and the message still come last',
      at('id="reqHalfWrap"') < at('id="reqReturnWrap"') && at('id="reqReturnWrap"') < at('id="reqMessage"'));
    check('every box is still there once, moved rather than copied',
      ['reqLeaveType', 'reqDateFrom', 'reqDateTo', 'reqReturn', 'reqMessage']
        .every(id => (form.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1));
  }

  console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
