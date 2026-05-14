"use strict";

const express = require("express");
const router = express.Router();
const { query, param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./reports.service");

// ─────────────────────────────────────────────────────────────
// REPORTS ROUTES
//
// One endpoint pattern per family. Format negotiated via the
// ?format=  query param (default: json). When format is binary
// (pdf/excel) the response streams the buffer with the right
// Content-Type/Content-Disposition headers; otherwise JSON.
//
// Permission keys are per-family so payroll reports can be
// restricted to HR/owners separately from sales reports being
// available to managers.
// ─────────────────────────────────────────────────────────────

router.get("/", can("reports", "view"), (req, res) => {
  res.json({
    available_families: service.REPORT_FAMILIES,
    supported_formats: service.SUPPORTED_FORMATS,
    docs: "See README for per-family report types and options",
  });
});

// ─── SALES ───────────────────────────────────────────────────

router.get(
  "/sales/:reportType",
  param("reportType").isIn(["by_period", "by_product", "by_customer"]),
  query("start_date").isISO8601(),
  query("end_date").isISO8601(),
  query("format").optional().isIn(["json", "csv", "pdf", "excel"]),
  query("group_by").optional().isIn(["day", "week", "month"]),
  query("limit").optional().isInt({ min: 1, max: 1000 }),
  query("archive").optional().isBoolean(),
  validate,
  can("reports", "view"),
  async (req, res, next) => {
    try {
      await handle(req, res, "sales");
    } catch (e) {
      next(e);
    }
  },
);

// ─── FINANCE ─────────────────────────────────────────────────

router.get(
  "/finance/:reportType",
  param("reportType").isIn([
    "profit_and_loss",
    "outstanding_invoices",
    "expenses_by_category",
  ]),
  query("start_date").optional().isISO8601(),
  query("end_date").optional().isISO8601(),
  query("as_of_date").optional().isISO8601(),
  query("format").optional().isIn(["json", "csv", "pdf", "excel"]),
  query("archive").optional().isBoolean(),
  validate,
  // Finance reports use 'approve'-level access — they expose P&L
  // which is more sensitive than ordinary view.
  can("reports", "approve"),
  async (req, res, next) => {
    try {
      await handle(req, res, "finance");
    } catch (e) {
      next(e);
    }
  },
);

// ─── STOCK ───────────────────────────────────────────────────

router.get(
  "/stock/:reportType",
  param("reportType").isIn(["valuation", "movements", "low_stock"]),
  query("start_date").optional().isISO8601(),
  query("end_date").optional().isISO8601(),
  query("product_id").optional().isUUID(),
  query("movement_type").optional().isString(),
  query("format").optional().isIn(["json", "csv", "pdf", "excel"]),
  query("archive").optional().isBoolean(),
  validate,
  can("reports", "view"),
  async (req, res, next) => {
    try {
      await handle(req, res, "stock");
    } catch (e) {
      next(e);
    }
  },
);

// ─── PAYROLL ─────────────────────────────────────────────────

router.get(
  "/payroll/:reportType",
  param("reportType").isIn(["summary", "staff_detail"]),
  query("start_date").optional().isISO8601(),
  query("end_date").optional().isISO8601(),
  query("payroll_id").optional().isUUID(),
  query("format").optional().isIn(["json", "csv", "pdf", "excel"]),
  query("archive").optional().isBoolean(),
  validate,
  // Payroll reports require approval-level permission — owner /
  // HR manager only.
  can("payroll", "approve"),
  async (req, res, next) => {
    try {
      await handle(req, res, "payroll");
    } catch (e) {
      next(e);
    }
  },
);

// ─── DELIVERY ────────────────────────────────────────────────

router.get(
  "/delivery/:reportType",
  param("reportType").isIn(["performance", "by_courier"]),
  query("start_date").isISO8601(),
  query("end_date").isISO8601(),
  query("format").optional().isIn(["json", "csv", "pdf", "excel"]),
  query("archive").optional().isBoolean(),
  validate,
  can("reports", "view"),
  async (req, res, next) => {
    try {
      await handle(req, res, "delivery");
    } catch (e) {
      next(e);
    }
  },
);

// ─────────────────────────────────────────────────────────────
// SHARED HANDLER
// ─────────────────────────────────────────────────────────────

async function handle(req, res, family) {
  const format = req.query.format || "json";

  // Map query parameters to options shape that each report file expects.
  const options = {
    startDate: req.query.start_date,
    endDate: req.query.end_date,
    asOfDate: req.query.as_of_date,
    groupBy: req.query.group_by,
    limit: req.query.limit ? parseInt(req.query.limit) : undefined,
    productId: req.query.product_id,
    movementType: req.query.movement_type,
    payrollId: req.query.payroll_id,
  };

  const { output, mimeType, filename } = await service.generate({
    business: req.business,
    family,
    reportType: req.params.reportType,
    format,
    options,
    user: req.user,
    archive: req.query.archive === "true",
  });

  if (format === "json") {
    return res.json(output);
  }
  res.set({
    "Content-Type": mimeType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": output.length,
  });
  return res.send(output);
}

module.exports = router;
