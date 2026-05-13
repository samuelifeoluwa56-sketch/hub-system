"use strict";

const { withBusinessContext } = require("../../config/db");
const auditService = require("../../shared/audit/audit.service");
const notifService = require("../../shared/notifications/notifications.service");
const { emitToBusiness } = require("../../config/sockets");
const repo = require("./crm.repository");

async function listDeals(
  business,
  { page = 1, limit = 50, stage, assignedTo, contactId } = {},
  user,
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await repo.listDeals(client, {
      stage,
      assignedTo,
      contactId,
      limit: parseInt(limit),
      offset,
    });
    return { data: rows };
  });
}

async function createDeal(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const deal = await repo.insertDeal(client, {
      contact_id: data.contact_id,
      assigned_to: data.assigned_to || user.user_id,
      title: data.title,
      stage: data.stage,
      expected_value: data.expected_value,
      probability: data.probability,
      expected_close_date: data.expected_close_date,
      source: data.source,
    });

    await logActivity(
      business,
      deal.deal_id,
      { activity_type: "note", summary: `Deal created: ${data.title}` },
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
    const deal = await repo.findDealById(client, dealId);
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
    return repo.updateDeal(client, dealId, sets, vals);
  });
}

async function moveDealStage(business, dealId, newStage, user) {
  return withBusinessContext(business, async (client) => {
    const old = await repo.getDealStage(client, dealId);
    const deal = await repo.moveDealStage(client, dealId, newStage);
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
  const run = async (client) =>
    repo.insertActivity(client, {
      dealId,
      activity_type: data.activity_type,
      summary: data.summary,
      direction: data.direction,
      userId: user?.user_id,
      is_auto: data.is_auto,
    });

  if (existingClient) return run(existingClient);
  return withBusinessContext(business, run);
}

async function getPipeline(business, user, scope) {
  return withBusinessContext(business, async (client) => {
    const stages = await repo.getPipelineStages(client, business);
    const deals = await repo.getPipelineDeals(client, {
      scope,
      userId: user.user_id,
    });

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
    const rows = await repo.getNotes(client, dealId);
    return { data: rows };
  });
}

async function addNote(business, dealId, { content, is_pinned = false }, user) {
  return withBusinessContext(business, async (client) => {
    const contactId = await repo.getDealContactId(client, dealId);
    return repo.insertNote(client, {
      dealId,
      contactId,
      content,
      is_pinned,
      userId: user.user_id,
    });
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
