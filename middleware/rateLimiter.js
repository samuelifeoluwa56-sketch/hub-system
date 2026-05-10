'use strict';

const rateLimit = require('express-rate-limit');

const general = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      300,          // 300 requests per minute per IP
  message:  { message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const webhooks = rateLimit({
  windowMs: 60 * 1000,
  max:      500,
  message:  { message: 'Webhook rate limit exceeded' },
});

module.exports = { general, webhooks };
