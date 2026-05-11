"use strict";

const { withBusinessContext } = require("../../config/db");
const { calculateDeductions } = require("./deductions");

/**
 * Calculate payslip figures for a single staff member for a given payroll run period.
 * Does NOT write to DB — returns computed values for review before confirmation.
 */
async function calculatePayslip(
  business,
  profileId,
  periodMonth,
  periodYear,
  client,
) {
  // Get staff base salary from current active contract
  const {
    rows: [profile],
  } = await client.query(
    `SELECT sp.profile_id, sp.base_salary,
            c.display_name,
            COALESCE(sc.gross_salary, sp.base_salary) AS contract_gross
     FROM shared.staff_profiles sp
     JOIN shared.contacts c ON c.contact_id = sp.contact_id
     LEFT JOIN shared.staff_contracts sc
       ON sc.profile_id = sp.profile_id
       AND sc.effective_from <= CURRENT_DATE
       AND (sc.effective_to IS NULL OR sc.effective_to >= CURRENT_DATE)
     WHERE sp.profile_id = $1
     ORDER BY sc.effective_from DESC NULLS LAST
     LIMIT 1`,
    [profileId],
  );
  if (!profile) throw new Error(`Staff profile ${profileId} not found`);

  const basicSalary = parseFloat(profile.base_salary);

  // Standard allowances (configurable per business — here using common Nigerian pattern)
  const housingAllowance = parseFloat((basicSalary * 0.2).toFixed(2)); // 20% of basic
  const transportAllowance = parseFloat((basicSalary * 0.1).toFixed(2)); // 10% of basic

  // Commission earned this period
  const {
    rows: [commRow],
  } = await client.query(
    `SELECT COALESCE(SUM(commission_amount), 0) AS total
     FROM commission_earned
     WHERE profile_id=$1 AND period_month=$2 AND period_year=$3 AND payslip_id IS NULL`,
    [profileId, periodMonth, periodYear],
  );
  const commissionAmount = parseFloat(commRow.total);

  const grossSalary = parseFloat(
    (
      basicSalary +
      housingAllowance +
      transportAllowance +
      commissionAmount
    ).toFixed(2),
  );

  // Outstanding cash advances to recover
  const {
    rows: [advRow],
  } = await client.query(
    `SELECT COALESCE(SUM(outstanding_balance), 0) AS total
     FROM cash_advances
     WHERE profile_id=$1 AND status='disbursed'`,
    [profileId],
  );
  // Recover at most 50% of net salary per month
  const advanceOutstanding = Math.min(
    parseFloat(advRow.total),
    grossSalary * 0.5,
  );

  // Absent days deduction
  const {
    rows: [absRow],
  } = await client.query(
    `SELECT COALESCE(SUM(days_requested), 0) AS absent_days
     FROM shared.leave_requests
     WHERE profile_id=$1
       AND leave_type='unpaid'
       AND status='approved'
       AND EXTRACT(MONTH FROM start_date)=$2
       AND EXTRACT(YEAR  FROM start_date)=$3`,
    [profileId, periodMonth, periodYear],
  );
  const daysAbsent = parseInt(absRow.absent_days);
  const dailyRate = basicSalary / 22; // Assuming 22 working days
  const absentDeduct = parseFloat((daysAbsent * dailyRate).toFixed(2));

  const deductions = calculateDeductions({
    basicSalary,
    grossSalary,
    advanceOutstanding,
    otherDeductions: absentDeduct,
  });

  return {
    profileId,
    displayName: profile.display_name,
    basicSalary,
    housingAllowance,
    transportAllowance,
    commissionAmount,
    grossSalary,
    daysAbsent,
    ...deductions,
  };
}

module.exports = { calculatePayslip };
