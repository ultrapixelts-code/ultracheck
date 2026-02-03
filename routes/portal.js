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
function requireAdmin(req, res, next) {
  if (req.session?.user?.role === "admin") return next();
  return res.status(403).send("Forbidden");
}

async function getOrderOr403(orderId, user) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE id=$1 LIMIT 1`, [orderId]);
  const order = rows[0];
  if (!order) return { order: null, forbidden: false, notFound: true };

  // dealer vede solo i suoi ordini
  if (user.role !== "admin" && Number(order.dealer_user_id) !== Number(user.id)) {
    return { order, forbidden: true, notFound: false };
  }
  return { order, forbidden: false, notFound: false };
}
router.get("/orders", requireLogin, async (req, res) => {
  const user = req.session.user;

  const q =
    user.role === "admin"
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
router.get("/orders/new", requireLogin, (req, res) => {
  res.render("portal/orders/new", { user: req.session.user, error: null });
});

router.post("/orders", requireLogin, express.urlencoded({ extended: true }), async (req, res) => {
  const user = req.session.user;
  const { title, notes_dealer } = req.body;

  if (!title?.trim()) {
    return res.render("portal/orders/new", { user, error: "Inserisci un titolo" });
  }

  const { rows } = await pool.query(
    `INSERT INTO orders (dealer_user_id, title, status, notes_dealer, created_at, updated_at)
     VALUES ($1,$2,'pricing',$3,now(),now())
     RETURNING id`,
    [user.id, title.trim(), notes_dealer || null]
  );

  const orderId = rows[0].id;

  // evento
  await pool.query(
    `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
     VALUES ($1,$2,'ORDER_CREATED',$3,now())`,
    [orderId, user.id, JSON.stringify({ title: title.trim() })]
  );

  return res.redirect(`/portal/orders/${orderId}`);
});

router.get("/orders/:id", requireLogin, async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  const { order, forbidden, notFound } = await getOrderOr403(orderId, user);
  if (notFound) return res.status(404).send("Order not found");
  if (forbidden) return res.status(403).send("Forbidden");

  const { rows: files } = await pool.query(
    `SELECT * FROM order_files WHERE order_id=$1 ORDER BY created_at DESC`,
    [orderId]
  );

  const { rows: quoteRows } = await pool.query(`SELECT * FROM quotes WHERE order_id=$1 LIMIT 1`, [orderId]);
  const quote = quoteRows[0] || null;

  const { rows: proofRows } = await pool.query(
    `SELECT * FROM proofs WHERE order_id=$1 ORDER BY version DESC`,
    [orderId]
  );

  const { rows: events } = await pool.query(
    `SELECT e.*, u.email
     FROM order_events e
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.order_id=$1
     ORDER BY e.created_at DESC
     LIMIT 200`,
    [orderId]
  );

  res.render("portal/orders/show", { user, order, files, quote, proofs: proofRows, events });
});

router.post("/orders/:id/quote", requireLogin, requireAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  const orderId = Number(req.params.id);
  const { price_total, lead_time_days } = req.body;

  await pool.query(
    `INSERT INTO quotes(order_id, price_total, lead_time_days, sent_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT(order_id) DO UPDATE
     SET price_total=EXCLUDED.price_total,
         lead_time_days=EXCLUDED.lead_time_days,
         sent_at=now()`,
    [orderId, price_total || null, lead_time_days || null]
  );

  await pool.query(`UPDATE orders SET status='quoted', updated_at=now() WHERE id=$1`, [orderId]);

  await pool.query(
    `INSERT INTO order_events(order_id, actor_user_id, type, payload_json, created_at)
     VALUES ($1,$2,'QUOTE_SENT',$3,now())`,
    [orderId, req.session.user.id, JSON.stringify({ price_total, lead_time_days })]
  );

  res.redirect(`/portal/orders/${orderId}`);
});

router.post("/orders/:id/confirm", requireLogin, async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  const { order, forbidden, notFound } = await getOrderOr403(orderId, user);
  if (notFound) return res.status(404).send("Order not found");
  if (forbidden) return res.status(403).send("Forbidden");
  if (order.status !== "quoted") return res.status(400).send("Bad status");

  await pool.query(`UPDATE orders SET status='confirmed', updated_at=now() WHERE id=$1`, [orderId]);
  await pool.query(`UPDATE quotes SET accepted_at=now() WHERE order_id=$1`, [orderId]);

  await pool.query(
    `INSERT INTO order_events(order_id, actor_user_id, type, created_at)
     VALUES ($1,$2,'QUOTE_ACCEPTED',now())`,
    [orderId, user.id]
  );

  res.redirect(`/portal/orders/${orderId}`);
});


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
