"use strict";
const logger = require("../config/logger");
// TODO: Query scheduled social posts and dispatch to social adapters
module.exports = async function publishScheduledPosts() {
  logger.debug(
    "publishScheduledPosts: implement social_posts table and publisher logic",
  );
};
