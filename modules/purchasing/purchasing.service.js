"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const stockService = require("../stock/stock.service");
const auditService = require("../../shared/audit/audit.service");
const repo = require("./purchasing.repository");

async function listSuppliers(business, { page = 1, limit = 50, search } = {}) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    return {
      data: await repo.listSuppliers(client, {
        search,
        limit: parseInt(limit),
        offset,
      }),
    };
  });
}

async function createSupplier(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const n = await repo.getSupplierCount(client);
    const code = `SUP-${String(n).padStart(4, "0")}`;
    return repo.insertSupplier(client, {
      contact_id: data.contact_id,
      code,
      payment_terms_days: data.payment_terms_days,
      preferred_currency: data.preferred_currency,
      notes: data.notes,
    });
  });
}

async function getSupplier(business, supplierId) {
  return withBusinessContext(business, async (client) => {
    const s = await repo.findSupplierById(client, supplierId);
    if (!s)
      throw Object.assign(new Error("Supplier not found"), { status: 404 });
    return s;
  });
}

async function listRFQs(business, { page = 1, limit = 20, status } = {}) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    return {
      data: await repo.listRFQs(client, {
        status,
        limit: parseInt(limit),
        offset,
      }),
    };
  });
}

async function createRFQ(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const rfqNumber = await nextDocumentNumber(client, business, "rfq");
    const rfq = await repo.insertRFQ(client, {
      rfqNumber,
      title: data.title,
      response_deadline: data.response_deadline,
      notes: data.notes,
      userId: user.user_id,
    });
    for (const l of data.lines) {
      await repo.insertRFQLine(client, {
        rfq_id: rfq.rfq_id,
        product_id: l.product_id,
        description: l.description,
        quantity_needed: l.quantity_needed,
        target_price: l.target_price,
      });
    }
    return rfq;
  });
}

async function listPOs(
  business,
  { page = 1, limit = 20, status, supplierId } = {},
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    return {
      data: await repo.listPOs(client, {
        status,
        supplierId,
        limit: parseInt(limit),
        offset,
      }),
    };
  });
}

async function createPO(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const poNumber = await nextDocumentNumber(
      client,
      business,
      "purchase_order",
    );
    let subtotal = 0;
    for (const l of data.lines) subtotal += l.unit_price * l.quantity_ordered;
    const total =
      subtotal +
      (data.shipping_cost || 0) +
      (data.import_duty || 0) +
      (data.other_charges || 0);

    const po = await repo.insertPO(client, {
      poNumber,
      supplier_id: data.supplier_id,
      expected_delivery: data.expected_delivery,
      subtotal,
      shipping_cost: data.shipping_cost,
      import_duty: data.import_duty,
      other_charges: data.other_charges,
      total,
      currency: data.currency,
      exchange_rate: data.exchange_rate,
      ngn_equivalent: data.exchange_rate ? total * data.exchange_rate : null,
      notes: data.notes,
      userId: user.user_id,
    });

    for (const l of data.lines) {
      await repo.insertPOLine(client, {
        po_id: po.po_id,
        product_id: l.product_id,
        quantity_ordered: l.quantity_ordered,
        unit_price: l.unit_price,
      });
    }
    return po;
  });
}

async function getPO(business, poId) {
  return withBusinessContext(business, async (client) => {
    const po = await repo.findPOById(client, poId);
    if (!po) throw Object.assign(new Error("PO not found"), { status: 404 });
    return po;
  });
}

async function receiveGoods(business, poId, { lines, notes }, user) {
  return withBusinessContext(business, async (client) => {
    const receipt = await repo.insertGoodsReceipt(client, {
      poId,
      userId: user.user_id,
      notes,
    });

    for (const l of lines) {
      await repo.insertGoodsReceiptLine(client, {
        receipt_id: receipt.receipt_id,
        po_line_id: l.po_line_id,
        quantity_received: l.quantity_received,
        quantity_accepted: l.quantity_accepted,
        quantity_rejected: l.quantity_rejected,
        rejection_reason: l.rejection_reason,
      });
      await repo.updatePOLineReceived(client, {
        po_line_id: l.po_line_id,
        quantity_accepted: l.quantity_accepted,
      });

      if (l.quantity_accepted > 0) {
        const poLine = await repo.getPOLineProduct(client, l.po_line_id);
        if (poLine) {
          await stockService.recordMovement(client, {
            business,
            productId: poLine.product_id,
            movementType: "received",
            quantity: l.quantity_accepted,
            direction: 1,
            referenceType: "purchase_order",
            referenceId: poId,
            performedBy: user.user_id,
          });
        }
      }
    }

    await repo.updatePOStatus(client, poId);
    return receipt;
  });
}

module.exports = {
  listSuppliers,
  createSupplier,
  getSupplier,
  listRFQs,
  createRFQ,
  listPOs,
  createPO,
  getPO,
  receiveGoods,
};
