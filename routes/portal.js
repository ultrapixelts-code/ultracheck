// ────────────────────────────────────────────────
// INVIA PREVENTIVO (solo admin)
// ────────────────────────────────────────────────
router.post('/orders/:id(\\d+)/quote', requireLogin, requireAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  const orderId = Number(req.params.id);
  const price_total = Number(req.body.price_total);
  const lead_time_days = Number(req.body.lead_time_days);

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
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

    // 1. Salva / aggiorna preventivo
    await client.query(
      `INSERT INTO quotes (order_id, price_total, lead_time_days, sent_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (order_id) DO UPDATE SET
         price_total = EXCLUDED.price_total,
         lead_time_days = EXCLUDED.lead_time_days,
         sent_at = NOW()`,
      [orderId, price_total, lead_time_days]
    );

    // 2. Cambia stato ordine (solo se ancora RFQ)
    const { rowCount } = await client.query(
      `UPDATE orders SET status = 'QUOTED', updated_at = NOW()
       WHERE id = $1 AND status = 'RFQ'`,
      [orderId]
    );

    if (rowCount === 0) {
      throw new Error('Impossibile quotare: ordine non in stato RFQ o già processato');
    }

    // 3. Registra evento QUOTE_SENT
    await client.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'QUOTE_SENT', $3, NOW())`,
      [orderId, req.session.user.id, JSON.stringify({ price_total, lead_time_days })]
    );

    // 4. Evento STATUS_CHANGED (richiesto)
    await client.query(
      `INSERT INTO order_events (order_id, actor_user_id, type, payload_json, created_at)
       VALUES ($1, $2, 'STATUS_CHANGED', $3, NOW())`,
      [orderId, req.session.user.id, JSON.stringify({ from: 'RFQ', to: 'QUOTED' })]
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
