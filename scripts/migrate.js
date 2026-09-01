'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /render\.com|amazonaws/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : false
});
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  const { rows } = await pool.query('SELECT id FROM orgs LIMIT 1');
  if (!rows[0]) {
    await pool.query('INSERT INTO orgs (name) VALUES ($1)', [process.env.ORG_NAME || 'AllyConnect Pvt. Ltd.']);
    console.log('created default org');
  }
  console.log('migration complete');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
