'use strict';

const { withSharedContext } = require('../config/db');
const { getCachedPermissions, cachePermissions } = require('../config/redis');

// ── can(module, action) ───────────────────────────────────
// Returns Express middleware that checks whether req.user
// has permission for the given module + action combination.
// Usage:  router.post('/invoices', verifyToken, businessContext, can('invoicing','create'), handler)
function can(module, action) {
  return async (req, res, next) => {
    try {
      const { role_id } = req.user;

      // 1. Check Redis cache first
      let permissions = await getCachedPermissions(role_id);

      // 2. Cache miss — load from DB
      if (!permissions) {
        await withSharedContext(async (client) => {
          const result = await client.query(
            `SELECT module, action, record_scope, hidden_fields
             FROM shared.permissions
             WHERE role_id = $1`,
            [role_id]
          );
          permissions = result.rows;
        });
        await cachePermissions(role_id, permissions);
      }

      // 3. Find matching permission
      const perm = permissions.find(p => p.module === module && p.action === action);

      if (!perm) {
        return res.status(403).json({
          message: `You do not have permission to ${action} in ${module}`,
        });
      }

      // Attach scope and hidden fields for the service layer to use
      req.permissionScope  = perm.record_scope;
      req.hiddenFields     = perm.hidden_fields || [];

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { can };
