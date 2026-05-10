"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const notifService = require("../../shared/notifications/notifications.service");
const auditService = require("../../shared/audit/audit.service");
const { renderToPDF } = require("../../lib/pdf/generator");
const { sendWithAttachment } = require("../../lib/email/sender");
const whatsapp = require("../../integrations/messaging/adapters/whatsapp");
const logger = require("../../config/logger");

async function list(
  business,
  { page = 1, limit = 50, status, contactId },
  scope,
  user,
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await client.query(
      `SELECT i.invoice_id, i.invoice_number, i.invoice_type, i.status,
              i.total_amount, i.amount_paid, i.amount_outstanding,
              i.issue_date, i.due_date,
              c.display_name AS contact_name, c.contact_id
       FROM invoices i
       JOIN shared.contacts c ON c.contact_id = i.contact_id
       WHERE i.is_deleted = false
         AND ($1::TEXT IS NULL OR i.status = $1)
         AND ($2::UUID IS NULL OR i.contact_id = $2)
         AND ($3::TEXT = 'all' OR i.created_by = $4)
       ORDER BY i.created_at DESC
       LIMIT $5 OFFSET $6`,
      [
        status || null,
        contactId || null,
        scope,
        user.user_id,
        parseInt(limit),
        offset,
      ],
    );
    return { data: rows };
  });
}

async function getById(business, invoiceId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [inv],
    } = await client.query(
      `SELECT i.*,
              c.display_name AS contact_name, c.email, c.primary_phone, c.whatsapp_number,
              json_agg(il.* ORDER BY il.display_order) AS lines,
              json_agg(ip.*) FILTER (WHERE ip.payment_id IS NOT NULL) AS payments
       FROM invoices i
       JOIN shared.contacts c ON c.contact_id = i.contact_id
       LEFT JOIN invoice_lines il ON il.invoice_id = i.invoice_id
       LEFT JOIN invoice_payments ip ON ip.invoice_id = i.invoice_id
       WHERE i.invoice_id = $1 AND i.is_deleted = false
       GROUP BY i.invoice_id, c.display_name, c.email, c.primary_phone, c.whatsapp_number`,
      [invoiceId],
    );
    return inv || null;
  });
}

async function create(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const invoiceNumber = await nextDocumentNumber(client, business, "invoice");

    // Calculate totals
    let subtotal = 0;
    let vatTotal = 0;
    for (const line of data.lines) {
      const lineTotal =
        line.unit_price * line.quantity - (line.discount_amount || 0);
      const vatAmt = lineTotal * (line.vat_rate || 0.075);
      subtotal += lineTotal;
      vatTotal += vatAmt;
    }
    const total = subtotal + vatTotal - (data.discount_total || 0);

    const {
      rows: [inv],
    } = await client.query(
      `INSERT INTO invoices
         (invoice_number, invoice_type, contact_id, order_id, status,
          issue_date, due_date, subtotal, discount_total, vat_amount,
          total_amount, currency, notes, payment_instructions, created_by)
       VALUES ($1,$2,$3,$4,'draft',CURRENT_DATE,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        invoiceNumber,
        data.invoice_type || "standard",
        data.contact_id,
        data.order_id || null,
        data.due_date,
        subtotal,
        data.discount_total || 0,
        vatTotal,
        total,
        data.currency || "NGN",
        data.notes || null,
        data.payment_instructions || null,
        user.user_id,
      ],
    );

    // Insert lines
    for (let i = 0; i < data.lines.length; i++) {
      const l = data.lines[i];
      const lineTotal = l.unit_price * l.quantity - (l.discount_amount || 0);
      const vatAmt = lineTotal * (l.vat_rate || 0.075);
      await client.query(
        `INSERT INTO invoice_lines
           (invoice_id, product_id, description, quantity, unit_price,
            discount_amount, vat_rate, vat_amount, line_total, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          inv.invoice_id,
          l.product_id || null,
          l.description,
          l.quantity,
          l.unit_price,
          l.discount_amount || 0,
          l.vat_rate || 0.075,
          vatAmt,
          lineTotal + vatAmt,
          i,
        ],
      );
    }

    // Post journal entry
    await postInvoiceJournal(client, business, inv);

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "invoicing",
      action: "create",
      table: "invoices",
      recordId: inv.invoice_id,
      after: inv,
    });

    return inv;
  });
}

async function postInvoiceJournal(client, business, invoice) {
  // Get AR and Revenue account codes
  const {
    rows: [ar],
  } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = '1310' LIMIT 1`,
  );
  const {
    rows: [rev],
  } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = '4100' LIMIT 1`,
  );
  const {
    rows: [vat],
  } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = '2210' LIMIT 1`,
  );

  if (!ar || !rev) return; // COA not seeded yet

  const {
    rows: [entry],
  } = await client
    .query(
      `INSERT INTO journal_entries
       (entry_number, entry_date, description, reference_type, reference_id, posted_by)
     SELECT 'JE-' || nextval('journal_entry_seq'), CURRENT_DATE, $1, 'invoice', $2, $3
     RETURNING entry_id`,
      [
        `Invoice ${invoice.invoice_number}`,
        invoice.invoice_id,
        invoice.created_by,
      ],
    )
    .catch(() => ({ rows: [] })); // Sequence may not exist yet — handle gracefully

  if (!entry) return;

  // DR Accounts Receivable, CR Revenue, CR Output VAT
  await client.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES
     ($1, $2, $3, 0),
     ($1, $4, 0, $5),
     ($1, $6, 0, $7)`,
    [
      entry.entry_id,
      ar.account_id,
      invoice.total_amount,
      rev.account_id,
      invoice.subtotal,
      vat.account_id,
      invoice.vat_amount,
    ],
  );
}

async function recordPayment(business, invoiceId, data, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [payment],
    } = await client.query(
      `INSERT INTO invoice_payments
         (invoice_id, payment_date, amount, payment_method, reference,
          paystack_reference, is_confirmed, recorded_by, notes)
       VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        invoiceId,
        data.payment_date || null,
        data.amount,
        data.payment_method,
        data.reference || null,
        data.paystack_reference || null,
        data.is_confirmed !== undefined ? data.is_confirmed : true,
        user.user_id,
        data.notes || null,
      ],
    );

    // Trigger trg_invoice_payment_update fires automatically
    // Post cash receipt journal
    const {
      rows: [inv],
    } = await client.query(
      `SELECT invoice_number, contact_id FROM invoices WHERE invoice_id = $1`,
      [invoiceId],
    );

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "invoicing",
      action: "create",
      table: "invoice_payments",
      recordId: payment.payment_id,
      after: payment,
    });

    return payment;
  });
}

async function send(business, invoiceId, { channel = "email" }, user) {
  const inv = await getById(business, invoiceId);
  if (!inv)
    throw Object.assign(new Error("Invoice not found"), { status: 404 });

  const pdf = await generatePDF(business, invoiceId);

  if (channel === "email" && inv.email) {
    await sendWithAttachment({
      to: inv.email,
      subject: `Invoice ${inv.invoice_number}`,
      html: `<p>Dear ${inv.contact_name}, please find attached your invoice ${inv.invoice_number} for ₦${Number(inv.total_amount).toLocaleString()}. Due: ${inv.due_date}.</p>`,
      filename: `${inv.invoice_number}.pdf`,
      pdfBuffer: pdf,
    });
  } else if (channel === "whatsapp" && inv.whatsapp_number) {
    await whatsapp.sendMessage({
      to: inv.whatsapp_number,
      text: `Dear ${inv.contact_name}, your invoice ${inv.invoice_number} of ₦${Number(inv.total_amount).toLocaleString()} is due on ${inv.due_date}. Please make payment to our bank account.`,
    });
  }

  await withBusinessContext(business, async (client) => {
    await client.query(
      `UPDATE invoices SET status = 'sent', sent_at = now() WHERE invoice_id = $1 AND status = 'draft'`,
      [invoiceId],
    );
  });
}

async function voidInvoice(business, invoiceId, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [inv],
    } = await client.query(
      `UPDATE invoices SET status = 'voided', updated_at = now()
       WHERE invoice_id = $1 AND status NOT IN ('paid','voided')
       RETURNING *`,
      [invoiceId],
    );
    if (!inv)
      throw Object.assign(new Error("Cannot void this invoice"), {
        status: 400,
      });

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "invoicing",
      action: "delete",
      table: "invoices",
      recordId: invoiceId,
      before: inv,
    });
  });
}

async function generatePDF(business, invoiceId) {
  const inv = await getById(business, invoiceId);
  if (!inv)
    throw Object.assign(new Error("Invoice not found"), { status: 404 });
  return renderToPDF("invoices", inv);
}

module.exports = {
  list,
  getById,
  create,
  recordPayment,
  send,
  voidInvoice,
  generatePDF,
};
