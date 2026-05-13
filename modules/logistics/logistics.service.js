"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const courierService = require("../../integrations/logistics/logistics.service");
const stockService = require("../stock/stock.service");
const notifService = require("../../shared/notifications/notifications.service");
const auditService = require("../../shared/audit/audit.service");
const whatsapp = require("../../integrations/messaging/adapters/whatsapp");
const { emitToBusiness } = require("../../config/sockets");
const logger = require("../../config/logger");
const repo = require("./logistics.repository");

async function listDeliveries(
  business,
  { page = 1, limit = 50, status, courier } = {},
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    return {
      data: await repo.listDeliveries(client, {
        status,
        courier,
        limit: parseInt(limit),
        offset,
      }),
    };
  });
}

async function getDelivery(business, deliveryId) {
  return withBusinessContext(business, async (client) => {
    const delivery = await repo.findDeliveryById(client, deliveryId);
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
    const delivery = await repo.insertDelivery(client, {
      deliveryNumber,
      reference_type: data.reference_type,
      reference_id: data.reference_id,
      contact_id: data.contact_id,
      delivery_address: data.delivery_address,
      courier: data.courier,
      deliveryFee: data.delivery_fee || 0,
      fee_borne_by: data.fee_borne_by,
      userId: user.user_id,
    });

    if (data.items && data.items.length) {
      for (const item of data.items) {
        await repo.insertDeliveryItem(client, {
          delivery_id: delivery.delivery_id,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
        });
      }
    } else {
      const lines =
        data.reference_type === "sales_order"
          ? await repo.getOrderLines(client, data.reference_id)
          : data.reference_type === "pos_transaction"
            ? await repo.getPOSLines(client, data.reference_id)
            : [];
      for (const l of lines) {
        await repo.insertDeliveryItem(client, {
          delivery_id: delivery.delivery_id,
          product_id: l.product_id,
          description: l.description,
          quantity: l.quantity,
        });
      }
    }

    await repo.insertTrackingEntry(client, {
      delivery_id: delivery.delivery_id,
      status: "pending_dispatch",
      source: "system",
      message: "Delivery created and awaiting dispatch",
    });
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
    const delivery = await repo.findDispatchable(client, deliveryId);
    if (!delivery)
      throw Object.assign(
        new Error("Delivery not found or not ready to dispatch"),
        { status: 400 },
      );

    const items = await repo.getDeliveryItems(client, deliveryId);
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

    const updated = await repo.setDispatched(client, {
      deliveryId,
      courierId: booking.courierId,
      waybill: booking.waybill,
    });

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
          .catch(() => {});
      }
    }

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
    const delivery = await repo.setDelivered(client, deliveryId);
    if (!delivery)
      throw Object.assign(
        new Error("Delivery not found or cannot be marked delivered"),
        { status: 400 },
      );

    await repo.insertTrackingEntry(client, {
      delivery_id: deliveryId,
      status: "delivered",
      source: "manual",
      message: "Marked as delivered by staff",
    });

    const contact = await repo.getDeliveryContact(client, deliveryId);
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
    const delivery = await repo.setFailed(client, {
      deliveryId,
      failure_reason,
    });
    if (!delivery)
      throw Object.assign(new Error("Cannot update this delivery"), {
        status: 400,
      });

    await repo.insertTrackingEntry(client, {
      delivery_id: deliveryId,
      status: "failed",
      source: "manual",
      message: `Delivery failed: ${failure_reason}`,
    });

    const managers = await repo.getLogisticsManagers(client, business);
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
    return { data: await repo.getTracking(client, deliveryId) };
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
