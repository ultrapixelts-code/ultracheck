import bcrypt from "bcrypt";
import { pool } from "../db.js";

const email = process.argv[2];
const password = process.argv[3];
const dealerName = process.argv[4] || "UltraPixel";

if (!email || !password) {
  console.log('Usage: node scripts/create-admin.js "email" "password" ["dealerName"]');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);

await pool.query(
  `insert into users (email, password_hash, role, dealer_name)
   values ($1, $2, 'admin', $3)
   on conflict (email) do update
   set password_hash = excluded.password_hash,
       role = excluded.role,
       dealer_name = excluded.dealer_name,
       is_active = true`,
[email.toLowerCase().trim(), hash, dealerName]

