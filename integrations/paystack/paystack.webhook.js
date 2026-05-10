'use strict';

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const config   = require('../../config/config');
const logger   = require('../../config/logger');
const { pool } = require('../../config/db');

// Raw body needed for HMAC verification — must be before express.json()
router.use(express.raw({ type: 'application/json' }));

router.post('/', async (req, res) => {
  // 1. Verify signature
  const hash = crypto
    .createHmac('sha512', config.paystack.webhookSecret)
    .update(req.body)
    .digest('hex');

  const signatureValid = hash === req.headers['x-paystack-signature'];

  const payload   = JSON.parse(req.body.toString());
  const eventType = payload.event;

  // 2. Log the webhook before processing (idempotency check)
  const existing = await pool.query(
    `SELECT webhook_id, processed FROM shared.webhook_log
     WHERE source = 'paystack'
       AND (payload->>'id') = $1
       AND processed = true
     LIMIT 1`,
    [payload.data?.id]
  );

  if (existing.rows.length) {
    logger.debug(`Paystack webhook already processed: ${payload.data?.id}`);
    return res.sendStatus(200); // Acknowledge without reprocessing
  }

  const { rows: [logged] } = await pool.query(
    `INSERT INTO shared.webhook_log (source, event_type, payload, signature_valid)
     VALUES ('paystack', $1, $2, $3) RETURNING webhook_id`,
    [eventType, payload, signatureValid]
  );

  if (!signatureValid) {
    logger.warn(`Invalid Paystack webhook signature`);
    return res.sendStatus(400);
  }

  // 3. Respond immediately — process async
  res.sendStatus(200);

  // 4. Handle event
  try {
    if (eventType === 'charge.success') {
      await handleChargeSuccess(payload.data);
    }
    // Mark processed
    await pool.query(
      `UPDATE shared.webhook_log SET processed = true, processed_at = now()
       WHERE webhook_id = $1`,
      [logged.webhook_id]
    );
  } catch (err) {
    logger.error(`Paystack webhook processing failed: ${eventType}`, err);
    await pool.query(
      `UPDATE shared.webhook_log SET error_message = $1 WHERE webhook_id = $2`,
      [err.message, logged.webhook_id]
    );
  }
});

async function handleChargeSuccess(data) {
  // Find the invoice or POS payment split by reference
  const reference = data.reference;

  // Try to match against jewelry invoices
  for (const business of ['jewelry', 'diffusers']) {
    const result = await pool.query(
      `SET LOCAL search_path TO ${business}, shared, public;
       SELECT payment_id FROM invoice_payments
       WHERE paystack_reference = $1 LIMIT 1`,
      [reference]
    );
    if (result.rows.length) {
      await pool.query(
        `UPDATE invoice_payments
         SET is_confirmed = true, confirmed_at = now()
         WHERE paystack_reference = $1`,
        [reference]
      );
      logger.info(`Paystack payment confirmed: ${reference} [${business}]`);
      return;
    }
  }
  logger.warn(`Paystack charge.success with no matching payment: ${reference}`);
}

module.exports = router;
