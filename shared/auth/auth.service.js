"use strict";

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const config = require("../../config/config");
const { withSharedContext } = require("../../config/db");
const { invalidatePermissionCache } = require("../../config/redis");

async function login(email, password, ip = "") {
  return withSharedContext(async (client) => {
    // 1. Find user
    const { rows } = await client.query(
      `SELECT u.user_id, u.password_hash, u.is_active, u.failed_login_attempts,
              u.locked_until, u.default_business, u.permitted_businesses,
              u.force_password_reset, u.staff_profile_id,
              r.role_id, r.role_name
       FROM shared.users u
       LEFT JOIN shared.user_roles ur ON ur.user_id = u.user_id AND ur.business = '*'
       LEFT JOIN shared.roles r ON r.role_id = ur.role_id
       WHERE u.email = $1 LIMIT 1`,
      [email],
    );

    if (!rows.length) {
      throw Object.assign(new Error("Invalid credentials"), { status: 401 });
    }

    const user = rows[0];

    // 2. Check locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw Object.assign(
        new Error(
          `Account locked until ${new Date(user.locked_until).toISOString()}`,
        ),
        { status: 423 },
      );
    }

    // 3. Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = user.failed_login_attempts + 1;
      const lockUntil =
        attempts >= 10
          ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
          : null;

      await client.query(
        `UPDATE shared.users
         SET failed_login_attempts = $1, locked_until = $2
         WHERE user_id = $3`,
        [attempts, lockUntil, user.user_id],
      );
      throw Object.assign(new Error("Invalid credentials"), { status: 401 });
    }

    if (!user.is_active) {
      throw Object.assign(new Error("Account suspended"), { status: 403 });
    }

    // 4. Reset failed attempts, update last login
    await client.query(
      `UPDATE shared.users
       SET failed_login_attempts = 0, locked_until = NULL,
           last_login_at = now(), last_login_ip = $2
       WHERE user_id = $1`,
      [user.user_id, ip],
    );

    // 5. Issue tokens
    const { accessToken, refreshToken } = await issueTokens(client, user);

    return {
      accessToken,
      refreshToken,
      user: {
        user_id: user.user_id,
        default_business: user.default_business,
        permitted_businesses: user.permitted_businesses,
        force_password_reset: user.force_password_reset,
        role: user.role_name,
      },
    };
  });
}

async function issueTokens(client, user) {
  const jti = crypto.randomUUID();

  const accessToken = jwt.sign(
    {
      user_id: user.user_id,
      role_id: user.role_id,
      current_business: user.default_business,
      jti,
    },
    config.app.jwtSecret,
    { expiresIn: config.app.jwtExpiry },
  );

  const rawRefresh = crypto.randomBytes(64).toString("hex");
  const hashRefresh = crypto
    .createHash("sha256")
    .update(rawRefresh)
    .digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await client.query(
    `INSERT INTO shared.refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.user_id, hashRefresh, expiresAt],
  );

  return { accessToken, refreshToken: rawRefresh };
}

async function refresh(rawRefreshToken) {
  return withSharedContext(async (client) => {
    const hash = crypto
      .createHash("sha256")
      .update(rawRefreshToken)
      .digest("hex");

    const { rows } = await client.query(
      `SELECT rt.token_id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.is_active, u.default_business, u.permitted_businesses,
              ur.role_id
       FROM shared.refresh_tokens rt
       JOIN shared.users u ON u.user_id = rt.user_id
       LEFT JOIN shared.user_roles ur ON ur.user_id = rt.user_id AND ur.business = '*'
       WHERE rt.token_hash = $1`,
      [hash],
    );

    if (
      !rows.length ||
      rows[0].revoked_at ||
      new Date(rows[0].expires_at) < new Date()
    ) {
      throw Object.assign(new Error("Invalid or expired refresh token"), {
        status: 401,
      });
    }

    const token = rows[0];

    // Rotate: revoke old, issue new
    await client.query(
      `UPDATE shared.refresh_tokens SET revoked_at = now() WHERE token_id = $1`,
      [token.token_id],
    );

    const { accessToken, refreshToken } = await issueTokens(client, {
      user_id: token.user_id,
      role_id: token.role_id,
      default_business: token.default_business,
    });

    return { accessToken, refreshToken };
  });
}

async function logout(userId, rawRefreshToken) {
  return withSharedContext(async (client) => {
    if (rawRefreshToken) {
      const hash = crypto
        .createHash("sha256")
        .update(rawRefreshToken)
        .digest("hex");
      await client.query(
        `UPDATE shared.refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND user_id = $2`,
        [hash, userId],
      );
    }
    await client.query(`DELETE FROM shared.user_sessions WHERE user_id = $1`, [
      userId,
    ]);
  });
}

async function switchBusiness(userId, business) {
  if (!config.app.businesses.includes(business)) {
    throw Object.assign(new Error(`Invalid business: ${business}`), {
      status: 400,
    });
  }

  return withSharedContext(async (client) => {
    const { rows } = await client.query(
      `SELECT permitted_businesses, default_business FROM shared.users WHERE user_id = $1`,
      [userId],
    );

    if (!rows.length || !rows[0].permitted_businesses.includes(business)) {
      throw Object.assign(new Error("Not permitted for this business"), {
        status: 403,
      });
    }

    const jti = crypto.randomUUID();
    const { rows: roleRows } = await client.query(
      `SELECT role_id FROM shared.user_roles
       WHERE user_id = $1 AND (business = $2 OR business = '*')
       LIMIT 1`,
      [userId, business],
    );

    const accessToken = jwt.sign(
      {
        user_id: userId,
        role_id: roleRows[0]?.role_id,
        current_business: business,
        jti,
      },
      config.app.jwtSecret,
      { expiresIn: config.app.jwtExpiry },
    );

    return { accessToken, current_business: business };
  });
}

async function getMe(userId) {
  return withSharedContext(async (client) => {
    const { rows } = await client.query(
      `SELECT u.user_id, u.email, u.default_business, u.permitted_businesses,
              sp.profile_id, sp.job_title, sp.department,
              c.display_name, c.primary_phone,
              r.role_name
       FROM shared.users u
       LEFT JOIN shared.staff_profiles sp ON sp.profile_id = u.staff_profile_id
       LEFT JOIN shared.contacts c ON c.contact_id = sp.contact_id
       LEFT JOIN shared.user_roles ur ON ur.user_id = u.user_id AND ur.business = '*'
       LEFT JOIN shared.roles r ON r.role_id = ur.role_id
       WHERE u.user_id = $1`,
      [userId],
    );
    if (!rows.length)
      throw Object.assign(new Error("User not found"), { status: 404 });
    return rows[0];
  });
}

async function changePassword(userId, currentPassword, newPassword) {
  return withSharedContext(async (client) => {
    const { rows } = await client.query(
      `SELECT password_hash FROM shared.users WHERE user_id = $1`,
      [userId],
    );
    if (!rows.length)
      throw Object.assign(new Error("User not found"), { status: 404 });

    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid)
      throw Object.assign(new Error("Current password incorrect"), {
        status: 400,
      });

    const hash = await bcrypt.hash(newPassword, 12);
    await client.query(
      `UPDATE shared.users
       SET password_hash = $1, force_password_reset = false, updated_at = now()
       WHERE user_id = $2`,
      [hash, userId],
    );

    // Revoke all existing refresh tokens on password change
    await client.query(
      `UPDATE shared.refresh_tokens SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );

    // Clear permission cache
    const { rows: roleRows } = await client.query(
      `SELECT role_id FROM shared.user_roles WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (roleRows.length) await invalidatePermissionCache(roleRows[0].role_id);
  });
}

module.exports = {
  login,
  refresh,
  logout,
  switchBusiness,
  getMe,
  changePassword,
};
