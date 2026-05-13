"use strict";

const { withBusinessContext, nextDocumentNumber } = require("../../config/db");
const auditService = require("../../shared/audit/audit.service");

async function listAccounts(business, { type, active = "true" } = {}) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT account_id, account_code, account_name, account_type, account_subtype,
              parent_account_id, is_system, is_active
       FROM chart_of_accounts
       WHERE ($1::TEXT IS NULL OR account_type = $1)
         AND ($2::BOOLEAN IS NULL OR is_active = $2)
       ORDER BY account_code`,
      [type || null, active === "true"],
    );
    return { data: rows };
  });
}

async function listJournals(
  business,
  { page = 1, limit = 50, startDate, endDate, referenceType } = {},
) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await client.query(
      `SELECT je.entry_id, je.entry_number, je.entry_date, je.description,
              je.reference_type, je.reference_id, je.is_reversed,
              COALESCE(SUM(jl.debit),0) AS total_debit
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.entry_id = je.entry_id
       WHERE ($1::DATE IS NULL OR je.entry_date >= $1)
         AND ($2::DATE IS NULL OR je.entry_date <= $2)
         AND ($3::TEXT IS NULL OR je.reference_type = $3)
       GROUP BY je.entry_id
       ORDER BY je.entry_date DESC, je.posted_at DESC
       LIMIT $4 OFFSET $5`,
      [
        startDate || null,
        endDate || null,
        referenceType || null,
        parseInt(limit),
        offset,
      ],
    );
    return { data: rows };
  });
}

async function getJournal(business, entryId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [entry],
    } = await client.query(
      `SELECT je.*,
              json_agg(
                json_build_object(
                  'line_id', jl.line_id,
                  'account_code', coa.account_code,
                  'account_name', coa.account_name,
                  'account_type', coa.account_type,
                  'debit', jl.debit,
                  'credit', jl.credit,
                  'description', jl.description
                ) ORDER BY jl.line_id
              ) AS lines
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.entry_id = je.entry_id
       LEFT JOIN chart_of_accounts coa ON coa.account_id = jl.account_id
       WHERE je.entry_id = $1
       GROUP BY je.entry_id`,
      [entryId],
    );
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

    const {
      rows: [period],
    } = await client.query(
      `SELECT period_id FROM fiscal_periods
       WHERE $1 BETWEEN start_date AND end_date AND is_closed = false LIMIT 1`,
      [data.entry_date],
    );

    const {
      rows: [entry],
    } = await client.query(
      `INSERT INTO journal_entries
         (entry_number, entry_date, description, reference_type, fiscal_period_id, posted_by)
       VALUES ('JE-M-' || to_char(now(),'YYYYMMDD-HH24MISS'), $1, $2, 'manual', $3, $4)
       RETURNING *`,
      [
        data.entry_date,
        data.description,
        period?.period_id || null,
        user.user_id,
      ],
    );

    for (const l of data.lines) {
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit, description)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          entry.entry_id,
          l.account_id,
          l.debit || 0,
          l.credit || 0,
          l.description || null,
        ],
      );
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
    const { rows } = await client.query(
      `SELECT
         coa.account_type,
         coa.account_subtype,
         coa.account_code,
         coa.account_name,
         COALESCE(SUM(
           CASE WHEN coa.account_type='income'  THEN jl.credit - jl.debit
                WHEN coa.account_type='expense' THEN jl.debit  - jl.credit
                ELSE 0 END
         ), 0) AS balance
       FROM chart_of_accounts coa
       LEFT JOIN journal_lines jl ON jl.account_id = coa.account_id
       LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id
         AND je.entry_date BETWEEN $1 AND $2
         AND je.is_reversed = false
       WHERE coa.account_type IN ('income','expense') AND coa.is_active = true
       GROUP BY coa.account_id, coa.account_type, coa.account_subtype,
                coa.account_code, coa.account_name
       ORDER BY coa.account_type DESC, coa.account_code`,
      [sd, ed],
    );

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
    const { rows } = await client.query(
      `SELECT
         coa.account_type,
         coa.account_subtype,
         coa.account_code,
         coa.account_name,
         COALESCE(SUM(
           CASE WHEN coa.account_type IN ('asset','expense') THEN jl.debit  - jl.credit
                ELSE jl.credit - jl.debit END
         ), 0) AS balance
       FROM chart_of_accounts coa
       LEFT JOIN journal_lines jl ON jl.account_id = coa.account_id
       LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id
         AND je.entry_date <= $1
         AND je.is_reversed = false
       WHERE coa.account_type IN ('asset','liability','equity') AND coa.is_active = true
       GROUP BY coa.account_id, coa.account_type, coa.account_subtype,
                coa.account_code, coa.account_name
       ORDER BY coa.account_type, coa.account_code`,
      [date],
    );

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
    const { rows } = await client.query(
      `SELECT
         coa.account_code, coa.account_name, coa.account_type,
         COALESCE(SUM(jl.debit),0)  AS total_debit,
         COALESCE(SUM(jl.credit),0) AS total_credit
       FROM chart_of_accounts coa
       LEFT JOIN journal_lines jl ON jl.account_id = coa.account_id
       LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id
         AND je.entry_date BETWEEN $1 AND $2
       WHERE coa.is_active = true
       GROUP BY coa.account_id, coa.account_code, coa.account_name, coa.account_type
       HAVING COALESCE(SUM(jl.debit),0) != 0 OR COALESCE(SUM(jl.credit),0) != 0
       ORDER BY coa.account_code`,
      [sd, ed],
    );
    return { period: { startDate: sd, endDate: ed }, data: rows };
  });
}

async function listBankStatements(
  business,
  { bankAccountId, reconciled } = {},
) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT bs.*, ba.bank_name, ba.account_name
       FROM bank_statements bs
       JOIN shared.bank_accounts ba ON ba.account_id = bs.bank_account_id
       WHERE ($1::UUID IS NULL OR bs.bank_account_id = $1)
         AND ($2::BOOLEAN IS NULL OR bs.is_reconciled = $2)
       ORDER BY bs.transaction_date DESC
       LIMIT 200`,
      [
        bankAccountId || null,
        reconciled !== undefined ? reconciled === "true" : null,
      ],
    );
    return { data: rows };
  });
}

async function reconcile(business, { statement_id, payment_id }, user) {
  return withBusinessContext(business, async (client) => {
    await client.query(
      `UPDATE bank_statements
       SET is_reconciled=true, matched_payment_id=$1, matched_at=now()
       WHERE statement_id=$2`,
      [payment_id, statement_id],
    );
    return { message: "Reconciled successfully" };
  });
}

async function listFiscalPeriods(business) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT period_id, name, period_type, start_date, end_date, is_closed
       FROM fiscal_periods ORDER BY start_date DESC`,
    );
    return { data: rows };
  });
}

async function closePeriod(business, periodId, user) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [period],
    } = await client.query(
      `UPDATE fiscal_periods
       SET is_closed=true, closed_by=$1, closed_at=now()
       WHERE period_id=$2 AND is_closed=false RETURNING *`,
      [user.user_id, periodId],
    );
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
