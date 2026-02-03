import { pool } from "../db.js";

async function migrate() {
  console.log("🚀 Running DB migration...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id             BIGSERIAL PRIMARY KEY,
      dealer_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title          TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pricing',
      notes_dealer   TEXT,
      notes_admin    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_events (
      id            BIGSERIAL PRIMARY KEY,
      order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      actor_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      type          TEXT NOT NULL,
      payload_json  JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("✅ Migration completed");
  process.exit(0);
}

migrate().catch(err => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
