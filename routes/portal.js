import express from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { pool } from '../db.js';

console.log("✅ portalRouter LOADED");

const router = express.Router();

// ────────────────────────────────────────────────
// Configurazione Multer
// ────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/zip',
      'application/x-rar-compressed'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato file non supportato. Ammessi: PDF, JPG, PNG, WEBP, ZIP, RAR'));
    }
  }
});

// ────────────────────────────────────────────────
// Middleware di autenticazione
// ────────────────────────────────────────────────
const requireLogin = (req, res, next) => {
  if (req.session?.user) return next();
  res.redirect('/portal/login');
};

const requireAdmin = (req, res, next) => {
  if (req.session?.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Accesso riservato agli amministratori' });
};

const getOrderOr403 = async (orderId, user) => {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return { order: null, status: 400, message: 'ID ordine non valido' };
  }

  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );
  const order = rows[0];

  if (!order) {
    return { order: null, status: 404, message: 'Ordine non trovato' };
  }

  if (user.role !== 'admin' && Number(order.dealer_user_id) !== Number(user.id)) {
    return { order: null, status: 403, message: 'Non sei autorizzato a visualizzare questo ordine' };
  }

  return { order, status: 200, message: null };
};

// ────────────────────────────────────────────────
// LISTA ORDINI
// ────────────────────────────────────────────────
router.get('/orders', requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    const isAdmin = user.role === 'admin';
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

    res.render('portal/orders/index', { user, orders });
  } catch (err) {
    console.error('Errore caricamento lista ordini:', err);
    res.status(500).render('portal/error', { user, message: 'Impossibile caricare gli ordini' });
  }
});

// ────────────────────────────────────────────────
// FORM NUOVO ORDINE
// ────────────────────────────────────────────────
router.get('/orders/new', requireLogin, (req, res) => {
  res.render('portal/orders/new', { user: req.session.user, error: null });
});

// ────────────────────────────────────────────────
// CREA ORDINE
// ────────────────────────────────────────────────
router.post('/orders', requireLogin, express.urlencoded({ extended: true }), async (req, res) => {
  const user = req.session.user;
  const title = String(req.body.title || '').trim();
  const notes = String(req.body.notes_dealer || '').trim() || null;

  if (!title) {
    return res.render('portal/orders/new', { user, error: 'Il titolo è obbligatorio' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO orders (dealer_user_id, title, status, notes_dealer, created_at, updated_at)
       VALUES ($1, $2, 'RFQ', $3, NOW(), NOW())
       RETURNING id`,
      [user.id, title, notes]
    );

    const orderId = rows[0].id;

    await client.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
      [orderId, user.id, JSON.stringify({ from: null, to: 'RFQ' })]
    );

    await client.query('COMMIT');
    res.redirect(`/portal/orders/${orderId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Errore creazione ordine:', err);
    res.render('portal/orders/new', { user, error: 'Errore durante la creazione dell\'ordine' });
  } finally {
    client.release();
  }
});

// ────────────────────────────────────────────────
// DETTAGLIO ORDINE
// ────────────────────────────────────────────────
router.get('/orders/:id([0-9]+)', requireLogin, async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  const result = await getOrderOr403(orderId, user);
  if (result.status !== 200) {
    return res.status(result.status).send(result.message);
  }
  const { order } = result;

  try {
    const [filesRes, eventsRes, quoteRes] = await Promise.all([
      pool.query(
        `SELECT id, original_name, mime_type, size_bytes, created_at
         FROM order_files WHERE order_id = $1 ORDER BY created_at DESC`,
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
      pool.query('SELECT * FROM quotes WHERE order_id = $1 LIMIT 1', [orderId])
        .catch(() => ({ rows: [] })) // tabella quotes potrebbe non esistere ancora
    ]);

    res.render('portal/orders/show', {
      user,
      order,
      files: filesRes.rows,
      events: eventsRes.rows,
      quote: quoteRes.rows[0] || null,
      proofs: [] // da implementare quando ci sarà la tabella
    });
  } catch (err) {
    console.error('Errore caricamento dettaglio ordine:', err);
    res.status(500).send('Errore durante il caricamento dei dati');
  }
});

// ────────────────────────────────────────────────
// CARICA FILE
// ────────────────────────────────────────────────
router.post('/orders/:id([0-9]+)/files', requireLogin, upload.single('file'), async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  const result = await getOrderOr403(orderId, user);
  if (result.status !== 200) {
    return res.status(result.status).send(result.message);
  }

  if (!req.file) {
    return res.status(400).send('Nessun file selezionato');
  }

  const { originalname, mimetype, size, buffer } = req.file;

  try {
    await pool.query(
      `INSERT INTO order_files (order_id, uploader_user_id, original_name, mime_type, size_bytes, content)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, user.id, originalname, mimetype, size, buffer]
    );

    await pool.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'FILE_UPLOADED', $3, NOW())`,
      [orderId, user.id, JSON.stringify({ name: originalname, size })]
    );

    res.redirect(`/portal/orders/${orderId}`);
  } catch (err) {
    console.error('Errore caricamento file:', err);
    res.status(500).send('Errore durante il caricamento del file');
  }
});

// ────────────────────────────────────────────────
// SCARICA / VISUALIZZA FILE
// ────────────────────────────────────────────────
router.get('/files/:id([0-9]+)', requireLogin, async (req, res) => {
  const user = req.session.user;
  const fileId = Number(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT f.*, o.dealer_user_id
       FROM order_files f
       JOIN orders o ON o.id = f.order_id
       WHERE f.id = $1`,
      [fileId]
    );

    const file = rows[0];
    if (!file) return res.status(404).send('File non trovato');

    if (user.role !== 'admin' && Number(file.dealer_user_id) !== Number(user.id)) {
      return res.status(403).send('Non autorizzato');
    }

    const safeName = (file.original_name || 'document').replace(/[^\w.-]/g, '_');

    res.set({
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Content-Length': file.size_bytes
    });

    res.send(file.content);
  } catch (err) {
    console.error('Errore recupero file:', err);
    res.status(500).send('Errore durante il recupero del file');
  }
});

// ────────────────────────────────────────────────
// INVIA PREVENTIVO (admin)
// ────────────────────────────────────────────────
router.post('/orders/:id([0-9]+)/quote', requireLogin, requireAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  const orderId = Number(req.params.id);
  const price_total = Number(req.body.price_total);
  const lead_time_days = Number(req.body.lead_time_days);

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return res.status(400).send('ID ordine non valido');
  }
  if (!Number.isFinite(price_total) || price_total <= 0) {
    return res.status(400).send('Inserisci un prezzo totale valido (> 0)');
  }
  if (!Number.isSafeInteger(lead_time_days) || lead_time_days < 1) {
    return res.status(400).send('Inserisci un lead time valido (giorni interi ≥ 1)');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO quotes (order_id, price_total, lead_time_days, sent_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (order_id) DO UPDATE
       SET price_total = EXCLUDED.price_total,
           lead_time_days = EXCLUDED.lead_time_days,
           sent_at = NOW()`,
      [orderId, price_total, lead_time_days]
    );

    const { rowCount } = await client.query(
      `UPDATE orders SET status = 'QUOTED', updated_at = NOW()
       WHERE id = $1 AND status = 'RFQ'`,
      [orderId]
    );

    if (rowCount === 0) {
      throw new Error('Ordine non trovabile o non in stato RFQ');
    }

    await client.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'QUOTE_SENT', $3, NOW())`,
      [orderId, req.session.user.id, JSON.stringify({ price_total, lead_time_days })]
    );

    await client.query('COMMIT');
    res.redirect(`/portal/orders/${orderId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Errore invio preventivo:', err);
    res.status(400).send(err.message || 'Errore durante l\'invio del preventivo');
  } finally {
    client.release();
  }
});

// ────────────────────────────────────────────────
// CONFERMA PREVENTIVO (dealer)
// ────────────────────────────────────────────────
router.post('/orders/:id([0-9]+)/confirm', requireLogin, async (req, res) => {
  const user = req.session.user;
  const orderId = Number(req.params.id);

  const result = await getOrderOr403(orderId, user);
  if (result.status !== 200) {
    return res.status(result.status).send(result.message);
  }
  const { order } = result;

  if (order.status !== 'QUOTED') {
    return res.status(400).send('L\'ordine non è in attesa di conferma preventivo');
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE orders SET status = 'PRICE_APPROVED', updated_at = NOW()
       WHERE id = $1 AND status = 'QUOTED'`,
      [orderId]
    );

    if (rowCount === 0) {
      return res.status(400).send('Stato ordine non aggiornato – possibile race condition');
    }

    await pool.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
      [orderId, user.id, JSON.stringify({ from: 'QUOTED', to: 'PRICE_APPROVED' })]
    );

    res.redirect(`/portal/orders/${orderId}`);
  } catch (err) {
    console.error('Errore conferma preventivo:', err);
    res.status(500).send('Errore durante la conferma');
  }
});

// ────────────────────────────────────────────────
// AUTENTICAZIONE
// ────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/portal');
  res.render('portal/login', { error: null });
});

router.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = req.body.password;

  if (!email || !password) {
    return res.render('portal/login', { error: 'Email e password sono obbligatorie' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, role, dealer_name, is_active
       FROM users WHERE email = $1`,
      [email]
    );

    const user = rows[0];
    if (!user || !user.is_active) {
      return res.render('portal/login', { error: 'Credenziali non valide o account non attivo' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.render('portal/login', { error: 'Credenziali non valide' });
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      dealerName: user.dealer_name
    };

    res.redirect('/portal');
  } catch (err) {
    console.error('Errore login:', err);
    res.render('portal/login', { error: 'Errore di sistema, riprova più tardi' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/portal/login');
  });
});

// ────────────────────────────────────────────────
// DASHBOARD
// ────────────────────────────────────────────────
router.get('/', requireLogin, (req, res) => {
  res.render('portal/dashboard', { user: req.session.user });
});

export default router;
