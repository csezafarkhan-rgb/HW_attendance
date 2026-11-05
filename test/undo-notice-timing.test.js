/* The restore-point notice, and how long it sits there.
 *
 * It is the quick way back straight after an import, and it was staying on
 * screen for seven seconds and then taking another one and a bit to fade -
 * better than eight seconds of a green box over the record somebody is trying
 * to read. Three now, gone inside four.
 *
 * Nothing is lost by it going: every import keeps its restore point under
 * Backup & Restore with a Restore button beside it, so this is a notice
 * ending rather than an offer expiring.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'src', 'attendance.html'), 'utf8');

let pass = 0, fail = 0;
function check(what, ok, got) {
  if (ok) { pass++; console.log('PASS ' + what); }
  else { fail++; console.log('FAIL ' + what + '  ' + JSON.stringify(got)); }
}

/* ---- how long it stays ---- */
const dwell = /var UNDO_DWELL = (\d+);/.exec(APP);
check('it waits a stated number of milliseconds, not a number typed twice',
  !!dwell, APP.indexOf('UNDO_DWELL'));
check('three seconds', dwell && Number(dwell[1]) === 3000, dwell && dwell[1]);
check('and the wait after the pointer leaves is the same one',
  (APP.match(/setTimeout\(away, UNDO_DWELL\)/g) || []).length === 2,
  (APP.match(/setTimeout\(away, UNDO_DWELL\)/g) || []).length);
check('seven seconds is gone from it',
  !/setTimeout\(away, 7000\)/.test(APP), null);

/* ---- and how it goes ---- */
const fade = /\.undo-import\{transition:opacity ([\d.]+)s ease, transform [\d.]+s ease;\}/.exec(APP);
check('it fades rather than blinking out', !!fade, null);
check('the fade is under a second', fade && Number(fade[1]) < 1, fade && fade[1]);
/* Dwell plus fade is what somebody actually experiences. */
{
  const total = (dwell ? Number(dwell[1]) : 0) + (fade ? Number(fade[1]) * 1000 : 0);
  check('so the whole thing is gone inside four seconds', total <= 4000, total);
  check('and not so fast it cannot be read', total >= 3000, total);
}
/* The box is cleared after the fade has run, not during it - clearing it
   mid-transition is the blink the fade exists to avoid. */
const clear = /\}, (\d+)\);\s*\n\s*\};\s*\n\s*if\(UNDO_TIMER\) clearTimeout\(UNDO_TIMER\);/.exec(APP);
check('it is cleared only once the fade has run', !!clear, null);
check('and that wait outlasts the fade',
  clear && fade && Number(clear[1]) >= Number(fade[1]) * 1000,
  clear && fade && [clear[1], fade[1]]);

/* ---- what it must not do ---- */
check('it is not taken away while somebody is reading it',
  /if\(box\.matches\(':hover'\)\)\{ UNDO_TIMER = setTimeout\(away, UNDO_DWELL\); return; \}/.test(APP),
  null);
check('a fresh notice starts fully present rather than mid-fade',
  /box\.classList\.remove\('going'\);\s*\/\/ a fresh notice starts fully present/.test(APP), null);
check('one that has had its turn does not pop back up',
  /if\(UNDO_SAID && UNDO_SAID === info\.at\)\{/.test(APP), null);
/* Somebody who would rather not wait can shut it, and the restore point
   stays where it is. */
check('it can still be dismissed by hand',
  /id="undoImportDismiss"/.test(APP), null);
check('and the way back outlives the notice',
  /The restore point\s*\n?\s*stays where it is/.test(APP)
  || /restore point\s+stays/.test(APP.replace(/\s+/g, ' ')), null);
/* Somebody who has asked for less movement gets a plain fade, not a slide. */
check('reduced motion still gets a fade, without the slide',
  /@media \(prefers-reduced-motion: reduce\)\{[\s\S]{0,160}\.undo-import\{transition:opacity \.2s linear;\}/
    .test(APP), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
