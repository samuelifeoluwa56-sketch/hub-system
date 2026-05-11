"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const config = require("./config/config");
const logger = require("./config/logger");
const requestLogger = require("./middleware/requestLogger");
const rateLimiter = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");
const routes = require("./routes/index");

const app = express();

// ── Security & parsing ────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: config.app.allowedOrigins, credentials: true }));
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Logging ───────────────────────────────────────────────
app.use(requestLogger);

// ── Rate limiting (general) ───────────────────────────────
app.use("/api", rateLimiter.general);

// ── Routes ───────────────────────────────────────────────
app.use("/api", routes);

// ── Static PWA ───────────────────────────────────────────
app.use(express.static("public"));

// ── Health check ─────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", env: config.app.env }),
);

// ── 404 ──────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ message: "Route not found" }));

// ── Error handler ─────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
