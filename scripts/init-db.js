import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  try {
    console.log("🔌 Connessione al DB...");

    await pool.query(`
      create table if not exists sessions (
        sid varchar not null primary key,
        sess json not null,
        expire timestamptz not null
      );
    `);

    await pool.query(`
      create index if not exists idx_sessions_expire
      on sessions(expire);
    `);

    await pool.query(`
      create table if not exists users (
        id bigserial primary key,
        email text unique not null,
        password_hash text not null,
        role text not null default 'dealer',
        dealer_name text,
        is_active boolean not null default true,
        created_at timestamptz not null default now()
      );
    `);

    console.log("✅ Tabelle create con successo");
  } catch (err) {
    console.error("❌ Errore:", err);
  } finally {
    await pool.end();
  }
}

init();
