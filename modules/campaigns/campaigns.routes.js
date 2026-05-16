"use strict";

const express = require("express");
const router = express.Router();
const { body, param, query } = require("express-validator");
const validate = require("../../middleware/validateBody");
const { can } = require("../../middleware/permissions");
const service = require("./campaigns.service");

// ─── LIST / CRUD ──────────────────────────────────────────────

router.get("/", can("campaigns", "view"), async (req, res, next) => {
  try {
    res.json(await service.list(req.business, req.query));
  } catch (err) {
    next(err);
  }
});

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

// ─── AUDIENCE ─────────────────────────────────────────────────

// Live preview — show the user who matches the filter as they edit.
router.post(
  "/audience/preview",
  body("filter").isObject(),
  body("channel_type").optional().isIn(["email", "whatsapp", "auto"]),
  validate,
  can("campaigns", "view"),
  async (req, res, next) => {
    try {
      res.json(
        await service.previewAudience(
          req.business,
          req.body.filter,
          req.body.channel_type,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

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

// Build audience from a saved segment — convenience that copies the
// segment's filter onto the campaign and runs buildAudience.
router.post(
  "/:id/build-audience-from-segment",
  param("id").isUUID(),
  body("segment_id").isUUID(),
  validate,
  can("campaigns", "edit"),
  async (req, res, next) => {
    try {
      res.json(
        await service.buildAudienceFromSegment(
          req.business,
          req.params.id,
          req.body.segment_id,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

// ─── SAVED SEGMENTS ───────────────────────────────────────────

router.get("/segments", can("campaigns", "view"), async (req, res, next) => {
  try {
    res.json({ data: await service.listSegments(req.business) });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/segments/:segmentId",
  param("segmentId").isUUID(),
  validate,
  can("campaigns", "view"),
  async (req, res, next) => {
    try {
      const row = await service.getSegment(req.business, req.params.segmentId);
      if (!row) return res.status(404).json({ message: "Segment not found" });
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/segments/:segmentId/preview",
  param("segmentId").isUUID(),
  query("channel_type").optional().isIn(["email", "whatsapp", "auto"]),
  validate,
  can("campaigns", "view"),
  async (req, res, next) => {
    try {
      res.json(
        await service.previewSegment(
          req.business,
          req.params.segmentId,
          req.query.channel_type,
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/segments",
  body("name").isString().notEmpty(),
  body("filter").isObject(),
  body("description").optional().isString(),
  validate,
  can("campaigns", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(await service.saveSegment(req.business, req.body, req.user));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/segments/:segmentId",
  param("segmentId").isUUID(),
  validate,
  can("campaigns", "delete"),
  async (req, res, next) => {
    try {
      res.json(await service.deleteSegment(req.business, req.params.segmentId));
    } catch (err) {
      next(err);
    }
  },
);

// ─── SCHEDULING ───────────────────────────────────────────────

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

// ─── STATS & ACTIVITY ─────────────────────────────────────────

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

router.get(
  "/:id/recipients",
  param("id").isUUID(),
  query("status")
    .optional()
    .isIn([
      "pending",
      "sent",
      "delivered",
      "opened",
      "clicked",
      "bounced",
      "unsubscribed",
    ]),
  validate,
  can("campaigns", "view"),
  async (req, res, next) => {
    try {
      res.json(
        await service.getRecipientActivity(req.business, req.params.id, {
          status: req.query.status,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

// Smart-suggestion endpoint: VIPs who opened ≥2× but didn't click.
router.get(
  "/:id/follow-up-suggestions",
  param("id").isUUID(),
  validate,
  can("campaigns", "view"),
  async (req, res, next) => {
    try {
      res.json(
        await service.getFollowUpSuggestions(req.business, req.params.id),
      );
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/:id/ab-results",
  param("id").isUUID(),
  validate,
  can("campaigns", "view"),
  async (req, res, next) => {
    try {
      res.json(await service.getAbTestResults(req.business, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

// Create an A/B variant of a campaign — child links to parent via
// parent_campaign_id. Results aggregate via the /ab-results endpoint
// when called with the parent's ID.
router.post(
  "/:id/variants",
  param("id").isUUID(),
  body("subject_line").optional().isString(),
  body("campaign_name").optional().isString(),
  body("html_content").optional().isString(),
  body("audience_filter").optional().isObject(),
  validate,
  can("campaigns", "create"),
  async (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          await service.createVariant(
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

// ─── PUBLIC TRACKING ENDPOINTS ────────────────────────────────
// These are NOT under `protect` — they're hit by email clients
// directly. The tracking_token is the credential.

// Open pixel — always returns a 1×1 GIF even on bad tokens, so an
// invalid token never breaks an email's display.
router.get("/track/:token", async (req, res, next) => {
  try {
    const pixel = await service.handlePixelOpen(req.params.token, {
      ip: req.ip,
      user_agent: req.get("user-agent"),
    });
    res.set({ "Content-Type": "image/gif", "Content-Length": pixel.length });
    res.send(pixel);
  } catch {
    // Even on internal failure, return a pixel — never break the email.
    const fallback = Buffer.from(
      "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
      "base64",
    );
    res.set({
      "Content-Type": "image/gif",
      "Content-Length": fallback.length,
    });
    res.send(fallback);
  }
});

// Click redirect — record the click, then 302 to the real URL.
router.get(
  "/track/:token/click",
  query("url").isURL({ require_protocol: true }),
  validate,
  async (req, res, next) => {
    try {
      const { redirectTo } = await service.handleClick(
        req.params.token,
        req.query.url,
        { ip: req.ip, user_agent: req.get("user-agent") },
      );
      res.redirect(302, redirectTo);
    } catch (err) {
      next(err);
    }
  },
);

// Unsubscribe — usually hit from an email footer link. Returns a tiny
// HTML confirmation page; production should redirect to a branded page.
router.get("/unsubscribe/:token", async (req, res) => {
  const result = await service.handleUnsubscribe(req.params.token, {
    ip: req.ip,
  });
  const message = result.ok
    ? "You have been unsubscribed. We're sorry to see you go."
    : "Unsubscribe link is invalid or expired.";
  res.set("Content-Type", "text/html");
  res.send(
    `<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:48px">
      <h2>${message}</h2>
    </body></html>`,
  );
});

module.exports = router;
