"use strict";
const { withBusinessContext } = require("../config/db");
const { sendEmail } = require("../lib/email/sender");
const logger = require("../config/logger");

module.exports = async function sendPaymentReminders() {
  for (const business of ["jewelry", "diffusers"]) {
    await withBusinessContext(business, async (client) => {
      // Invoices overdue 1, 3, 7 days — send reminder
      const { rows } = await client.query(`
        SELECT i.invoice_id, i.invoice_number, i.amount_outstanding, i.due_date,
               c.email, c.display_name, c.whatsapp_number
        FROM invoices i
        JOIN shared.contacts c ON c.contact_id = i.contact_id
        WHERE i.status IN ('overdue','partially_paid')
          AND i.is_deleted = false
          AND c.email IS NOT NULL
          AND (CURRENT_DATE - i.due_date) IN (1, 3, 7)
      `);

      for (const inv of rows) {
        try {
          await sendEmail({
            to: inv.email,
            subject: `Payment Reminder — ${inv.invoice_number}`,
            html: `<p>Dear ${inv.display_name}, your invoice ${inv.invoice_number} of ₦${Number(inv.amount_outstanding).toLocaleString()} is overdue. Please make payment at your earliest convenience.</p>`,
          });
          logger.info(
            `Payment reminder sent: ${inv.invoice_number} → ${inv.email}`,
          );
        } catch (err) {
          logger.error(`Reminder failed for ${inv.invoice_number}`, err);
        }
      }
    });
  }
};
