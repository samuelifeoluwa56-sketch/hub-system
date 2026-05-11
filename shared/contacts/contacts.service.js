"use strict";

const { withSharedContext } = require("../../config/db");
const auditService = require("../audit/audit.service");

async function list(
  { search = "", type, page = 1, limit = 50 },
  user,
  hiddenFields = [],
) {
  return withSharedContext(async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [`%${search}%`];
    let where = `WHERE is_deleted = false
                   AND visible_to && ARRAY[$2]`;
    params.push(user.current_business || "jewelry");

    if (type) {
      params.push(type);
      where += ` AND $${params.length} = ANY(contact_type)`;
    }

    if (search) {
      params[0] = `%${search}%`;
      where += ` AND (display_name ILIKE $1 OR primary_phone ILIKE $1 OR email ILIKE $1)`;
    } else {
      params.shift();
      where = where.replace("$2", "$1");
      params.unshift(user.current_business || "jewelry");
      if (type) {
        /* already handled */
      }
    }

    // Simple query without complex param rewriting
    const { rows } = await client.query(
      `SELECT contact_id, contact_type, display_name, first_name, last_name,
              primary_phone, whatsapp_number, email, priority_level, source,
              created_at, updated_at
       FROM shared.contacts
       WHERE is_deleted = false
         AND ($1 = ANY(visible_to) OR visible_to IS NULL)
         AND ($2::TEXT IS NULL OR display_name ILIKE $2 OR primary_phone ILIKE $2 OR email ILIKE $2)
         AND ($3::TEXT IS NULL OR $3 = ANY(contact_type))
       ORDER BY display_name ASC
       LIMIT $4 OFFSET $5`,
      [
        user.current_business,
        search ? `%${search}%` : null,
        type || null,
        parseInt(limit),
        offset,
      ],
    );

    const {
      rows: [{ count }],
    } = await client.query(
      `SELECT COUNT(*) FROM shared.contacts
       WHERE is_deleted = false
         AND ($1 = ANY(visible_to) OR visible_to IS NULL)`,
      [user.current_business],
    );

    return {
      data: rows,
      total: parseInt(count),
      page: parseInt(page),
      limit: parseInt(limit),
    };
  });
}

async function getById(contactId, hiddenFields = []) {
  return withSharedContext(async (client) => {
    const { rows } = await client.query(
      `SELECT c.*,
              json_agg(DISTINCT ca.*) FILTER (WHERE ca.address_id IS NOT NULL) AS addresses,
              json_agg(DISTINCT ct.*) FILTER (WHERE ct.tag_id IS NOT NULL) AS tags
       FROM shared.contacts c
       LEFT JOIN shared.contact_addresses ca ON ca.contact_id = c.contact_id
       LEFT JOIN shared.contact_tags ct ON ct.contact_id = c.contact_id
       WHERE c.contact_id = $1 AND c.is_deleted = false
       GROUP BY c.contact_id`,
      [contactId],
    );
    return rows[0] || null;
  });
}

async function create(data, user) {
  return withSharedContext(async (client) => {
    const {
      rows: [contact],
    } = await client.query(
      `INSERT INTO shared.contacts
         (contact_type, display_name, first_name, last_name, company_name,
          primary_phone, whatsapp_number, email, priority_level, source,
          visible_to, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        data.contact_type,
        data.display_name,
        data.first_name || null,
        data.last_name || null,
        data.company_name || null,
        data.primary_phone,
        data.whatsapp_number || null,
        data.email || null,
        data.priority_level || "regular",
        data.source || null,
        data.visible_to || ["jewelry", "diffusers"],
        data.notes || null,
        user.user_id,
      ],
    );

    await auditService.log(client, {
      userId: user.user_id,
      userName: user.display_name || "System",
      business: user.current_business || "shared",
      module: "crm",
      action: "create",
      table: "contacts",
      recordId: contact.contact_id,
      after: contact,
    });

    return contact;
  });
}

async function update(contactId, data, user) {
  return withSharedContext(async (client) => {
    const {
      rows: [before],
    } = await client.query(
      `SELECT * FROM shared.contacts WHERE contact_id = $1`,
      [contactId],
    );
    if (!before)
      throw Object.assign(new Error("Contact not found"), { status: 404 });

    const fields = [
      "display_name",
      "first_name",
      "last_name",
      "company_name",
      "primary_phone",
      "whatsapp_number",
      "email",
      "priority_level",
      "source",
      "notes",
      "addresses",
    ];
    const updates = [];
    const values = [];

    for (const field of fields) {
      if (data[field] !== undefined) {
        values.push(data[field]);
        updates.push(`${field} = $${values.length}`);
      }
    }

    if (!updates.length) return before;

    values.push(contactId);
    const {
      rows: [after],
    } = await client.query(
      `UPDATE shared.contacts SET ${updates.join(", ")}, updated_at = now()
       WHERE contact_id = $${values.length} RETURNING *`,
      values,
    );

    await auditService.log(client, {
      userId: user.user_id,
      userName: user.display_name || "System",
      business: user.current_business || "shared",
      module: "crm",
      action: "update",
      table: "contacts",
      recordId: contactId,
      before,
      after,
    });

    return after;
  });
}

async function softDelete(contactId, user) {
  return withSharedContext(async (client) => {
    const {
      rows: [before],
    } = await client.query(
      `UPDATE shared.contacts
       SET is_deleted = true, deleted_at = now(), updated_at = now()
       WHERE contact_id = $1 RETURNING *`,
      [contactId],
    );

    await auditService.log(client, {
      userId: user.user_id,
      userName: user.display_name || "System",
      business: user.current_business || "shared",
      module: "crm",
      action: "delete",
      table: "contacts",
      recordId: contactId,
      before,
    });
  });
}

async function getTimeline(contactId, business) {
  return withSharedContext(async (client) => {
    const activities = await client.query(
      `SELECT activity_id, activity_type, summary, direction, performed_at, is_auto
       FROM ${business}.crm_activities
       WHERE contact_id = $1
       ORDER BY performed_at DESC LIMIT 50`,
      [contactId],
    );

    const invoices = await client.query(
      `SELECT invoice_id, invoice_number, total_amount, amount_paid, status, issue_date
       FROM ${business}.invoices
       WHERE contact_id = $1 AND is_deleted = false
       ORDER BY issue_date DESC LIMIT 20`,
      [contactId],
    );

    const deals = await client.query(
      `SELECT deal_id, title, stage, expected_value, created_at
       FROM ${business}.crm_deals
       WHERE contact_id = $1 AND is_deleted = false
       ORDER BY created_at DESC LIMIT 10`,
      [contactId],
    );

    return {
      activities: activities.rows,
      invoices: invoices.rows,
      deals: deals.rows,
    };
  });
}

async function addAddress(contactId, data, user) {
  return withSharedContext(async (client) => {
    if (data.is_default) {
      await client.query(
        `UPDATE shared.contact_addresses
         SET is_default = false
         WHERE contact_id = $1 AND address_type = $2`,
        [contactId, data.address_type || "delivery"],
      );
    }

    const {
      rows: [address],
    } = await client.query(
      `INSERT INTO shared.contact_addresses
         (contact_id, address_type, line1, line2, area, city, state, country,
          landmark, recipient_name, recipient_phone, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        contactId,
        data.address_type || "delivery",
        data.line1,
        data.line2 || null,
        data.area || null,
        data.city || "Lagos",
        data.state || "Lagos",
        data.country || "Nigeria",
        data.landmark || null,
        data.recipient_name || null,
        data.recipient_phone || null,
        data.is_default || false,
        user.user_id,
      ],
    );
    return address;
  });
}

module.exports = {
  list,
  getById,
  create,
  update,
  softDelete,
  getTimeline,
  addAddress,
};
