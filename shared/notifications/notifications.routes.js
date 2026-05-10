"use strict";

const express = require("express");
const router = express.Router();
const { param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const service = require("./notifications.service");

// GET /api/notifications — list unread for current user
router.get("/", async (req, res, next) => {
  try {
    const result = await service.list(
      req.user.user_id,
      req.business,
      req.query,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read
router.patch(
  "/:id/read",
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      await service.markRead(req.params.id, req.user.user_id);
      res.json({ message: "Marked as read" });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/notifications/read-all
router.patch("/read-all", async (req, res, next) => {
  try {
    await service.markAllRead(req.user.user_id, req.business);
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
