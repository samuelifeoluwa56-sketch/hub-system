'use strict';

const { withBusinessContext, nextDocumentNumber } = require('../../config/db');
const stockService = require('../stock/stock.service');
const auditService = require('../../shared/audit/audit.service');

async function listSuppliers(business, { page=1, limit=50, search }={}) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT s.supplier_id, s.supplier_code, s.payment_terms_days,
              s.preferred_currency, s.rating, s.is_active,
              c.display_name, c.email, c.primary_phone
       FROM suppliers s
       JOIN shared.contacts c ON c.contact_id = s.contact_id
       WHERE s.is_active = true
         AND ($1::TEXT IS NULL OR c.display_name ILIKE $1)
       ORDER BY c.display_name
       LIMIT $2 OFFSET $3`,
      [search ? `%${search}%` : null, parseInt(limit), (parseInt(page)-1)*parseInt(limit)]
    );
    return { data: rows };
  });
}

async function createSupplier(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const { rows: [count] } = await client.query(`SELECT COUNT(*)+1 AS n FROM suppliers`);
    const code = `SUP-${String(count.n).padStart(4,'0')}`;
    const { rows: [s] } = await client.query(
      `INSERT INTO suppliers (contact_id, supplier_code, payment_terms_days, preferred_currency, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [data.contact_id, code, data.payment_terms_days||30, data.preferred_currency||'USD', data.notes||null]
    );
    return s;
  });
}

async function getSupplier(business, supplierId) {
  return withBusinessContext(business, async (client) => {
    const { rows: [s] } = await client.query(
      `SELECT s.*, c.display_name, c.email, c.primary_phone, c.addresses
       FROM suppliers s JOIN shared.contacts c ON c.contact_id = s.contact_id
       WHERE s.supplier_id = $1`, [supplierId]
    );
    if (!s) throw Object.assign(new Error('Supplier not found'), { status: 404 });
    return s;
  });
}

async function listRFQs(business, { page=1, limit=20, status }={}) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT rfq_id, rfq_number, title, status, response_deadline, created_at
       FROM rfqs
       WHERE ($1::TEXT IS NULL OR status=$1)
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [status||null, parseInt(limit), (parseInt(page)-1)*parseInt(limit)]
    );
    return { data: rows };
  });
}

async function createRFQ(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const rfqNumber = await nextDocumentNumber(client, business, 'rfq');
    const { rows: [rfq] } = await client.query(
      `INSERT INTO rfqs (rfq_number, title, response_deadline, notes, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [rfqNumber, data.title, data.response_deadline||null, data.notes||null, user.user_id]
    );
    for (const l of data.lines) {
      await client.query(
        `INSERT INTO rfq_lines (rfq_id, product_id, description, quantity_needed, target_price)
         VALUES ($1,$2,$3,$4,$5)`,
        [rfq.rfq_id, l.product_id||null, l.description||'', l.quantity_needed, l.target_price||null]
      );
    }
    return rfq;
  });
}

async function listPOs(business, { page=1, limit=20, status, supplierId }={}) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT po.po_id, po.po_number, po.status, po.total_amount, po.currency,
              po.order_date, po.expected_delivery,
              c.display_name AS supplier_name
       FROM purchase_orders po
       JOIN suppliers s ON s.supplier_id = po.supplier_id
       JOIN shared.contacts c ON c.contact_id = s.contact_id
       WHERE po.is_deleted = false
         AND ($1::TEXT IS NULL OR po.status=$1)
         AND ($2::UUID IS NULL OR po.supplier_id=$2)
       ORDER BY po.order_date DESC LIMIT $3 OFFSET $4`,
      [status||null, supplierId||null, parseInt(limit), (parseInt(page)-1)*parseInt(limit)]
    );
    return { data: rows };
  });
}

async function createPO(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const poNumber = await nextDocumentNumber(client, business, 'purchase_order');

    let subtotal = 0;
    for (const l of data.lines) { subtotal += l.unit_price * l.quantity_ordered; }
    const total = subtotal + (data.shipping_cost||0) + (data.import_duty||0) + (data.other_charges||0);

    const { rows: [po] } = await client.query(
      `INSERT INTO purchase_orders
         (po_number, supplier_id, status, order_date, expected_delivery,
          subtotal, shipping_cost, import_duty, other_charges,
          total_amount, currency, exchange_rate, ngn_equivalent,
          notes, created_by)
       VALUES ($1,$2,'draft',CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [poNumber, data.supplier_id, data.expected_delivery||null,
       subtotal, data.shipping_cost||0, data.import_duty||0, data.other_charges||0, total,
       data.currency||'USD', data.exchange_rate||null,
       data.exchange_rate ? total*data.exchange_rate : null,
       data.notes||null, user.user_id]
    );

    for (const l of data.lines) {
      await client.query(
        `INSERT INTO po_lines (po_id, product_id, quantity_ordered, quantity_received, unit_price, line_total)
         VALUES ($1,$2,$3,0,$4,$5)`,
        [po.po_id, l.product_id, l.quantity_ordered, l.unit_price, l.unit_price*l.quantity_ordered]
      );
    }

    return po;
  });
}

async function getPO(business, poId) {
  return withBusinessContext(business, async (client) => {
    const { rows: [po] } = await client.query(
      `SELECT po.*,
              c.display_name AS supplier_name,
              json_agg(pl.* ORDER BY pl.line_id) AS lines
       FROM purchase_orders po
       JOIN suppliers s ON s.supplier_id = po.supplier_id
       JOIN shared.contacts c ON c.contact_id = s.contact_id
       LEFT JOIN po_lines pl ON pl.po_id = po.po_id
       WHERE po.po_id = $1 AND po.is_deleted = false
       GROUP BY po.po_id, c.display_name`,
      [poId]
    );
    if (!po) throw Object.assign(new Error('PO not found'), { status: 404 });
    return po;
  });
}

async function receiveGoods(business, poId, { lines, notes }, user) {
  return withBusinessContext(business, async (client) => {
    const { rows: [receipt] } = await client.query(
      `INSERT INTO goods_received (po_id, received_by, notes)
       VALUES ($1,$2,$3) RETURNING *`,
      [poId, user.user_id, notes||null]
    );

    for (const l of lines) {
      // Insert GR line
      await client.query(
        `INSERT INTO goods_received_lines
           (receipt_id, po_line_id, quantity_received, quantity_accepted, quantity_rejected,
            rejection_reason, quality_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [receipt.receipt_id, l.po_line_id, l.quantity_received,
         l.quantity_accepted, l.quantity_rejected||0,
         l.rejection_reason||null,
         l.quantity_rejected > 0 ? 'partially_rejected' : 'accepted']
      );

      // Update PO line received qty
      await client.query(
        `UPDATE po_lines SET quantity_received = quantity_received + $1 WHERE line_id = $2`,
        [l.quantity_accepted, l.po_line_id]
      );

      // Create stock movement for accepted qty
      if (l.quantity_accepted > 0) {
        const { rows: [poLine] } = await client.query(
          `SELECT pl.product_id, po.supplier_id
           FROM po_lines pl JOIN purchase_orders po ON po.po_id = pl.po_id
           WHERE pl.line_id = $1`, [l.po_line_id]
        );

        await stockService.recordMovement(client, {
          business,
          productId:    poLine.product_id,
          movementType: 'received',
          quantity:     l.quantity_accepted,
          direction:    1,
          referenceType:'purchase_order',
          referenceId:  poId,
          performedBy:  user.user_id,
        });
      }
    }

    // Update PO status
    await client.query(
      `UPDATE purchase_orders
       SET status = CASE
         WHEN (SELECT SUM(quantity_ordered - quantity_received) FROM po_lines WHERE po_id=$1) = 0
           THEN 'received'
           ELSE 'partially_received'
         END
       WHERE po_id=$1`,
      [poId]
    );

    return receipt;
  });
}

module.exports = { listSuppliers, createSupplier, getSupplier,
                   listRFQs, createRFQ, listPOs, createPO, getPO, receiveGoods };
