import { pool } from "../db.js";

async function migrate() {
  console.log("🚀 Running DB migration (files)...");

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

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_files_order ON order_files(order_id);`);

  console.log("✅ Migration completed (files)");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("❌ Migration failed (files):", err);
  process.exit(1);
});
EOF
