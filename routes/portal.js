import express from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import multer from "multer";

console.log("✅ portalRouter LOADED");

const router = express.Router();

// Configurazione Multer (una sola volta, fuori dalle route)
const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// ────────────────────────────────────────────────
// Middleware di autenticazione
// ────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect("/portal/login");
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === "admin") return next();
  return res.status(403).send("Forbidden");
}

async function getOrderOr403(orderId, user) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 LIMIT 1`,
    [orderId]
  );
  const order = rows[0];

  if (!order) {
    return { order: null, forbidden: false, notFound: true };
  }

  // Solo admin o il dealer proprietario vede l'ordine
  if (user.role !== "admin" && Number(order.dealer_user_id) !== Number(user.id)) {
    return { order, forbidden: true, notFound: false };
  }

  return { order, forbidden: false, notFound: false };
}

// ────────────────────────────────────────────────
// LISTA ORDINI
// ────────────────────────────────────────────────
router.get("/orders", requireLogin, async (req, res) => {
  const user = req.session.user;

  const q = user.role === "admin"
    ? `SELECT o.*, u.dealer_name, u.email
       FROM orders o
       JOIN users u ON u.id = o.dealer_user_id
       ORDER BY o.created_at DESC
       LIMIT 200`
    : `SELECT o.*
       FROM orders o
       WHERE o.dealer_user_id = $1
       ORDER BY o.created_at DESC
       LIMIT 200`;

  const params = user.role === "admin" ? [] : [user.id];
  const { rows: orders } = await pool.query(q, params);

  res.render("portal/orders/index", { user, orders });
});

// ────────────────────────────────────────────────
// FORM NUOVO ORDINE
// ────────────────────────────────────────────────
router.get("/orders/new", requireLogin, (req, res) => {
  res.render("portal/orders/new", { user: req.session.user, error: null });
});

// ────────────────────────────────────────────────
// CREA ORDINE
// ────────────────────────────────────────────────
router.post("/orders", requireLogin, express.urlencoded({ extended: true }), async (req, res) => {
  const user = req.session.user;
  const { title, notes_dealer } = req.body;

  if (!title?.trim()) {
    return res.render("portal/orders/new", { user, error: "Inserisci un titolo" });
  }

  const { rows } = await pool.query(
    `INSERT INTO orders (dealer_user_id, title, status, notes_dealer, created_at, updated_at)
     VALUES ($1, $2, 'pricing', $3, NOW(), NOW())
     RETURNING id`,
    [user.id, title.trim(), notes_dealer || null]
  );

  const orderId = rows[0].id;

  // Registra evento creazione
  await pool.query(
    `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
     VALUES ($1, $2, 'ORDER_CREATED', $3, NOW())`,
    [orderId, user.id, JSON.stringify({ title: title.trim() })]
  );

  res.redirect(`/portal/orders/${orderId}`);
});

// ────────────────────────────────────────────────
// DETTAGLIO ORDINE
// ────────────────────────────────────────────────
router.get("/orders/:id", requireLogin, async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).send("ID ordine non valido");
  }

  const { order, forbidden, notFound } = await getOrderOr403(orderId, user);
  if (notFound) return res.status(404).send("Ordine non trovato");
  if (forbidden) return res.status(403).send("Non autorizzato");

  const { rows: files } = await pool.query(
    `SELECT * FROM order_files WHERE order_id = $1 ORDER BY created_at DESC`,
    [orderId]
  );

  // Temporaneamente disabilitate perché le tabelle quotes e proofs non esistono ancora
  // const { rows: quoteRows } = await pool.query(`SELECT * FROM quotes WHERE order_id = $1 LIMIT 1`, [orderId]);
  // const quote = quoteRows[0] || null;

  // const { rows: proofRows } = await pool.query(
  //   `SELECT * FROM proofs WHERE order_id = $1 ORDER BY version DESC`,
  //   [orderId]
  // );

  const quote = null;
  const proofRows = [];

  const { rows: events } = await pool.query(
    `SELECT e.*, u.email
     FROM order_events e
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.order_id = $1
     ORDER BY e.created_at DESC
     LIMIT 200`,
    [orderId]
  );

  res.render("portal/orders/show", {
    user,
    order,
    files,
    quote,
    proofs: proofRows,
    events
  });
});

// ────────────────────────────────────────────────
// CARICA FILE NELL'ORDINE
// ────────────────────────────────────────────────
router.post("/orders/:id/files", requireLogin, uploadMem.single("file"), async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).send("ID ordine non valido");
  }

  const { order, forbidden, notFound } = await getOrderOr403(orderId, user);
  if (notFound) return res.status(404).send("Ordine non trovato");
  if (forbidden) return res.status(403).send("Non autorizzato");

  if (!req.file) {
    return res.status(400).send("Nessun file caricato");
  }

  const { originalname, mimetype, size, buffer } = req.file;

  await pool.query(
    `INSERT INTO order_files (order_id, uploader_user_id, original_name, mime_type, size_bytes, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, user.id, originalname, mimetype, size, buffer]
  );

  await pool.query(
    `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
     VALUES ($1, $2, 'FILE_UPLOADED', $3, NOW())`,
    [orderId, user.id, JSON.stringify({ original_name: originalname, size_bytes: size })]
  );

  res.redirect(`/portal/orders/${orderId}`);
});

// ────────────────────────────────────────────────
// VISUALIZZA / SCARICA FILE
// ────────────────────────────────────────────────
router.get("/files/:fileId", requireLogin, async (req, res) => {
  const user = req.session.user;
  const fileId = Number(req.params.fileId);

  if (!Number.isInteger(fileId) || fileId <= 0) {
    return res.status(400).send("ID file non valido");
  }

  const { rows } = await pool.query(
    `SELECT f.*, o.dealer_user_id
     FROM order_files f
     JOIN orders o ON o.id = f.order_id
     WHERE f.id = $1
     LIMIT 1`,
    [fileId]
  );

  const file = rows[0];
  if (!file) return res.status(404).send("File non trovato");

  if (user.role !== "admin" && Number(file.dealer_user_id) !== Number(user.id)) {
    return res.status(403).send("Non autorizzato");
  }

  const safeName = String(file.original_name || "documento").replace(/"/g, "");

  res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
  res.send(file.content);
});

// ────────────────────────────────────────────────
// INVIA PREVENTIVO (solo admin)
// ────────────────────────────────────────────────
router.post("/orders/:id/quote", requireLogin, requireAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  const orderId = Number(req.params.id);
  const { price_total, lead_time_days } = req.body;

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).send("ID ordine non valido");
  }

  await pool.query(
    `INSERT INTO quotes (order_id, price_total, lead_time_days, sent_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (order_id) DO UPDATE
     SET price_total = EXCLUDED.price_total,
         lead_time_days = EXCLUDED.lead_time_days,
         sent_at = NOW()`,
    [orderId, price_total || null, lead_time_days || null]
  );

  await pool.query(`UPDATE orders SET status = 'quoted', updated_at = NOW() WHERE id = $1`, [orderId]);

  await pool.query(
    `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
     VALUES ($1, $2, 'QUOTE_SENT', $3, NOW())`,
    [orderId, req.session.user.id, JSON.stringify({ price_total, lead_time_days })]
  );

  res.redirect(`/portal/orders/${orderId}`);
});

// ────────────────────────────────────────────────
// CONFERMA PREVENTIVO (dealer)
// ────────────────────────────────────────────────
router.post("/orders/:id/confirm", requireLogin, async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).send("ID ordine non valido");
  }

  const { order, forbidden, notFound } = await getOrderOr403(orderId, user);
  if (notFound) return res.status(404).send("Ordine non trovato");
  if (forbidden) return res.status(403).send("Non autorizzato");
  if (order.status !== "quoted") return res.status(400).send("Stato non valido per conferma");

  await pool.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [orderId]);
  await pool.query(`UPDATE quotes SET accepted_at = NOW() WHERE order_id = $1`, [orderId]);

  await pool.query(
    `INSERT INTO order_events (order_id, actor_user_id, type, created_at)
     VALUES ($1, $2, 'QUOTE_ACCEPTED', NOW())`,
    [orderId, user.id]
  );

  res.redirect(`/portal/orders/${orderId}`);
});

// ────────────────────────────────────────────────
// LOGIN
// ────────────────────────────────────────────────
router.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/portal");
  res.render("portal/login", { error: null });
});

router.post("/login", express.urlencoded({ extended: true }), async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      `SELECT id, email, password_hash, role, dealer_name, is_active
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    const user = result.rows[0];

    if (!user || !user.is_active) {
      return res.render("portal/login", { error: "Credenziali non valide" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.render("portal/login", { error: "Credenziali non valide" });
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      dealerName: user.dealer_name
    };

    return res.redirect("/portal");
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.render("portal/login", { error: "Errore server, riprova" });
  }
});

// ────────────────────────────────────────────────
// LOGOUT
// ────────────────────────────────────────────────
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/portal/login");
  });
});

// ────────────────────────────────────────────────
// DASHBOARD
// ────────────────────────────────────────────────
router.get("/", requireLogin, (req, res) => {
  res.render("portal/dashboard", {
    user: req.session.user
  });
});

export default router;
