"use strict";

const { withBusinessContext } = require("../../config/db");
const auditService = require("../../shared/audit/audit.service");
const repo = require("./accounting.repository");

async function listAccounts(business, { type, active = "true" } = {}) {
  return withBusinessContext(business, async (client) => {
    const rows = await repo.findAccounts(client, { type, active });
    return { data: rows };
  });
}

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
    // Validate balance
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

    const period = await repo.findActivePeriod(client, data.entry_date);

    const entry = await repo.insertJournalEntry(client, {
      entryDate: data.entry_date,
      description: data.description,
      referenceType: "manual",
      periodId: period?.period_id || null,
      postedBy: user.user_id,
    });

    for (const l of data.lines) {
      await repo.insertJournalLine(client, {
        entryId: entry.entry_id,
        accountId: l.account_id,
        debit: l.debit || 0,
        credit: l.credit || 0,
        description: l.description || null,
      });
    }

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

async function getProfitAndLoss(business, { startDate, endDate } = {}) {
  const now = new Date();
  const sd = startDate || `${now.getFullYear()}-01-01`;
  const ed = endDate || `${now.getFullYear()}-12-31`;

  return withBusinessContext(business, async (client) => {
    const rows = await repo.getPLData(client, { startDate: sd, endDate: ed });

    const income = rows.filter((r) => r.account_type === "income");
    const expenses = rows.filter((r) => r.account_type === "expense");
    const totalIncome = income.reduce((s, r) => s + parseFloat(r.balance), 0);
    const totalExpenses = expenses.reduce(
      (s, r) => s + parseFloat(r.balance),
      0,
    );

    return {
      period: { startDate: sd, endDate: ed },
      income,
      expenses,
      total_income: totalIncome,
      total_expenses: totalExpenses,
      net_profit: totalIncome - totalExpenses,
    };
  });
}

async function getBalanceSheet(business, { asOfDate } = {}) {
  const date = asOfDate || new Date().toISOString().split("T")[0];

  return withBusinessContext(business, async (client) => {
    const rows = await repo.getBalanceSheetData(client, { asOfDate: date });

    const assets = rows.filter((r) => r.account_type === "asset");
    const liabilities = rows.filter((r) => r.account_type === "liability");
    const equity = rows.filter((r) => r.account_type === "equity");

    return {
      as_of_date: date,
      assets,
      liabilities,
      equity,
      total_assets: assets.reduce((s, r) => s + parseFloat(r.balance), 0),
      total_liabilities: liabilities.reduce(
        (s, r) => s + parseFloat(r.balance),
        0,
      ),
      total_equity: equity.reduce((s, r) => s + parseFloat(r.balance), 0),
    };
  });
}

async function getTrialBalance(business, { startDate, endDate } = {}) {
  const now = new Date();
  const sd = startDate || `${now.getFullYear()}-01-01`;
  const ed = endDate || `${now.getFullYear()}-12-31`;

  return withBusinessContext(business, async (client) => {
    const rows = await repo.getTrialBalanceData(client, {
      startDate: sd,
      endDate: ed,
    });
    return { period: { startDate: sd, endDate: ed }, data: rows };
  });
}

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
    await repo.reconcileStatement(client, {
      statementId: statement_id,
      paymentId: payment_id,
    });
    return { message: "Reconciled successfully" };
  });
}

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
  getProfitAndLoss,
  getBalanceSheet,
  getTrialBalance,
  listBankStatements,
  reconcile,
  listFiscalPeriods,
  closePeriod,
};
