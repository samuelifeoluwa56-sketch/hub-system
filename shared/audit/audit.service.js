'use strict';

// Audit service — always use the direct pool for audit writes
// so they are not rolled back if the main transaction fails.
const { pool } = require('../../config/db');

async function log(client, { userId, userName, business, module, action, table, recordId, before, after, metadata = {} }) {
  // Use the passed client if available (same transaction), otherwise pool
  const db = client || pool;

  try {
    await db.query(
      `INSERT INTO shared.audit_log
         (user_id, user_name, business, module, action, table_name, record_id,
          before_state, after_state, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId   || null,
        userName || 'system',
        business,
        module,
        action,
        table    || null,
        recordId || null,
        before   ? JSON.stringify(before) : null,
        after    ? JSON.stringify(after)  : null,
        JSON.stringify(metadata),
      ]
    );
  } catch (err) {
    // Audit failures must NEVER break the main operation
    console.error('Audit log failed (non-fatal):', err.message);
  }
}

async function getForRecord(tableName, recordId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT log_id, occurred_at, user_name, action, before_state, after_state
     FROM shared.audit_log
     WHERE table_name = $1 AND record_id = $2
     ORDER BY occurred_at DESC
     LIMIT $3`,
    [tableName, recordId, limit]
  );
  return rows;
}

async function getForUser(userId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT log_id, occurred_at, business, module, action, table_name, record_id
     FROM shared.audit_log
     WHERE user_id = $1
     ORDER BY occurred_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

module.exports = { log, getForRecord, getForUser };
