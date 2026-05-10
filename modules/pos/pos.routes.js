"use strict";

const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./pos.service");

router.get("/terminals", can("pos", "view"), async (req, res, next) => {
  try {
    res.json(await service.getTerminals(req.business));
  } catch (e) {
    next(e);
  }
});

router.post(
  "/sessions/open",
  body("terminal_id").isUUID(),
  body("opening_float").optional().isNumeric(),
  validate,
  can("pos", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(await service.openSession(req.business, req.body, req.user));
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/sessions/:id",
  param("id").isUUID(),
  validate,
  can("pos", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getSession(req.business, req.params.id));
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/sessions/:id/close",
  param("id").isUUID(),
  body("actual_cash").isNumeric(),
  validate,
  can("pos", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.closeSession(
          req.business,
          req.params.id,
          req.body,
          req.user,
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/transactions",
  body("session_id").isUUID(),
  body("lines").isArray({ min: 1 }),
  body("payments").isArray({ min: 1 }),
  validate,
  can("pos", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          await service.createTransaction(req.business, req.body, req.user),
        );
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/transactions/:id",
  param("id").isUUID(),
  validate,
  can("pos", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getTransaction(req.business, req.params.id));
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/transactions/:id/void",
  param("id").isUUID(),
  body("void_reason").notEmpty(),
  validate,
  can("pos", "delete"),
  async (req, res, next) => {
    try {
      res.json(
        await service.voidTransaction(
          req.business,
          req.params.id,
          req.body,
          req.user,
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/transactions/:id/receipt",
  param("id").isUUID(),
  validate,
  can("pos", "view"),
  async (req, res, next) => {
    try {
      res.json(
        await service.sendReceipt(req.business, req.params.id, req.body),
      );
    } catch (e) {
      next(e);
    }
  },
);

module.exports = router;
