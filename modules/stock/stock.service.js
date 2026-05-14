"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const movements = require("./movements.service");
const repo = require("./stock.repository");

// ─────────────────────────────────────────────────────────────
// Stock service — coordination layer for the stock module.
//
// Heavy lifting lives in two sub-services:
//   - movements.service.js → all writes to stock_movements and reservations
//   - valuation.service.js → cost basis, COGS, total stock value
//
// This file orchestrates: current-stock queries, transfers, adjustments,
// low-stock alerts, location list. It re-exports recordMovement and
// checkLowStock from movements.service so existing callers in POS,
// sales, purchasing, and logistics continue to work unchanged.
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
  // Re-exported from movements.service so external callers
  // (POS, sales, purchasing, logistics) keep their imports unchanged.
  recordMovement: movements.recordMovement,
  checkLowStock: movements.checkLowStock,
  // New capabilities surfaced via the stock service for convenience.
  getAvailableQty: movements.getAvailableQty,
  createReservation: movements.createReservation,
  releaseReservation: movements.releaseReservation,
  // Local operations
  createAdjustment,
  createTransfer,
  getLowStockAlerts,
  getLocations,
};
