"use strict";

const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./stock.service");

// GET /api/stock — current stock levels
router.get("/", can("stock", "view"), async (req, res, next) => {
  try {
    const result = await service.getCurrentStock(req.business, req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/stock/:productId/movements
router.get(
  "/:productId/movements",
  param("productId").isUUID(),
  validate,
  can("stock", "view"),
  async (req, res, next) => {
    try {
      const result = await service.getMovements(
        req.business,
        req.params.productId,
        req.query,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/stock/adjustment — write-off, correction
router.post(
  "/adjustment",
  body("product_id").isUUID(),
  body("location_id").isUUID(),
  body("quantity_after").isInt(),
  body("reason").notEmpty(),
  validate,
  can("stock", "approve"),
  async (req, res, next) => {
    try {
      const result = await service.createAdjustment(
        req.business,
        req.body,
        req.user,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/stock/transfer
router.post(
  "/transfer",
  body("from_location_id").isUUID(),
  body("to_location_id").isUUID(),
  body("items").isArray({ min: 1 }),
  validate,
  can("stock", "create"),
  async (req, res, next) => {
    try {
      const result = await service.createTransfer(
        req.business,
        req.body,
        req.user,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/stock/alerts — low stock items
router.get("/alerts", can("stock", "view"), async (req, res, next) => {
  try {
    const result = await service.getLowStockAlerts(req.business);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/stock/locations
router.get("/locations", can("stock", "view"), async (req, res, next) => {
  try {
    const result = await service.getLocations(req.business);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
