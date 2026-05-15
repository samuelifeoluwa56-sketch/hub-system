"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const movements = require("./movements.service");
const valuation = require("./valuation.service");
const repo = require("./stock.repository");

// ─────────────────────────────────────────────────────────────
// Stock service — coordination layer for the stock module.
//
// Heavy lifting lives in two sub-services:
//   - movements.service.js → all writes to stock_movements and reservations
//   - valuation.service.js → cost basis, COGS, total stock value
//
// This file orchestrates: current-stock queries, transfers, adjustments,
// low-stock alerts, location list. It re-exports the public API of both
// sub-services so external callers (POS, sales, purchasing, invoicing,
// logistics, retail-partners, dashboards) have a single import path:
//
//   const stockService = require("../stock/stock.service");
//   await stockService.recordMovement(...);   // from movements
//   await stockService.calculateLineCOGS(...); // from valuation
//
// This prevents the cross-module-boundary smell of every consumer
// reaching into ../stock/valuation.service directly.
// ─────────────────────────────────────────────────────────────

async function getCurrentStock(
  business,
  { locationId, search, belowReorder } = {},
) {
  return withBusinessContext(business, async (client) => {
    const rows = await repo.getCurrentStock(client, {
      locationId,
      search,
      belowReorder,
    });
    return { data: rows };
  });
}

async function getMovements(
  business,
  productId,
  { page = 1, limit = 50 } = {},
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await repo.getMovements(client, productId, {
      limit: parseInt(limit),
      offset,
    });
    return { data: rows };
  });
}

async function createAdjustment(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const currentQty = await repo.getCurrentQty(client, data.product_id);
    const diff = data.quantity_after - currentQty;
    const direction = diff >= 0 ? 1 : -1;

    if (diff === 0) return { message: "No adjustment needed" };

    const adj = await repo.insertAdjustment(client, {
      product_id: data.product_id,
      location_id: data.location_id,
      adjustment_type: data.adjustment_type,
      currentQty,
      quantity_after: data.quantity_after,
      reason: data.reason,
      userId: user.user_id,
    });

    await movements.recordMovement(client, {
      business,
      productId: data.product_id,
      movementType: "adjustment",
      quantity: Math.abs(diff),
      direction,
      toLocationId: direction === 1 ? data.location_id : null,
      fromLocationId: direction === -1 ? data.location_id : null,
      referenceType: "adjustment",
      referenceId: adj.adjustment_id,
      notes: data.reason,
      performedBy: user.user_id,
    });

    return adj;
  });
}

async function createTransfer(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const transferNumber = await nextDocumentNumber(
      client,
      business,
      "transfer",
    );
    const transfer = await repo.insertTransfer(client, {
      transferNumber,
      from_location_id: data.from_location_id,
      to_location_id: data.to_location_id,
      userId: user.user_id,
    });

    for (const item of data.items) {
      await movements.recordMovement(client, {
        business,
        productId: item.product_id,
        movementType: "transferred_out",
        quantity: item.quantity,
        direction: -1,
        fromLocationId: data.from_location_id,
        referenceType: "transfer",
        referenceId: transfer.transfer_id,
        performedBy: user.user_id,
      });
      await movements.recordMovement(client, {
        business,
        productId: item.product_id,
        movementType: "transferred_in",
        quantity: item.quantity,
        direction: 1,
        toLocationId: data.to_location_id,
        referenceType: "transfer",
        referenceId: transfer.transfer_id,
        performedBy: user.user_id,
      });
    }

    return transfer;
  });
}

async function getLowStockAlerts(business) {
  return withBusinessContext(business, async (client) => {
    const rows = await repo.getLowStockAlerts(client);
    return { data: rows };
  });
}

async function getLocations(business) {
  return withBusinessContext(business, async (client) => {
    const rows = await repo.getLocations(client);
    return { data: rows };
  });
}

module.exports = {
  getCurrentStock,
  getMovements,
  // ── Movements (re-exported from movements.service) ──────────
  // POS, sales, purchasing, logistics already import these via
  // stock.service so the import paths stay stable across modules.
  recordMovement: movements.recordMovement,
  checkLowStock: movements.checkLowStock,
  getAvailableQty: movements.getAvailableQty,
  createReservation: movements.createReservation,
  releaseReservation: movements.releaseReservation,
  convertReservationToSale: movements.convertReservationToSale,
  expireReservations: movements.expireReservations,
  // Semantic shortcuts for the four common movement cases.
  recordSale: movements.recordSale,
  recordReceipt: movements.recordReceipt,
  recordWriteOff: movements.recordWriteOff,
  recordReturnFromCustomer: movements.recordReturnFromCustomer,
  // ── Valuation (re-exported from valuation.service) ──────────
  // Per-product cost basis — used by POS/sales/invoicing to compute
  // COGS at the moment of sale.
  getUnitCost: valuation.getUnitCost,
  getUnitCostForBusiness: valuation.getUnitCostForBusiness,
  calculateLineCOGS: valuation.calculateLineCOGS,
  calculateSaleCOGS: valuation.calculateSaleCOGS,
  // Aggregate valuation — used by dashboards and the Balance Sheet
  // inventory note.
  getTotalValuation: valuation.getTotalValuation,
  getTotalValuationForBusiness: valuation.getTotalValuationForBusiness,
  getValuationByProduct: valuation.getValuationByProduct,
  getValuationByProductForBusiness: valuation.getValuationByProductForBusiness,
  // ── Local operations ────────────────────────────────────────
  createAdjustment,
  createTransfer,
  getLowStockAlerts,
  getLocations,
};
