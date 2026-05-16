"use strict";

async function listQuotations(
  client,
  { status, contactId, scope, userId, limit, offset },
) {
  const { rows } = await client.query(
    `SELECT q.quotation_id, q.quotation_number, q.status, q.valid_until,
            q.total_amount, q.created_at,
            c.display_name AS contact_name
     FROM quotations q
     JOIN shared.contacts c ON c.contact_id = q.contact_id
     WHERE q.is_deleted = false
       AND ($1::TEXT IS NULL OR q.status = $1)
       AND ($2::UUID IS NULL OR q.contact_id = $2)
       AND ($3 = 'all' OR q.assigned_to = $4)
     ORDER BY q.created_at DESC LIMIT $5 OFFSET $6`,
    [status || null, contactId || null, scope, userId, limit, offset],
  );
  return rows;
}

async function insertQuotation(
  client,
  {
    quoteNumber,
    contact_id,
    deal_id,
    assigned_to,
    valid_until,
    subtotal,
    discountTotal,
    vatTotal,
    total,
    payment_terms,
    notes,
    terms_conditions,
    userId,
  },
) {
  const {
    rows: [q],
  } = await client.query(
    `INSERT INTO quotations
       (quotation_number, contact_id, deal_id, assigned_to, status,
        valid_until, subtotal, discount_total, vat_amount, total_amount,
        payment_terms, notes, terms_conditions, created_by)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      quoteNumber,
      contact_id,
      deal_id || null,
      assigned_to,
      valid_until,
      subtotal,
      discountTotal,
      vatTotal,
      total,
      payment_terms || null,
      notes || null,
      terms_conditions || null,
      userId,
    ],
  );
  return q;
}

async function insertQuotationLine(
  client,
  {
    quotation_id,
    product_id,
    description,
    quantity,
    unit_price,
    discount_pct,
    disc,
    lineTotal,
    order,
  },
) {
  await client.query(
    `INSERT INTO quotation_lines
       (quotation_id, product_id, description, quantity, unit_price,
        discount_pct, discount_amount, line_total, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      quotation_id,
      product_id || null,
      description,
      quantity,
      unit_price,
      discount_pct || 0,
      disc,
      lineTotal,
      order,
    ],
  );
}

async function findQuotationById(client, quotationId) {
  const {
    rows: [q],
  } = await client.query(
    `SELECT q.*,
            c.display_name AS contact_name, c.email, c.whatsapp_number, c.primary_phone,
            json_agg(ql.* ORDER BY ql.display_order) AS lines
     FROM quotations q
     JOIN shared.contacts c ON c.contact_id = q.contact_id
     LEFT JOIN quotation_lines ql ON ql.quotation_id = q.quotation_id
     WHERE q.quotation_id = $1 AND q.is_deleted = false
     GROUP BY q.quotation_id, c.display_name, c.email, c.whatsapp_number, c.primary_phone`,
    [quotationId],
  );
  return q || null;
}

async function getQuotationStatus(client, quotationId) {
  const {
    rows: [q],
  } = await client.query(
    `SELECT status FROM quotations WHERE quotation_id = $1`,
    [quotationId],
  );
  return q || null;
}

async function updateQuotation(client, quotationId, sets, vals) {
  const {
    rows: [updated],
  } = await client.query(
    `UPDATE quotations SET ${sets.join(", ")}, updated_at = now() WHERE quotation_id = $${vals.length} RETURNING *`,
    vals,
  );
  return updated;
}

async function setQuotationSent(client, quotationId) {
  await client.query(
    `UPDATE quotations SET status='sent', sent_at=now() WHERE quotation_id=$1 AND status='draft'`,
    [quotationId],
  );
}

async function setQuotationConfirmed(client, quotationId) {
  await client.query(
    `UPDATE quotations SET status='confirmed', confirmed_at=now() WHERE quotation_id=$1`,
    [quotationId],
  );
}

async function insertOrder(
  client,
  {
    orderNumber,
    quotationId,
    contact_id,
    fulfilment_type,
    total_amount,
    userId,
  },
) {
  const {
    rows: [order],
  } = await client.query(
    `INSERT INTO sales_orders
       (order_number, quotation_id, contact_id, status, fulfilment_type,
        total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,'confirmed',$4,$5,0,$6) RETURNING *`,
    [
      orderNumber,
      quotationId,
      contact_id,
      fulfilment_type || "walk_in",
      total_amount,
      userId,
    ],
  );
  return order;
}

async function copyQuotationLinesToOrder(client, { orderId, quotationId }) {
  await client.query(
    `INSERT INTO order_lines (order_id, product_id, description, quantity, unit_price, line_total, status)
     SELECT $1, product_id, description, quantity, unit_price, line_total, 'pending'
     FROM quotation_lines WHERE quotation_id = $2`,
    [orderId, quotationId],
  );
}

async function getOrderProductLines(client, orderId) {
  const { rows } = await client.query(
    `SELECT product_id, quantity FROM order_lines WHERE order_id=$1 AND product_id IS NOT NULL`,
    [orderId],
  );
  return rows;
}

// NOTE: reserveStock was removed in Sprint 5 polish. It silently
// swallowed errors via `.catch(() => {})`, which meant orders could
// quietly fail to reserve stock without anyone noticing. It also
// didn't check availability before inserting.
//
// All callers now go through movementsService.createReservation
// (modules/stock/movements.service.js) which:
//   - validates availability with a stock check
//   - throws a 409 on insufficient stock instead of silently no-op'ing
//   - emits a socket event for real-time UI updates
//   - audit-logs the reservation

async function listOrders(client, { status, limit, offset }) {
  const { rows } = await client.query(
    `SELECT o.order_id, o.order_number, o.status, o.total_amount,
            o.amount_paid, o.amount_outstanding, o.created_at,
            c.display_name AS contact_name
     FROM sales_orders o
     JOIN shared.contacts c ON c.contact_id = o.contact_id
     WHERE ($1::TEXT IS NULL OR o.status = $1)
     ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
    [status || null, limit, offset],
  );
  return rows;
}

async function findOrderById(client, orderId) {
  const {
    rows: [order],
  } = await client.query(
    `SELECT o.*, c.display_name AS contact_name, c.primary_phone,
            json_agg(ol.* ORDER BY ol.line_id) AS lines
     FROM sales_orders o
     JOIN shared.contacts c ON c.contact_id = o.contact_id
     LEFT JOIN order_lines ol ON ol.order_id = o.order_id
     WHERE o.order_id = $1
     GROUP BY o.order_id, c.display_name, c.primary_phone`,
    [orderId],
  );
  return order || null;
}

module.exports = {
  listQuotations,
  insertQuotation,
  insertQuotationLine,
  findQuotationById,
  getQuotationStatus,
  updateQuotation,
  setQuotationSent,
  setQuotationConfirmed,
  insertOrder,
  copyQuotationLinesToOrder,
  getOrderProductLines,
  listOrders,
  findOrderById,
};
