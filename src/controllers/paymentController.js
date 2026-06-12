/**
 * paymentController.js
 *
 * Controllers for:
 *  POST /api/payments/stkpush   - initiate payment
 *  POST /api/payments/callback  - Safaricom callback
 *  GET  /api/payments/:id       - query transaction status
 *  GET  /api/payments           - list payments (admin)
 */

const validator = require('validator');
const Payment = require('../models/Payment');
const { initiateSTKPush } = require('../services/darajaService');
const logger = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize phone to Safaricom format: 2547XXXXXXXX
 * Accepts: 07XXXXXXXX | 7XXXXXXXX | 2547XXXXXXXX | +2547XXXXXXXX
 */
const normalizePhone = (phone) => {
  const cleaned = String(phone).replace(/\D/g, '');

  if (/^2547\d{8}$/.test(cleaned)) return cleaned;
  if (/^07\d{8}$/.test(cleaned)) return `254${cleaned.slice(1)}`;
  if (/^7\d{8}$/.test(cleaned)) return `254${cleaned}`;
  if (/^2541\d{8}$/.test(cleaned)) return cleaned; // Airtel KE
  if (/^01\d{8}$/.test(cleaned)) return `254${cleaned.slice(1)}`;

  return null;
};

const validateSafaricomPhone = (phone) => /^2547\d{8}$/.test(phone);

// ── Initiate STK Push ─────────────────────────────────────────────────────────

exports.initiatePayment = async (req, res, next) => {
  try {
    const { phone, amount, accountReference, transactionDesc } = req.body;

    // ── Validation ────────────────────────────────────────────────────────
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });
    if (!amount || isNaN(amount) || Number(amount) < 1) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }
    if (!accountReference) {
      return res.status(400).json({ success: false, message: 'accountReference is required' });
    }
    if (accountReference.length > 12) {
      return res.status(400).json({ success: false, message: 'accountReference max length is 12 characters' });
    }
    if (transactionDesc && transactionDesc.length > 13) {
      return res.status(400).json({ success: false, message: 'transactionDesc max length is 13 characters' });
    }

    // ── Normalize phone ───────────────────────────────────────────────────
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone || !validateSafaricomPhone(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Use format: 07XXXXXXXX or 2547XXXXXXXX',
      });
    }

    // ── Call Daraja ───────────────────────────────────────────────────────
    const darajaResponse = await initiateSTKPush({
      phone: normalizedPhone,
      amount: Number(amount),
      accountReference: validator.escape(accountReference),
      transactionDesc: transactionDesc ? validator.escape(transactionDesc) : 'Payment',
    });

    // ── Persist to DB ─────────────────────────────────────────────────────
    const payment = await Payment.create({
      phone: normalizedPhone,
      amount: Number(amount),
      accountReference,
      transactionDesc,
      checkoutRequestId: darajaResponse.CheckoutRequestID,
      merchantRequestId: darajaResponse.MerchantRequestID,
      status: 'PENDING',
      stkPushResponse: darajaResponse,
    });

    logger.info(`Payment created: ${payment._id} | CheckoutRequestID: ${payment.checkoutRequestId}`);

    return res.status(200).json({
      success: true,
      message: darajaResponse.CustomerMessage,
      data: {
        checkoutRequestId: darajaResponse.CheckoutRequestID,
        merchantRequestId: darajaResponse.MerchantRequestID,
        responseCode: darajaResponse.ResponseCode,
        responseDescription: darajaResponse.ResponseDescription,
        customerMessage: darajaResponse.CustomerMessage,
      },
    });
  } catch (error) {
    logger.error(`initiatePayment error: ${error.message}`);
    next(error);
  }
};

// ── Daraja Callback ───────────────────────────────────────────────────────────

exports.handleCallback = async (req, res, next) => {
  try {
    const body = req.body;

    // ── Verify top-level structure ────────────────────────────────────────
    if (!body?.Body?.stkCallback) {
      logger.warn('Callback received with unexpected payload structure');
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid payload structure' });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } =
      body.Body.stkCallback;

    logger.info(
      `Callback received | CheckoutRequestID: ${CheckoutRequestID} | ResultCode: ${ResultCode}`
    );

    // ── Parse metadata only on success ────────────────────────────────────
    let amount = null;
    let mpesaReceiptNumber = null;
    let transactionDate = null;
    let phoneNumber = null;

    if (ResultCode === 0 && CallbackMetadata?.Item) {
      const findItem = (name) =>
        CallbackMetadata.Item.find((i) => i.Name === name)?.Value ?? null;

      amount = findItem('Amount');
      mpesaReceiptNumber = findItem('MpesaReceiptNumber');
      transactionDate = String(findItem('TransactionDate'));
      phoneNumber = String(findItem('PhoneNumber'));
    }

    // ── Update payment record ─────────────────────────────────────────────
    const payment = await Payment.findOneAndUpdate(
      { checkoutRequestId: CheckoutRequestID },
      {
        merchantRequestId: MerchantRequestID,
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        receiptNumber: mpesaReceiptNumber,
        transactionDate,
        ...(phoneNumber && { phone: phoneNumber }),
        ...(amount !== null && { amount }),
        status: ResultCode === 0 ? 'SUCCESS' : 'FAILED',
        callbackPayload: body,
      },
      { new: true }
    );

    if (!payment) {
      logger.warn(`Callback for unknown CheckoutRequestID: ${CheckoutRequestID}`);
    } else {
      logger.info(`Payment updated: ${payment._id} → ${payment.status}`);
    }

    // ── Always return 200 to Safaricom ────────────────────────────────────
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    logger.error(`handleCallback error: ${error.message}`);
    // Still return 200 so Safaricom doesn't retry
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
};

// ── Query Transaction ─────────────────────────────────────────────────────────

exports.getTransaction = async (req, res, next) => {
  try {
    const { checkoutRequestId } = req.params;

    if (!checkoutRequestId) {
      return res.status(400).json({ success: false, message: 'checkoutRequestId is required' });
    }

    const payment = await Payment.findOne({ checkoutRequestId });

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        status: payment.status,
        amount: payment.amount,
        receipt: payment.receiptNumber,
        phone: payment.phone,
        accountReference: payment.accountReference,
        resultDesc: payment.resultDesc,
        transactionDate: payment.formattedDate,
        createdAt: payment.createdAt,
      },
    });
  } catch (error) {
    logger.error(`getTransaction error: ${error.message}`);
    next(error);
  }
};

// ── List Payments (admin) ─────────────────────────────────────────────────────

exports.listPayments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status.toUpperCase();
    if (req.query.phone) filter.phone = req.query.phone.replace(/\D/g, '');

    const [payments, total] = await Promise.all([
      Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Payment.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: payments.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: payments,
    });
  } catch (error) {
    logger.error(`listPayments error: ${error.message}`);
    next(error);
  }
};
