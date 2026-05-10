"use strict";

require("dotenv").config({
  path:
    process.env.NODE_ENV === "production"
      ? ".env.production"
      : process.env.NODE_ENV === "staging"
        ? ".env.staging"
        : ".env.local",
});

const config = {
  app: {
    env: process.env.NODE_ENV || "development",
    port: parseInt(process.env.PORT || "3000"),
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiry: process.env.JWT_EXPIRY || "24h",
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || "7d",
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS || "http://localhost:3000"
    ).split(","),
    businesses: ["jewelry", "diffusers"], // extend when adding new business line
  },

  pg: {
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DATABASE || "hub_db",
    user: process.env.PG_USER || "hub_app",
    password: process.env.PG_PASSWORD,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: true }
        : false,
    pool: {
      max: parseInt(process.env.PG_POOL_MAX || "20"),
      min: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    },
  },

  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },

  storage: {
    driver: process.env.STORAGE_DRIVER || "local", // 'local' | 's3'
    localPath: process.env.STORAGE_LOCAL_PATH || "./uploads",
    s3Bucket: process.env.S3_BUCKET,
    s3Region: process.env.S3_REGION || "eu-west-1",
  },

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY,
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET,
    baseUrl: "https://api.paystack.co",
  },

  flutterwave: {
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY,
    webhookSecret: process.env.FLUTTERWAVE_WEBHOOK_SECRET,
    baseUrl: "https://api.flutterwave.com/v3",
  },

  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
    storeUrl: process.env.SHOPIFY_STORE_URL,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  },

  woocommerce: {
    siteUrl: process.env.WC_SITE_URL,
    consumerKey: process.env.WC_CONSUMER_KEY,
    consumerSecret: process.env.WC_CONSUMER_SECRET,
    webhookSecret: process.env.WC_WEBHOOK_SECRET,
  },

  meta: {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    accessToken: process.env.META_ACCESS_TOKEN,
    verifyToken: process.env.META_VERIFY_TOKEN, // for webhook verification
    igBusinessId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
    fbPageId: process.env.FACEBOOK_PAGE_ID,
  },

  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    accessToken: process.env.TIKTOK_ACCESS_TOKEN,
  },

  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
  },

  whatsapp: {
    apiToken: process.env.WHATSAPP_API_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    baseUrl: "https://graph.facebook.com/v18.0",
  },

  chowdeck: {
    apiKey: process.env.CHOWDECK_API_KEY,
    baseUrl: process.env.CHOWDECK_BASE_URL || "https://api.chowdeck.com",
  },

  gigl: {
    clientId: process.env.GIGL_CLIENT_ID,
    clientSecret: process.env.GIGL_CLIENT_SECRET,
    baseUrl: process.env.GIGL_BASE_URL || "https://api.gigl.com",
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.SMTP_FROM_NAME || "Hub Platform",
    fromEmail: process.env.SMTP_FROM_EMAIL,
  },
};

// Validate critical config at startup
const required = ["pg.password", "app.jwtSecret", "app.refreshSecret"];
for (const key of required) {
  const val = key.split(".").reduce((o, k) => o?.[k], config);
  if (!val) {
    console.error(`FATAL: Missing required config: ${key}`);
    process.exit(1);
  }
}

module.exports = config;
