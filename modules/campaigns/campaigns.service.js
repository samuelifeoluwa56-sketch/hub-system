"use strict";

const { withBusinessContext } = require("../../config/db");
const { sendEmail } = require("../../lib/email/sender");
const whatsapp = require("../../integrations/messaging/adapters/whatsapp");
const auditService = require("../../shared/audit/audit.service");
const crypto = require("crypto");
const logger = require("../../config/logger");

async function list(
  business,
  { page = 1, limit = 30, status, campaign_type } = {},
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await client.query(
      `SELECT campaign_id, campaign_name, campaign_type, status,
              recipient_count, delivered_count, opened_count, clicked_count,
              scheduled_at, sent_at, created_at
       FROM campaigns
       WHERE ($1::TEXT IS NULL OR status        = $1)
         AND ($2::TEXT IS NULL OR campaign_type = $2)
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [status || null, campaign_type || null, parseInt(limit), offset],
    );
    return { data: rows };
  });
}

async function create(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [campaign],
    } = await client.query(
      `INSERT INTO campaigns
         (campaign_name, campaign_type, subject_line, from_name,
          html_content, audience_filter, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
       RETURNING *`,
      [
        data.campaign_name,
        data.campaign_type,
        data.subject_line || null,
        data.from_name || null,
        data.html_content,
        JSON.stringify(data.audience_filter || {}),
        user.user_id,
      ],
    );

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "campaigns",
      action: "create",
      table: "campaigns",
      recordId: campaign.campaign_id,
      after: campaign,
    });

    return campaign;
  });
}

async function getById(business, campaignId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [campaign],
    } = await client.query(
      `SELECT c.*,
              COUNT(cr.recipient_id) FILTER (WHERE cr.status='sent')        AS sent_count,
              COUNT(cr.recipient_id) FILTER (WHERE cr.status='opened')      AS opened_count_live,
              COUNT(cr.recipient_id) FILTER (WHERE cr.status='clicked')     AS clicked_count_live,
              COUNT(cr.recipient_id) FILTER (WHERE cr.status='bounced')     AS bounced_count,
              COUNT(cr.recipient_id) FILTER (WHERE cr.status='unsubscribed') AS unsub_count
       FROM campaigns c
       LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.campaign_id
       WHERE c.campaign_id = $1
       GROUP BY c.campaign_id`,
      [campaignId],
    );
    if (!campaign)
      throw Object.assign(new Error("Campaign not found"), { status: 404 });
    return campaign;
  });
}

async function update(business, campaignId, data, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [c],
    } = await client.query(
      `SELECT status FROM campaigns WHERE campaign_id=$1`,
      [campaignId],
    );
    if (!c) throw Object.assign(new Error("Not found"), { status: 404 });
    if (!["draft"].includes(c.status)) {
      throw Object.assign(new Error("Only draft campaigns can be edited"), {
        status: 400,
      });
    }

    const allowed = [
      "campaign_name",
      "subject_line",
      "from_name",
      "html_content",
      "audience_filter",
    ];
    const sets = [],
      vals = [];
    for (const f of allowed) {
      if (data[f] !== undefined) {
        vals.push(f === "audience_filter" ? JSON.stringify(data[f]) : data[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length)
      throw Object.assign(new Error("Nothing to update"), { status: 400 });
    vals.push(campaignId);
    const {
      rows: [updated],
    } = await client.query(
      `UPDATE campaigns SET ${sets.join(", ")}, updated_at=now()
       WHERE campaign_id=$${vals.length} RETURNING *`,
      vals,
    );
    return updated;
  });
}

// Build the audience from the filter criteria and insert campaign_recipients
async function buildAudience(business, campaignId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [campaign],
    } = await client.query(
      `SELECT campaign_id, campaign_type, audience_filter
       FROM campaigns WHERE campaign_id=$1`,
      [campaignId],
    );
    if (!campaign) throw Object.assign(new Error("Not found"), { status: 404 });

    const filter = campaign.audience_filter || {};

    // Build dynamic WHERE clause from filter
    // Supported filters: priority_level, contact_type, tags, has_not_purchased_in_days,
    //                    milestone_type_upcoming_days, minimum_loyalty_points
    let where = `c.is_deleted = false AND c.visible_to @> ARRAY[$1]`;
    const params = [business];

    if (filter.priority_level) {
      params.push(filter.priority_level);
      where += ` AND c.priority_level = $${params.length}`;
    }

    if (filter.contact_type) {
      params.push(filter.contact_type);
      where += ` AND $${params.length} = ANY(c.contact_type)`;
    }

    if (campaign.campaign_type === "email") {
      where += ` AND c.email IS NOT NULL`;
    } else if (campaign.campaign_type === "whatsapp") {
      where += ` AND c.whatsapp_number IS NOT NULL`;
    }

    // Pull contacts
    const { rows: contacts } = await client.query(
      `SELECT c.contact_id FROM shared.contacts c WHERE ${where}`,
      params,
    );

    // Delete previous recipients and rebuild
    await client.query(
      `DELETE FROM campaign_recipients WHERE campaign_id=$1 AND status='pending'`,
      [campaignId],
    );

    let inserted = 0;
    for (const contact of contacts) {
      const token = crypto.randomBytes(16).toString("hex");
      await client.query(
        `INSERT INTO campaign_recipients (campaign_id, contact_id, status, tracking_token)
         VALUES ($1,$2,'pending',$3)
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [campaignId, contact.contact_id, token],
      );
      inserted++;
    }

    await client.query(
      `UPDATE campaigns SET recipient_count=$1 WHERE campaign_id=$2`,
      [inserted, campaignId],
    );

    return {
      recipient_count: inserted,
      message: "Audience built successfully",
    };
  });
}

async function schedule(business, campaignId, scheduledAt, user) {
  return withBusinessContext(business, async (client) => {
    // Ensure audience is built
    const {
      rows: [c],
    } = await client.query(
      `SELECT status, recipient_count FROM campaigns WHERE campaign_id=$1`,
      [campaignId],
    );
    if (!c) throw Object.assign(new Error("Not found"), { status: 404 });
    if (!["draft"].includes(c.status)) {
      throw Object.assign(new Error("Only draft campaigns can be scheduled"), {
        status: 400,
      });
    }
    if (!c.recipient_count) {
      throw Object.assign(new Error("Build audience first before scheduling"), {
        status: 400,
      });
    }

    const {
      rows: [updated],
    } = await client.query(
      `UPDATE campaigns SET status='queued', scheduled_at=$1, updated_at=now()
       WHERE campaign_id=$2 RETURNING *`,
      [scheduledAt, campaignId],
    );
    return updated;
  });
}

async function sendNow(business, campaignId, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [campaign],
    } = await client.query(
      `SELECT * FROM campaigns WHERE campaign_id=$1 AND status IN ('draft','queued')`,
      [campaignId],
    );
    if (!campaign)
      throw Object.assign(new Error("Campaign not sendable"), { status: 400 });

    // Build audience if not yet done
    if (!campaign.recipient_count) {
      await buildAudience(business, campaignId);
    }

    // Mark as sending
    await client.query(
      `UPDATE campaigns SET status='sending', updated_at=now() WHERE campaign_id=$1`,
      [campaignId],
    );

    // Send immediately — async, non-blocking after DB update
    setImmediate(() =>
      processSend(business, campaignId, campaign).catch((err) => {
        logger.error(`Campaign send failed: ${campaignId}`, err);
      }),
    );

    return { message: "Campaign is now sending", campaign_id: campaignId };
  });
}

// Internal: send to all pending recipients
async function processSend(business, campaignId, campaign) {
  const { withBusinessContext } = require("../../config/db");

  await withBusinessContext(business, async (client) => {
    const { rows: recipients } = await client.query(
      `SELECT cr.recipient_id, cr.contact_id, cr.tracking_token,
              c.email, c.whatsapp_number, c.display_name
       FROM campaign_recipients cr
       JOIN shared.contacts c ON c.contact_id = cr.contact_id
       WHERE cr.campaign_id=$1 AND cr.status='pending'`,
      [campaignId],
    );

    let sentCount = 0;

    for (const r of recipients) {
      try {
        let personalHtml = campaign.html_content.replace(
          /\{\{name\}\}/g,
          r.display_name || "Valued Customer",
        );

        // Inject tracking pixel for email
        if (campaign.campaign_type === "email") {
          const trackUrl = `${process.env.BASE_URL || "http://localhost:3000"}/api/campaigns/track/${r.tracking_token}?type=opened`;
          personalHtml += `<img src="${trackUrl}" width="1" height="1" alt="" />`;

          await sendEmail({
            to: r.email,
            subject: campaign.subject_line,
            html: personalHtml,
            from: campaign.from_name,
          });
        } else if (campaign.campaign_type === "whatsapp" && r.whatsapp_number) {
          await whatsapp.sendMessage({
            to: r.whatsapp_number,
            text: personalHtml.replace(/<[^>]*>/g, ""), // Strip HTML for WhatsApp
          });
        }

        await client.query(
          `UPDATE campaign_recipients SET status='sent', sent_at=now()
           WHERE recipient_id=$1`,
          [r.recipient_id],
        );
        sentCount++;
      } catch (err) {
        logger.error(`Campaign recipient failed: ${r.contact_id}`, err);
        await client.query(
          `UPDATE campaign_recipients SET status='bounced' WHERE recipient_id=$1`,
          [r.recipient_id],
        );
      }
    }

    await client.query(
      `UPDATE campaigns
       SET status='sent', sent_at=now(), delivered_count=$1, updated_at=now()
       WHERE campaign_id=$2`,
      [sentCount, campaignId],
    );

    logger.info(
      `Campaign sent: ${campaignId} — ${sentCount}/${recipients.length} delivered`,
    );
  });
}

async function cancel(business, campaignId, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [c],
    } = await client.query(
      `UPDATE campaigns SET status='cancelled', updated_at=now()
       WHERE campaign_id=$1 AND status IN ('draft','queued')
       RETURNING *`,
      [campaignId],
    );
    if (!c)
      throw Object.assign(new Error("Campaign cannot be cancelled"), {
        status: 400,
      });
    return c;
  });
}

async function getStats(business, campaignId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [stats],
    } = await client.query(
      `SELECT
         COUNT(*)                                            AS total_recipients,
         COUNT(*) FILTER (WHERE status='sent')              AS sent,
         COUNT(*) FILTER (WHERE status='delivered')         AS delivered,
         COUNT(*) FILTER (WHERE status='opened')            AS opened,
         COUNT(*) FILTER (WHERE status='clicked')           AS clicked,
         COUNT(*) FILTER (WHERE status='bounced')           AS bounced,
         COUNT(*) FILTER (WHERE status='unsubscribed')      AS unsubscribed,
         ROUND(COUNT(*) FILTER (WHERE status='opened')::NUMERIC /
               NULLIF(COUNT(*) FILTER (WHERE status='sent'),0) * 100, 2) AS open_rate_pct,
         ROUND(COUNT(*) FILTER (WHERE status='clicked')::NUMERIC /
               NULLIF(COUNT(*) FILTER (WHERE status='opened'),0) * 100, 2) AS click_rate_pct
       FROM campaign_recipients
       WHERE campaign_id=$1`,
      [campaignId],
    );
    return stats;
  });
}

async function trackEvent(token, eventType, ip) {
  return withBusinessContext("jewelry", async (client) => {
    // Try to find in any business schema
    for (const business of ["jewelry", "diffusers"]) {
      const db = require("../../config/db");
      const {
        rows: [r],
      } = await db.pool.query(
        `SELECT cr.recipient_id, cr.campaign_id
         FROM ${business}.campaign_recipients cr
         WHERE cr.tracking_token=$1 LIMIT 1`,
        [token],
      );
      if (!r) continue;

      const validEvents = ["opened", "clicked"];
      if (!validEvents.includes(eventType)) return;

      await db.pool.query(
        `UPDATE ${business}.campaign_recipients
         SET status=$1,
             opened_at  = CASE WHEN $1='opened'  AND opened_at  IS NULL THEN now() ELSE opened_at END,
             clicked_at = CASE WHEN $1='clicked' AND clicked_at IS NULL THEN now() ELSE clicked_at END
         WHERE tracking_token=$2`,
        [eventType, token],
      );

      // Increment campaign counter
      const col = eventType === "opened" ? "opened_count" : "clicked_count";
      await db.pool.query(
        `UPDATE ${business}.campaigns SET ${col}=${col}+1 WHERE campaign_id=$1`,
        [r.campaign_id],
      );

      // Insert campaign event
      await db.pool.query(
        `INSERT INTO ${business}.campaign_events (recipient_id, event_type)
         VALUES ($1,$2)`,
        [r.recipient_id, eventType],
      );

      return;
    }
  }).catch(() => {}); // Non-fatal — tracking pixel must not break
}

module.exports = {
  list,
  create,
  getById,
  update,
  buildAudience,
  schedule,
  sendNow,
  cancel,
  getStats,
  trackEvent,
};
