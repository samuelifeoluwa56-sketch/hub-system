"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const { renderToPDF } = require("../../lib/pdf/generator");
const { sendEmail } = require("../../lib/email/sender");
const whatsapp = require("../../integrations/messaging/adapters/whatsapp");
const auditService = require("../../shared/audit/audit.service");
const crmService = require("../crm/crm.service");

async function listQuotations(
  business,
  { page = 1, limit = 50, status, contactId } = {},
  user,
  scope,
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
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

async function createQuotation(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const quoteNumber = await nextDocumentNumber(client, business, "quotation");

    let subtotal = 0,
      discountTotal = 0,
      vatTotal = 0;
    for (const l of data.lines) {
      const lt = l.unit_price * l.quantity;
      const disc = l.discount_amount || (lt * (l.discount_pct || 0)) / 100;
      const net = lt - disc;
      const vat = net * 0.075;
      subtotal += net;
      discountTotal += disc;
      vatTotal += vat;
    }
    const total = subtotal + vatTotal;

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
        data.contact_id,
        data.deal_id || null,
        data.assigned_to || user.user_id,
        data.valid_until,
        subtotal,
        discountTotal,
        vatTotal,
        total,
        data.payment_terms || null,
        data.notes || null,
        data.terms_conditions || null,
        user.user_id,
      ],
    );

    for (let i = 0; i < data.lines.length; i++) {
      const l = data.lines[i];
      const lt = l.unit_price * l.quantity;
      const disc = l.discount_amount || (lt * (l.discount_pct || 0)) / 100;
      await client.query(
        `INSERT INTO quotation_lines
           (quotation_id, product_id, description, quantity, unit_price,
            discount_pct, discount_amount, line_total, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          q.quotation_id,
          l.product_id || null,
          l.description,
          l.quantity,
          l.unit_price,
          l.discount_pct || 0,
          disc,
          lt - disc,
          i,
        ],
      );
    }

    if (data.deal_id) {
      await crmService.logActivity(
        business,
        data.deal_id,
        {
          activity_type: "quotation_sent",
          summary: `Quotation ${quoteNumber} created`,
          is_auto: true,
        },
        user,
        client,
      );
    }

    return q;
  });
}

async function getQuotation(business, quotationId) {
  return withBusinessContext(business, async (client) => {
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
    if (!q)
      throw Object.assign(new Error("Quotation not found"), { status: 404 });
    return q;
  });
}

async function updateQuotation(business, quotationId, data, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [q],
    } = await client.query(
      `SELECT status FROM quotations WHERE quotation_id = $1`,
      [quotationId],
    );
    if (!q) throw Object.assign(new Error("Not found"), { status: 404 });
    if (!["draft"].includes(q.status)) {
      throw Object.assign(new Error("Only draft quotations can be edited"), {
        status: 400,
      });
    }
    const allowed = [
      "valid_until",
      "payment_terms",
      "notes",
      "terms_conditions",
    ];
    const sets = [],
      vals = [];
    for (const f of allowed) {
      if (data[f] !== undefined) {
        vals.push(data[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return q;
    vals.push(quotationId);
    const {
      rows: [updated],
    } = await client.query(
      `UPDATE quotations SET ${sets.join(", ")}, updated_at = now()
       WHERE quotation_id = $${vals.length} RETURNING *`,
      vals,
    );
    return updated;
  });
}

async function sendQuotation(
  business,
  quotationId,
  { channel = "email" },
  user,
) {
  const q = await getQuotation(business, quotationId);
  const pdf = await generateQuotationPDF(business, quotationId);

  if (channel === "email" && q.email) {
    await sendEmail({
      to: q.email,
      subject: `Quotation ${q.quotation_number}`,
      html: `<p>Dear ${q.contact_name}, please find attached your quotation ${q.quotation_number} valid until ${q.valid_until}.</p>`,
      attachments: [
        {
          filename: `${q.quotation_number}.pdf`,
          content: pdf,
          contentType: "application/pdf",
        },
      ],
    });
  } else if (channel === "whatsapp" && q.whatsapp_number) {
    await whatsapp.sendMessage({
      to: q.whatsapp_number,
      text: `Dear ${q.contact_name}, your quotation ${q.quotation_number} for ₦${Number(q.total_amount).toLocaleString()} is valid until ${q.valid_until}.`,
    });
  }

  await withBusinessContext(business, async (client) => {
    await client.query(
      `UPDATE quotations SET status='sent', sent_at=now()
       WHERE quotation_id=$1 AND status='draft'`,
      [quotationId],
    );
  });

  return { message: "Quotation sent" };
}

async function confirmQuotation(business, quotationId, user) {
  return withBusinessContext(business, async (client) => {
    const q = await getQuotation(business, quotationId);
    if (!["sent", "viewed", "draft"].includes(q.status)) {
      throw Object.assign(new Error("Quotation cannot be confirmed"), {
        status: 400,
      });
    }

    const orderNumber = await nextDocumentNumber(
      client,
      business,
      "sales_order",
    );
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
        q.contact_id,
        q.fulfilment_type || "walk_in",
        q.total_amount,
        user.user_id,
      ],
    );

    // Copy quotation lines to order lines
    await client.query(
      `INSERT INTO order_lines (order_id, product_id, description, quantity, unit_price, line_total, status)
       SELECT $1, product_id, description, quantity, unit_price, line_total, 'pending'
       FROM quotation_lines WHERE quotation_id = $2`,
      [order.order_id, quotationId],
    );

    await client.query(
      `UPDATE quotations SET status='confirmed', confirmed_at=now()
       WHERE quotation_id=$1`,
      [quotationId],
    );

    // Reserve stock for all product lines
    const { rows: lines } = await client.query(
      `SELECT product_id, quantity FROM order_lines WHERE order_id=$1 AND product_id IS NOT NULL`,
      [order.order_id],
    );
    for (const l of lines) {
      await client
        .query(
          `INSERT INTO stock_reservations
           (product_id, quantity, reserved_for, expires_at, status)
         SELECT $1, $2, o.contact_id, now() + INTERVAL '7 days', 'active'
         FROM sales_orders o WHERE o.order_id = $3`,
          [l.product_id, l.quantity, order.order_id],
        )
        .catch(() => {}); // Non-fatal if stock service not available
    }

    return order;
  });
}

async function listOrders(business, { page = 1, limit = 50, status } = {}) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await client.query(
      `SELECT o.order_id, o.order_number, o.status, o.total_amount,
              o.amount_paid, o.amount_outstanding, o.created_at,
              c.display_name AS contact_name
       FROM sales_orders o
       JOIN shared.contacts c ON c.contact_id = o.contact_id
       WHERE ($1::TEXT IS NULL OR o.status = $1)
       ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
      [status || null, parseInt(limit), offset],
    );
    return { data: rows };
  });
}

async function getOrder(business, orderId) {
  return withBusinessContext(business, async (client) => {
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
    if (!order)
      throw Object.assign(new Error("Order not found"), { status: 404 });
    return order;
  });
}

async function generateQuotationPDF(business, quotationId) {
  const q = await getQuotation(business, quotationId);
  return renderToPDF("quotations", q);
}

module.exports = {
  listQuotations,
  createQuotation,
  getQuotation,
  updateQuotation,
  sendQuotation,
  confirmQuotation,
  listOrders,
  getOrder,
  generateQuotationPDF,
};
