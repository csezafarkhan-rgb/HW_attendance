// Every column the server asks the users table for must exist in schema.sql.
//
// Adding leave_approver to a query and to schema.sql looked complete and was
// not: the schema is only applied by migrate.js, and the server used to run it
// solely when the tables were missing or empty. On a database that already had
// accounts the column was never added, and the users list answered 500 - after
// the deploy, with nothing failing before it.
//
// This reads the column names out of schema.sql and checks the server's own
// queries against them, which is the half that can be checked here.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const results = [];
const check = (name, ok, got) => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(got)));
};

/* The columns a table is declared with, plus any added by a later ALTER. */
function columnsOf(table) {
  const out = new Set();
  const m = new RegExp('CREATE TABLE IF NOT EXISTS ' + table + '\\s*\\(([\\s\\S]*?)\\n\\);', 'i').exec(schema);
  if (m) {
    for (const line of m[1].split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('--') || /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(t)) continue;
      const name = /^([a-z_][a-z0-9_]*)\s/i.exec(t);
      if (name) out.add(name[1].toLowerCase());
    }
  }
  const alter = new RegExp('ALTER TABLE ' + table + ' ADD COLUMN IF NOT EXISTS\\s+([a-z_][a-z0-9_]*)', 'gi');
  for (const a of schema.matchAll(alter)) out.add(a[1].toLowerCase());
  return out;
}

const userCols = columnsOf('users');
check('schema.sql declares the users table', userCols.size > 5, [...userCols]);
/* Who approves first is an address in the mail settings, not a mark on an
   account, so the users table carries nothing for it - and the server must not
   ask for anything it does not have. */
check('and nothing is asked of it for the two-stage leave approval',
  !/leave_approver/.test(server), 'server.js still mentions leave_approver');

/* What the server asks for. Only the plain select lists - anything with a
   function call or a sub-select in it is left alone rather than guessed at. */
const asked = new Map();
for (const m of server.matchAll(/SELECT\s+([\s\S]{1,400}?)\s+FROM users\b/gi)) {
  const list = m[1];
  if (/\(|\*/.test(list)) continue;
  for (let part of list.split(',')) {
    part = part.trim().replace(/\s+AS\s+[a-z_][a-z0-9_]*$/i, '').trim();
    if (/^[a-z_][a-z0-9_]*$/i.test(part)) asked.set(part.toLowerCase(), m[0].slice(0, 70));
  }
}
check('the server asks the users table for something', asked.size > 3, [...asked.keys()]);

const missing = [...asked.keys()].filter(c => !userCols.has(c));
check('and every column it asks for is one the table has',
  missing.length === 0, missing.map(c => c + '  in  ' + asked.get(c)));

/* The other half: the schema has to actually be applied. It is written to be
   run over and over, and the server used to run it only when the tables were
   missing - so a column added to it never reached a database already in use. */
const ensure = /async function ensureSchema\(\)[\s\S]*?\n\}/.exec(server);
check('the server knows how to apply the schema', !!ensure);
check('and does so on every boot, not only when the tables are missing',
  !!ensure && !/if \(n\.rows\[0\]\.n > 0\) return;/.test(ensure[0]),
  ensure && ensure[0].slice(0, 500));

console.log(results.every(Boolean) ? 'ALL PASS (' + results.length + ')' : 'SOME FAILED');
process.exitCode = results.every(Boolean) ? 0 : 1;
