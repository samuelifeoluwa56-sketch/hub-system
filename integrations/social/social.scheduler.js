"use strict";

// Called by jobs/publishScheduledPosts.js
// In a full implementation this queries a social_posts table
// and publishes anything with scheduled_at <= now()
// For now this is the pattern — wire to DB when social_posts table is added

const socialService = require("./social.service");
const logger = require("../../config/logger");

async function processScheduledPosts() {
  // TODO: Query social_posts table (to be added in a future migration)
  // SELECT * FROM shared.social_posts WHERE status='scheduled' AND scheduled_at <= now()
  // For each post: await socialService.publishPost(...)
  // UPDATE status='published'
  logger.debug("processScheduledPosts: awaiting social_posts table migration");
}

module.exports = { processScheduledPosts };
