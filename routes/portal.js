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

      // 0) Leggi stato reale dell'ordine
      const { rows: oRows } = await client.query(
        `SELECT status FROM orders WHERE id = $1`,
        [orderId]
      );

      if (oRows.length === 0) {
        throw new Error('Ordine non trovato');
      }

      const fromStatus = oRows[0].status;

      // FIX 1: Blocca SUBITO se non è RFQ — prima di toccare la quote
      if (fromStatus !== 'RFQ') {
        throw new Error(`Impossibile quotare: ordine non in stato RFQ (attuale: ${fromStatus})`);
      }

      // 1) Salva / aggiorna preventivo
      await client.query(
        `INSERT INTO quotes (order_id, price_total, lead_time_days, sent_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (order_id) DO UPDATE SET
           price_total     = EXCLUDED.price_total,
           lead_time_days  = EXCLUDED.lead_time_days,
           sent_at         = NOW()`,
        [orderId, price_total, lead_time_days]
      );

      // 2) Cambia stato ordine (con doppia sicurezza)
      const { rowCount } = await client.query(
        `UPDATE orders 
         SET status = 'QUOTED', 
             updated_at = NOW()
         WHERE id = $1 AND status = 'RFQ'`,
        [orderId]
      );

      if (rowCount === 0) {
        // Dovrebbe essere quasi impossibile arrivare qui dopo il check precedente,
        // ma teniamo il controllo per race conditions teoriche
        throw new Error(`Impossibile aggiornare stato ordine (possibile race condition)`);
      }

      // 3) Registra evento QUOTE_SENT
      await client.query(
        `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
         VALUES ($1, $2, 'QUOTE_SENT', $3, NOW())`,
        [
          orderId,
          req.session.user.id,
          JSON.stringify({ price_total, lead_time_days })
        ]
      );

      // 4) Evento STATUS_CHANGED con from reale
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

      // FIX 2: risposta più prevedibile per form classici
      const isAjax = req.xhr;

      if (isAjax) {
        return res.json({
          success: true,
          message: 'Preventivo inviato con successo',
          orderId,
          redirectUrl: `/portal/orders/${orderId}`
        });
      }

      // Comportamento standard per submit form normale
      res.redirect(`/portal/orders/${orderId}`);
    } catch (err) {
      await client.query('ROLLBACK');

      console.error('Errore invio preventivo:', {
        orderId,
        error: err.message,
        stack: err.stack?.substring(0, 400) || 'no stack'
      });

      const isClientError = 
        err.message.includes('non trovato') ||
        err.message.includes('non in stato') ||
        err.message.includes('non valido');

      const statusCode = isClientError ? 400 : 500;
      const message = err.message || 'Errore durante l\'invio del preventivo';

      const isAjax = req.xhr;

      if (isAjax) {
        return res.status(statusCode).json({ error: message });
      }

      res.status(statusCode).send(message);
    } finally {
      client.release();
    }
  }
);
