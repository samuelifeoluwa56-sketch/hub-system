"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const notifService = require("../../shared/notifications/notifications.service");
const auditService = require("../../shared/audit/audit.service");
const { emitToBusiness } = require("../../config/sockets");

// Current stock = SUM(quantity * direction) per product per location
async function getCurrentStock(
  business,
  { locationId, search, belowReorder } = {},
) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT
         p.product_id, p.sku, p.name, p.reorder_level, p.selling_price,
         p.category_id, p.is_active,
         COALESCE(sm.current_qty, 0) AS current_quantity,
         sm.location_breakdown
       FROM products p
       LEFT JOIN (
         SELECT
           product_id,
           SUM(quantity * direction) AS current_qty,
           json_object_agg(
             location_id::TEXT,
             location_qty
           ) AS location_breakdown
         FROM (
           SELECT product_id,
                  COALESCE(to_location_id, from_location_id) AS location_id,
                  SUM(quantity * direction) AS location_qty
           FROM stock_movements
           GROUP BY product_id, COALESCE(to_location_id, from_location_id)
         ) loc_stock
         GROUP BY product_id
       ) sm ON sm.product_id = p.product_id
       WHERE p.is_deleted = false
         AND p.is_active = true
         AND ($1::UUID IS NULL OR
              EXISTS (
                SELECT 1 FROM stock_movements sm2
                WHERE sm2.product_id = p.product_id
                AND COALESCE(sm2.to_location_id, sm2.from_location_id) = $1
              ))
         AND ($2::TEXT IS NULL OR p.name ILIKE $2 OR p.sku ILIKE $2)
         AND ($3::BOOLEAN = false OR COALESCE(sm.current_qty, 0) <= p.reorder_level)
       ORDER BY p.name`,
      [
        locationId || null,
        search ? `%${search}%` : null,
        belowReorder === "true",
      ],
    );
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
    const { rows } = await client.query(
      `SELECT sm.*, u.email AS performed_by_email
       FROM stock_movements sm
       LEFT JOIN shared.users u ON u.user_id = sm.performed_by
       WHERE sm.product_id = $1
       ORDER BY sm.performed_at DESC
       LIMIT $2 OFFSET $3`,
      [productId, parseInt(limit), offset],
    );
    return { data: rows };
  });
}

async function recordMovement(
  client,
  {
    business,
    productId,
    movementType,
    quantity,
    direction,
    fromLocationId,
    toLocationId,
    referenceType,
    referenceId,
    unitCost,
    notes,
    performedBy,
  },
) {
  const {
    rows: [movement],
  } = await client.query(
    `INSERT INTO stock_movements
       (product_id, movement_type, quantity, direction,
        from_location_id, to_location_id, reference_type, reference_id,
        unit_cost, notes, performed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      productId,
      movementType,
      quantity,
      direction,
      fromLocationId || null,
      toLocationId || null,
      referenceType || null,
      referenceId || null,
      unitCost || null,
      notes || null,
      performedBy,
    ],
  );

  // Check low stock after outbound movement
  if (direction === -1) {
    await checkLowStock(client, business, productId);
  }

  return movement;
}

async function checkLowStock(client, business, productId) {
  const {
    rows: [stock],
  } = await client.query(
    `SELECT p.product_id, p.name, p.reorder_level,
            COALESCE(SUM(sm.quantity * sm.direction), 0) AS current_qty
     FROM products p
     LEFT JOIN stock_movements sm ON sm.product_id = p.product_id
     WHERE p.product_id = $1
     GROUP BY p.product_id, p.name, p.reorder_level`,
    [productId],
  );

  if (stock && stock.current_qty <= stock.reorder_level) {
    // Notify stock managers
    const { rows: managers } = await client.query(
      `SELECT u.user_id FROM shared.users u
       JOIN shared.user_roles ur ON ur.user_id = u.user_id
       JOIN shared.roles r ON r.role_id = ur.role_id
       WHERE r.role_name IN ('owner','manager','stock_manager')
         AND (ur.business = $1 OR ur.business = '*')`,
      [business],
    );

    for (const manager of managers) {
      await notifService.create(client, {
        userId: manager.user_id,
        business,
        type: "stock_alert",
        title: `Low stock: ${stock.name}`,
        body: `Current quantity (${stock.current_qty}) is at or below reorder level (${stock.reorder_level}).`,
        referenceType: "product",
        referenceId: productId,
        actionUrl: `/stock?productId=${productId}`,
      });
    }

    emitToBusiness(business, "stock:low_alert", {
      productId,
      productName: stock.name,
      currentQty: stock.current_qty,
    });
  }
}

async function createAdjustment(business, data, user) {
  return withBusinessContext(business, async (client) => {
    // Get current qty
    const {
      rows: [current],
    } = await client.query(
      `SELECT COALESCE(SUM(quantity * direction), 0) AS qty
       FROM stock_movements WHERE product_id = $1`,
      [data.product_id],
    );

    const currentQty = parseInt(current?.qty || 0);
    const diff = data.quantity_after - currentQty;
    const direction = diff >= 0 ? 1 : -1;

    if (diff === 0) return { message: "No adjustment needed" };

    const {
      rows: [adj],
    } = await client.query(
      `INSERT INTO stock_adjustments
         (product_id, location_id, adjustment_type, quantity_before,
          quantity_after, reason, approved_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       RETURNING *`,
      [
        data.product_id,
        data.location_id,
        data.adjustment_type || "correction",
        currentQty,
        data.quantity_after,
        data.reason,
        user.user_id,
      ],
    );

    // Record the movement
    await recordMovement(client, {
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

    const {
      rows: [transfer],
    } = await client.query(
      `INSERT INTO stock_transfers
         (transfer_number, from_location_id, to_location_id, status, initiated_by)
       VALUES ($1,$2,$3,'in_transit',$4)
       RETURNING *`,
      [
        transferNumber,
        data.from_location_id,
        data.to_location_id,
        user.user_id,
      ],
    );

    for (const item of data.items) {
      await recordMovement(client, {
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
      await recordMovement(client, {
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
    const { rows } = await client.query(
      `SELECT p.product_id, p.sku, p.name, p.reorder_level, p.reorder_quantity,
              COALESCE(SUM(sm.quantity * sm.direction), 0) AS current_qty
       FROM products p
       LEFT JOIN stock_movements sm ON sm.product_id = p.product_id
       WHERE p.is_deleted = false AND p.is_active = true
       GROUP BY p.product_id, p.sku, p.name, p.reorder_level, p.reorder_quantity
       HAVING COALESCE(SUM(sm.quantity * sm.direction), 0) <= p.reorder_level
       ORDER BY current_qty ASC`,
    );
    return { data: rows };
  });
}

async function getLocations(business) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT location_id, name, location_type, is_active FROM stock_locations
       WHERE is_active = true ORDER BY name`,
    );
    return { data: rows };
  });
}

module.exports = {
  getCurrentStock,
  getMovements,
  recordMovement,
  createAdjustment,
  createTransfer,
  getLowStockAlerts,
  getLocations,
};
