"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const notifService = require("../../shared/notifications/notifications.service");
const auditService = require("../../shared/audit/audit.service");
const { renderToPDF } = require("../../lib/pdf/generator");
const { sendWithAttachment } = require("../../lib/email/sender");
const whatsapp = require("../../integrations/messaging/adapters/whatsapp");
const logger = require("../../config/logger");
const repo = require("./invoicing.repository");

async function list(
  business,
  { page = 1, limit = 50, status, contactId },
  scope,
  user,
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await repo.list(client, {
      status,
      contactId,
      scope,
      userId: user.user_id,
      limit: parseInt(limit),
      offset,
    });
    return { data: rows };
  });
}

async function getById(business, invoiceId) {
  return withBusinessContext(business, async (client) =>
    repo.findById(client, invoiceId),
  );
}

async function create(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const invoiceNumber = await nextDocumentNumber(client, business, "invoice");

    let subtotal = 0,
      vatTotal = 0;
    for (const line of data.lines) {
      const lineTotal =
        line.unit_price * line.quantity - (line.discount_amount || 0);
      const vatAmt = lineTotal * (line.vat_rate || 0.075);
      subtotal += lineTotal;
      vatTotal += vatAmt;
    }
    const total = subtotal + vatTotal - (data.discount_total || 0);

    const inv = await repo.insert(client, {
      invoiceNumber,
      invoice_type: data.invoice_type,
      contact_id: data.contact_id,
      order_id: data.order_id,
      due_date: data.due_date,
      subtotal,
      discount_total: data.discount_total,
      vatTotal,
      total,
      currency: data.currency,
      notes: data.notes,
      payment_instructions: data.payment_instructions,
      userId: user.user_id,
    });

    for (let i = 0; i < data.lines.length; i++) {
      const l = data.lines[i];
      const lineTotal = l.unit_price * l.quantity - (l.discount_amount || 0);
      const vatAmt = lineTotal * (l.vat_rate || 0.075);
      await repo.insertLine(client, {
        invoice_id: inv.invoice_id,
        product_id: l.product_id,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price,
        discount_amount: l.discount_amount,
        vat_rate: l.vat_rate,
        vatAmt,
        lineTotal: lineTotal + vatAmt,
        order: i,
      });
    }

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
  const ar = await repo.getARAccount(client);
  const rev = await repo.getRevenueAccount(client);
  const vat = await repo.getVATAccount(client);
  if (!ar || !rev) return;

  const entry = await repo.insertJournalEntry(client, {
    description: `Invoice ${invoice.invoice_number}`,
    referenceId: invoice.invoice_id,
    createdBy: invoice.created_by,
  });
  if (!entry) return;

  await repo.insertJournalLines(client, {
    entryId: entry.entry_id,
    arId: ar.account_id,
    totalAmount: invoice.total_amount,
    revId: rev.account_id,
    subtotal: invoice.subtotal,
    vatId: vat?.account_id,
    vatAmount: invoice.vat_amount,
  });
}

async function recordPayment(business, invoiceId, data, user) {
  return withBusinessContext(business, async (client) => {
    const payment = await repo.insertPayment(client, {
      invoiceId,
      payment_date: data.payment_date,
      amount: data.amount,
      payment_method: data.payment_method,
      reference: data.reference,
      paystack_reference: data.paystack_reference,
      is_confirmed: data.is_confirmed,
      userId: user.user_id,
      notes: data.notes,
    });

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

  await withBusinessContext(business, async (client) =>
    repo.setSent(client, invoiceId),
  );
}

async function voidInvoice(business, invoiceId, user) {
  return withBusinessContext(business, async (client) => {
    const inv = await repo.setVoided(client, invoiceId);
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
