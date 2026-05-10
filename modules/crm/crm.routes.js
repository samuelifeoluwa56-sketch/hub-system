"use strict";

const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./crm.service");

// GET /api/crm/deals
router.get("/deals", can("crm", "view"), async (req, res, next) => {
  try {
    res.json(await service.listDeals(req.business, req.query, req.user));
  } catch (err) {
    next(err);
  }
});

// POST /api/crm/deals
router.post(
  "/deals",
  body("contact_id").isUUID(),
  body("title").notEmpty(),
  body("stage").notEmpty(),
  validate,
  can("crm", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(await service.createDeal(req.business, req.body, req.user));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/crm/deals/:id
router.get(
  "/deals/:id",
  param("id").isUUID(),
  validate,
  can("crm", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getDeal(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/crm/deals/:id
router.patch(
  "/deals/:id",
  param("id").isUUID(),
  validate,
  can("crm", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.updateDeal(
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

// PATCH /api/crm/deals/:id/stage
router.patch(
  "/deals/:id/stage",
  param("id").isUUID(),
  body("stage").notEmpty(),
  validate,
  can("crm", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.moveDealStage(
          req.business,
          req.params.id,
          req.body.stage,
          req.user,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/crm/deals/:id/activities
router.post(
  "/deals/:id/activities",
  param("id").isUUID(),
  body("activity_type").notEmpty(),
  body("summary").notEmpty(),
  validate,
  can("crm", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          await service.logActivity(
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

// GET /api/crm/pipeline — board view grouped by stage
router.get("/pipeline", can("crm", "view"), async (req, res, next) => {
  try {
    res.json(
      await service.getPipeline(req.business, req.user, req.permissionScope),
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/crm/deals/:id/notes
router.get(
  "/deals/:id/notes",
  param("id").isUUID(),
  validate,
  can("crm", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getNotes(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/crm/deals/:id/notes
router.post(
  "/deals/:id/notes",
  param("id").isUUID(),
  body("content").notEmpty(),
  validate,
  can("crm", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          await service.addNote(
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

module.exports = router;
