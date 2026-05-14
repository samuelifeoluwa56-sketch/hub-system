"use strict";

const { withBusinessContext } = require("../../config/db");
const auditService = require("../../shared/audit/audit.service");
const repo = require("./accounting.repository");
const journalService = require("./journal.service");
const reconciliationService = require("./reconciliation.service");
const reportsService = require("./reports.service");

// ─── Accounts ────────────────────────────────────────────────────────────────

async function listAccounts(business, { type, active = "true" } = {}) {
  return withBusinessContext(business, async (client) => {
    const rows = await repo.findAccounts(client, { type, active });
    return { data: rows };
  });
}

// ─── Journal entries ─────────────────────────────────────────────────────────

async function listJournals(
  business,
  { page = 1, limit = 50, startDate, endDate, referenceType } = {},
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await repo.findJournals(client, {
      startDate,
      endDate,
      referenceType,
      limit: parseInt(limit),
      offset,
    });
    return { data: rows };
  });
}

async function getJournal(business, entryId) {
  return withBusinessContext(business, async (client) => {
    const entry = await repo.findJournalById(client, entryId);
    if (!entry)
      throw Object.assign(new Error("Journal entry not found"), {
        status: 404,
      });
    return entry;
  });
}

async function createManualJournal(business, data, user) {
  return withBusinessContext(business, async (client) => {
    // Balance validation stays here — it's a service-layer concern
    const totalDebit = data.lines.reduce(
      (s, l) => s + parseFloat(l.debit || 0),
      0,
    );
    const totalCredit = data.lines.reduce(
      (s, l) => s + parseFloat(l.credit || 0),
      0,
    );
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw Object.assign(
        new Error(
          `Journal entry out of balance: DR=${totalDebit} CR=${totalCredit}`,
        ),
        { status: 400 },
      );
    }

    // Delegate the write to journal.service — single source of truth for all journal writes
    const entry = await journalService.postEntry(client, {
      entryDate: data.entry_date,
      description: data.description,
      referenceType: "manual",
      postedBy: user.user_id,
      lines: data.lines,
    });

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "accounting",
      action: "create",
      table: "journal_entries",
      recordId: entry.entry_id,
      after: entry,
    });

    return entry;
  });
}

async function reverseJournal(business, entryId, user) {
  return withBusinessContext(business, async (client) => {
    const reversal = await journalService.reverseEntry(client, {
      entryId,
      postedBy: user.user_id,
    });

    await auditService.log(client, {
      userId: user.user_id,
      userName: "staff",
      business,
      module: "accounting",
      action: "reverse",
      table: "journal_entries",
      recordId: entryId,
      after: reversal,
    });

    return reversal;
  });
}

// ─── Financial reports ────────────────────────────────────────────────────────

async function getProfitAndLoss(business, query = {}) {
  return withBusinessContext(business, async (client) => {
    return reportsService.profitAndLoss(client, query);
  });
}

async function getBalanceSheet(business, query = {}) {
  return withBusinessContext(business, async (client) => {
    return reportsService.balanceSheet(client, query);
  });
}

async function getTrialBalance(business, query = {}) {
  return withBusinessContext(business, async (client) => {
    return reportsService.trialBalance(client, query);
  });
}

// ─── Bank reconciliation ──────────────────────────────────────────────────────

async function listBankStatements(
  business,
  { bankAccountId, reconciled } = {},
) {
  return withBusinessContext(business, async (client) => {
    const rows = await repo.findBankStatements(client, {
      bankAccountId,
      reconciled,
    });
    return { data: rows };
  });
}

async function reconcile(business, { statement_id, payment_id }, user) {
  return withBusinessContext(business, async (client) => {
    return reconciliationService.reconcileItem(client, {
      statementId: statement_id,
      paymentId: payment_id,
    });
  });
}

async function getReconciliationSummary(business, bankAccountId) {
  return withBusinessContext(business, async (client) => {
    return reconciliationService.getReconciliationSummary(
      client,
      bankAccountId,
    );
  });
}

async function listUnreconciled(business) {
  return withBusinessContext(business, async (client) => {
    const rows = await reconciliationService.listUnreconciled(client);
    return { data: rows };
  });
}

// ─── Fiscal periods ───────────────────────────────────────────────────────────

async function listFiscalPeriods(business) {
  return withBusinessContext(business, async (client) => {
    const rows = await repo.findFiscalPeriods(client);
    return { data: rows };
  });
}

async function closePeriod(business, periodId, user) {
  return withBusinessContext(business, async (client) => {
    const period = await repo.closeFiscalPeriod(client, {
      periodId,
      userId: user.user_id,
    });
    if (!period)
      throw Object.assign(new Error("Period not found or already closed"), {
        status: 400,
      });
    return period;
  });
}

module.exports = {
  listAccounts,
  listJournals,
  getJournal,
  createManualJournal,
  reverseJournal,
  getProfitAndLoss,
  getBalanceSheet,
  getTrialBalance,
  listBankStatements,
  reconcile,
  getReconciliationSummary,
  listUnreconciled,
  listFiscalPeriods,
  closePeriod,
};
