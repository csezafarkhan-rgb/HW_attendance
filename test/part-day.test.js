// A short leave or a half day, taken rather than asked for.
//
// Leave for part of a day used to go the way all leave goes: a request, a
// wait, a decision. For a quarter of a day that is a decision costing more
// than the thing being decided, and the morning it is about is usually over
// before the answer comes - so people stopped asking, and the day turned up on
// the record afterwards as leave nobody had requested. Taken anyway, and
// unaccounted for.
//
// It counts at once now, and this is what that is allowed to mean. The file is
// mostly refusals, because the thing being written is leave, and leave is
// money.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');
const mailer = require(path.join(REPO, 'mailer.js'));

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
    if (c === '"' || c === "'" || c === '`') { const q = c; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

/* ---- the thing itself, actually running ----
   A stand-in for the one connection it takes out, which remembers what it was
   told: the rows it handed back, what was written to which key, and whether
   the transaction was seen through or abandoned. */
{
  const NLRE = /\r?\n/;
  let wrote = {}, sql = [];
  const client = {
    query: async (q, args) => {
      const text = String(q).trim();
      sql.push(text.split(NLRE)[0]);
      if (/^INSERT INTO kv/.test(text)) { wrote[args[1]] = args[2]; return { rows: [] }; }
      if (/^INSERT INTO/.test(text)) return { rows: [] };
      const m = /key = '(\w+)'/.exec(text);
      if (m) return { rows: [{ value: ctx.__kv[m[1]] }] };
      if (/key = \$2/.test(text)) return { rows: [{ value: ctx.__kv[args[1]] }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const ctx = {
    pool: { connect: async () => client },
    lockedMonthsOf: async () => ctx.__locked,
    logChange: async () => {}, addHistory: async () => {},
    crypto: require('crypto'),
    IST_MS: 5.5 * 3600 * 1000,
    Date, JSON, Object, Math, String, Array, Number, Boolean, console,
  };
  vm.createContext(ctx);
  ['parseJson', 'clip', 'canon', 'isPlainObject', 'diffValue',
   'parseShiftSpan', 'nightTurnsAt', 'shiftFor', 'ownDays'].forEach(n => vm.runInContext(grab(SRV, n), ctx));
  vm.runInContext(/const SELF_PART_KINDS = \[[^\]]*\];/.exec(SRV)[0], ctx);
  vm.runInContext('async ' + grab(SRV, 'takePartDay'), ctx);

  /* Today, as the thing under test will work it out: nobody here is on a
     night shift, so the shift's day and the calendar's are the same. */
  const TODAY = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const K = n => n + '|' + TODAY;

  const run = async (body, store) => {
    wrote = {}; sql = [];
    const st = store || {};
    ctx.__kv = {
      shiftAssignments: JSON.stringify(st.shifts || {}),
      overrides: JSON.stringify(st.overrides || {}),
      halfDays: JSON.stringify(st.halfDays || {}),
      leaveRequests: JSON.stringify(st.leaveRequests || []),
    };
    ctx.__locked = st.locked || {};
    const r = await ctx.takePartDay(1, 'Keshav Garg', 7, body);
    return {
      code: r.code, out: r.out, told: r.told, sql,
      parts: wrote.halfDays ? JSON.parse(wrote.halfDays) : null,
      reqs: wrote.leaveRequests ? JSON.parse(wrote.leaveRequests) : null,
    };
  };

  (async () => {
    /* ---- what it writes ---- */
    let r = await run({ kind: 'HALF', half: 'PM', message: 'dentist' });
    const hd = r.parts && r.parts[K('Keshav Garg')];
    check('a half day taken is a half day marked',
      r.code === 200 && hd && hd.kind === 'HALF' && hd.half === 'PM', r.out);
    check('deducted as casual leave, like every other part day',
      !!hd && hd.leave === 'CL', hd);
    check('and signed, so it can be told from a mark the office made',
      !!hd && hd.by === 'self', hd);
    /* The grid and the exports read note; why is their own words on their own,
       so the card can show them back without the prefix in front. */
    check('the note the grid reads says which half it was, and why',
      !!hd && hd.note === 'Second half · dentist' && hd.why === 'dentist', hd);

    const req = r.reqs && r.reqs[0];
    check('and a request is written beside it, already granted',
      !!req && req.status === 'approved' && req.leaveType === 'HALF', r.reqs);
    check('nobody granted it, and the record does not pretend otherwise',
      !!req && req.selfTaken === true && req.approvedBy === '', req);
    /* Without the request, the panel that hunts for leave nobody asked for
       would call every one of these a day taken behind the office's back. */
    check('one day, so the panel for unrequested leave has nothing to report',
      !!req && req.dateFrom === TODAY && req.dateTo === TODAY, req);
    check('the mark and the request point at each other',
      !!hd && !!req && hd.reqId === req.id, [hd, req]);

    r = await run({ kind: 'SHORT', message: 'bank' });
    check('a short leave is a quarter of a day, marked SHORT',
      r.parts[K('Keshav Garg')].kind === 'SHORT', r.parts);
    check('a half is meaningless on a short leave and is not kept',
      r.parts[K('Keshav Garg')].half === '', r.parts);
    r = await run({ kind: 'SHORT', half: 'PM' });
    check('even when the page sends one',
      r.parts[K('Keshav Garg')].half === '', r.parts);
    r = await run({ kind: 'HALF' });
    check('a half day with no half named is the first half',
      r.parts[K('Keshav Garg')].half === 'AM', r.parts);

    /* ---- the refusals ---- */
    r = await run({ kind: 'THREEQ' });
    check('three quarters of a day is more than this grants and is refused',
      r.code === 400 && r.out.error === 'bad_kind', r.out);
    r = await run({ kind: 'CL' });
    check('and a whole day of leave is still somebody else’s to agree to',
      r.code === 400, r.out);

    r = await run({ kind: 'HALF' }, { locked: { [TODAY.slice(0, 7)]: true } });
    check('a month whose pay has been run is not touched',
      r.code === 409 && r.out.error === 'month_locked' && r.parts === null, r.out);
    check('and the transaction is abandoned rather than left open',
      r.sql.indexOf('ROLLBACK') > -1 && r.sql.indexOf('COMMIT') === -1, r.sql);

    r = await run({ kind: 'HALF' },
      { overrides: { [K('Keshav Garg')]: { cat: 'LEAVE', detail: 'CL' } } });
    check('a day already away whole has no half left to take',
      r.code === 409 && r.out.error === 'day_is_leave', r.out);
    /* A day from home or out on a visit is still a working day, and half of a
       working day is a thing somebody can take. */
    r = await run({ kind: 'HALF' },
      { overrides: { [K('Keshav Garg')]: { cat: 'WFH' } } });
    check('a day from home is a working day, and half of one can be taken',
      r.code === 200, r.out);

    r = await run({ kind: 'HALF' },
      { halfDays: { [K('Keshav Garg')]: { kind: 'SHORT', leave: 'CL' } } });
    check('a mark the office made is not theirs to move',
      r.code === 409 && r.out.error === 'marked_by_office', r.out);
    r = await run({ kind: 'HALF' },
      { halfDays: { [K('Keshav Garg')]: { kind: 'HALF', reqId: 'req_x', leave: 'CL' } } });
    check('nor one that came out of a request somebody granted',
      r.code === 409 && r.out.error === 'marked_by_office', r.out);

    r = await run({ kind: 'HALF' }, { leaveRequests: [
      { id: 'req_a', empName: 'Keshav Garg', dateFrom: TODAY, dateTo: TODAY,
        leaveType: 'HALF', status: 'pending' }] });
    check('a request already waiting on somebody’s word is not overtaken',
      r.code === 409 && r.out.error === 'already_requested' && r.out.status === 'pending', r.out);
    r = await run({ kind: 'HALF' }, { leaveRequests: [
      { id: 'req_a', empName: 'Keshav Garg', dateFrom: '2026-01-01', dateTo: '2036-01-01',
        leaveType: 'CL', status: 'approved' }] });
    check('nor one already granted that covers the day',
      r.code === 409 && r.out.error === 'already_requested', r.out);
    /* Refused or taken back accounts for nothing, and nor does somebody
       else's request for the same date. */
    r = await run({ kind: 'HALF' }, { leaveRequests: [
      { id: 'req_a', empName: 'Keshav Garg', dateFrom: TODAY, dateTo: TODAY,
        leaveType: 'HALF', status: 'rejected' },
      { id: 'req_b', empName: 'Aman Gupta', dateFrom: TODAY, dateTo: TODAY,
        leaveType: 'HALF', status: 'pending' }] });
    check('a refused request, and somebody else’s, stand in nobody’s way',
      r.code === 200, r.out);

    r = await run({ kind: 'HALF', half: 'AM' },
      { halfDays: { [K('Keshav Garg')]: { kind: 'HALF', half: 'AM', by: 'self' } } });
    check('taking the same thing twice is a slip and is said so',
      r.code === 409 && r.out.error === 'already_taken', r.out);

    /* ---- changing their mind ---- */
    const beforeOne = {
      halfDays: { [K('Keshav Garg')]: { kind: 'SHORT', half: '', by: 'self', reqId: 'req_own' } },
      leaveRequests: [{ id: 'req_own', empName: 'Keshav Garg', dateFrom: TODAY, dateTo: TODAY,
                        leaveType: 'SHORT', status: 'approved', selfTaken: true }]
    };
    r = await run({ kind: 'HALF', half: 'PM' }, beforeOne);
    check('a quarter of a day can become a half',
      r.code === 200 && r.parts[K('Keshav Garg')].kind === 'HALF', r.out);
    check('and amends the one record of the day rather than making a second',
      r.reqs.length === 1 && r.reqs[0].id === 'req_own' && r.reqs[0].leaveType === 'HALF', r.reqs);
    check('the office is told what it was before, so one day reads as one day',
      r.told && r.told.was === 'SHORT', r.told);

    r = await run({}, beforeOne);
    check('a day taken can be put back',
      r.code === 200 && r.parts[K('Keshav Garg')] === undefined, r.parts);
    check('and the record of it is cancelled, not left standing as granted',
      r.reqs[0].status === 'cancelled' && !!r.reqs[0].cancelledAt, r.reqs);
    check('the office hears about that too, as the putting back it is',
      r.told && r.told.removed === true, r.told);
    r = await run({});
    check('there is nothing to put back on a whole working day',
      r.code === 409 && r.out.error === 'nothing_to_undo', r.out);
    r = await run({}, { halfDays: { [K('Keshav Garg')]: { kind: 'HALF' } } });
    check('and a mark the office made is not put back from here either',
      r.code === 409 && r.out.error === 'marked_by_office', r.out);

    /* ---- how it writes, not just what ---- */
    r = await run({ kind: 'HALF' });
    check('one transaction, begun and seen through',
      r.sql[0] === 'BEGIN' && r.sql.indexOf('COMMIT') > -1, r.sql);
    /* A shared value is one whole blob: without the lock two saves a moment
       apart each write the map they read, and the second drops the first. */
    const locks = r.sql.filter(q => /FOR UPDATE/.test(q)).length;
    check('both maps are read for update before either is written',
      locks === 2, r.sql.filter(q => /FOR UPDATE/.test(q)));
    check('the mark and the grant are written inside the same transaction',
      r.sql.indexOf('COMMIT') > r.sql.lastIndexOf('INSERT INTO kv (org_id, user_id, key, value, updated_by) VALUES ($1, NULL, $2, $3, $4)'),
      r.sql);

    const body = grab(SRV, 'takePartDay');
    /* At two in the morning a night shift belongs to yesterday, and nothing
       the browser sends gets to choose which day this writes. */
    check('the day is worked out from the shift, not taken from the browser',
      /ownDays\(shiftFor\(/.test(body) && !/body\.day/.test(body), null);
    check('and a locked month is checked before anything is read for writing',
      body.indexOf('lockedMonthsOf') < body.indexOf('FOR UPDATE'), null);

    /* ---- why this is a route of the server's at all ----
       If either of these two ever stops being true, the page could grant its
       own leave, and this endpoint would have been pointless from the start. */
    check('halfDays is still not a thing an employee may write',
      !/EMPLOYEE_WRITABLE = \[[^\]]*halfDays/.test(SRV), null);
    check('and a request somebody makes for themselves is still forced to pending',
      /status: 'pending', adminNote: ''/.test(grab(SRV, 'mergeEmployeeRequests')), null);
    /* Their own rows of it, which is how the card knows what they took. */
    check('but they are served their own part days to read',
      /EMP_KEYED_BY_DAY = \['overrides', 'halfDays'/.test(SRV), null);

    /* ---- who hears about it ----
       The management, because leave is theirs to know about; whoever holds the
       first word on leave, because a day taken without asking is exactly what
       they would have been asked about; and the person whose day it is. */
    {
      const c2 = { EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, Object, String, console,
                   approvalRouteOf: async () => c2.__route };
      vm.createContext(c2);
      vm.runInContext('async ' + grab(SRV, 'leaveApprovers'), c2);
      c2.__route = { 'Nitish Kumar': 'final', 'karan Ahuja': 'final',
                     'Keshav Garg': 'karan@homeweavers.net',
                     'Aman Gupta': 'karan@homeweavers.net',
                     'Shyam Lal ESS': 'munish@homeweavers.net' };
      let who = await c2.leaveApprovers(1, { leave: { firstTo: ['support@homeweavers.net'] } });
      check('the two people who hold the first word on leave are both told',
        who.indexOf('karan@homeweavers.net') > -1 && who.indexOf('munish@homeweavers.net') > -1, who);
      check('the office’s own first approver with them',
        who.indexOf('support@homeweavers.net') > -1, who);
      check('each of them once, however many people they look after',
        who.length === 3, who);
      /* Read out of the office's own routing rather than written down in the
         code: holding that word is the whole reason they are told, so moving
         it moves the message with it. */
      check('somebody routed straight to the management holds no first word',
        who.indexOf('final') === -1 && who.every(a => /@/.test(a)), who);
      c2.__route = { 'Keshav Garg': 'final' };
      who = await c2.leaveApprovers(1, { leave: { firstTo: [] } });
      check('and a company where nobody holds it has nobody extra to tell',
        who.length === 0, who);
      check('the addresses are not written down here',
        !/karan|munish/i.test(grab(SRV, 'notifyPartDayTaken') + grab(SRV, 'leaveApprovers')), null);
    }

    /* The management are who it is addressed to, and the employee is copied -
       there should never be a message about somebody's leave that they did not
       see. */
    const notify = grab(SRV, 'notifyPartDayTaken');
    check('it is addressed to whoever decides leave',
      /mailRecipients\(orgId, settings, 'leave'\)/.test(notify), null);
    check('the person whose day it is is copied in',
      /ownersOf\(orgId, items\.map/.test(notify), null);
    check('and it is sent after the write, never waited for',
      /if \(r\.told\) notifyPartDayTaken/.test(SRV), null);

    /* ---- the message ---- */
    const one = mailer.partDayEmail({
      orgName: 'Home Weavers', siteUrl: 'https://attendance.homeweavers.net/',
      items: [{ name: 'Keshav Garg', day: TODAY, kindName: 'Half day',
                qty: 'half a day', half: 'PM', note: 'dentist', leave: 'CL' }] });
    check('the message names the person, the day and which half went',
      /Keshav Garg/.test(one.html) && /Half day/.test(one.html) && /second half/.test(one.html), one.subject);
    check('and says in days what it costs, not in fractions',
      /half a day/.test(one.html) && /casual leave/.test(one.html), null);
    check('their own words are carried',
      /dentist/.test(one.html), null);
    /* Told, not asked. A button to approve what is already granted would be a
       lie about what this is. */
    check('there is nothing on it to approve or reject',
      !/Approve|Reject/i.test(one.html), null);
    check('it says so in as many words',
      /nothing is being asked of you/.test(one.html), null);
    const back = mailer.partDayEmail({
      items: [{ name: 'Keshav Garg', day: TODAY, kindName: 'Short leave', removed: true }] });
    check('a day put back does not read as a day taken',
      /whole working day again/.test(back.html) && /put back/.test(back.subject), back.subject);
    /* The office's own wording, the same bargain every other message strikes. */
    const worded = mailer.partDayEmail({
      subject: 'Part day · {who}', intro: 'Dear sir, {n} to note.', footer: 'Regards',
      items: [{ name: 'Keshav Garg', day: TODAY, kindName: 'Half day', qty: 'half a day' }] });
    check('the office can word it itself',
      worded.subject === 'Part day · Keshav Garg'
      && /Dear sir, 1 to note\./.test(worded.html) && /Regards/.test(worded.html), worded.subject);
    check('and there is somewhere in the settings to write that wording',
      /part: \(function \(\) \{/.test(SRV) && /isPlainObject\(ex\.part\)/.test(SRV), null);

    /* ---- the card they take it from ---- */
    {
      const c3 = {
        todayISO_full: TODAY, halfDays: {}, overrides: {},
        shotEsc: t => String(t == null ? '' : t).replace(/[&<>"]/g, c =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        String, Object, console,
      };
      vm.createContext(c3);
      ['hdQty', 'hdLabel', 'hdMark', 'partSaid', 'partDayRow'].forEach(n => vm.runInContext(grab(APP, n), c3));
      vm.runInContext(/var PART_SELF = \[[\s\S]*?\];/.exec(APP)[0], c3);

      let html = c3.partDayRow('Keshav Garg', TODAY);
      check('the card offers a short leave and either half of a day',
        /value="SHORT"/.test(html) && /value="HALF:AM"/.test(html) && /value="HALF:PM"/.test(html), null);
      check('and says it counts at once with nobody agreeing to it',
        /nobody has to agree to it/.test(html), null);
      check('a whole day away still needs asking, and the card says so',
        /still needs a request/.test(html), null);
      /* Today only, like the hours and the visit beside it. */
      check('yesterday is not offered',
        c3.partDayRow('Keshav Garg', '2026-01-05') === '', null);

      c3.halfDays[K('Keshav Garg')] = { kind: 'HALF', half: 'PM', by: 'self', why: 'dentist' };
      html = c3.partDayRow('Keshav Garg', TODAY);
      check('what they took is shown back to them',
        /selected/.test(html) && /second half/.test(html), null);
      check('their own words come back without the prefix in front',
        /value="dentist"/.test(html), null);
      check('and it can be put back',
        /edPartClear/.test(html), null);

      c3.halfDays[K('Keshav Garg')] = { kind: 'THREEQ' };
      html = c3.partDayRow('Keshav Garg', TODAY);
      check('a mark the office made is shown but not offered for changing',
        /entered by the office/.test(html) && !/edPartKind/.test(html), null);
      c3.halfDays = {};
      c3.overrides[K('Keshav Garg')] = { cat: 'LEAVE', detail: 'CL' };
      check('and a day already away whole offers no half of it',
        /no part of it left/.test(c3.partDayRow('Keshav Garg', TODAY)), null);

      /* The page does not write the mark - it cannot, and asking the server is
         the whole point of the route. */
      check('the card asks the server rather than writing the mark itself',
        /fetch\('\/api\/part-day'/.test(APP) && !/halfDays\[name \+ '\|' \+ day\] =/.test(APP), null);
      check('and reads back what the server wrote rather than guessing it',
        /Promise\.all\(\[loadHalfDays\(\), loadLeaveRequests\(\)\]\)/.test(APP), null);
      /* Each refusal the server can give is a sentence somebody can act on. */
      ['month_locked', 'marked_by_office', 'day_is_leave', 'already_requested',
       'already_taken', 'nothing_to_undo'].forEach(e => {
        check('the card has words for ' + e,
          new RegExp('/' + e + '/\\.test\\(why\\)').test(APP), null);
      });
    }

    /* ---- the office types the addresses itself ----
       Who should hear that somebody has taken leave is not the same question
       as who should hear they came in late, and it is not a question this
       code is in any position to answer. So the message has a To and a Cc of
       its own on the settings panel, and the answer above - the management
       with the approvers copied - is only what happens until somebody types
       one. */
    {
      const part = /part: \(function \(\) \{[\s\S]*?\}\)\(\)/.exec(SRV)[0];
      check('the part-day message has addresses of its own in the settings',
        /to: \(Array\.isArray\(pt\.to\)/.test(part) && /cc: \(Array\.isArray\(pt\.cc\)/.test(part), null);
      check('and they are filtered like every other address box',
        (part.match(/EMAIL_RE\.test\(x\)\)\.slice\(0, 20\)/g) || []).length === 2, null);
      check('its wording is kept beside them',
        /subject: clip\(pt\.subject, 200\)/.test(part), null);

      const notify = grab(SRV, 'notifyPartDayTaken');
      /* Whoever is named on the tab is who it goes to - the same bargain
         every other tab in this panel strikes. */
      check('typed addresses are who it goes to',
        /const named = \(words\.to \|\| \[\]\)\.length > 0;/.test(notify)
        && /to = named \? \(words\.to \|\| \[\]\)\.slice\(\)/.test(notify), null);
      check('and nobody else - the approvers are not added on top of them',
        /if \(!named\) \(await leaveApprovers\(orgId, settings\)\)\.forEach\(push\);/.test(notify), null);
      check('named nobody, it still reaches whoever decides leave',
        /: \(await mailRecipients\(orgId, settings, 'leave'\)\)\.slice\(\)/.test(notify), null);
      /* Whatever the office types, the person whose leave it is still sees
         the message about it. */
      check('and the person who took the day is copied in either way',
        notify.indexOf('ownersOf(orgId, items.map') > notify.indexOf('if (!named)'), null);

      check('there is wording it comes with, so the boxes are not blank',
        !!mailer.DEFAULT_TEXT.partDay && /\{kind\}/.test(mailer.DEFAULT_TEXT.partDay.subject),
        mailer.DEFAULT_TEXT.partDay);
      check('and the panel is sent that wording to show',
        /defaults: mailer\.DEFAULT_TEXT/.test(SRV), null);

      /* The panel itself: boxes to type in, and a save that keeps them. */
      check('the settings panel has a box for the addresses',
        /id="emPtTo"/.test(APP) && /id="emPtCc"/.test(APP), null);
      check('with the subject and the words beside it',
        /id="emPtSubject"/.test(APP) && /id="emPtIntro"/.test(APP) && /id="emPtFooter"/.test(APP), null);
      check('and saving the panel keeps all five',
        /part: \{ to: list\('emPtTo'\), cc: list\('emPtCc'\),/.test(APP)
        && /subject: document\.getElementById\('emPtSubject'\)/.test(APP), null);
      /* It sits with the other two things somebody marks on their own day,
         which is where anybody would go looking for it. */
      check('it sits on the tab for marks people make themselves',
        /data-em-tab="lt">Self-marked</.test(APP)
        && APP.indexOf('id="emPtTo"') > APP.indexOf('data-em-pane="lt"')
        && APP.indexOf('id="emPtTo"') < APP.indexOf('data-em-pane="lv"'), null);
      check('and says plainly where it goes while nobody has typed anything',
        /Nobody named, so it goes to whoever decides leave/.test(APP), null);
      check('the default wording is shown in the boxes rather than hidden',
        /mailEscape\(text\(pt\.subject, D\.subject\)\)/.test(APP), null);
    }

    const bad = results.filter(x => !x).length;
    console.log(bad ? ('FAILED ' + bad + ' of ' + results.length)
                    : ('ALL PASS (' + results.length + ' checks)'));
    process.exit(bad ? 1 : 0);
  })().catch(e => { console.error(e); process.exit(1); });
}
