"use strict";

const { withBusinessContext } = require("../../config/db");
const repo = require("./dashboards.repository");

function getPeriodDates(query) {
  const now = new Date();
  const year = parseInt(query.year || now.getFullYear());
  const month = parseInt(query.month || now.getMonth() + 1);
  const startDate =
    query.start_date || `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate =
    query.end_date ||
    `${year}-${String(month).padStart(2, "0")}-${new Date(year, month, 0).getDate()}`;
  return { startDate, endDate, year, month };
}

async function getSalesDashboard(business, query, user) {
  const { startDate, endDate } = getPeriodDates(query);
  return withBusinessContext(business, async (client) => {
    const [
      revenue,
      topProducts,
      revenueByDay,
      quoteConversion,
      paymentMethods,
    ] = await Promise.all([
      repo.getSalesRevenue(client, { startDate, endDate }),
      repo.getTopProducts(client, { startDate, endDate }),
      repo.getRevenueByDay(client, { startDate, endDate }),
      repo.getQuoteConversion(client, { startDate, endDate }),
      repo.getPaymentMethods(client, { startDate, endDate }),
    ]);
    return {
      period: { startDate, endDate },
      revenue,
      top_products: topProducts,
      revenue_by_day: revenueByDay,
      quotations: quoteConversion,
      payment_methods: paymentMethods,
    };
  });
}

async function getFinanceDashboard(business, query) {
  const { startDate, endDate } = getPeriodDates(query);
  return withBusinessContext(business, async (client) => {
    const [incomeVsExpense, arAgeing, apSummary, cashBalance] =
      await Promise.all([
        repo.getIncomeVsExpense(client, { startDate, endDate }),
        repo.getARAgeing(client),
        repo.getAPSummary(client),
        repo.getBankBalances(client, business),
      ]);
    return {
      period: { startDate, endDate },
      income_vs_expense: incomeVsExpense,
      ar_ageing: arAgeing,
      ap_summary: apSummary,
      bank_balances: cashBalance,
    };
  });
}

async function getStockDashboard(business, query) {
  return withBusinessContext(business, async (client) => {
    const [totalValue, lowStock, topMoving, locationBreakdown] =
      await Promise.all([
        repo.getTotalStockValue(client),
        repo.getLowStockCount(client),
        repo.getTopMovingProducts(client),
        repo.getStockByLocation(client),
      ]);
    return {
      total_value: totalValue,
      low_stock: lowStock,
      top_moving: topMoving,
      location_breakdown: locationBreakdown,
    };
  });
}

async function getCustomerDashboard(business, query) {
  const { startDate, endDate } = getPeriodDates(query);
  return withBusinessContext(business, async (client) => {
    const [summary, newVsReturning, topCustomers, pipelineHealth] =
      await Promise.all([
        repo.getCustomerSummary(client, { startDate, endDate, business }),
        repo.getNewVsReturning(client, { startDate, endDate }),
        repo.getTopCustomers(client),
        repo.getPipelineHealth(client),
      ]);
    return {
      period: { startDate, endDate },
      summary,
      new_vs_returning: newVsReturning,
      top_customers: topCustomers,
      pipeline_health: pipelineHealth,
    };
  });
}

async function getRetailPartnerDashboard(business, query) {
  return withBusinessContext(business, async (client) => {
    return { data: await repo.getRetailPartners(client) };
  });
}

async function getLogisticsDashboard(business, query) {
  const { startDate, endDate } = getPeriodDates(query);
  return withBusinessContext(business, async (client) => {
    const [summary, byCourier, activeDeliveries] = await Promise.all([
      repo.getLogisticsSummary(client, { startDate, endDate }),
      repo.getLogisticsByCourier(client, { startDate, endDate }),
      repo.getActiveDeliveries(client),
    ]);
    return {
      period: { startDate, endDate },
      summary,
      by_courier: byCourier,
      active_deliveries: activeDeliveries,
    };
  });
}

async function getOverview(business, query, user) {
  const { startDate, endDate } = getPeriodDates(query);
  return withBusinessContext(business, async (client) => {
    const [revenue, stock, deliveries, crm, notifications] = await Promise.all([
      repo.getOverviewRevenue(client, { startDate, endDate }),
      repo.getOverviewStock(client),
      repo.getOverviewDeliveries(client),
      repo.getOverviewCRM(client),
      repo.getUnreadNotifications(client, user.user_id),
    ]);
    return {
      period: { startDate, endDate },
      revenue,
      stock,
      deliveries,
      crm,
      notifications,
    };
  });
}

module.exports = {
  getSalesDashboard,
  getFinanceDashboard,
  getStockDashboard,
  getCustomerDashboard,
  getRetailPartnerDashboard,
  getLogisticsDashboard,
  getOverview,
};
