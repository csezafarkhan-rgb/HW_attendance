'use strict';
/* Usage: node scripts/create-user.js <email> <password> [role] [name]
   role: admin | editor | viewer   (default admin for the first user) */
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
(async () => {
  const [email, password, role = 'admin', name = null] = process.argv.slice(2);
  if (!email || !password) { console.error('usage: create-user <email> <password> [role] [name]'); process.exit(1); }
  if (password.length < 8) { console.error('password must be at least 8 characters'); process.exit(1); }
  const { rows: orgs } = await pool.query('SELECT id FROM orgs ORDER BY id LIMIT 1');
  if (!orgs[0]) { console.error('no org found - run npm run migrate first'); process.exit(1); }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (org_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
    [orgs[0].id, email.toLowerCase(), hash, name, role]
  );
  console.log('user ready:', email, '(' + role + ')');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
