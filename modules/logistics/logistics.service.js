"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const courierService = require("../../integrations/logistics/logistics.service");
const stockService = require("../stock/stock.service");
const notifService = require("../../shared/notifications/notifications.service");
const auditService = require("../../shared/audit/audit.service");
const whatsapp = require("../../integrations/messaging/adapters/whatsapp");
const { emitToBusiness } = require("../../config/sockets");
const logger = require("../../config/logger");

async function listDeliveries(
  business,
  { page = 1, limit = 50, status, courier } = {},
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await client.query(
      `SELECT d.delivery_id, d.delivery_number, d.status, d.courier,
              d.delivery_fee, d.dispatched_at, d.delivered_at, d.created_at,
              c.display_name AS contact_name, c.primary_phone
       FROM deliveries d
       JOIN shared.contacts c ON c.contact_id = d.contact_id
       WHERE ($1::TEXT IS NULL OR d.status  = $1)
         AND ($2::TEXT IS NULL OR d.courier = $2)
       ORDER BY d.created_at DESC
       LIMIT $3 OFFSET $4`,
      [status || null, courier || null, parseInt(limit), offset],
    );
    return { data: rows };
  });
}

async function getDelivery(business, deliveryId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [delivery],
    } = await client.query(
      `SELECT d.*,
              c.display_name AS contact_name, c.primary_phone, c.whatsapp_number,
              json_agg(di.* ORDER BY di.item_id) FILTER (WHERE di.item_id IS NOT NULL) AS items,
              json_agg(dt.* ORDER BY dt.occurred_at DESC) FILTER (WHERE dt.track_id IS NOT NULL) AS tracking_history
       FROM deliveries d
       JOIN shared.contacts c ON c.contact_id = d.contact_id
       LEFT JOIN delivery_items    di ON di.delivery_id = d.delivery_id
       LEFT JOIN delivery_tracking dt ON dt.delivery_id = d.delivery_id
       WHERE d.delivery_id = $1
       GROUP BY d.delivery_id, c.display_name, c.primary_phone, c.whatsapp_number`,
      [deliveryId],
    );
    if (!delivery)
      throw Object.assign(new Error("Delivery not found"), { status: 404 });
    return delivery;
  });
}

async function createDelivery(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const deliveryNumber = await nextDocumentNumber(
      client,
      business,
      "delivery",
    );

    // Calculate delivery fee if courier supports it
    let deliveryFee = data.delivery_fee || 0;

    const {
      rows: [delivery],
    } = await client.query(
      `INSERT INTO deliveries
         (delivery_number, reference_type, reference_id, contact_id,
          delivery_address, courier, status, delivery_fee,
          fee_borne_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'pending_dispatch',$7,$8,$9)
       RETURNING *`,
      [
        deliveryNumber,
        data.reference_type,
        data.reference_id,
        data.contact_id,
        typeof data.delivery_address === "string"
          ? JSON.stringify({ line1: data.delivery_address })
          : JSON.stringify(data.delivery_address),
        data.courier,
        deliveryFee,
        data.fee_borne_by || "customer",
        user.user_id,
      ],
    );

    // Add items from source document
    if (data.items && data.items.length) {
      for (const item of data.items) {
        await client.query(
          `INSERT INTO delivery_items (delivery_id, product_id, description, quantity)
           VALUES ($1,$2,$3,$4)`,
          [
            delivery.delivery_id,
            item.product_id || null,
            item.description,
            item.quantity,
          ],
        );
      }
    } else {
      // Auto-pull items from order/POS transaction
      if (data.reference_type === "sales_order") {
        const { rows: lines } = await client.query(
          `SELECT product_id, description, quantity FROM order_lines
           WHERE order_id = $1 AND status = 'pending'`,
          [data.reference_id],
        );
        for (const l of lines) {
          await client.query(
            `INSERT INTO delivery_items (delivery_id, product_id, description, quantity)
             VALUES ($1,$2,$3,$4)`,
            [delivery.delivery_id, l.product_id, l.description, l.quantity],
          );
        }
      } else if (data.reference_type === "pos_transaction") {
        const { rows: lines } = await client.query(
          `SELECT product_id, description, quantity FROM pos_transaction_lines
           WHERE transaction_id = $1`,
          [data.reference_id],
        );
        for (const l of lines) {
          await client.query(
            `INSERT INTO delivery_items (delivery_id, product_id, description, quantity)
             VALUES ($1,$2,$3,$4)`,
            [delivery.delivery_id, l.product_id, l.description, l.quantity],
          );
        }
      }
    }

    // Initial tracking entry
    await client.query(
      `INSERT INTO delivery_tracking (delivery_id, status, source, message)
       VALUES ($1, 'pending_dispatch', 'system', 'Delivery created and awaiting dispatch')`,
      [delivery.delivery_id],
    );

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "logistics",
      action: "create",
      table: "deliveries",
      recordId: delivery.delivery_id,
      after: delivery,
    });

    return delivery;
  });
}

async function dispatchDelivery(business, deliveryId, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [delivery],
    } = await client.query(
      `SELECT d.*, c.display_name, c.primary_phone, c.whatsapp_number
       FROM deliveries d
       JOIN shared.contacts c ON c.contact_id = d.contact_id
       WHERE d.delivery_id = $1 AND d.status = 'pending_dispatch'`,
      [deliveryId],
    );
    if (!delivery)
      throw Object.assign(
        new Error("Delivery not found or not ready to dispatch"),
        { status: 400 },
      );

    // Fetch items
    const { rows: items } = await client.query(
      `SELECT di.*, p.name, p.weight_grams
       FROM delivery_items di
       LEFT JOIN products p ON p.product_id = di.product_id
       WHERE di.delivery_id = $1`,
      [deliveryId],
    );

    // Book courier
    const booking = await courierService.bookCourier({
      courier: delivery.courier,
      delivery: { ...delivery, pickup_address: "Hub Warehouse, Lagos" },
      contact: {
        display_name: delivery.display_name,
        primary_phone: delivery.primary_phone,
      },
      items: items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        weight_grams: i.weight_grams,
      })),
    });

    // Update delivery with courier reference
    const {
      rows: [updated],
    } = await client.query(
      `UPDATE deliveries
       SET status='dispatched', courier_order_id=$1, waybill_number=$2,
           dispatched_at=now(), updated_at=now()
       WHERE delivery_id=$3 RETURNING *`,
      [booking.courierId || null, booking.waybill || null, deliveryId],
    );

    // Deduct stock from warehouse on dispatch
    for (const item of items) {
      if (item.product_id) {
        await stockService
          .recordMovement(client, {
            business,
            productId: item.product_id,
            movementType: "sold",
            quantity: item.quantity,
            direction: -1,
            referenceType: "delivery",
            referenceId: deliveryId,
            performedBy: user.user_id,
          })
          .catch(() => {}); // Non-fatal — stock may have already been deducted at POS
      }
    }

    // Notify customer via WhatsApp if available
    if (delivery.whatsapp_number) {
      await whatsapp
        .sendMessage({
          to: delivery.whatsapp_number,
          text: `Your order ${delivery.delivery_number} has been dispatched via ${delivery.courier.toUpperCase()}. ${booking.trackingUrl ? `Track: ${booking.trackingUrl}` : "We will update you when it arrives."}`,
        })
        .catch((err) =>
          logger.warn("WhatsApp dispatch notification failed", err),
        );
    }

    emitToBusiness(business, "delivery:dispatched", {
      deliveryId,
      courierId: booking.courierId,
      status: "dispatched",
    });

    return updated;
  });
}

async function markDelivered(business, deliveryId, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [delivery],
    } = await client.query(
      `UPDATE deliveries
       SET status='delivered', delivered_at=now(), updated_at=now()
       WHERE delivery_id=$1 AND status IN ('dispatched','picked_up','in_transit')
       RETURNING *`,
      [deliveryId],
    );
    if (!delivery)
      throw Object.assign(
        new Error("Delivery not found or cannot be marked delivered"),
        { status: 400 },
      );

    await client.query(
      `INSERT INTO delivery_tracking (delivery_id, status, source, message)
       VALUES ($1,'delivered','manual','Marked as delivered by staff')`,
      [deliveryId],
    );

    // Notify customer
    const {
      rows: [contact],
    } = await client.query(
      `SELECT c.whatsapp_number, c.display_name
       FROM deliveries d JOIN shared.contacts c ON c.contact_id = d.contact_id
       WHERE d.delivery_id=$1`,
      [deliveryId],
    );
    if (contact?.whatsapp_number) {
      await whatsapp
        .sendMessage({
          to: contact.whatsapp_number,
          text: `Your order ${delivery.delivery_number} has been delivered successfully. Thank you for shopping with us!`,
        })
        .catch(() => {});
    }

    emitToBusiness(business, "delivery:delivered", { deliveryId });
    return delivery;
  });
}

async function markFailed(business, deliveryId, { failure_reason }, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [delivery],
    } = await client.query(
      `UPDATE deliveries
       SET status='failed', failure_reason=$1, updated_at=now()
       WHERE delivery_id=$2 AND status NOT IN ('delivered','returned')
       RETURNING *`,
      [failure_reason, deliveryId],
    );
    if (!delivery)
      throw Object.assign(new Error("Cannot update this delivery"), {
        status: 400,
      });

    await client.query(
      `INSERT INTO delivery_tracking (delivery_id, status, source, message)
       VALUES ($1,'failed','manual',$2)`,
      [deliveryId, `Delivery failed: ${failure_reason}`],
    );

    // Notify logistics team
    const { rows: managers } = await client.query(
      `SELECT u.user_id FROM shared.users u
       JOIN shared.user_roles ur ON ur.user_id=u.user_id
       JOIN shared.roles r ON r.role_id=ur.role_id
       WHERE r.role_name IN ('owner','manager','logistics') AND (ur.business=$1 OR ur.business='*')`,
      [business],
    );
    for (const m of managers) {
      await notifService.create(client, {
        userId: m.user_id,
        business,
        type: "delivery_update",
        title: `Delivery failed: ${delivery.delivery_number}`,
        body: failure_reason,
        referenceType: "delivery",
        referenceId: deliveryId,
        actionUrl: `/logistics/${deliveryId}`,
      });
    }

    return delivery;
  });
}

async function getTracking(business, deliveryId) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT track_id, status, location, message, source, occurred_at
       FROM delivery_tracking
       WHERE delivery_id=$1
       ORDER BY occurred_at DESC`,
      [deliveryId],
    );
    return { data: rows };
  });
}

async function getQuote({ courier, pickup_address, delivery_address }) {
  return courierService.getQuote({
    courier,
    pickupAddress: pickup_address,
    deliveryAddress: delivery_address,
  });
}

module.exports = {
  listDeliveries,
  getDelivery,
  createDelivery,
  dispatchDelivery,
  markDelivered,
  markFailed,
  getTracking,
  getQuote,
};
