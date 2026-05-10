'use strict';

const express  = require('express');
const router   = express.Router();
const { body } = require('express-validator');
const validate = require('../../middleware/validateBody');
const { verifyToken } = require('../../middleware/auth');
const authService = require('./auth.service');

// POST /api/auth/login
router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  validate,
  async (req, res, next) => {
    try {
      const result = await authService.login(req.body.email, req.body.password, req.ip);
      res.json(result);
    } catch (err) { next(err); }
  }
);

// POST /api/auth/refresh
router.post('/refresh',
  body('refreshToken').notEmpty(),
  validate,
  async (req, res, next) => {
    try {
      const result = await authService.refresh(req.body.refreshToken);
      res.json(result);
    } catch (err) { next(err); }
  }
);

// POST /api/auth/logout
router.post('/logout', verifyToken, async (req, res, next) => {
  try {
    await authService.logout(req.user.user_id, req.body.refreshToken);
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// POST /api/auth/switch-business
router.post('/switch-business', verifyToken,
  body('business').notEmpty(),
  validate,
  async (req, res, next) => {
    try {
      const result = await authService.switchBusiness(req.user.user_id, req.body.business);
      res.json(result);
    } catch (err) { next(err); }
  }
);

// GET /api/auth/me
router.get('/me', verifyToken, async (req, res, next) => {
  try {
    const user = await authService.getMe(req.user.user_id);
    res.json(user);
  } catch (err) { next(err); }
});

// POST /api/auth/change-password
router.post('/change-password', verifyToken,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 12 }),
  validate,
  async (req, res, next) => {
    try {
      await authService.changePassword(req.user.user_id, req.body.currentPassword, req.body.newPassword);
      res.json({ message: 'Password changed successfully' });
    } catch (err) { next(err); }
  }
);

module.exports = router;
