const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. Add a PostgreSQL database on Render.');
    }
    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function initDb() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  try {
    await getPool().query(sql);
  } catch (err) {
    if (err.code === 'ENOTFOUND' || /getaddrinfo ENOTFOUND/i.test(String(err.message))) {
      const host = (() => {
        try {
          return new URL(process.env.DATABASE_URL.replace(/^postgres:/, 'postgresql:')).hostname;
        } catch {
          return 'unknown';
        }
      })();
      throw new Error(
        `Cannot reach PostgreSQL host "${host}". On Render: open your Postgres instance → copy a fresh ` +
          `Internal Database URL → Web service (sales-audit-2.0-2) → Environment → DATABASE_URL → Save & redeploy. ` +
          `If the database was deleted (free tier expiry), create a new Postgres and link it.`
      );
    }
    throw err;
  }
}

async function ensureSession(sessionId) {
  await getPool().query(
    `INSERT INTO workspace_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [sessionId]
  );
}

module.exports = { getPool, initDb, ensureSession };
