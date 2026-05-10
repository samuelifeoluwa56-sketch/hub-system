"use strict";

const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./payroll.service");

// GET /api/payroll/runs
router.get("/runs", can("payroll", "view"), async (req, res, next) => {
  try {
    res.json(await service.listRuns(req.business, req.query));
  } catch (err) {
    next(err);
  }
});

// POST /api/payroll/runs — initiate new payroll run
router.post(
  "/runs",
  body("period_month").isInt({ min: 1, max: 12 }),
  body("period_year").isInt({ min: 2024 }),
  validate,
  can("payroll", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(await service.initiateRun(req.business, req.body, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/payroll/runs/:id
router.get(
  "/runs/:id",
  param("id").isUUID(),
  validate,
  can("payroll", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getRun(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/payroll/runs/:id/approve
router.post(
  "/runs/:id/approve",
  param("id").isUUID(),
  validate,
  can("payroll", "approve"),
  async (req, res, next) => {
    try {
      res.json(await service.approveRun(req.business, req.params.id, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/payroll/runs/:id/mark-paid
router.post(
  "/runs/:id/mark-paid",
  param("id").isUUID(),
  validate,
  can("payroll", "approve"),
  async (req, res, next) => {
    try {
      res.json(await service.markPaid(req.business, req.params.id, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/payroll/runs/:id/payslips
router.get(
  "/runs/:id/payslips",
  param("id").isUUID(),
  validate,
  can("payroll", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getPayslips(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/payroll/payslips/:id — individual payslip (staff can view own)
router.get(
  "/payslips/:id",
  param("id").isUUID(),
  validate,
  can("payroll", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getPayslip(req.business, req.params.id, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/payroll/payslips/:id/pdf
router.get(
  "/payslips/:id/pdf",
  param("id").isUUID(),
  validate,
  can("payroll", "view"),
  async (req, res, next) => {
    try {
      const pdf = await service.generatePayslipPDF(
        req.business,
        req.params.id,
        req.user,
      );
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
      });
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/payroll/commission-rules
router.get(
  "/commission-rules",
  can("payroll", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.listCommissionRules(req.business));
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/payroll/commission-rules
router.post(
  "/commission-rules",
  body("rule_type").isIn(["percentage_of_sales", "fixed_per_item", "tiered"]),
  validate,
  can("payroll", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          await service.createCommissionRule(req.business, req.body, req.user),
        );
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
