"use strict";

const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./invoicing.service");

// GET /api/invoicing
router.get("/", can("invoicing", "view"), async (req, res, next) => {
  try {
    const result = await service.list(
      req.business,
      req.query,
      req.permissionScope,
      req.user,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/invoicing/:id
router.get(
  "/:id",
  param("id").isUUID(),
  validate,
  can("invoicing", "view"),
  async (req, res, next) => {
    try {
      const inv = await service.getById(req.business, req.params.id);
      if (!inv) return res.status(404).json({ message: "Invoice not found" });
      res.json(inv);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/invoicing — create manual invoice
router.post(
  "/",
  body("contact_id").isUUID(),
  body("due_date").isISO8601(),
  body("lines").isArray({ min: 1 }),
  validate,
  can("invoicing", "create"),
  async (req, res, next) => {
    try {
      const inv = await service.create(req.business, req.body, req.user);
      res.status(201).json(inv);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/invoicing/:id/send — email / WhatsApp invoice to customer
router.post(
  "/:id/send",
  param("id").isUUID(),
  validate,
  can("invoicing", "edit"),
  async (req, res, next) => {
    try {
      await service.send(req.business, req.params.id, req.body, req.user);
      res.json({ message: "Invoice sent" });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/invoicing/:id/payments — record a payment
router.post(
  "/:id/payments",
  param("id").isUUID(),
  body("amount").isNumeric(),
  body("payment_method").notEmpty(),
  validate,
  can("invoicing", "edit"),
  async (req, res, next) => {
    try {
      const payment = await service.recordPayment(
        req.business,
        req.params.id,
        req.body,
        req.user,
      );
      res.status(201).json(payment);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/invoicing/:id/void
router.post(
  "/:id/void",
  param("id").isUUID(),
  validate,
  can("invoicing", "delete"),
  async (req, res, next) => {
    try {
      await service.voidInvoice(req.business, req.params.id, req.user);
      res.json({ message: "Invoice voided" });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/invoicing/:id/pdf
router.get(
  "/:id/pdf",
  param("id").isUUID(),
  validate,
  can("invoicing", "view"),
  async (req, res, next) => {
    try {
      const pdfBuffer = await service.generatePDF(req.business, req.params.id);
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
      });
      res.send(pdfBuffer);
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
