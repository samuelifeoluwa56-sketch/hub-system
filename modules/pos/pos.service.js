"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const stockService = require("../stock/stock.service");
const notifService = require("../../shared/notifications/notifications.service");
const auditService = require("../../shared/audit/audit.service");
const { emitToBusiness } = require("../../config/sockets");
const repo = require("./pos.repository");

async function getTerminals(business) {
  return withBusinessContext(business, async (client) => {
    const rows = await repo.getTerminals(client);
    return { data: rows };
  });
}

async function openSession(business, { terminal_id, opening_float = 0 }, user) {
  return withBusinessContext(business, async (client) => {
    const existing = await repo.findOpenSession(client, terminal_id);
    if (existing.length)
      throw Object.assign(new Error("Terminal already has an open session"), {
        status: 409,
      });

    const session = await repo.insertSession(client, {
      terminal_id,
      userId: user.user_id,
      opening_float,
    });
    emitToBusiness(business, "pos:session_opened", {
      sessionId: session.session_id,
      terminalId: terminal_id,
    });
    return session;
  });
}

async function getSession(business, sessionId) {
  return withBusinessContext(business, async (client) => {
    const session = await repo.findSessionById(client, sessionId);
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
    const totals = await repo.getSessionTotals(client, sessionId);

    const session = await repo.closeSession(client, {
      sessionId,
      userId: user.user_id,
      actual_cash,
      expected_cash: totals.cash_total,
      transfer_total: totals.transfer_total,
      card_total: totals.card_total,
      total_revenue: totals.total_revenue,
      reconciliation_notes,
    });
    if (!session)
      throw Object.assign(new Error("Session not found or already closed"), {
        status: 400,
      });

    const txCount = await repo.getSessionTxCount(client, sessionId);
    await repo.insertSessionSummary(client, {
      sessionId,
      total: txCount.total,
      voided: txCount.voided,
      total_revenue: totals.total_revenue,
      cash_total: totals.cash_total,
      card_total: totals.card_total,
      transfer_total: totals.transfer_total,
    });

    emitToBusiness(business, "pos:session_closed", { sessionId });
    return session;
  });
}

async function createTransaction(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const session = await repo.validateOpenSession(client, data.session_id);
    if (!session)
      throw Object.assign(new Error("No open session found"), { status: 400 });

    // Check minimum price per line
    for (const line of data.lines) {
      if (!line.product_id) continue;
      const prod = await repo.getProductMinPrice(client, line.product_id);
      if (
        prod?.min_selling_price &&
        parseFloat(line.unit_price) < parseFloat(prod.min_selling_price)
      ) {
        const da = await repo.insertDiscountApproval(client, {
          sessionId: data.session_id,
          productId: line.product_id,
          unitPrice: line.unit_price,
          minPrice: prod.min_selling_price,
          userId: user.user_id,
        });
        const managers = await repo.getManagers(client, business);
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

    let subtotal = 0,
      discountTotal = 0,
      vatTotal = 0;
    for (const l of data.lines) {
      const net = l.unit_price * l.quantity - (l.discount_amount || 0);
      discountTotal += l.discount_amount || 0;
      subtotal += net;
      vatTotal += net * 0.075;
    }
    const totalAmount = subtotal + vatTotal;
    const totalPaid = data.payments.reduce(
      (s, p) => s + parseFloat(p.amount),
      0,
    );
    const change = Math.max(0, totalPaid - totalAmount);

    const txNumber = await nextDocumentNumber(client, business, "receipt");
    const tx = await repo.insertTransaction(client, {
      txNumber,
      session_id: data.session_id,
      contact_id: data.contact_id,
      userId: user.user_id,
      subtotal,
      discountTotal,
      vatTotal,
      totalAmount,
      totalPaid,
      change,
      fulfilment_type: data.fulfilment_type,
    });

    for (let i = 0; i < data.lines.length; i++) {
      const l = data.lines[i];
      const net = l.unit_price * l.quantity - (l.discount_amount || 0);
      const vat = net * 0.075;
      await repo.insertTransactionLine(client, {
        transaction_id: tx.transaction_id,
        product_id: l.product_id,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price,
        discount_amount: l.discount_amount,
        vat,
        lineTotal: net + vat,
        order: i,
      });
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

    for (const p of data.payments) {
      await repo.insertPaymentSplit(client, {
        transaction_id: tx.transaction_id,
        payment_method: p.payment_method,
        amount: p.amount,
        reference: p.reference,
        paystack_reference: p.paystack_reference,
      });
    }

    const transferAmt = data.payments
      .filter((p) => p.payment_method === "bank_transfer")
      .reduce((s, p) => s + parseFloat(p.amount), 0);
    const cardAmt = data.payments
      .filter((p) => p.payment_method === "pos_card")
      .reduce((s, p) => s + parseFloat(p.amount), 0);
    await repo.updateSessionTotals(client, {
      totalAmount,
      transferAmt,
      cardAmt,
      session_id: data.session_id,
    });

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
    const tx = await repo.findTransactionById(client, transactionId);
    if (!tx)
      throw Object.assign(new Error("Transaction not found"), { status: 404 });
    return tx;
  });
}

async function voidTransaction(business, transactionId, { void_reason }, user) {
  return withBusinessContext(business, async (client) => {
    const tx = await repo.voidTransaction(client, {
      transactionId,
      userId: user.user_id,
      void_reason,
    });
    if (!tx)
      throw Object.assign(new Error("Transaction cannot be voided"), {
        status: 400,
      });

    const lines = await repo.getTransactionProductLines(client, transactionId);
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
