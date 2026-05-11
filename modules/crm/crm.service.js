"use strict";

const { withBusinessContext } = require("../../config/db");
const auditService = require("../../shared/audit/audit.service");
const notifService = require("../../shared/notifications/notifications.service");
const { emitToBusiness } = require("../../config/sockets");

async function listDeals(
  business,
  { page = 1, limit = 50, stage, assignedTo, contactId } = {},
  user,
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await client.query(
      `SELECT d.deal_id, d.title, d.stage, d.expected_value, d.probability,
              d.expected_close_date, d.source, d.created_at,
              c.display_name AS contact_name, c.contact_id,
              u.email AS assigned_to_email
       FROM crm_deals d
       JOIN shared.contacts c ON c.contact_id = d.contact_id
       LEFT JOIN shared.users u ON u.user_id = d.assigned_to
       WHERE d.is_deleted = false
         AND ($1::TEXT IS NULL OR d.stage = $1)
         AND ($2::UUID IS NULL OR d.assigned_to = $2)
         AND ($3::UUID IS NULL OR d.contact_id = $3)
       ORDER BY d.updated_at DESC
       LIMIT $4 OFFSET $5`,
      [
        stage || null,
        assignedTo || null,
        contactId || null,
        parseInt(limit),
        offset,
      ],
    );
    return { data: rows };
  });
}

async function createDeal(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [deal],
    } = await client.query(
      `INSERT INTO crm_deals
         (contact_id, assigned_to, title, stage, expected_value,
          probability, expected_close_date, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        data.contact_id,
        data.assigned_to || user.user_id,
        data.title,
        data.stage,
        data.expected_value || null,
        data.probability || 50,
        data.expected_close_date || null,
        data.source || null,
      ],
    );

    await logActivity(
      business,
      deal.deal_id,
      {
        activity_type: "note",
        summary: `Deal created: ${data.title}`,
      },
      user,
      client,
    );

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "crm",
      action: "create",
      table: "crm_deals",
      recordId: deal.deal_id,
      after: deal,
    });

    emitToBusiness(business, "crm:deal_created", {
      dealId: deal.deal_id,
      stage: deal.stage,
    });
    return deal;
  });
}

async function getDeal(business, dealId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [deal],
    } = await client.query(
      `SELECT d.*,
              c.display_name AS contact_name, c.email, c.primary_phone,
              c.whatsapp_number, c.priority_level,
              u.email AS assigned_to_email,
              json_agg(DISTINCT da.*) FILTER (WHERE da.activity_id IS NOT NULL) AS activities,
              json_agg(DISTINCT dn.*) FILTER (WHERE dn.note_id    IS NOT NULL) AS notes
       FROM crm_deals d
       JOIN shared.contacts c ON c.contact_id = d.contact_id
       LEFT JOIN shared.users u ON u.user_id = d.assigned_to
       LEFT JOIN crm_activities da ON da.deal_id = d.deal_id
       LEFT JOIN crm_notes      dn ON dn.deal_id = d.deal_id
       WHERE d.deal_id = $1 AND d.is_deleted = false
       GROUP BY d.deal_id, c.display_name, c.email, c.primary_phone,
                c.whatsapp_number, c.priority_level, u.email`,
      [dealId],
    );
    if (!deal)
      throw Object.assign(new Error("Deal not found"), { status: 404 });
    return deal;
  });
}

async function updateDeal(business, dealId, data, user) {
  return withBusinessContext(business, async (client) => {
    const allowed = [
      "title",
      "expected_value",
      "probability",
      "expected_close_date",
      "source",
      "assigned_to",
      "lost_reason",
    ];
    const sets = [],
      vals = [];
    for (const f of allowed) {
      if (data[f] !== undefined) {
        vals.push(data[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length)
      throw Object.assign(new Error("Nothing to update"), { status: 400 });
    vals.push(dealId);
    const {
      rows: [deal],
    } = await client.query(
      `UPDATE crm_deals SET ${sets.join(", ")}, updated_at = now()
       WHERE deal_id = $${vals.length} AND is_deleted = false RETURNING *`,
      vals,
    );
    return deal;
  });
}

async function moveDealStage(business, dealId, newStage, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [old],
    } = await client.query(`SELECT stage FROM crm_deals WHERE deal_id = $1`, [
      dealId,
    ]);
    const {
      rows: [deal],
    } = await client.query(
      `UPDATE crm_deals
       SET stage = $1,
           won_at  = CASE WHEN $1 = 'completed' OR $1 = 'delivered' THEN now() ELSE won_at END,
           lost_at = CASE WHEN $1 = 'lost'                          THEN now() ELSE lost_at END,
           updated_at = now()
       WHERE deal_id = $2 AND is_deleted = false RETURNING *`,
      [newStage, dealId],
    );
    if (!deal)
      throw Object.assign(new Error("Deal not found"), { status: 404 });

    await logActivity(
      business,
      dealId,
      {
        activity_type: "stage_change",
        summary: `Stage moved from "${old?.stage}" to "${newStage}"`,
        is_auto: true,
      },
      user,
      client,
    );

    emitToBusiness(business, "crm:stage_moved", {
      dealId,
      from: old?.stage,
      to: newStage,
    });
    return deal;
  });
}

async function logActivity(business, dealId, data, user, existingClient) {
  const run = async (client) => {
    const {
      rows: [activity],
    } = await client.query(
      `INSERT INTO crm_activities
         (deal_id, contact_id, activity_type, summary, direction, performed_by, is_auto)
       SELECT $1, d.contact_id, $2, $3, $4, $5, $6 FROM crm_deals d WHERE d.deal_id = $1
       RETURNING *`,
      [
        dealId,
        data.activity_type,
        data.summary,
        data.direction || null,
        user?.user_id || null,
        data.is_auto || false,
      ],
    );
    return activity;
  };

  if (existingClient) return run(existingClient);
  return withBusinessContext(business, run);
}

async function getPipeline(business, user, scope) {
  return withBusinessContext(business, async (client) => {
    // Get stage definitions
    const { rows: stages } = await client.query(
      `SELECT stage_key, stage_label, colour, display_order, is_terminal
       FROM shared.pipeline_stage_defs
       WHERE business = $1 AND pipeline_type = 'crm'
       ORDER BY display_order`,
      [business],
    );

    // Get deals grouped by stage
    const { rows: deals } = await client.query(
      `SELECT d.deal_id, d.title, d.stage, d.expected_value, d.probability,
              d.expected_close_date, d.updated_at,
              c.display_name AS contact_name, c.priority_level
       FROM crm_deals d
       JOIN shared.contacts c ON c.contact_id = d.contact_id
       WHERE d.is_deleted = false
         AND d.stage NOT IN ('completed','delivered','won','lost')
         AND ($1 = 'all' OR d.assigned_to = $2)
       ORDER BY d.updated_at DESC`,
      [scope, user.user_id],
    );

    // Group deals by stage
    const pipeline = stages.map((s) => ({
      ...s,
      deals: deals.filter((d) => d.stage === s.stage_key),
      total_value: deals
        .filter((d) => d.stage === s.stage_key)
        .reduce((sum, d) => sum + parseFloat(d.expected_value || 0), 0),
    }));

    return { pipeline };
  });
}

async function getNotes(business, dealId) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT n.*, u.email AS created_by_email
       FROM crm_notes n
       LEFT JOIN shared.users u ON u.user_id = n.created_by
       WHERE n.deal_id = $1
       ORDER BY n.is_pinned DESC, n.created_at DESC`,
      [dealId],
    );
    return { data: rows };
  });
}

async function addNote(business, dealId, { content, is_pinned = false }, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [deal],
    } = await client.query(
      `SELECT contact_id FROM crm_deals WHERE deal_id = $1`,
      [dealId],
    );
    const {
      rows: [note],
    } = await client.query(
      `INSERT INTO crm_notes (deal_id, contact_id, content, is_pinned, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [dealId, deal.contact_id, content, is_pinned, user.user_id],
    );
    return note;
  });
}

module.exports = {
  listDeals,
  createDeal,
  getDeal,
  updateDeal,
  moveDealStage,
  logActivity,
  getPipeline,
  getNotes,
  addNote,
};
