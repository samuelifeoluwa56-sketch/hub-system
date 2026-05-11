"use strict";

const { withSharedContext } = require("../../config/db");
const { emitToUser } = require("../../config/sockets");

async function create(
  client,
  {
    userId,
    business,
    type,
    title,
    body,
    referenceType,
    referenceId,
    actionUrl,
  },
) {
  const {
    rows: [n],
  } = await client.query(
    `INSERT INTO shared.notifications
       (user_id, business, type, title, body, reference_type, reference_id, action_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      userId,
      business,
      type,
      title,
      body || null,
      referenceType || null,
      referenceId || null,
      actionUrl || null,
    ],
  );

  // Emit real-time event
  emitToUser(userId, "notification:new", {
    notification_id: n.notification_id,
    type: n.type,
    title: n.title,
    body: n.body,
    action_url: n.action_url,
  });

  return n;
}

async function list(
  userId,
  business,
  { page = 1, limit = 30, unreadOnly = false },
) {
  return withSharedContext(async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await client.query(
      `SELECT notification_id, type, title, body, action_url, is_read, created_at
       FROM shared.notifications
       WHERE user_id = $1 AND business = $2
         AND ($3::BOOLEAN = false OR is_read = false)
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5`,
      [userId, business, unreadOnly === "true", parseInt(limit), offset],
    );

    const {
      rows: [{ count }],
    } = await client.query(
      `SELECT COUNT(*) FROM shared.notifications
       WHERE user_id = $1 AND business = $2 AND is_read = false`,
      [userId, business],
    );

    return { data: rows, unread_count: parseInt(count) };
  });
}

async function markRead(notificationId, userId) {
  return withSharedContext(async (client) => {
    await client.query(
      `UPDATE shared.notifications
       SET is_read = true, read_at = now()
       WHERE notification_id = $1 AND user_id = $2`,
      [notificationId, userId],
    );
  });
}

async function markAllRead(userId, business) {
  return withSharedContext(async (client) => {
    await client.query(
      `UPDATE shared.notifications
       SET is_read = true, read_at = now()
       WHERE user_id = $1 AND business = $2 AND is_read = false`,
      [userId, business],
    );
  });
}

module.exports = { create, list, markRead, markAllRead };
