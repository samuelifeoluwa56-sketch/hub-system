'use strict';

const { withBusinessContext, nextDocumentNumber } = require('../../config/db');
const { calculatePayslip } = require('./calculator.service');
const { renderToPDF }      = require('../../lib/pdf/generator');
const auditService         = require('../../shared/audit/audit.service');
const notifService         = require('../../shared/notifications/notifications.service');
const logger               = require('../../config/logger');

async function listRuns(business, { page = 1, limit = 24, status } = {}) {
  return withBusinessContext(business, async (client) => {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await client.query(
      `SELECT run_id, run_number, period_month, period_year, status,
              total_gross, total_net, total_paye, created_at
       FROM payroll_runs
       WHERE ($1::TEXT IS NULL OR status = $1)
       ORDER BY period_year DESC, period_month DESC
       LIMIT $2 OFFSET $3`,
      [status || null, parseInt(limit), offset]
    );
    return { data: rows };
  });
}

async function initiateRun(business, { period_month, period_year }, user) {
  return withBusinessContext(business, async (client) => {
    // Check for duplicate
    const { rows: existing } = await client.query(
      `SELECT run_id FROM payroll_runs WHERE period_month=$1 AND period_year=$2`,
      [period_month, period_year]
    );
    if (existing.length) {
      throw Object.assign(
        new Error(`Payroll run already exists for ${period_month}/${period_year}`),
        { status: 409 }
      );
    }

    const runNumber = await nextDocumentNumber(client, business, 'payroll_run');

    // Create the run record
    const { rows: [run] } = await client.query(
      `INSERT INTO payroll_runs
         (run_number, period_month, period_year, status, created_by)
       VALUES ($1,$2,$3,'draft',$4) RETURNING *`,
      [runNumber, period_month, period_year, user.user_id]
    );

    // Get all active staff for this business
    const { rows: staff } = await client.query(
      `SELECT profile_id FROM shared.staff_profiles
       WHERE business=$1 AND is_deleted=false AND end_date IS NULL`,
      [business]
    );

    if (!staff.length) {
      return { ...run, message: 'Run created — no active staff found' };
    }

    // Calculate and create payslip for each staff member
    let totalGross = 0, totalNet = 0, totalPAYE = 0,
        totalPensionEmployee = 0, totalPensionEmployer = 0, totalNHF = 0;

    for (const s of staff) {
      try {
        const calc = await calculatePayslip(business, s.profile_id, period_month, period_year, client);

        await client.query(
          `INSERT INTO payslips
             (run_id, profile_id, basic_salary, housing_allowance,
              transport_allowance, commission_amount, gross_salary,
              paye_deduction, pension_employee, pension_employer,
              nhf_deduction, advance_recovery, other_deductions,
              total_deductions, net_salary, days_absent)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            run.run_id, calc.profileId,
            calc.basicSalary, calc.housingAllowance,
            calc.transportAllowance, calc.commissionAmount, calc.grossSalary,
            calc.paye, calc.pensionEmployee, calc.pensionEmployer,
            calc.nhf, calc.advanceRecovery, calc.otherDeductions,
            calc.totalDeductions, calc.netSalary, calc.daysAbsent,
          ]
        );

        totalGross          += calc.grossSalary;
        totalNet            += calc.netSalary;
        totalPAYE           += calc.paye;
        totalPensionEmployee += calc.pensionEmployee;
        totalPensionEmployer += calc.pensionEmployer;
        totalNHF            += calc.nhf;

      } catch (err) {
        logger.error(`Payslip calculation failed for profile ${s.profile_id}`, err);
      }
    }

    // Update run totals
    const { rows: [updatedRun] } = await client.query(
      `UPDATE payroll_runs
       SET total_gross=$1, total_net=$2, total_paye=$3,
           total_pension_employee=$4, total_pension_employer=$5, total_nhf=$6,
           total_deductions=$7
       WHERE run_id=$8 RETURNING *`,
      [
        totalGross, totalNet, totalPAYE,
        totalPensionEmployee, totalPensionEmployer, totalNHF,
        totalPAYE + totalPensionEmployee + totalNHF,
        run.run_id,
      ]
    );

    await auditService.log(client, {
      userId: user.user_id, userName: 'staff', business,
      module: 'payroll', action: 'create',
      table: 'payroll_runs', recordId: run.run_id, after: updatedRun,
    });

    return updatedRun;
  });
}

async function getRun(business, runId) {
  return withBusinessContext(business, async (client) => {
    const { rows: [run] } = await client.query(
      `SELECT r.*,
              COUNT(p.payslip_id) AS payslip_count
       FROM payroll_runs r
       LEFT JOIN payslips p ON p.run_id = r.run_id
       WHERE r.run_id = $1
       GROUP BY r.run_id`,
      [runId]
    );
    if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });
    return run;
  });
}

async function approveRun(business, runId, user) {
  return withBusinessContext(business, async (client) => {
    const { rows: [run] } = await client.query(
      `UPDATE payroll_runs
       SET status='approved', approved_by=$1, approved_at=now()
       WHERE run_id=$2 AND status='draft'
       RETURNING *`,
      [user.user_id, runId]
    );
    if (!run) throw Object.assign(new Error('Run not found or not in draft'), { status: 400 });

    // Post payroll journal entries
    await postPayrollJournal(client, business, runId, run);

    await auditService.log(client, {
      userId: user.user_id, userName: 'staff', business,
      module: 'payroll', action: 'approve',
      table: 'payroll_runs', recordId: runId, after: run,
    });

    return run;
  });
}

async function postPayrollJournal(client, business, runId, run) {
  // Fetch COA accounts
  const accounts = {};
  const codeMap  = { salaries: '6110', pension_employer: '6120', paye: '2310', pension: '2320', nhf: '2330', bank: '1210' };
  for (const [key, code] of Object.entries(codeMap)) {
    const { rows: [acc] } = await client.query(
      `SELECT account_id FROM chart_of_accounts WHERE account_code=$1 LIMIT 1`, [code]
    );
    if (acc) accounts[key] = acc.account_id;
  }

  if (!accounts.salaries || !accounts.bank) return; // COA not ready

  const entryDesc = `Payroll Run ${run.run_number} — ${run.period_month}/${run.period_year}`;
  const { rows: [entry] } = await client.query(
    `INSERT INTO journal_entries
       (entry_number, entry_date, description, reference_type, reference_id, posted_by)
     VALUES ('JE-PR-' || $1, CURRENT_DATE, $2, 'payroll_run', $3, $4)
     RETURNING entry_id`,
    [runId.substring(0, 8), entryDesc, runId, run.approved_by]
  );

  // DR Salary Expense, CR Payroll Liabilities + Bank
  const lines = [
    { account: accounts.salaries,        debit: run.total_gross, credit: 0 },
    { account: accounts.paye,            debit: 0, credit: run.total_paye },
    { account: accounts.pension,         debit: 0, credit: run.total_pension_employee },
    { account: accounts.nhf,             debit: 0, credit: run.total_nhf },
    { account: accounts.bank,            debit: 0, credit: run.total_net },
  ];

  for (const l of lines) {
    if ((!l.debit && !l.credit) || !l.account) continue;
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1,$2,$3,$4)`,
      [entry.entry_id, l.account, l.debit, l.credit]
    );
  }

  // Employer pension as separate entry
  if (accounts.pension_employer && run.total_pension_employer > 0) {
    const { rows: [entry2] } = await client.query(
      `INSERT INTO journal_entries
         (entry_number, entry_date, description, reference_type, reference_id, posted_by)
       VALUES ('JE-PEN-' || $1, CURRENT_DATE, $2, 'payroll_run', $3, $4)
       RETURNING entry_id`,
      [runId.substring(0, 8), `Employer Pension — ${run.run_number}`, runId, run.approved_by]
    );
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES
       ($1,$2,$3,0), ($1,$4,0,$3)`,
      [entry2.entry_id, accounts.pension_employer, run.total_pension_employer, accounts.pension]
    );
  }
}

async function markPaid(business, runId, user) {
  return withBusinessContext(business, async (client) => {
    const { rows: [run] } = await client.query(
      `UPDATE payroll_runs SET status='paid', paid_at=now()
       WHERE run_id=$1 AND status='approved' RETURNING *`,
      [runId]
    );
    if (!run) throw Object.assign(new Error('Run must be approved before marking paid'), { status: 400 });

    // Settle outstanding advances deducted in this run
    await client.query(
      `UPDATE cash_advances ca
       SET outstanding_balance = outstanding_balance - p.advance_recovery,
           status = CASE WHEN outstanding_balance - p.advance_recovery <= 0 THEN 'settled' ELSE status END
       FROM payslips p
       WHERE p.run_id=$1 AND ca.profile_id=p.profile_id
         AND ca.status='disbursed' AND p.advance_recovery > 0`,
      [runId]
    );

    // Mark commission_earned as attached to payslips
    await client.query(
      `UPDATE commission_earned ce
       SET payslip_id = p.payslip_id
       FROM payslips p
       WHERE p.run_id=$1
         AND ce.profile_id=p.profile_id
         AND ce.payslip_id IS NULL`,
      [runId]
    );

    return run;
  });
}

async function getPayslips(business, runId) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT p.payslip_id, p.profile_id, p.gross_salary, p.net_salary,
              p.paye_deduction, p.pension_employee, p.days_absent,
              c.display_name, sp.job_title
       FROM payslips p
       JOIN shared.staff_profiles sp ON sp.profile_id = p.profile_id
       JOIN shared.contacts c ON c.contact_id = sp.contact_id
       WHERE p.run_id = $1
       ORDER BY c.display_name`,
      [runId]
    );
    return { data: rows };
  });
}

async function getPayslip(business, payslipId, user) {
  return withBusinessContext(business, async (client) => {
    const { rows: [ps] } = await client.query(
      `SELECT p.*, c.display_name, c.email, sp.job_title, sp.employee_number,
              sp.bank_name, sp.bank_account_number,
              r.run_number, r.period_month, r.period_year
       FROM payslips p
       JOIN payroll_runs r ON r.run_id = p.run_id
       JOIN shared.staff_profiles sp ON sp.profile_id = p.profile_id
       JOIN shared.contacts c ON c.contact_id = sp.contact_id
       WHERE p.payslip_id = $1`,
      [payslipId]
    );
    if (!ps) throw Object.assign(new Error('Payslip not found'), { status: 404 });

    // Staff can only view their own payslip unless manager/owner
    if (user.permissionScope === 'own') {
      const { rows: [staffUser] } = await client.query(
        `SELECT u.staff_profile_id FROM shared.users u WHERE u.user_id=$1`, [user.user_id]
      );
      if (staffUser?.staff_profile_id !== ps.profile_id) {
        throw Object.assign(new Error('Access denied'), { status: 403 });
      }
    }

    return ps;
  });
}

async function generatePayslipPDF(business, payslipId, user) {
  const payslip = await getPayslip(business, payslipId, user);
  return renderToPDF('payslips', payslip);
}

async function listCommissionRules(business) {
  return withBusinessContext(business, async (client) => {
    const { rows } = await client.query(
      `SELECT cr.*,
              sp.profile_id, c.display_name AS staff_name,
              r.role_name
       FROM commission_rules cr
       LEFT JOIN shared.staff_profiles sp ON sp.profile_id = cr.profile_id
       LEFT JOIN shared.contacts c ON c.contact_id = sp.contact_id
       LEFT JOIN shared.roles r ON r.role_id = cr.role_id
       WHERE cr.is_active = true
       ORDER BY cr.created_at DESC`
    );
    return { data: rows };
  });
}

async function createCommissionRule(business, data, user) {
  return withBusinessContext(business, async (client) => {
    const { rows: [rule] } = await client.query(
      `INSERT INTO commission_rules
         (profile_id, role_id, rule_type, rate, tiers, applicable_to, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [
        data.profile_id || null,
        data.role_id    || null,
        data.rule_type,
        data.rate       || null,
        data.tiers      ? JSON.stringify(data.tiers) : null,
        data.applicable_to || 'all',
      ]
    );
    return rule;
  });
}

module.exports = {
  listRuns, initiateRun, getRun, approveRun, markPaid,
  getPayslips, getPayslip, generatePayslipPDF,
  listCommissionRules, createCommissionRule,
};
