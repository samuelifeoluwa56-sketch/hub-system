"use strict";

async function list(
  client,
  { status, contactId, scope, userId, limit, offset },
) {
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
    [status || null, contactId || null, scope, userId, limit, offset],
  );
  return rows;
}

async function findById(client, invoiceId) {
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
}

async function insert(
  client,
  {
    invoiceNumber,
    invoice_type,
    contact_id,
    order_id,
    due_date,
    subtotal,
    discount_total,
    vatTotal,
    total,
    currency,
    notes,
    payment_instructions,
    userId,
  },
) {
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
      invoice_type || "standard",
      contact_id,
      order_id || null,
      due_date,
      subtotal,
      discount_total || 0,
      vatTotal,
      total,
      currency || "NGN",
      notes || null,
      payment_instructions || null,
      userId,
    ],
  );
  return inv;
}

async function insertLine(
  client,
  {
    invoice_id,
    product_id,
    description,
    quantity,
    unit_price,
    discount_amount,
    vat_rate,
    vatAmt,
    lineTotal,
    order,
  },
) {
  await client.query(
    `INSERT INTO invoice_lines
       (invoice_id, product_id, description, quantity, unit_price,
        discount_amount, vat_rate, vat_amount, line_total, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      invoice_id,
      product_id || null,
      description,
      quantity,
      unit_price,
      discount_amount || 0,
      vat_rate || 0.075,
      vatAmt,
      lineTotal,
      order,
    ],
  );
}

async function getARAccount(client) {
  const {
    rows: [ar],
  } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = '1310' LIMIT 1`,
  );
  return ar || null;
}

async function getRevenueAccount(client) {
  const {
    rows: [rev],
  } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = '4100' LIMIT 1`,
  );
  return rev || null;
}

async function getVATAccount(client) {
  const {
    rows: [vat],
  } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = '2210' LIMIT 1`,
  );
  return vat || null;
}

async function insertJournalEntry(
  client,
  { description, referenceId, createdBy },
) {
  const {
    rows: [entry],
  } = await client
    .query(
      `INSERT INTO journal_entries
       (entry_number, entry_date, description, reference_type, reference_id, posted_by)
     SELECT 'JE-' || nextval('journal_entry_seq'), CURRENT_DATE, $1, 'invoice', $2, $3
     RETURNING entry_id`,
      [description, referenceId, createdBy],
    )
    .catch(() => ({ rows: [] }));
  return entry || null;
}

async function insertJournalLines(
  client,
  { entryId, arId, totalAmount, revId, subtotal, vatId, vatAmount },
) {
  await client.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES
     ($1, $2, $3, 0),
     ($1, $4, 0, $5),
     ($1, $6, 0, $7)`,
    [entryId, arId, totalAmount, revId, subtotal, vatId, vatAmount],
  );
}

async function insertPayment(
  client,
  {
    invoiceId,
    payment_date,
    amount,
    payment_method,
    reference,
    paystack_reference,
    is_confirmed,
    userId,
    notes,
  },
) {
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
      payment_date || null,
      amount,
      payment_method,
      reference || null,
      paystack_reference || null,
      is_confirmed !== undefined ? is_confirmed : true,
      userId,
      notes || null,
    ],
  );
  return payment;
}

async function getInvoiceNumberAndContact(client, invoiceId) {
  const {
    rows: [inv],
  } = await client.query(
    `SELECT invoice_number, contact_id FROM invoices WHERE invoice_id = $1`,
    [invoiceId],
  );
  return inv || null;
}

async function setSent(client, invoiceId) {
  await client.query(
    `UPDATE invoices SET status = 'sent', sent_at = now() WHERE invoice_id = $1 AND status = 'draft'`,
    [invoiceId],
  );
}

async function setVoided(client, invoiceId) {
  const {
    rows: [inv],
  } = await client.query(
    `UPDATE invoices SET status = 'voided', updated_at = now()
     WHERE invoice_id = $1 AND status NOT IN ('paid','voided')
     RETURNING *`,
    [invoiceId],
  );
  return inv || null;
}

module.exports = {
  list,
  findById,
  insert,
  insertLine,
  getARAccount,
  getRevenueAccount,
  getVATAccount,
  insertJournalEntry,
  insertJournalLines,
  insertPayment,
  getInvoiceNumberAndContact,
  setSent,
  setVoided,
};
