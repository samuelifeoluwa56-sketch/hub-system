"use strict";

const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./sales.service");

// GET  /api/sales/quotations
router.get("/quotations", can("sales", "view"), async (req, res, next) => {
  try {
    res.json(
      await service.listQuotations(
        req.business,
        req.query,
        req.user,
        req.permissionScope,
      ),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/sales/quotations
router.post(
  "/quotations",
  body("contact_id").isUUID(),
  body("valid_until").isISO8601(),
  body("lines").isArray({ min: 1 }),
  validate,
  can("sales", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(await service.createQuotation(req.business, req.body, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// GET  /api/sales/quotations/:id
router.get(
  "/quotations/:id",
  param("id").isUUID(),
  validate,
  can("sales", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getQuotation(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/sales/quotations/:id
router.patch(
  "/quotations/:id",
  param("id").isUUID(),
  validate,
  can("sales", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.updateQuotation(
          req.business,
          req.params.id,
          req.body,
          req.user,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/sales/quotations/:id/send
router.post(
  "/quotations/:id/send",
  param("id").isUUID(),
  validate,
  can("sales", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.sendQuotation(
          req.business,
          req.params.id,
          req.body,
          req.user,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/sales/quotations/:id/confirm — converts to sales order
router.post(
  "/quotations/:id/confirm",
  param("id").isUUID(),
  validate,
  can("sales", "approve"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          await service.confirmQuotation(req.business, req.params.id, req.user),
        );
    } catch (err) {
      next(err);
    }
  },
);

// GET  /api/sales/orders
router.get("/orders", can("sales", "view"), async (req, res, next) => {
  try {
    res.json(await service.listOrders(req.business, req.query));
  } catch (err) {
    next(err);
  }
});

// GET  /api/sales/orders/:id
router.get(
  "/orders/:id",
  param("id").isUUID(),
  validate,
  can("sales", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getOrder(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// GET  /api/sales/quotations/:id/pdf
router.get(
  "/quotations/:id/pdf",
  param("id").isUUID(),
  validate,
  can("sales", "view"),
  async (req, res, next) => {
    try {
      const pdf = await service.generateQuotationPDF(
        req.business,
        req.params.id,
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

module.exports = router;
