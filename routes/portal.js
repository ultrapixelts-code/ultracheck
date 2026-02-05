// src/routes/portal.js
// Router completo per /portal (ESM) — include: login/logout, dashboard, orders, files, quote, confirm
// IMPORTANTE: non usa più :id(\d+) perché nel tuo deploy rompe path-to-regexp.

import express, { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import { pool } from "../db.js";

console.log("✅ portalRouter LOADED (full)");

const router = Router();

/* ────────────────────────────────────────────────
   MULTER (upload in RAM) + filtro mimetype
──────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/zip",
      "application/x-rar-compressed",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Formato non supportato. Ammessi: PDF, JPG, PNG, WEBP, ZIP, RAR"));
  },
});

/* ────────────────────────────────────────────────
   AUTH MIDDLEWARE
──────────────────────────────────────────────── */
function requireLogin(req, res, next) {
  if (!req.session?.user) {
    const redirectTo = encodeURIComponent(req.originalUrl || "/portal");
    return res.redirect(`/portal/login?redirect=${redirectTo}`);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === "admin") return next();
  return res.status(403).send("Accesso negato – solo amministratori");
}

/* ────────────────────────────────────────────────
   HELPERS
──────────────────────────────────────────────── */
async function getOrderOr403(orderId, user, client = pool) {
  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    return { ok: false, status: 400, message: "ID ordine non valido", order: null };
  }

  const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [orderId]);
  const order = rows[0];
  if (!order) return { ok: false, status: 404, message: "Ordine non trovato", order: null };

  if (user.role !== "admin" && Number(order.dealer_user_id) !== Number(user.id)) {
    return { ok: false, status: 403, message: "Non autorizzato", order: null };
  }

  return { ok: true, status: 200, message: null, order };
}

function safeFilename(name) {
  return String(name || "document")
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 180);
}

function normalizeKind(kindRaw) {
  const kind = String(kindRaw || "GENERIC").toUpperCase().trim();
  const allowed = new Set(["GENERIC", "ARTWORK", "BRIEF", "PROOF_ADMIN", "DEALER_LOGO"]);
  return allowed.has(kind) ? kind : "GENERIC";
}

/* ────────────────────────────────────────────────
   PING (debug)
──────────────────────────────────────────────── */
router.get("/__ping", (req, res) => res.send("PORTAL OK"));

/* ────────────────────────────────────────────────
   DASHBOARD
──────────────────────────────────────────────── */
router.get("/", requireLogin, (req, res) => {
  res.render("portal/dashboard", { user: req.session.user });
});

/* ────────────────────────────────────────────────
   LOGIN / LOGOUT
──────────────────────────────────────────────── */
router.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/portal");
  res.render("portal/login", { error: null });
});

router.post("/login", express.urlencoded({ extended: true }), async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password) {
    return res.render("portal/login", { error: "Email e password obbligatorie" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, role, dealer_name, is_active
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email]
    );

    const user = rows[0];
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
      dealerName: user.dealer_name,
    };

    // redirect dopo login
    const redirectTo = String(req.query.redirect || "").trim();
    if (redirectTo && redirectTo.startsWith("/portal")) return res.redirect(redirectTo);
    return res.redirect("/portal");
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.render("portal/login", { error: "Errore server, riprova" });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/portal/login"));
});

/* ────────────────────────────────────────────────
   ORDERS LIST
──────────────────────────────────────────────── */
router.get("/orders", requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    const isAdmin = user.role === "admin";
    const query = isAdmin
      ? `SELECT o.*, u.dealer_name, u.email
         FROM orders o
         JOIN users u ON u.id = o.dealer_user_id
         ORDER BY o.created_at DESC
         LIMIT 200`
      : `SELECT *
         FROM orders
         WHERE dealer_user_id = $1
         ORDER BY created_at DESC
         LIMIT 200`;

    const params = isAdmin ? [] : [user.id];
    const { rows: orders } = await pool.query(query, params);

    res.render("portal/orders/index", { user, orders });
  } catch (err) {
    console.error("Errore caricamento lista ordini:", err);
    res.status(500).render("portal/error", { user, message: "Impossibile caricare gli ordini" });
  }
});

/* ────────────────────────────────────────────────
   NEW ORDER FORM
──────────────────────────────────────────────── */
router.get("/orders/new", requireLogin, (req, res) => {
  res.render("portal/orders/new", { user: req.session.user, error: null });
});

/* ────────────────────────────────────────────────
   CREATE ORDER
──────────────────────────────────────────────── */
router.post("/orders", requireLogin, express.urlencoded({ extended: true }), async (req, res) => {
  const user = req.session.user;
  const title = String(req.body.title || "").trim();
  const notes_dealer = String(req.body.notes_dealer || "").trim() || null;

  if (!title) {
    return res.render("portal/orders/new", { user, error: "Il titolo è obbligatorio" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO orders (dealer_user_id, title, status, notes_dealer, created_at, updated_at)
       VALUES ($1, $2, 'RFQ', $3, NOW(), NOW())
       RETURNING id`,
      [user.id, title, notes_dealer]
    );

    const orderId = rows[0].id;

    await client.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
      [orderId, user.id, JSON.stringify({ from: null, to: "RFQ" })]
    );

    await client.query("COMMIT");
    res.redirect(`/portal/orders/${orderId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Errore creazione ordine:", err);
    res.render("portal/orders/new", { user, error: "Errore durante la creazione dell'ordine" });
  } finally {
    client.release();
  }
});

/* ────────────────────────────────────────────────
   ORDER DETAIL
──────────────────────────────────────────────── */
router.get("/orders/:id", requireLogin, async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  try {
    const check = await getOrderOr403(orderId, user, pool);
    if (!check.ok) return res.status(check.status).send(check.message);
    const order = check.order;

    const [filesRes, eventsRes, quoteRes] = await Promise.all([
      pool.query(
        `SELECT id, original_name, mime_type, size_bytes, created_at, kind
         FROM order_files
         WHERE order_id = $1
         ORDER BY created_at DESC`,
        [orderId]
      ),
      pool.query(
        `SELECT e.*, u.email
         FROM order_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.order_id = $1
         ORDER BY e.created_at DESC
         LIMIT 200`,
        [orderId]
      ),
      pool.query(`SELECT * FROM quotes WHERE order_id = $1 LIMIT 1`, [orderId]).catch(() => ({ rows: [] })),
    ]);

    res.render("portal/orders/show", {
      user,
      order,
      files: filesRes.rows,
      events: eventsRes.rows,
      quote: quoteRes.rows[0] || null,
      proofs: [],
    });
  } catch (err) {
    console.error("Errore caricamento dettaglio ordine:", err);
    res.status(500).send("Errore durante il caricamento dei dati");
  }
});

/* ────────────────────────────────────────────────
   UPLOAD FILE (GENERIC / ARTWORK / BRIEF / PROOF_ADMIN / DEALER_LOGO)
   form field:
   - file: il file
   - kind: opzionale (string)
──────────────────────────────────────────────── */
router.post("/orders/:id/files", requireLogin, upload.single("file"), async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  try {
    const check = await getOrderOr403(orderId, user, pool);
    if (!check.ok) return res.status(check.status).send(check.message);

    if (!req.file) return res.status(400).send("Nessun file caricato");

    const kind = normalizeKind(req.body.kind);
    const { originalname, mimetype, size, buffer } = req.file;

    await pool.query(
      `INSERT INTO order_files (order_id, uploader_user_id, original_name, mime_type, size_bytes, content, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orderId, user.id, originalname, mimetype, size, buffer, kind]
    );

    await pool.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'FILE_UPLOADED', $3, NOW())`,
      [orderId, user.id, JSON.stringify({ name: originalname, size_bytes: size, kind })]
    );

    res.redirect(`/portal/orders/${orderId}`);
  } catch (err) {
    console.error("Errore upload file:", err);
    res.status(500).send("Errore durante il caricamento del file");
  }
});

/* ────────────────────────────────────────────────
   VIEW / DOWNLOAD FILE
──────────────────────────────────────────────── */
router.get("/files/:id", requireLogin, async (req, res) => {
  const user = req.session.user;
  const fileId = Number(req.params.id);

  if (!Number.isSafeInteger(fileId) || fileId < 1) {
    return res.status(400).send("ID file non valido");
  }

  try {
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

    const filename = safeFilename(file.original_name);

    res.set({
      "Content-Type": file.mime_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": file.size_bytes ?? undefined,
    });

    res.send(file.content);
  } catch (err) {
    console.error("Errore recupero file:", err);
    res.status(500).send("Errore durante il recupero del file");
  }
});

/* ────────────────────────────────────────────────
   SEND QUOTE (admin)
   POST /portal/orders/:id/quote
   body: price_total, lead_time_days
──────────────────────────────────────────────── */
router.post(
  "/orders/:id/quote",
  requireLogin,
  requireAdmin,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const orderId = Number(req.params.id);
    const price_total = Number(req.body.price_total);
    const lead_time_days = Number(req.body.lead_time_days);

    if (!Number.isSafeInteger(orderId) || orderId < 1) return res.status(400).send("ID ordine non valido");
    if (!Number.isFinite(price_total) || price_total <= 0) return res.status(400).send("Prezzo totale non valido (> 0)");
    if (!Number.isSafeInteger(lead_time_days) || lead_time_days < 1) return res.status(400).send("Lead time non valido (>=1)");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Leggi stato reale
      const { rows: oRows } = await client.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
      if (oRows.length === 0) throw new Error("Ordine non trovato");
      const fromStatus = oRows[0].status;

      // Blocca subito se non è RFQ
      if (fromStatus !== "RFQ") {
        throw new Error(`Impossibile quotare: ordine non in stato RFQ (attuale: ${fromStatus})`);
      }

      // Salva/aggiorna preventivo (1 sola quote per ordine)
      await client.query(
        `INSERT INTO quotes (order_id, price_total, lead_time_days, sent_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (order_id) DO UPDATE SET
           price_total    = EXCLUDED.price_total,
           lead_time_days = EXCLUDED.lead_time_days,
           sent_at        = NOW()`,
        [orderId, price_total, lead_time_days]
      );

      // Aggiorna stato ordine
      const { rowCount } = await client.query(
        `UPDATE orders
         SET status = 'QUOTED', updated_at = NOW()
         WHERE id = $1 AND status = 'RFQ'`,
        [orderId]
      );
      if (rowCount === 0) throw new Error("Impossibile aggiornare stato ordine (possibile race condition)");

      // Eventi
      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'QUOTE_SENT', $3, NOW())`,
        [orderId, req.session.user.id, JSON.stringify({ price_total, lead_time_days })]
      );

      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
        [orderId, req.session.user.id, JSON.stringify({ from: fromStatus, to: "QUOTED" })]
      );

      await client.query("COMMIT");
      res.redirect(`/portal/orders/${orderId}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Errore invio preventivo:", err);
      res.status(400).send(err.message || "Errore durante l'invio del preventivo");
    } finally {
      client.release();
    }
  }
);

/* ────────────────────────────────────────────────
   CONFIRM QUOTE (dealer)
   POST /portal/orders/:id/confirm
──────────────────────────────────────────────── */
router.post("/orders/:id/confirm", requireLogin, async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const check = await getOrderOr403(orderId, user, client);
    if (!check.ok) {
      await client.query("ROLLBACK");
      return res.status(check.status).send(check.message);
    }

    const order = check.order;
    if (order.status !== "QUOTED") {
      await client.query("ROLLBACK");
      return res.status(400).send("Ordine non in stato QUOTED → impossibile confermare");
    }

    const { rowCount } = await client.query(
      `UPDATE orders
       SET status = 'PRICE_APPROVED', updated_at = NOW()
       WHERE id = $1 AND status = 'QUOTED'`,
      [orderId]
    );

    if (rowCount === 0) throw new Error("Conferma fallita: stato cambiato nel frattempo");

    await client.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
      [orderId, user.id, JSON.stringify({ from: "QUOTED", to: "PRICE_APPROVED" })]
    );

    await client.query("COMMIT");
    res.redirect(`/portal/orders/${orderId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Errore conferma preventivo:", err);
    res.status(500).send("Errore durante la conferma");
  } finally {
    client.release();
  }
});

export default router;
