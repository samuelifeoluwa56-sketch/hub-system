'use strict';

const express = require('express');
const router  = express.Router();
const { param } = require('express-validator');
const validate  = require('../../middleware/validateBody');
const { can }   = require('../../middleware/permissions');
const service   = require('./dashboards.service');

// GET /api/dashboards/sales
router.get('/sales', can('dashboards','view'), async (req, res, next) => {
  try { res.json(await service.getSalesDashboard(req.business, req.query, req.user)); }
  catch (err) { next(err); }
});

// GET /api/dashboards/finance
router.get('/finance', can('dashboards','view'), async (req, res, next) => {
  try { res.json(await service.getFinanceDashboard(req.business, req.query)); }
  catch (err) { next(err); }
});

// GET /api/dashboards/stock
router.get('/stock', can('dashboards','view'), async (req, res, next) => {
  try { res.json(await service.getStockDashboard(req.business, req.query)); }
  catch (err) { next(err); }
});

// GET /api/dashboards/customers
router.get('/customers', can('dashboards','view'), async (req, res, next) => {
  try { res.json(await service.getCustomerDashboard(req.business, req.query)); }
  catch (err) { next(err); }
});

// GET /api/dashboards/retail-partners
router.get('/retail-partners', can('dashboards','view'), async (req, res, next) => {
  try { res.json(await service.getRetailPartnerDashboard(req.business, req.query)); }
  catch (err) { next(err); }
});

// GET /api/dashboards/logistics
router.get('/logistics', can('dashboards','view'), async (req, res, next) => {
  try { res.json(await service.getLogisticsDashboard(req.business, req.query)); }
  catch (err) { next(err); }
});

// GET /api/dashboards/overview — combined high-level summary
router.get('/overview', can('dashboards','view'), async (req, res, next) => {
  try { res.json(await service.getOverview(req.business, req.query, req.user)); }
  catch (err) { next(err); }
});

module.exports = router;
