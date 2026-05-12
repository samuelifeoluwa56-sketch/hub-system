"use strict";

const repo = require("./accounting.repository");

async function listUnreconciled(client, business) {
  return repo.findBankStatements(client, { reconciled: "false" });
}

async function reconcileItem(client, { statementId, paymentId }) {
  await repo.reconcileStatement(client, { statementId, paymentId });
  return { message: "Reconciled" };
}

async function getReconciliationSummary(client, bankAccountId) {
  const {
    rows: [summary],
  } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_reconciled=false) AS unreconciled_count,
       COALESCE(SUM(ABS(amount)) FILTER (WHERE is_reconciled=false),0) AS unreconciled_value,
       COUNT(*) FILTER (WHERE is_reconciled=true)  AS reconciled_count,
       MAX(transaction_date) AS last_statement_date
     FROM bank_statements WHERE bank_account_id=$1`,
    [bankAccountId],
  );
  return summary;
}

module.exports = { listUnreconciled, reconcileItem, getReconciliationSummary };
