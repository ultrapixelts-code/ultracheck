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
router.get("/", requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    const isAdmin = user.role === "admin";

    const ordersQuery = isAdmin
      ? `SELECT o.*, u.dealer_name, u.email
         FROM orders o
         JOIN users u ON u.id = o.dealer_user_id
         ORDER BY o.updated_at DESC
         LIMIT 20`
      : `SELECT *
         FROM orders
         WHERE dealer_user_id = $1
         ORDER BY updated_at DESC
         LIMIT 20`;

    const ordersParams = isAdmin ? [] : [user.id];

    const { rows: recentOrders } = await pool.query(ordersQuery, ordersParams);

    const statsQuery = isAdmin
      ? `SELECT status, COUNT(*)::int AS count
         FROM orders
         GROUP BY status`
      : `SELECT status, COUNT(*)::int AS count
         FROM orders
         WHERE dealer_user_id = $1
         GROUP BY status`;

    const { rows: statsRows } = await pool.query(statsQuery, ordersParams);

    const stats = {};
    for (const row of statsRows) {
      stats[row.status] = row.count;
    }

    res.render("portal/dashboard", {
      user,
      recentOrders,
      stats,
    });
  } catch (err) {
    console.error("Errore dashboard:", err);
    res.status(500).render("portal/error", {
      user,
      message: "Impossibile caricare la dashboard",
    });
  }
});
/* ────────────────────────────────────────────────
   LOGIN / LOGOUT
──────────────────────────────────────────────── */
router.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/portal");
  res.render("portal/login", { error: null });
});

router.post("/login", express.urlencoded({ extended: true }), async (req, res) => {
   console.log("LOGIN BODY:", req.body);
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
router.post("/orders", requireLogin, (req, res) => {
  upload.array("files", 10)(req, res, async (err) => {
    const user = req.session.user;

    if (err) {
      return res.render("portal/orders/new", {
        user,
        error: err.message || "Errore upload file",
      });
    }

    const title = String(req.body.title || "").trim();
    const customer_name = String(req.body.customer_name || "").trim();
    const customer_email = String(req.body.customer_email || "").trim() || null;
    const product_name = String(req.body.product_name || "").trim();
    const quantity_options = String(req.body.quantity_options || "").trim();
    const variants = String(req.body.variants || "").trim() || null;

    const width_mm = req.body.width_mm ? Number(req.body.width_mm) : null;
    const height_mm = req.body.height_mm ? Number(req.body.height_mm) : null;

    const material = String(req.body.material || "").trim() || null;
    const adhesive = String(req.body.adhesive || "").trim() || null;
    const colors = String(req.body.colors || "").trim() || null;
    const core_mm = req.body.core_mm ? Number(req.body.core_mm) : null;
    const unwind_direction = String(req.body.unwind_direction || "").trim() || null;
    const application_type = String(req.body.application_type || "").trim() || null;
    const variable_data = req.body.variable_data === "true";
    const urgent = req.body.urgent === "true";
    const notes_dealer = String(req.body.notes_dealer || "").trim() || null;

    const finishingOptionsRaw = req.body.finishing_options;
    const finishingOptions = Array.isArray(finishingOptionsRaw)
      ? finishingOptionsRaw
      : finishingOptionsRaw
        ? [finishingOptionsRaw]
        : [];

    const hotfoil_count = req.body.hotfoil_count ? Number(req.body.hotfoil_count) : 0;
    const hotfoil_colors = String(req.body.hotfoil_colors || "").trim();

    const finishingParts = [...finishingOptions];

    if (hotfoil_count > 0) {
      finishingParts.push(
        `${hotfoil_count} stampa${hotfoil_count > 1 ? "e" : ""} a caldo${hotfoil_colors ? ` (${hotfoil_colors})` : ""}`
      );
    }

    const finishing = finishingParts.length ? finishingParts.join(", ") : null;

    if (!title || !customer_name || !product_name || !width_mm || !height_mm || !quantity_options) {
      return res.render("portal/orders/new", {
        user,
        error: "Compila tutti i campi obbligatori",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO orders (
          dealer_user_id,
          title,
          status,
          notes_dealer,
          customer_name,
          customer_email,
          product_name,
          width_mm,
          height_mm,
          material,
          adhesive,
          colors,
          finishing,
          quantity_options,
          variants,
          core_mm,
          unwind_direction,
          application_type,
          variable_data,
          urgent,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, 'RFQ', $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), NOW()
        )
        RETURNING id`,
        [
          user.id,
          title,
          notes_dealer,
          customer_name,
          customer_email,
          product_name,
          width_mm,
          height_mm,
          material,
          adhesive,
          colors,
          finishing,
          quantity_options,
          variants,
          core_mm,
          unwind_direction,
          application_type,
          variable_data,
          urgent,
        ]
      );

      const orderId = rows[0].id;
      const uploadedFiles = req.files || [];

      for (const file of uploadedFiles) {
        await client.query(
          `INSERT INTO order_files (
            order_id,
            uploader_user_id,
            original_name,
            mime_type,
            size_bytes,
            content,
            kind
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'ARTWORK')`,
          [
            orderId,
            user.id,
            file.originalname,
            file.mimetype,
            file.size,
            file.buffer,
          ]
        );
      }

      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
        [orderId, user.id, JSON.stringify({ from: null, to: "RFQ" })]
      );

      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'RFQ_CREATED', $3, NOW())`,
        [
          orderId,
          user.id,
          JSON.stringify({
            customer_name,
            product_name,
            width_mm,
            height_mm,
            quantity_options,
            variants,
            material,
            adhesive,
            colors,
            finishing,
            core_mm,
            unwind_direction,
            application_type,
            variable_data,
            urgent,
            files_count: uploadedFiles.length,
          }),
        ]
      );

      if (uploadedFiles.length > 0) {
        await client.query(
          `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
           VALUES ($1, $2, 'FILES_UPLOADED', $3, NOW())`,
          [
            orderId,
            user.id,
            JSON.stringify({
              count: uploadedFiles.length,
              files: uploadedFiles.map(f => ({
                name: f.originalname,
                size_bytes: f.size,
                mime_type: f.mimetype,
              })),
            }),
          ]
        );
      }

      await client.query("COMMIT");
      return res.redirect(`/portal/orders/${orderId}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Errore creazione ordine:", err);

      return res.render("portal/orders/new", {
        user,
        error: "Errore durante la creazione dell'ordine",
      });
    } finally {
      client.release();
    }
  });
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
router.post("/orders/:id/files", requireLogin, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    const user = req.session.user;
    const orderId = Number(req.params.id);

    if (err) return res.status(400).send(err.message || "Errore upload");
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

      return res.redirect(`/portal/orders/${orderId}`);
    } catch (e) {
      console.error("Errore upload file:", e);
      return res.status(500).send("Errore durante il caricamento del file");
    }
  });
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
  `SELECT f.*, 
          o.dealer_user_id,
          o.status AS order_status
   FROM order_files f
   JOIN orders o ON o.id = f.order_id
   WHERE f.id = $1
   LIMIT 1`,
  [fileId]
);


    const file = rows[0];
     const orderStatus = String(file.order_status || "").trim();

    if (!file) return res.status(404).send("File non trovato");

    if (user.role !== "admin" && Number(file.dealer_user_id) !== Number(user.id)) {
      return res.status(403).send("Non autorizzato");
    }
const canSeeProof =
  user.role === "admin" ||
  ["PROOF_SENT", "PROOF_APPROVED", "PROOF_CHANGES_REQUESTED"].includes(orderStatus);

if (file.kind === "PROOF_ADMIN" && !canSeeProof) {
  return res.status(403).send("Bozza non ancora disponibile");
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
   PROOF FLOW
   - Admin carica bozza PDF → status PROOF_SENT (file salvato come PROOF_ADMIN)
   - Dealer approva → status PROOF_APPROVED
   - Dealer richiede modifiche → status PROOF_CHANGES_REQUESTED (+ note)
──────────────────────────────────────────────── */

// Admin: carica bozza (PDF) e invia
router.post(
  "/orders/:id/proof",
  requireLogin,
  requireAdmin,
  (req, res) => {
    // wrapper per catturare errori multer (tipo mimetype non supportato)
    upload.single("file")(req, res, async (err) => {
      const orderId = Number(req.params.id);

      if (err) return res.status(400).send(err.message || "Errore upload");
      if (!req.file) return res.status(400).send("Nessun file caricato");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows } = await client.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
        if (rows.length === 0) throw new Error("Ordine non trovato");
        const fromStatus = rows[0].status;

        // Consentiamo invio proof solo da PRICE_APPROVED o PROOF_CHANGES_REQUESTED
        if (!["PRICE_APPROVED", "PROOF_CHANGES_REQUESTED"].includes(fromStatus)) {
          throw new Error(`Impossibile inviare bozza: stato attuale = ${fromStatus}`);
        }

        const { originalname, mimetype, size, buffer } = req.file;

        // extra safety: bozza solo PDF (anche se multer già filtra)
        if (mimetype !== "application/pdf") throw new Error("La bozza deve essere un PDF");

        // salva come PROOF_ADMIN
        await client.query(
          `INSERT INTO order_files (order_id, uploader_user_id, original_name, mime_type, size_bytes, content, kind)
           VALUES ($1, $2, $3, $4, $5, $6, 'PROOF_ADMIN')`,
          [orderId, req.session.user.id, originalname, mimetype, size, buffer]
        );

        // aggiorna stato
        await client.query(
          `UPDATE orders SET status='PROOF_SENT', updated_at=NOW() WHERE id=$1`,
          [orderId]
        );

        // eventi
        await client.query(
          `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
           VALUES ($1, $2, 'PROOF_SENT', $3, NOW())`,
          [orderId, req.session.user.id, JSON.stringify({ file: originalname })]
        );

        await client.query(
          `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
           VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
          [orderId, req.session.user.id, JSON.stringify({ from: fromStatus, to: "PROOF_SENT" })]
        );

        await client.query("COMMIT");
        return res.redirect(`/portal/orders/${orderId}`);
      } catch (e) {
        await client.query("ROLLBACK");
        console.error("PROOF upload error:", e);
        return res.status(400).send(e.message || "Errore invio bozza");
      } finally {
        client.release();
      }
    });
  }
);

// Dealer: approva bozza
router.post("/orders/:id/proof/approve", requireLogin, async (req, res) => {
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

    if (check.order.status !== "PROOF_SENT") {
      await client.query("ROLLBACK");
      return res.status(400).send("Ordine non in stato PROOF_SENT → impossibile approvare");
    }

    const { rowCount } = await client.query(
      `UPDATE orders SET status='PROOF_APPROVED', updated_at=NOW()
       WHERE id=$1 AND status='PROOF_SENT'`,
      [orderId]
    );
    if (rowCount === 0) throw new Error("Approvazione fallita: stato cambiato nel frattempo");

    await client.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
      [orderId, user.id, JSON.stringify({ from: "PROOF_SENT", to: "PROOF_APPROVED" })]
    );

    await client.query("COMMIT");
    return res.redirect(`/portal/orders/${orderId}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("PROOF approve error:", e);
    return res.status(500).send("Errore durante approvazione bozza");
  } finally {
    client.release();
  }
});

// Dealer: richiede modifiche
router.post(
  "/orders/:id/proof/changes",
  requireLogin,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const user = req.session.user;
    const orderId = Number(req.params.id);
    const note = String(req.body.note || "").trim() || null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const check = await getOrderOr403(orderId, user, client);
      if (!check.ok) {
        await client.query("ROLLBACK");
        return res.status(check.status).send(check.message);
      }

      if (check.order.status !== "PROOF_SENT") {
        await client.query("ROLLBACK");
        return res.status(400).send("Ordine non in stato PROOF_SENT → impossibile chiedere modifiche");
      }

      const { rowCount } = await client.query(
        `UPDATE orders SET status='PROOF_CHANGES_REQUESTED', updated_at=NOW()
         WHERE id=$1 AND status='PROOF_SENT'`,
        [orderId]
      );
      if (rowCount === 0) throw new Error("Richiesta modifiche fallita: stato cambiato nel frattempo");

      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'PROOF_CHANGES_REQUESTED', $3, NOW())`,
        [orderId, user.id, JSON.stringify({ note })]
      );

      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
        [orderId, user.id, JSON.stringify({ from: "PROOF_SENT", to: "PROOF_CHANGES_REQUESTED" })]
      );

      await client.query("COMMIT");
      return res.redirect(`/portal/orders/${orderId}`);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("PROOF changes error:", e);
      return res.status(500).send("Errore durante richiesta modifiche");
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
     
    // Leggi il preventivo (quote) e prenditi il prezzo
    const { rows: qRows } = await client.query(
      `SELECT price_total, lead_time_days
       FROM quotes
       WHERE order_id = $1
       LIMIT 1`,
      [orderId]
    );

    if (qRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).send("Nessun preventivo trovato per questo ordine");
    }

    const { price_total, lead_time_days } = qRows[0];

    // 1) aggiorna ordine e "congela" il prezzo approvato
    const { rowCount } = await client.query(
      `UPDATE orders
       SET status = 'PRICE_APPROVED',
           price_approved = $2,
           approved_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'QUOTED'`,
      [orderId, price_total]
    );

    if (rowCount === 0) throw new Error("Conferma fallita: stato cambiato nel frattempo");

    // 2) eventi SOLO dopo update riuscito
    await client.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'PRICE_APPROVED', $3, NOW())`,
      [orderId, user.id, JSON.stringify({ price_total, lead_time_days })]
    );

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

router.post(
  "/dealers/:id/logo",
  requireLogin,
  requireAdmin,
  (req, res) => {
    upload.single("file")(req, res, async (err) => {
      if (err) return res.status(400).send(err.message || "Errore upload");
      if (!req.file) return res.status(400).send("Nessun file caricato");

      const dealerId = Number(req.params.id);
      if (!Number.isSafeInteger(dealerId) || dealerId < 1) return res.status(400).send("Dealer ID non valido");

      // accettiamo solo immagini
      const okMime = ["image/png", "image/jpeg", "image/webp"];
      if (!okMime.includes(req.file.mimetype)) return res.status(400).send("Logo deve essere PNG/JPG/WEBP");

      await pool.query(
        `INSERT INTO dealer_logos (user_id, mime_type, content, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           mime_type = EXCLUDED.mime_type,
           content = EXCLUDED.content,
           updated_at = NOW()`,
        [dealerId, req.file.mimetype, req.file.buffer]
      );

      res.send("OK logo salvato");
    });
  }
);


export default router;
