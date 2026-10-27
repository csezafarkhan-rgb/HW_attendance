// A self-marked in time is the one entry worth falsifying - it decides whether
// the day counts as late, and no clock check can catch a backdate, because a
// backdated time is in the past and every rule it meets says it is fine. So the
// moment it was typed is recorded and shown beside it. These are the checks
// that the moment is recorded per time rather than per record, that it survives
// the day being written again, and that the page cannot set it.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'attendance.html'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

const ctx = { Date, String, Number, Object, Array, JSON, IST_MS: 5.5 * 3600 * 1000 };
vm.createContext(ctx);
const lift = re => { const m = re.exec(SRC); if (!m) throw new Error('not found: ' + re); return m[0]; };
[/function parseJson\(s\) \{[\s\S]*?\n\}/,
 /function parseShiftSpan\(str\) \{[\s\S]*?\n\}/,
 /function ownDays\(shift\) \{[\s\S]*?\n\}/,
 /const TIME_RE = [^\n]*/,
 /function mergeEmployeeManual\(storedValue, incomingValue, name, selfMarkValue, shift\) \{[\s\S]*?\n\}/
].forEach(re => vm.runInContext(lift(re), ctx));

const [TODAY] = ctx.ownDays();
const IST_NOW = new Date(Date.now() + 5.5 * 3600000);
const NOW_MIN = IST_NOW.getUTCHours() * 60 + IST_NOW.getUTCMinutes();
const hhmm = m => String(Math.floor(Math.max(0, m) / 60)).padStart(2, '0')
                + ':' + String(Math.max(0, m) % 60).padStart(2, '0');
const NAME = 'Shyam Lal ESS';
const MARKED = JSON.stringify({ [NAME]: true });
const KEY = NAME + '|' + TODAY;
const save = (stored, rec) =>
  JSON.parse(ctx.mergeEmployeeManual(stored, JSON.stringify({ [KEY]: rec }), NAME, MARKED));

/* ---- the stamp is the server's, and there is one for each time ---- */
{
  const IN = hhmm(Math.max(0, NOW_MIN - 120));
  const first = save('{}', { 'in': IN, out: '' });
  check('marking an in time records when it was typed', !!first[KEY].inAt);
  check('and nothing is stamped for a time not given yet', first[KEY].outAt === '');
  check('the stamp says it came from the person', first[KEY].by === 'self');

  /* The trap this is all about: one "last touched" moment on the record would
     make the morning's in time look hours backdated the moment they typed
     their out time in the evening. */
  const later = save(JSON.stringify(first), { 'in': IN, out: hhmm(Math.max(1, NOW_MIN - 5)) });
  check('typing the out time later leaves the in time’s stamp alone',
    later[KEY].inAt === first[KEY].inAt, { was: first[KEY].inAt, now: later[KEY].inAt });
  check('and the out time gets a stamp of its own', !!later[KEY].outAt
    && later[KEY].outAt !== first[KEY].inAt);

  /* Changing the claim is a new claim, so it is stamped afresh. */
  const moved = save(JSON.stringify(later), { 'in': hhmm(Math.max(0, NOW_MIN - 130)), out: later[KEY].out });
  check('but changing the in time stamps it again',
    moved[KEY].inAt !== first[KEY].inAt, moved[KEY].inAt);

  /* The page sends whatever it likes; the server writes the stamp. */
  const forged = save('{}', { 'in': IN, out: '', inAt: '2020-01-01T00:00:00.000Z', by: 'office' });
  check('a stamp sent by the page is ignored', forged[KEY].inAt !== '2020-01-01T00:00:00.000Z'
    && forged[KEY].by === 'self', forged[KEY]);
}

/* ---- arrived is present ----
   Both times were wanted before a day counted, so somebody who marked their
   arrival at ten to ten read "Absent", in red, on their own calendar and on
   the office's, until they came back in the evening and typed the other half. */
{
  const IN = hhmm(Math.max(0, NOW_MIN - 90));
  const only = save('{}', { 'in': IN, out: '' });
  check('an in time with no out yet is present, not absent',
    only[KEY].st === 'PR', only[KEY]);
  const outOnly = save('{}', { 'in': '', out: hhmm(Math.max(1, NOW_MIN - 5)) });
  check('and so is an out time on its own', outOnly[KEY].st === 'PR', outOnly[KEY]);
  check('the page agrees, wherever it writes one',
    (APP.match(/st: \(tin \|\| tout\) \? 'PR' : 'AB'/g) || []).length >= 1
      && (APP.match(/st: \(inVal \|\| outVal\) \? 'PR' : 'AB'/g) || []).length >= 1);
  /* Days saved while that was true still carry the AB on them. */
  check('and a stored Absent with a time against it is overruled',
    /st: \(manual\['in'\] \|\| manual\.out\) \? 'PR' : \(manual\.st \|\| 'AB'\),/.test(APP));
  /* The figures in a day cell read as quietly as the words IN and OUT beside
     them; they were set in the cell's own dark colour and shouted. */
  check('the times and the duration are as grey as their labels',
    /\.emp-cal-cell \.ecd b\{[^}]*color:var\(--ink-soft\); opacity:\.8;/.test(APP)
      && /\.emp-cal-cell \.ecd-dur b\{[^}]*color:var\(--ink-soft\); opacity:\.8;/.test(APP));
}

/* ---- what the office is shown ---- */
{
  check('the page works out the gap from the server’s stamp',
    /function selfEntryGap\(emp, d\)\{/.test(APP)
      && /man\.by !== 'self' \|\| !man\['in'\] \|\| !man\.inAt/.test(APP));
  check('and compares it against a figure the office sets',
    /function selfFlagMin\(\)\{/.test(APP) && /selfMark\.__flagMin/.test(APP));
  check('five minutes unless it has been set otherwise',
    /if\(v === undefined \|\| v === null \|\| v === ''\) return 5;/.test(APP));
  /* It is set where the people it is about are set. */
  check('the figure is set in Shifts, beside who marks their own day',
    /id="shfFlagMin"/.test(APP) && /Flag a self-marked <b>in<\/b> time typed more than/.test(APP));
  check('and saves itself, with no separate Save to miss',
    /flagBox\.addEventListener\('change'[\s\S]{0,400}saveSelfMark\(\)/.test(APP));
  /* Two places: the cell carries a mark, the day says the whole sentence. */
  check('a flagged day is marked in the grid',
    /selfEntryFlagged\(emp\.name, dateStr\)/.test(APP)
      && /class="self-late-flag"/.test(APP));
  check('and the office sees the claim beside the moment it was made',
    /marked this day\./.test(APP) && /after the time claimed\./.test(APP));
  /* It is a gap, not an accusation - somebody who forgets until lunch has done
     nothing wrong, and the wording has to leave room for that. */
  check('said as a gap rather than as a verdict',
    /it is the gap you are being shown, not a verdict/.test(APP));
  check('the setting rides along in the backup',
    /'lunchBreakMin','break1Min','break2Min','mailSettings','selfMark',/.test(APP));
}

const bad = results.filter(r => !r).length;
console.log(bad ? ('SOME FAILED (' + bad + ')') : ('ALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
