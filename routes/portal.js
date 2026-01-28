import express from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";


console.log("✅ portalRouter LOADED");

const router = express.Router();

// --- middleware auth ---
function requireLogin(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect("/portal/login");
}

// --- LOGIN PAGE ---
router.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/portal");
  res.render("portal/login", { error: null });
});

// --- LOGIN SUBMIT ---
router.post("/login", express.urlencoded({ extended: true }), async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      `select id, email, password_hash, role, dealer_name, is_active
       from users
       where email = $1
       limit 1`,
      [email.toLowerCase().trim()]
    );

    const user = result.rows[0];

    if (!user || !user.is_active) {
      return res.render("portal/login", {
        error: "Credenziali non valide"
      });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.render("portal/login", {
        error: "Credenziali non valide"
      });
    }

    // ✅ sessione
    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      dealerName: user.dealer_name
    };

    return res.redirect("/portal");
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.render("portal/login", {
      error: "Errore server, riprova"
    });
  }
});

// --- LOGOUT ---
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/portal/login");
  });
});

// --- DASHBOARD (PROTETTA) ---
router.get("/", requireLogin, (req, res) => {
  res.render("portal/dashboard", {
    user: req.session.user
  });
});

export default router;
