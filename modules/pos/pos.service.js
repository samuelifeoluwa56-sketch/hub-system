"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const stockService = require("../stock/stock.service");
const notifService = require("../../shared/notifications/notifications.service");
const auditService = require("../../shared/audit/audit.service");
const { emitToBusiness } = require("../../config/sockets");

async function getTerminals(business) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT t.terminal_id, t.name, t.is_active,
              l.name AS location_name, l.location_type,
              s.session_id, s.status AS session_status,
              s.opened_by, s.opened_at, s.total_revenue
       FROM pos_terminals t
       JOIN stock_locations l ON l.location_id = t.location_id
       LEFT JOIN pos_sessions s ON s.terminal_id = t.terminal_id AND s.status = 'open'
       WHERE t.is_active = true ORDER BY t.name`,
    );
    return { data: rows };
  });
}

async function openSession(business, { terminal_id, opening_float = 0 }, user) {
  return withBusinessContext(business, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT session_id FROM pos_sessions WHERE terminal_id=$1 AND status='open'`,
      [terminal_id],
    );
    if (existing.length)
      throw Object.assign(new Error("Terminal already has an open session"), {
        status: 409,
      });

    const {
      rows: [session],
    } = await client.query(
      `INSERT INTO pos_sessions (terminal_id, opened_by, opening_float)
       VALUES ($1,$2,$3) RETURNING *`,
      [terminal_id, user.user_id, opening_float],
    );
    emitToBusiness(business, "pos:session_opened", {
      sessionId: session.session_id,
      terminalId: terminal_id,
    });
    return session;
  });
}

async function getSession(business, sessionId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [session],
    } = await client.query(
      `SELECT s.*, t.name AS terminal_name, u.email AS opened_by_email,
              COUNT(pt.transaction_id) AS transaction_count,
              COALESCE(SUM(pt.total_amount) FILTER (WHERE pt.status='completed'),0) AS session_revenue
       FROM pos_sessions s
       JOIN pos_terminals t ON t.terminal_id = s.terminal_id
       JOIN shared.users u  ON u.user_id = s.opened_by
       LEFT JOIN pos_transactions pt ON pt.session_id = s.session_id
       WHERE s.session_id = $1
       GROUP BY s.session_id, t.name, u.email`,
      [sessionId],
    );
    if (!session)
      throw Object.assign(new Error("Session not found"), { status: 404 });
    return session;
  });
}

async function closeSession(
  business,
  sessionId,
  { actual_cash, reconciliation_notes },
  user,
) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [totals],
    } = await client.query(
      `SELECT
         COALESCE(SUM(ps.amount) FILTER (WHERE ps.payment_method='cash'),0)          AS cash_total,
         COALESCE(SUM(ps.amount) FILTER (WHERE ps.payment_method='bank_transfer'),0)  AS transfer_total,
         COALESCE(SUM(ps.amount) FILTER (WHERE ps.payment_method='pos_card'),0)       AS card_total,
         COALESCE(SUM(ps.amount),0)                                                   AS total_revenue
       FROM pos_transactions pt
       JOIN pos_payment_splits ps ON ps.transaction_id = pt.transaction_id
       WHERE pt.session_id=$1 AND pt.status='completed'`,
      [sessionId],
    );

    const {
      rows: [session],
    } = await client.query(
      `UPDATE pos_sessions
       SET status='closed', closed_by=$1, closed_at=now(),
           actual_cash=$2, expected_cash=$3,
           total_transfers=$4, total_card=$5, total_revenue=$6,
           reconciliation_notes=$7
       WHERE session_id=$8 AND status='open' RETURNING *`,
      [
        user.user_id,
        actual_cash,
        totals.cash_total,
        totals.transfer_total,
        totals.card_total,
        totals.total_revenue,
        reconciliation_notes || null,
        sessionId,
      ],
    );
    if (!session)
      throw Object.assign(new Error("Session not found or already closed"), {
        status: 400,
      });

    const {
      rows: [txCount],
    } = await client.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status='voided') AS voided
       FROM pos_transactions WHERE session_id=$1`,
      [sessionId],
    );

    await client.query(
      `INSERT INTO pos_session_summary
         (session_id, total_transactions, voided_transactions,
          total_revenue, cash_total, card_total, transfer_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        sessionId,
        txCount.total,
        txCount.voided,
        totals.total_revenue,
        totals.cash_total,
        totals.card_total,
        totals.transfer_total,
      ],
    );

    emitToBusiness(business, "pos:session_closed", { sessionId });
    return session;
  });
}

async function createTransaction(business, data, user) {
  return withBusinessContext(business, async (client) => {
    // Validate session open
    const {
      rows: [session],
    } = await client.query(
      `SELECT session_id FROM pos_sessions WHERE session_id=$1 AND status='open'`,
      [data.session_id],
    );
    if (!session)
      throw Object.assign(new Error("No open session found"), { status: 400 });

    // Check minimum price per line
    for (const line of data.lines) {
      if (!line.product_id) continue;
      const {
        rows: [prod],
      } = await client.query(
        `SELECT min_selling_price FROM products WHERE product_id=$1`,
        [line.product_id],
      );
      if (
        prod?.min_selling_price &&
        parseFloat(line.unit_price) < parseFloat(prod.min_selling_price)
      ) {
        const {
          rows: [da],
        } = await client.query(
          `INSERT INTO discount_approvals
             (reference_type, reference_id, product_id, requested_price, min_price, requested_by)
           VALUES ('pos_transaction', $1, $2, $3, $4, $5) RETURNING approval_id`,
          [
            data.session_id,
            line.product_id,
            line.unit_price,
            prod.min_selling_price,
            user.user_id,
          ],
        );
        // Notify managers
        const { rows: managers } = await client.query(
          `SELECT u.user_id FROM shared.users u
           JOIN shared.user_roles ur ON ur.user_id=u.user_id
           JOIN shared.roles r ON r.role_id=ur.role_id
           WHERE r.role_name IN ('owner','manager') AND (ur.business=$1 OR ur.business='*')`,
          [business],
        );
        for (const m of managers) {
          await notifService.create(client, {
            userId: m.user_id,
            business,
            type: "approval_required",
            title: "Discount approval required",
            body: `Staff requesting price below minimum. Approval ID: ${da.approval_id}`,
            referenceType: "discount_approval",
            referenceId: da.approval_id,
          });
        }
        throw Object.assign(
          new Error(
            `Price below minimum. Approval requested: ${da.approval_id}`,
          ),
          { status: 402, approvalId: da.approval_id },
        );
      }
    }

    // Calculate totals
    let subtotal = 0,
      discountTotal = 0,
      vatTotal = 0;
    for (const l of data.lines) {
      const lineBase = l.unit_price * l.quantity;
      const disc = l.discount_amount || 0;
      const net = lineBase - disc;
      const vat = net * 0.075;
      subtotal += net;
      discountTotal += disc;
      vatTotal += vat;
    }
    const totalAmount = subtotal + vatTotal;
    const totalPaid = data.payments.reduce(
      (s, p) => s + parseFloat(p.amount),
      0,
    );
    const change = Math.max(0, totalPaid - totalAmount);

    // Create transaction
    const txNumber = await nextDocumentNumber(client, business, "receipt");
    const {
      rows: [tx],
    } = await client.query(
      `INSERT INTO pos_transactions
         (transaction_number, session_id, contact_id, served_by,
          subtotal, discount_total, vat_amount, total_amount,
          amount_paid, change_given, fulfilment_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed') RETURNING *`,
      [
        txNumber,
        data.session_id,
        data.contact_id || null,
        user.user_id,
        subtotal,
        discountTotal,
        vatTotal,
        totalAmount,
        totalPaid,
        change,
        data.fulfilment_type || "walk_in",
      ],
    );

    // Insert lines + deduct stock
    for (let i = 0; i < data.lines.length; i++) {
      const l = data.lines[i];
      const net = l.unit_price * l.quantity - (l.discount_amount || 0);
      const vat = net * 0.075;
      await client.query(
        `INSERT INTO pos_transaction_lines
           (transaction_id, product_id, description, quantity, unit_price,
            discount_amount, vat_amount, line_total, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tx.transaction_id,
          l.product_id || null,
          l.description,
          l.quantity,
          l.unit_price,
          l.discount_amount || 0,
          vat,
          net + vat,
          i,
        ],
      );
      if (l.product_id) {
        await stockService.recordMovement(client, {
          business,
          productId: l.product_id,
          movementType: "pos_sale",
          quantity: l.quantity,
          direction: -1,
          referenceType: "pos_transaction",
          referenceId: tx.transaction_id,
          performedBy: user.user_id,
        });
      }
    }

    // Insert payment splits
    for (const p of data.payments) {
      await client.query(
        `INSERT INTO pos_payment_splits
           (transaction_id, payment_method, amount, reference, paystack_reference, confirmed)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          tx.transaction_id,
          p.payment_method,
          p.amount,
          p.reference || null,
          p.paystack_reference || null,
          p.payment_method !== "bank_transfer",
        ],
      );
    }

    // Update session running totals
    const transferAmt = data.payments
      .filter((p) => p.payment_method === "bank_transfer")
      .reduce((s, p) => s + parseFloat(p.amount), 0);
    const cardAmt = data.payments
      .filter((p) => p.payment_method === "pos_card")
      .reduce((s, p) => s + parseFloat(p.amount), 0);
    await client.query(
      `UPDATE pos_sessions
       SET total_revenue=$1, total_transfers=total_transfers+$2, total_card=total_card+$3
       WHERE session_id=$4`,
      [totalAmount, transferAmt, cardAmt, data.session_id],
    );

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "pos",
      action: "create",
      table: "pos_transactions",
      recordId: tx.transaction_id,
      after: tx,
    });

    emitToBusiness(business, "pos:transaction_completed", {
      transactionId: tx.transaction_id,
      amount: totalAmount,
    });
    return { ...tx, change_given: change };
  });
}

async function getTransaction(business, transactionId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [tx],
    } = await client.query(
      `SELECT pt.*,
              json_agg(DISTINCT ptl.*) FILTER (WHERE ptl.line_id IS NOT NULL)  AS lines,
              json_agg(DISTINCT pps.*) FILTER (WHERE pps.split_id IS NOT NULL) AS payments,
              c.display_name AS contact_name, c.primary_phone
       FROM pos_transactions pt
       LEFT JOIN pos_transaction_lines ptl ON ptl.transaction_id = pt.transaction_id
       LEFT JOIN pos_payment_splits    pps ON pps.transaction_id = pt.transaction_id
       LEFT JOIN shared.contacts c         ON c.contact_id = pt.contact_id
       WHERE pt.transaction_id=$1
       GROUP BY pt.transaction_id, c.display_name, c.primary_phone`,
      [transactionId],
    );
    if (!tx)
      throw Object.assign(new Error("Transaction not found"), { status: 404 });
    return tx;
  });
}

async function voidTransaction(business, transactionId, { void_reason }, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [tx],
    } = await client.query(
      `UPDATE pos_transactions SET status='voided', voided_by=$1, void_reason=$2
       WHERE transaction_id=$3 AND status='completed' RETURNING *`,
      [user.user_id, void_reason, transactionId],
    );
    if (!tx)
      throw Object.assign(new Error("Transaction cannot be voided"), {
        status: 400,
      });

    // Reverse stock
    const { rows: lines } = await client.query(
      `SELECT product_id, quantity FROM pos_transaction_lines
       WHERE transaction_id=$1 AND product_id IS NOT NULL`,
      [transactionId],
    );
    for (const l of lines) {
      await stockService.recordMovement(client, {
        business,
        productId: l.product_id,
        movementType: "returned_from_customer",
        quantity: l.quantity,
        direction: 1,
        referenceType: "pos_transaction",
        referenceId: transactionId,
        performedBy: user.user_id,
        notes: `Void: ${void_reason}`,
      });
    }

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "pos",
      action: "delete",
      table: "pos_transactions",
      recordId: transactionId,
      before: tx,
    });

    return tx;
  });
}

async function sendReceipt(business, transactionId, { channel = "whatsapp" }) {
  const tx = await getTransaction(business, transactionId);
  if (channel === "whatsapp" && tx.primary_phone) {
    const whatsapp = require("../../integrations/messaging/adapters/whatsapp");
    await whatsapp.sendMessage({
      to: tx.primary_phone,
      text: `Receipt ${tx.transaction_number} — Total: ₦${Number(tx.total_amount).toLocaleString()}. Change: ₦${Number(tx.change_given).toLocaleString()}. Thank you for shopping with us!`,
    });
  }
  return { message: "Receipt sent" };
}

module.exports = {
  getTerminals,
  openSession,
  getSession,
  closeSession,
  createTransaction,
  getTransaction,
  voidTransaction,
  sendReceipt,
};
