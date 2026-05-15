"use strict";

const express = require("express");
const router = express.Router();
const { body, param, query } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./social.service");

// ─────────────────────────────────────────────────────────────
// social.routes — Module 14 (Social Media Management)
//
// Endpoints exposed:
//   GET    /api/social/posts              — list scheduled + published
//   GET    /api/social/posts/:id          — view one with metrics
//   POST   /api/social/posts              — schedule a new post
//   PATCH  /api/social/posts/:id          — edit (only while draft/scheduled)
//   DELETE /api/social/posts/:id          — cancel (only while draft/scheduled)
//   POST   /api/social/posts/:id/publish  — publish immediately
//   GET    /api/social/posts/:id/metrics  — engagement snapshots
//   POST   /api/social/posts/:id/metrics  — record an engagement snapshot
//                                             (called by the metric-refresh cron)
//
// All endpoints scope to req.business via the businessContext
// middleware, so the same logical post never leaks across brands.
// ─────────────────────────────────────────────────────────────

// ── LIST ─────────────────────────────────────────────────────

router.get(
  "/posts",
  query("status")
    .optional()
    .isIn([
      "draft",
      "scheduled",
      "publishing",
      "published",
      "partial",
      "failed",
      "cancelled",
    ]),
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 200 }),
  validate,
  can("social", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.list(req.business, req.query));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/posts/:id",
  param("id").isUUID(),
  validate,
  can("social", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getById(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// ── SCHEDULE ─────────────────────────────────────────────────

router.post(
  "/posts",
  body("channels").isArray({ min: 1 }),
  body("scheduled_at").isISO8601(),
  body("caption").optional().isString(),
  body("title").optional().isString(),
  body("description").optional().isString(),
  body("media_paths").optional().isArray(),
  body("video_path").optional().isString(),
  body("campaign_id").optional().isUUID(),
  validate,
  can("social", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(await service.schedule(req.business, req.body, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// ── EDIT ─────────────────────────────────────────────────────

router.patch(
  "/posts/:id",
  param("id").isUUID(),
  body("channels").optional().isArray({ min: 1 }),
  body("scheduled_at").optional().isISO8601(),
  body("caption").optional().isString(),
  body("title").optional().isString(),
  body("description").optional().isString(),
  body("media_paths").optional().isArray(),
  body("video_path").optional().isString(),
  validate,
  can("social", "edit"),
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

// ── CANCEL ───────────────────────────────────────────────────

router.delete(
  "/posts/:id",
  param("id").isUUID(),
  validate,
  can("social", "delete"),
  async (req, res, next) => {
    try {
      res.json(await service.cancel(req.business, req.params.id, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// ── PUBLISH NOW ──────────────────────────────────────────────

router.post(
  "/posts/:id/publish",
  param("id").isUUID(),
  validate,
  can("social", "edit"),
  async (req, res, next) => {
    try {
      res.json(await service.publishNow(req.business, req.params.id, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// ── METRICS ──────────────────────────────────────────────────

router.get(
  "/posts/:id/metrics",
  param("id").isUUID(),
  validate,
  can("social", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getMetrics(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/posts/:id/metrics",
  param("id").isUUID(),
  body("channel").isIn(["instagram", "facebook", "tiktok", "youtube"]),
  body("likes").optional().isInt({ min: 0 }),
  body("comments").optional().isInt({ min: 0 }),
  body("shares").optional().isInt({ min: 0 }),
  body("saves").optional().isInt({ min: 0 }),
  body("reach").optional().isInt({ min: 0 }),
  body("impressions").optional().isInt({ min: 0 }),
  body("extras").optional().isObject(),
  validate,
  can("social", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.recordMetric(req.business, req.params.id, req.body),
      );
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
