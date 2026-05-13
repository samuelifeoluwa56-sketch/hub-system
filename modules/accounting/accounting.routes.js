"use strict";

const express = require("express");
const router = express.Router();
const { body, param, query } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./accounting.service");

router.get("/accounts", can("accounting", "view"), async (req, res, next) => {
  try {
    res.json(await service.listAccounts(req.business, req.query));
  } catch (e) {
    next(e);
  }
});
router.get("/journals", can("accounting", "view"), async (req, res, next) => {
  try {
    res.json(await service.listJournals(req.business, req.query));
  } catch (e) {
    next(e);
  }
});
router.get(
  "/journals/:id",
  param("id").isUUID(),
  validate,
  can("accounting", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getJournal(req.business, req.params.id));
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/journals",
  body("entry_date").isISO8601(),
  body("description").notEmpty(),
  body("lines").isArray({ min: 2 }),
  validate,
  can("accounting", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          await service.createManualJournal(req.business, req.body, req.user),
        );
    } catch (e) {
      next(e);
    }
  },
);

router.get("/pl", can("accounting", "view"), async (req, res, next) => {
  try {
    res.json(await service.getProfitAndLoss(req.business, req.query));
  } catch (e) {
    next(e);
  }
});
router.get(
  "/balance-sheet",
  can("accounting", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getBalanceSheet(req.business, req.query));
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/trial-balance",
  can("accounting", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getTrialBalance(req.business, req.query));
    } catch (e) {
      next(e);
    }
  },
);
router.get(
  "/bank-statements",
  can("accounting", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.listBankStatements(req.business, req.query));
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/bank-statements/reconcile",
  body("statement_id").isUUID(),
  body("payment_id").isUUID(),
  validate,
  can("accounting", "approve"),
  async (req, res, next) => {
    try {
      res.json(await service.reconcile(req.business, req.body, req.user));
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/fiscal-periods",
  can("accounting", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.listFiscalPeriods(req.business));
    } catch (e) {
      next(e);
    }
  },
);
router.post(
  "/fiscal-periods/:id/close",
  param("id").isUUID(),
  validate,
  can("accounting", "approve"),
  async (req, res, next) => {
    try {
      res.json(
        await service.closePeriod(req.business, req.params.id, req.user),
      );
    } catch (e) {
      next(e);
    }
  },
);

module.exports = router;