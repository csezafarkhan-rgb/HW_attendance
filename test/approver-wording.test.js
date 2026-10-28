// Who holds the first stage was set against each person in the Shifts panel
// and the words were set in Email -> Leave, so neither screen ever showed one
// person's arrangement whole, and an approver could not be given wording of
// their own at all.
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

/* ---- which words one address reads ---- */
{
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(grab(SRV, 'firstWords'), ctx);
  const office = { leave: { firstIntro: 'Dear {approver}, the office wording.' } };
  const intros = { 'munish@homeweavers.net': 'Dear {approver}, your own wording.' };

  check('an approver with wording of their own reads it',
    ctx.firstWords(intros, 'munish@homeweavers.net', office) === 'Dear {approver}, your own wording.');
  check('the address is matched however it was typed',
    ctx.firstWords(intros, '  Munish@Homeweavers.NET ', office) === 'Dear {approver}, your own wording.');
  check('everybody else reads the office wording',
    ctx.firstWords(intros, 'support@homeweavers.net', office) === 'Dear {approver}, the office wording.');
  check('wording left blank is not wording - the office wording stands',
    ctx.firstWords({ 'a@b.co': '   ' }, 'a@b.co', office) === 'Dear {approver}, the office wording.');
  check('with neither written, nothing is claimed',
    ctx.firstWords({}, 'a@b.co', { leave: {} }) === '');
  check('no map at all is the same as an empty one',
    ctx.firstWords(null, 'a@b.co', office) === 'Dear {approver}, the office wording.');
  check('and nobody holding the stage reads nothing of theirs',
    ctx.firstWords(intros, '', office) === 'Dear {approver}, the office wording.');
}

/* ---- the store ---- */
{
  check('the server reads the wording from a shared key',
    /async function approverIntroOf\(orgId\)/.test(SRV)
    && /sharedKeys\(orgId, \['approverIntro'\]\)/.test(SRV));
  check('a list is not a map, and is refused as one',
    /!Array\.isArray\(map\)\) \? map : \{\}/.test(grab(SRV, 'approverIntroOf') + ''), 0);
  /* All three messages that ask for the first word, not one of them. */
  check('the nightly summary reads it',
    /const myWords = st === 1 \? firstWords\(await approverIntroOf\(orgId\), mine, settings\) : ''/.test(SRV));
  check('the note each request raises reads it',
    /intro: \(who && firstWords\(intros, who, settings\)\) \|\| settings\.leave\.intro/.test(SRV));
  check('the notice about days taken without a request reads it',
    /const gWords = stage \? firstWords\(await approverIntroOf\(orgId\), g\.approver, settings\) : ''/.test(SRV));
  check('and none of them still reaches past it to the office wording',
    !/settings\.leave\.firstIntro\) \? settings\.leave\.firstIntro/.test(SRV),
    (SRV.match(/settings\.leave\.firstIntro\)[^\n]*/g) || []).slice(0, 3));
}

/* ---- the page keeps it, and keeps it backed up ---- */
{
  check('the page holds the wording', /var approverIntro = \{\};/.test(APP));
  check('it is read at start-up', /loadSelfMark, loadApprovalRoute, loadApproverIntro,/.test(APP));
  check('and it goes into the backup with everything else',
    /'mailSettings','selfMark','approvalRoute','approverIntro',/.test(APP));
  check('a blank box is a deletion, not an empty string stored',
    /if\(v\) approverIntro\[k\] = v; else delete approverIntro\[k\];/.test(APP));
  check('the page matches the address the way the server does',
    /var k = who\.toLowerCase\(\)/.test(APP) && /String\(email \|\| ''\)\.trim\(\)\.toLowerCase\(\)/.test(APP));
}

/* ---- the panel ---- */
{
  check('there is a name to pick in the first-approval pane',
    /id="emLvWho"/.test(APP) && /Pick a name/.test(APP));
  /* A card-punch row with no person behind it - "500" on this reader - is on
     the roster and is hidden on the portal, which is already what keeps it out
     of the daily message. This pane goes by the same rule rather than a second
     one that would have to be kept in step with it. */
  check('it goes by the people the portal is showing',
    /function lvWhoPeople\(\)/.test(APP) && /\+   lvWhoPeople\(\)\.map\(function\(e\)\{/.test(APP));
  check('somebody hidden is still offered where an approver is named against them',
    /return shown \|\| \(e\.name in \(approvalRoute \|\| \{\}\)\)/.test(APP));
  check('and the tally of whose words these are goes by the same rule',
    /return lvWhoPeople\(\)\.filter\(function\(e\)\{/.test(APP));
  check('picking one shows who gets the first word about them',
    /id="emLvWhoAppr"/.test(APP) && /The usual one/.test(APP));
  check('an approver with no account can still be named',
    /id="emLvWhoOther"/.test(APP) && /Other\u2026/.test(APP));
  check('and somebody can be taken out of the first stage from here too',
    /Nobody \u2014 granted in one stage/.test(APP));
  check('it shows what that approver will actually read',
    /What they will read/.test(APP) && /replace\(\/\\{approver\\}\/g, byName\)/.test(APP));
  /* The trap this pane could set: wording reached through one person's name
     but kept against an address, changing it for everybody that address
     covers. It says whose words these are. */
  check('and names everybody those words would reach',
    /function lvWhoSharing\(email\)/.test(APP)
    && /about everybody they look after/.test(APP));
  check('the two stores save themselves rather than waiting on the mail Save',
    /saved as you change it/.test(APP)
    && /saveApproverIntro\(\)\.then/.test(APP) && /saveApprovalRoute\(\)\.then/.test(APP));
  check('a half-typed address is not saved as one',
    APP.indexOf('if(v && !/^[^@') > -1 && APP.indexOf('{ other.focus(); return; }') > -1);
}

/* ---- the panel stays open while it is being used ----
   The panel closed on any click it had not stopped itself. A dropdown draws
   its list of names in a menu outside the page, so choosing a name arrived as
   a click from somewhere else and shut the panel mid-edit. */
{
  const wire = APP.slice(APP.indexOf("var btn = document.getElementById('emailBtn')"),
                         APP.indexOf('function domNodeToCanvas'));
  check('a click that is not in the page any more decides nothing',
    wire.indexOf('if(!e.target || !document.contains(e.target)) return;') > -1);
  check('a click inside the panel, or on the button that opened it, leaves it open',
    wire.indexOf('if(dd.contains(e.target) || e.target === btn) return;') > -1);
  check('and a click on a choice in a list belongs to whatever opened it',
    wire.indexOf('if(inChoiceList(e.target)) return;') > -1);
  /* The list is drawn at the top of the page rather than inside the panel, so
     "is it inside the panel" was always false for it. Every panel that shuts
     on a click from elsewhere had the same trap, including the one that shuts
     all of them at once - so the rule is written once and read by each. */
  check('the rule is written once',
    (APP.match(/function inChoiceList\(t\)\{/g) || []).length === 1);
  check('and it names the list the page actually draws',
    APP.indexOf("t.closest('.selx-pop')") > -1);
  check('the panel that shuts all the others reads it first of all',
    APP.indexOf('if(inChoiceList(t)) return;') > -1
    && APP.indexOf('if(inChoiceList(t)) return;') < APP.indexOf("var inside = t.closest('.month-dropdown');"));
  check('and every panel with a closer of its own reads it too',
    (APP.match(/if\(inChoiceList\(e\.target\)\) return;/g) || []).length >= 5,
    (APP.match(/if\(inChoiceList\(e\.target\)\) return;/g) || []).length);
  check('the blanket close is gone',
    wire.indexOf("document.addEventListener('click', function(){ dd.classList.remove('open'); });") === -1);
  /* Holding it open on a focused list would hold it open for good; the box
     lets go of the focus as soon as a name is picked. */
}

/* ---- where it sits, and what it calls people ---- */
{
  const pane = APP.slice(APP.indexOf('<div data-lv-pane="first"'),
                         APP.indexOf('<div data-lv-pane="final"'));
  check('the name comes first - it is the question this pane is asked',
    pane.indexOf('emLvWho') < pane.indexOf('emLvFirstTo'),
    [pane.indexOf('emLvWho'), pane.indexOf('emLvFirstTo')]);
  check('and the addresses below it are the fallback for everybody it does not name',
    pane.indexOf('emLvFirstTo') < pane.indexOf('emLvFirstCc')
    && pane.indexOf('emLvFirstCc') < pane.indexOf('emLvFirstIntro'));
  /* A card-punch row renamed to say what it is should read that way here too,
     rather than showing the key its records are filed under. */
  check('a name is shown the way the rest of the page shows it',
    APP.indexOf("+ mailEscape(dispName(e.name)) + '</option>'") > -1);
  check('while the value stays the name the records are filed under',
    APP.indexOf(`'<option value="' + mailEscape(e.name) + '">'`) > -1);
}

const bad = results.filter(x => !x).length;
console.log(bad ? ('\n' + bad + ' FAILED of ' + results.length) : ('\nALL PASS (' + results.length + ')'));
process.exit(bad ? 1 : 0);
