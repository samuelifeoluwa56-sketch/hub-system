"use strict";

async function insert(
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
    `INSERT INTO shared.notifications (user_id, business, type, title, body, reference_type, reference_id, action_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
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
  return n;
}

async function list(client, { userId, business, unreadOnly, limit, offset }) {
  const { rows } = await client.query(
    `SELECT notification_id, type, title, body, action_url, is_read, created_at FROM shared.notifications WHERE user_id = $1 AND business = $2 AND ($3::BOOLEAN = false OR is_read = false) ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
    [userId, business, unreadOnly === "true", limit, offset],
  );
  return rows;
}

async function countUnread(client, { userId, business }) {
  const {
    rows: [{ count }],
  } = await client.query(
    `SELECT COUNT(*) FROM shared.notifications WHERE user_id = $1 AND business = $2 AND is_read = false`,
    [userId, business],
  );
  return parseInt(count);
}

async function markRead(client, { notificationId, userId }) {
  await client.query(
    `UPDATE shared.notifications SET is_read = true, read_at = now() WHERE notification_id = $1 AND user_id = $2`,
    [notificationId, userId],
  );
}

async function markAllRead(client, { userId, business }) {
  await client.query(
    `UPDATE shared.notifications SET is_read = true, read_at = now() WHERE user_id = $1 AND business = $2 AND is_read = false`,
    [userId, business],
  );
}

module.exports = { insert, list, countUnread, markRead, markAllRead };
