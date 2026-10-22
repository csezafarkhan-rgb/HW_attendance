#!/usr/bin/env node
/* Move everything from one Postgres to another.
   ----------------------------------------------------------------
   The free database expires; this carries the office's whole record over to a
   paid one without `pg_dump`, which is not on the machine this is run from.

   It is deliberately timid:

     - the source is only ever read (SELECT, nothing else);
     - the target must be empty, so running it twice cannot double anything;
     - every table is counted on both sides at the end, and it fails loudly
       if a single row did not make it;
     - the id sequences are set past the rows that came over, or the first
       insert after the move would collide with a row it just received.

   Tables are copied parents first, so the foreign keys hold at every step.
   Anything in the source that this does not know about is still copied - it
   goes last and is reported - rather than being left behind quietly.

   Usage:
     node scripts/move-database.js --from <old url> --to <new url> [--dry-run]

   Both URLs are Render's EXTERNAL connection strings. The target's inbound IP
   rules have to allow this machine, or it cannot connect at all.
*/
'use strict';
const { Client } = require('pg');

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf('--' + name);
  return i > -1 ? args[i + 1] : null;
};
const DRY = args.includes('--dry-run');
/* Clear the target before copying. Only ever wanted for a new database the
   service has already booted against, which `migrate.js` seeds. */
const WIPE = args.includes('--wipe-target');
const FROM = flag('from') || process.env.FROM_DATABASE_URL;
const TO = flag('to') || process.env.TO_DATABASE_URL;

if (!FROM || !TO) {
  console.error('usage: node scripts/move-database.js --from <old url> --to <new url> [--dry-run] [--wipe-target]');
  process.exit(2);
}
if (FROM === TO) {
  console.error('refusing to run: --from and --to are the same database');
  process.exit(2);
}

/* Parents before children, so every foreign key has something to point at by
   the time it is written. Anything not named here is copied afterwards. */
const ORDER = ['orgs', 'users', 'employees', 'records', 'kv', 'session',
               'history', 'change_log', 'client_errors',
               'mail_log', 'mail_shots', 'maintenance_done',
               'usage_bytes', 'service_meta'];

const BATCH = 500;                      // rows an INSERT, so a wide table still fits

const ssl = { rejectUnauthorized: false };   // Render's certificate chain
const connect = async (url, what) => {
  const c = new Client({ connectionString: url, ssl });
  try { await c.connect(); }
  catch (e) {
    console.error('could not reach the ' + what + ' database: ' + e.message);
    if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message)) {
      console.error('  (if this is the new database, its inbound IP rules may still be blocking this machine)');
    }
    process.exit(1);
  }
  return c;
};

async function tablesOf(c) {
  const r = await c.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`);
  return r.rows.map(x => x.table_name);
}
async function countOf(c, t) {
  const r = await c.query('SELECT count(*)::int AS n FROM ' + ident(t));
  return r.rows[0].n;
}
function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('refusing odd table name: ' + name);
  return '"' + name + '"';
}

(async () => {
  const src = await connect(FROM, 'old');
  const dst = await connect(TO, 'new');

  const have = await tablesOf(src);
  const want = await tablesOf(dst);
  const missing = have.filter(t => want.indexOf(t) === -1);
  /* `migrate.js` writes the schema, but four tables - the mail log, the shots
     kept with it, the bandwidth tally and the service's own notes - are made
     by the server the first time it needs them, so a database that has only
     been migrated does not have them yet. Rather than wait for the new service
     to touch each one, they are built here from the shape the old database
     gives them. */
  for (const t of missing) {
    if (DRY) { console.log('would build ' + t + ' from the old database\'s shape'); continue; }
    const cols = (await src.query(
      `SELECT column_name, data_type, udt_name, character_maximum_length,
              is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t])).rows;
    if (!cols.length) continue;
    const pk = (await src.query(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`, [t])).rows.map(r => r.attname);
    const defs = cols.map(c => {
      let type = c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type;
      if (c.character_maximum_length) type += '(' + c.character_maximum_length + ')';
      /* A serial's default names a sequence in the old database; the new one
         gets its own, so the column is declared as the serial it really is. */
      let def = c.column_default;
      if (def && /^nextval\(/.test(def)) {
        type = (type === 'bigint') ? 'BIGSERIAL' : 'SERIAL';
        def = null;
      }
      return '"' + c.column_name + '" ' + type
        + (def ? (' DEFAULT ' + def) : '')
        + (c.is_nullable === 'NO' ? ' NOT NULL' : '');
    });
    if (pk.length) defs.push('PRIMARY KEY (' + pk.map(c => '"' + c + '"').join(', ') + ')');
    await dst.query('CREATE TABLE IF NOT EXISTS ' + ident(t) + ' (' + defs.join(', ') + ')');
    console.log('built ' + t + ' in the new database');
  }

  /* Parents first, then whatever else the old database turns out to hold. */
  const order = ORDER.filter(t => have.indexOf(t) > -1)
    .concat(have.filter(t => ORDER.indexOf(t) === -1));
  const extra = have.filter(t => ORDER.indexOf(t) === -1);
  if (extra.length) console.log('also carrying over: ' + extra.join(', '));

  /* Nothing is written into a database that already holds something.

     The one case where that is too strict: a new database the service has
     already booted against. `migrate.js` seeds an organisation and the first
     admin, so the target is not empty even though it holds nothing anybody
     typed. --wipe-target clears it first, and says exactly what it is
     discarding before it does. */
  const already = [];
  for (const t of order) { const n = await countOf(dst, t); if (n > 0) already.push(t + ' (' + n + ')'); }
  if (already.length && WIPE && !DRY) {
    console.log('clearing the new database first: ' + already.join(', '));
    await dst.query('TRUNCATE ' + order.map(ident).join(', ') + ' RESTART IDENTITY CASCADE');
    console.log('cleared. The old database has not been touched.');
  } else if (already.length && !DRY) {
    console.error('the new database is not empty - ' + already.join(', ') + '.');
    console.error('refusing to run: this would double them.');
    console.error('If those are only what `migrate.js` seeded, run again with --wipe-target.');
    process.exit(1);
  } else if (already.length && DRY) {
    console.log('the new database already holds: ' + already.join(', ')
      + (WIPE ? ' - these would be cleared first' : ' - it would refuse without --wipe-target'));
  }

  const before = {};
  for (const t of order) before[t] = await countOf(src, t);
  const total = Object.values(before).reduce((a, b) => a + b, 0);
  console.log('carrying ' + total.toLocaleString() + ' rows across ' + order.length + ' tables'
    + (DRY ? ' - dry run, nothing will be written' : ''));

  for (const t of order) {
    const n = before[t];
    if (!n) { console.log('  ' + t.padEnd(18) + 'empty'); continue; }
    if (DRY) { console.log('  ' + t.padEnd(18) + n.toLocaleString() + ' rows to carry'); continue; }

    const cols = (await src.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t]
    )).rows.map(r => r.column_name);
    const quoted = cols.map(c => '"' + c + '"').join(', ');

    let done = 0;
    /* Read in pages, so a big table never has to sit in memory all at once. */
    for (let off = 0; off < n; off += BATCH) {
      const page = await src.query(
        'SELECT ' + quoted + ' FROM ' + ident(t) + ' ORDER BY 1 OFFSET $1 LIMIT $2', [off, BATCH]);
      if (!page.rows.length) break;
      const values = [];
      const tuples = page.rows.map((row, i) => {
        const marks = cols.map((c, k) => {
          values.push(row[c]);
          return '$' + (i * cols.length + k + 1);
        });
        return '(' + marks.join(', ') + ')';
      });
      await dst.query('INSERT INTO ' + ident(t) + ' (' + quoted + ') VALUES '
        + tuples.join(', ') + ' ON CONFLICT DO NOTHING', values);
      done += page.rows.length;
    }
    console.log('  ' + t.padEnd(18) + done.toLocaleString() + ' rows');
  }

  if (DRY) { await src.end(); await dst.end(); return; }

  /* The id counters. Left where they are, the next insert would be handed an
     id a row that just arrived is already using. */
  const seqs = (await dst.query(
    `SELECT c.relname AS seq, t.relname AS tbl, a.attname AS col
       FROM pg_class c
       JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE c.relkind = 'S'`)).rows;
  for (const s of seqs) {
    await dst.query(
      `SELECT setval($1, COALESCE((SELECT MAX(${'"' + s.col + '"'}) FROM ${ident(s.tbl)}), 0) + 1, false)`,
      [s.seq]);
  }
  console.log('reset ' + seqs.length + ' id counters past the rows that came over');

  /* And the part that matters: it is only a move if both sides agree. */
  let wrong = 0;
  console.log('\nchecking both sides:');
  for (const t of order) {
    const a = before[t], b = await countOf(dst, t);
    const ok = a === b;
    if (!ok) wrong++;
    console.log('  ' + (ok ? 'ok  ' : 'BAD ') + t.padEnd(18)
      + 'old ' + String(a).padStart(7) + '   new ' + String(b).padStart(7));
  }
  await src.end();
  await dst.end();

  if (wrong) {
    console.error('\n' + wrong + ' table(s) did not come over whole. The old database is untouched '
      + '- nothing has been lost. Empty the new one and run it again.');
    process.exit(1);
  }
  console.log('\nevery table matches. The old database was only read from.');
})().catch(e => { console.error(e); process.exit(1); });
