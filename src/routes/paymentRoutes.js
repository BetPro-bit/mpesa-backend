/**
 * paymentRoutes.js
 *
 * Base path: /api/payments
 *
 * Public:
 *   POST /stkpush   - initiate STK Push (JWT protected)
 *   POST /callback  - Safaricom callback (no auth – Safaricom calls this)
 *
 * Protected:
 *   GET  /:checkoutRequestId  - query a transaction
 *   GET  /                    - list all payments (admin)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const {
  initiatePayment,
  handleCallback,
  getTransaction,
  listPayments,
} = require('../controllers/paymentController');

const router = express.Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────

const stkLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 5,                    // max 5 STK pushes per minute per IP
  message: { success: false, message: 'Too many payment requests. Please wait a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const queryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many query requests. Slow down.' },
});

// ── Routes ────────────────────────────────────────────────────────────────────

// Initiate STK Push – requires JWT + rate limit
router.post('/stkpush', protect, stkLimiter, initiatePayment);

// Safaricom Callback – no auth (Safaricom hits this directly)
router.post('/callback', handleCallback);

// Query single transaction – requires JWT
router.get('/:checkoutRequestId', protect, queryLimiter, getTransaction);

// List all payments – requires JWT
router.get('/', protect, listPayments);

module.exports = router;
