"use strict";

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const config = require("../../config/config");
const logger = require("../../config/logger");
const { pool } = require("../../config/db");
const { getActiveBusinesses } = require("../../config/businesses");

router.use(express.json());

router.post("/", async (req, res) => {
  const signature = req.headers["verif-hash"];
  if (signature !== config.flutterwave.webhookSecret) {
    logger.warn("Invalid Flutterwave webhook signature");
    return res.sendStatus(401);
  }

  res.sendStatus(200); // Respond immediately

  const { event, data } = req.body;

  // Log webhook
  await pool
    .query(
      `INSERT INTO shared.webhook_log (source, event_type, payload, signature_valid)
     VALUES ('flutterwave', $1, $2, true)`,
      [event, req.body],
    )
    .catch(() => {});

  try {
    if (event === "charge.completed" && data.status === "successful") {
      // Find invoice payment by flutterwave reference
      for (const business of getActiveBusinesses()) {
        await pool
          .query(
            `
          UPDATE ${business}.invoice_payments
          SET is_confirmed = true, confirmed_at = now()
          WHERE flutterwave_reference = $1
        `,
            [data.tx_ref],
          )
          .catch(() => {});
      }
      logger.info(`Flutterwave payment confirmed: ${data.tx_ref}`);
    }
  } catch (err) {
    logger.error("Flutterwave webhook processing error", err);
  }
});

module.exports = router;
