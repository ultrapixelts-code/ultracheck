import { pool } from "../db.js";

export async function migrateFilesAndQuotes() {
  console.log("🚀 Running DB migration (files + quotes)...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_files (
      id               BIGSERIAL PRIMARY KEY,
      order_id         BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      uploader_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      original_name    TEXT NOT NULL,
      mime_type        TEXT,
      size_bytes       BIGINT,
      content          BYTEA NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_files_order
    ON order_files(order_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotes (
      order_id       BIGINT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      price_total    NUMERIC(12,2),
      lead_time_days INT,
      sent_at        TIMESTAMPTZ,
      accepted_at    TIMESTAMPTZ
    );
  `);

  console.log("✅ Migration completed (files + quotes)");
}
