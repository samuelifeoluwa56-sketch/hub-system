"use strict";

const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./campaigns.service");

// GET /api/campaigns
router.get("/", can("campaigns", "view"), async (req, res, next) => {
  try {
    res.json(await service.list(req.business, req.query));
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns
router.post(
  "/",
  body("campaign_name").notEmpty(),
  body("campaign_type").isIn(["email", "whatsapp"]),
  body("html_content").notEmpty(),
  validate,
  can("campaigns", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(await service.create(req.business, req.body, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/campaigns/:id
router.get(
  "/:id",
  param("id").isUUID(),
  validate,
  can("campaigns", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getById(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/campaigns/:id
router.patch(
  "/:id",
  param("id").isUUID(),
  validate,
  can("campaigns", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.update(req.business, req.params.id, req.body, req.user),
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/campaigns/:id/build-audience — preview who will receive
router.post(
  "/:id/build-audience",
  param("id").isUUID(),
  validate,
  can("campaigns", "edit"),
  async (req, res, next) => {
    try {
      res.json(await service.buildAudience(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/campaigns/:id/schedule
router.post(
  "/:id/schedule",
  param("id").isUUID(),
  body("scheduled_at").isISO8601(),
  validate,
  can("campaigns", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.schedule(
          req.business,
          req.params.id,
          req.body.scheduled_at,
          req.user,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/campaigns/:id/send-now — immediate send
router.post(
  "/:id/send-now",
  param("id").isUUID(),
  validate,
  can("campaigns", "approve"),
  async (req, res, next) => {
    try {
      res.json(await service.sendNow(req.business, req.params.id, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/campaigns/:id/cancel
router.post(
  "/:id/cancel",
  param("id").isUUID(),
  validate,
  can("campaigns", "delete"),
  async (req, res, next) => {
    try {
      res.json(await service.cancel(req.business, req.params.id, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/campaigns/:id/stats
router.get(
  "/:id/stats",
  param("id").isUUID(),
  validate,
  can("campaigns", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getStats(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/campaigns/track/:token — open/click tracking pixel (public)
router.get("/track/:token", async (req, res, next) => {
  try {
    await service.trackEvent(
      req.params.token,
      req.query.type || "opened",
      req.ip,
    );
    // Return 1x1 transparent pixel
    const pixel = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    res.set({ "Content-Type": "image/gif", "Content-Length": pixel.length });
    res.send(pixel);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
