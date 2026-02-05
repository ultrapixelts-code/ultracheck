// src/routes/portal.js

import express, { Router } from 'express';
const router = Router();

// ────────────────────────────────────────────────
// IMPORT DB (adatta il percorso reale del tuo pool PostgreSQL)
// ────────────────────────────────────────────────
import { pool } from '../db.js';  // oppure '../config/db.js' o simile – cambia se necessario

// ────────────────────────────────────────────────
// MIDDLEWARE DI AUTENTICAZIONE
// ────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (!req.session?.user) {
    const redirectTo = encodeURIComponent(req.originalUrl);
    return res.redirect(`/portal/login?redirect=${redirectTo}`);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Accesso negato – solo amministratori');
  }
  next();
}

// ────────────────────────────────────────────────
// QUI VANNO LE TUE ALTRE ROUTE ESISTENTI
// (login, logout, elenco ordini, dettaglio ordine, upload file, ecc.)
// Non toccarle – lasciale esattamente come sono nel tuo file reale
// Esempi di come potrebbero apparire (non copiarle se già esistono):
//
// router.get('/login', (req, res) => { ... });
// router.post('/login', (req, res) => { ... });
// router.get('/logout', (req, res) => { ... });
// router.get('/orders', requireLogin, async (req, res) => { ... });
// router.get('/orders/:id(\\d+)', requireLogin, async (req, res) => { ... });
// router.post('/orders/:id/upload', requireLogin, ...);
// ecc.
// ────────────────────────────────────────────────


// ────────────────────────────────────────────────
// INVIA PREVENTIVO (solo admin)
// ────────────────────────────────────────────────
router.post(
  '/orders/:id(\\d+)/quote',
  requireLogin,
  requireAdmin,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const orderId = Number(req.params.id);
    const price_total = Number(req.body.price_total);
    const lead_time_days = Number(req.body.lead_time_days);

    // Validazione input di base
    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return res.status(400).send('ID ordine non valido');
    }
    if (!Number.isFinite(price_total) || price_total <= 0) {
      return res.status(400).send('Prezzo totale non valido (deve essere > 0)');
    }
    if (!Number.isSafeInteger(lead_time_days) || lead_time_days < 1) {
      return res.status(400).send('Lead time non valido (giorni ≥ 1)');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Leggi stato reale dell'ordine
      const { rows: oRows } = await client.query(
        `SELECT status FROM orders WHERE id = $1`,
        [orderId]
      );

      if (oRows.length === 0) {
        throw new Error('Ordine non trovato');
      }

      const fromStatus = oRows[0].status;

      // Blocco immediato se non è in stato RFQ
      if (fromStatus !== 'RFQ') {
        throw new Error(`Impossibile quotare: ordine non in stato RFQ (attuale: ${fromStatus})`);
      }

      // Salva / aggiorna preventivo
      await client.query(
        `INSERT INTO quotes (order_id, price_total, lead_time_days, sent_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (order_id) DO UPDATE SET
           price_total     = EXCLUDED.price_total,
           lead_time_days  = EXCLUDED.lead_time_days,
           sent_at         = NOW()`,
        [orderId, price_total, lead_time_days]
      );

      // Aggiorna stato ordine (con doppia sicurezza)
      const { rowCount } = await client.query(
        `UPDATE orders 
         SET status = 'QUOTED', 
             updated_at = NOW()
         WHERE id = $1 AND status = 'RFQ'`,
        [orderId]
      );

      if (rowCount === 0) {
        throw new Error('Impossibile aggiornare stato ordine (possibile race condition)');
      }

      // Registra evento QUOTE_SENT
      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'QUOTE_SENT', $3, NOW())`,
        [
          orderId,
          req.session.user.id,
          JSON.stringify({ price_total, lead_time_days })
        ]
      );

      // Registra evento STATUS_CHANGED con stato reale
      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
        [
          orderId,
          req.session.user.id,
          JSON.stringify({ from: fromStatus, to: 'QUOTED' })
        ]
      );

      await client.query('COMMIT');

      // Risposta: AJAX o redirect normale
      if (req.xhr) {
        return res.json({
          success: true,
          message: 'Preventivo inviato con successo',
          orderId,
          redirectUrl: `/portal/orders/${orderId}`
        });
      }

      res.redirect(`/portal/orders/${orderId}`);
    } catch (err) {
      await client.query('ROLLBACK');

      console.error('Errore invio preventivo:', {
        orderId,
        error: err.message,
        stack: err.stack?.slice(0, 500) || 'no stack'
      });

      const isClientError =
        err.message?.includes('non trovato') ||
        err.message?.includes('non in stato') ||
        err.message?.includes('non valido');

      const statusCode = isClientError ? 400 : 500;
      const message = err.message || 'Errore durante l\'invio del preventivo';

      if (req.xhr) {
        return res.status(statusCode).json({ error: message });
      }

      res.status(statusCode).send(message);
    } finally {
      client.release();
    }
  }
);

// ────────────────────────────────────────────────
// ESM EXPORT (obbligatorio per il tuo server.js)
// ────────────────────────────────────────────────
export default router;
