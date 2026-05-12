"use strict";

const { withBusinessContext } = require("../../config/db");
const { sendEmail } = require("../../lib/email/sender");
const whatsapp = require("../../integrations/messaging/adapters/whatsapp");
const auditService = require("../../shared/audit/audit.service");
const repo = require("./campaigns.repository");
const crypto = require("crypto");
const logger = require("../../config/logger");

async function list(
  business,
  { page = 1, limit = 30, status, campaign_type } = {},
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await repo.list(client, {
      status,
      campaign_type,
      limit: parseInt(limit),
      offset,
    });
    return { data: rows };
  });
}

async function create(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const campaign = await repo.insert(client, {
      campaign_name: data.campaign_name,
      campaign_type: data.campaign_type,
      subject_line: data.subject_line,
      from_name: data.from_name,
      html_content: data.html_content,
      audience_filter: data.audience_filter,
      userId: user.user_id,
    });

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
    const campaign = await repo.findById(client, campaignId);
    if (!campaign)
      throw Object.assign(new Error("Campaign not found"), { status: 404 });
    return campaign;
  });
}

async function update(business, campaignId, data, user) {
  return withBusinessContext(business, async (client) => {
    const c = await repo.findStatusById(client, campaignId);
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

    return repo.update(client, campaignId, sets, vals);
  });
}

// Build the audience from the filter criteria and insert campaign_recipients
async function buildAudience(business, campaignId) {
  return withBusinessContext(business, async (client) => {
    const campaign = await repo.findAudienceFilter(client, campaignId);
    if (!campaign) throw Object.assign(new Error("Not found"), { status: 404 });

    const filter = campaign.audience_filter || {};
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

    const contacts = await repo.getContactsForAudience(client, {
      business,
      where,
      params,
    });

    await repo.deletePendingRecipients(client, campaignId);

    let inserted = 0;
    for (const contact of contacts) {
      const token = crypto.randomBytes(16).toString("hex");
      await repo.insertRecipient(client, campaignId, contact.contact_id, token);
      inserted++;
    }

    await repo.updateRecipientCount(client, campaignId, inserted);
    return {
      recipient_count: inserted,
      message: "Audience built successfully",
    };
  });
}

async function schedule(business, campaignId, scheduledAt, user) {
  return withBusinessContext(business, async (client) => {
    const c = await repo.findStatusById(client, campaignId);
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
    return repo.setScheduled(client, campaignId, scheduledAt);
  });
}

async function sendNow(business, campaignId, user) {
  return withBusinessContext(business, async (client) => {
    const campaign = await repo.findSendable(client, campaignId);
    if (!campaign)
      throw Object.assign(new Error("Campaign not sendable"), { status: 400 });

    if (!campaign.recipient_count) {
      await buildAudience(business, campaignId);
    }

    await repo.setStatus(client, campaignId, "sending");

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
    const recipients = await repo.getPendingRecipients(client, campaignId);
    let sentCount = 0;

    for (const r of recipients) {
      try {
        let personalHtml = campaign.html_content.replace(
          /\{\{name\}\}/g,
          r.display_name || "Valued Customer",
        );

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
            text: personalHtml.replace(/<[^>]*>/g, ""),
          });
        }

        await repo.markRecipientSent(client, r.recipient_id);
        sentCount++;
      } catch (err) {
        logger.error(`Campaign recipient failed: ${r.contact_id}`, err);
        await repo.markRecipientBounced(client, r.recipient_id);
      }
    }

    await repo.setSentTotals(client, campaignId, sentCount);
    logger.info(
      `Campaign sent: ${campaignId} — ${sentCount}/${recipients.length} delivered`,
    );
  });
}

async function cancel(business, campaignId, user) {
  return withBusinessContext(business, async (client) => {
    const c = await repo.setCancelled(client, campaignId);
    if (!c)
      throw Object.assign(new Error("Campaign cannot be cancelled"), {
        status: 400,
      });
    return c;
  });
}

async function getStats(business, campaignId) {
  return withBusinessContext(business, async (client) => {
    return repo.getStats(client, campaignId);
  });
}

async function trackEvent(token, eventType, ip) {
  return withBusinessContext("jewelry", async () => {
    const db = require("../../config/db");
    for (const business of ["jewelry", "diffusers"]) {
      const r = await repo.findRecipientByToken(db.pool, business, token);
      if (!r) continue;

      const validEvents = ["opened", "clicked"];
      if (!validEvents.includes(eventType)) return;

      await repo.updateTrackingEvent(db.pool, business, token, eventType);

      const col = eventType === "opened" ? "opened_count" : "clicked_count";
      await repo.incrementCampaignCounter(
        db.pool,
        business,
        r.campaign_id,
        col,
      );
      await repo.insertCampaignEvent(
        db.pool,
        business,
        r.recipient_id,
        eventType,
      );
      return;
    }
  }).catch(() => {});
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
