'use strict';
/* Creates the tables, then bootstraps the first admin account.
 *
 * The bootstrap exists because Render's free tier has no Shell tab, so
 * scripts/create-user.js cannot be run by hand there. Set ADMIN_EMAIL and
 * ADMIN_PASSWORD in the dashboard and the first admin is created on boot.
 *
 * It only ever fires when the users table is empty, so it cannot overwrite an
 * existing account or silently reset a password on every deploy.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /render\.com|amazonaws/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : false
});

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set.');
    process.exit(1);
  }

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema ready');

  const { rows: orgs } = await pool.query('SELECT id FROM orgs ORDER BY id LIMIT 1');
  let orgId;
  if (!orgs[0]) {
    const r = await pool.query(
      'INSERT INTO orgs (name) VALUES ($1) RETURNING id',
      [process.env.ORG_NAME || 'AllyConnect Pvt. Ltd.']
    );
    orgId = r.rows[0].id;
    console.log('created default org');
  } else {
    orgId = orgs[0].id;
  }

  // Older builds used viewer/editor for non-admin accounts. Normalize them
  // to the current two-role model before the app starts using the Users panel.
  // Keep older databases compatible with the current user model.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE');
  await pool.query("UPDATE users SET role = 'employee' WHERE org_id = $1 AND role IN ('viewer','editor')", [orgId]);

  // Older builds may have had a role constraint that still allowed viewer/editor.
  // Replace it so the current two-role model is enforced consistently.
  await pool.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_chk");
  await pool.query("ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('admin','employee'))");

  const { rows: existing } = await pool.query('SELECT count(*)::int AS n FROM users WHERE org_id = $1', [orgId]);
  if (existing[0].n > 0) {
    console.log('users already exist (' + existing[0].n + ') - skipping admin bootstrap');
  } else {
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || '';
    if (!email || !password) {
      console.log('NOTE: no users yet, and ADMIN_EMAIL/ADMIN_PASSWORD are not set.');
      console.log('      Set both in the Render dashboard and redeploy.');
    } else if (password.length < 8) {
      console.error('ADMIN_PASSWORD must be at least 8 characters - admin NOT created.');
    } else {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        'INSERT INTO users (org_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5)',
        [orgId, email, hash, process.env.ADMIN_NAME || 'Admin', 'admin']
      );
      console.log('bootstrapped first admin: ' + email);
    }
  }

  console.log('migration complete');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
