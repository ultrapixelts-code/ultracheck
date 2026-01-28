import bcrypt from "bcryptjs";
import { pool } from "../src/db.js";

const email = process.argv[2];
const password = process.argv[3];
const dealerName = process.argv[4] || "Admin";

if (!email || !password) {
  console.error("Usage: node create-admin.js <email> <password> [dealerName]");
  process.exit(1);
}

(async () => {
  try {
    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO users (email, password_hash, role, dealer_name, is_active)
      VALUES ($1, $2, 'admin', $3, true)
      ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          role = 'admin',
          dealer_name = EXCLUDED.dealer_name,
          is_active = true
      `,
      [email.toLowerCase().trim(), hash, dealerName]
    );

    console.log("✅ Admin creato/aggiornato:", email);
    process.exit(0);
  } catch (err) {
    console.error("❌ Errore create-admin:", err);
    process.exit(1);
  }
})();
