"use strict";

const { withSharedContext } = require("../../config/db");
const { emitToUser } = require("../../config/sockets");
const repo = require("./notifications.repository");

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
  const n = await repo.insert(client, {
    userId,
    business,
    type,
    title,
    body,
    referenceType,
    referenceId,
    actionUrl,
  });

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
    const rows = await repo.list(client, {
      userId,
      business,
      unreadOnly,
      limit: parseInt(limit),
      offset,
    });
    const unread_count = await repo.countUnread(client, { userId, business });
    return { data: rows, unread_count };
  });
}

async function markRead(notificationId, userId) {
  return withSharedContext(async (client) =>
    repo.markRead(client, { notificationId, userId }),
  );
}

async function markAllRead(userId, business) {
  return withSharedContext(async (client) =>
    repo.markAllRead(client, { userId, business }),
  );
}

module.exports = { create, list, markRead, markAllRead };
