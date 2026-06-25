const router = require('express').Router();
const supabase = require('../config/supabase');
const axios = require('axios');

// ─────────────────────────────────────────────
//  PESAPAL IPN CALLBACK
//  PesaPal POSTs here when a payment completes/fails
//  Register URL: POST /api/payments/register-ipn
//  This endpoint: POST /api/callback/pesapal
// ─────────────────────────────────────────────
router.post('/pesapal', async (req, res) => {
  // Always acknowledge immediately — PesaPal requires this
  res.json({ OrderNotificationType: 'IPNCHANGE', OrderTrackingId: req.body.OrderTrackingId, OrderMerchantReference: req.body.OrderMerchantReference });

  try {
    const { OrderTrackingId, OrderMerchantReference, OrderNotificationType } = req.body;
    if (!OrderTrackingId) return;

    // Fetch the authoritative transaction status from PesaPal
    let token;
    try {
      const tokenRes = await axios.post(
        `${process.env.PESAPAL_BASE_URL}/api/Auth/RequestToken`,
        {
          consumer_key: process.env.PESAPAL_CONSUMER_KEY,
          consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
        },
        { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
      );
      token = tokenRes.data.token;
    } catch (e) {
      console.error('PesaPal IPN: token error', e.message);
      return;
    }

    const statusRes = await axios.get(
      `${process.env.PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );

    const { payment_status_description, amount, currency } = statusRes.data;

    // Find the pending transaction in our DB
    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('checkout_id', OrderTrackingId)
      .eq('status', 'pending')
      .single();

    if (!tx) {
      // Maybe already processed (IPN can fire multiple times)
      console.log('PesaPal IPN: no pending tx for', OrderTrackingId);
      return;
    }

    if (payment_status_description?.toLowerCase() === 'completed') {
      // Mark transaction completed
      await supabase.from('transactions')
        .update({ status: 'completed', description: 'M-Pesa Deposit' })
        .eq('checkout_id', OrderTrackingId);

      // Credit user balance
      const { data: user } = await supabase
        .from('users').select('balance').eq('id', tx.user_id).single();
      const newBalance = (user?.balance || 0) + (amount || tx.amount);
      await supabase.from('users').update({ balance: newBalance }).eq('id', tx.user_id);

      console.log(`PesaPal IPN: credited KES ${amount || tx.amount} to user ${tx.user_id}`);
    } else if (['failed', 'invalid', 'reversed'].includes(payment_status_description?.toLowerCase())) {
      await supabase.from('transactions')
        .update({ status: 'failed' })
        .eq('checkout_id', OrderTrackingId);

      console.log(`PesaPal IPN: payment ${payment_status_description} for ${OrderTrackingId}`);
    }
    // PENDING — do nothing, wait for next IPN
  } catch (e) {
    console.error('PesaPal IPN processing error:', e.message);
  }
});

// ─────────────────────────────────────────────
//  PESAPAL REDIRECT CALLBACK
//  Browser lands here after user completes/cancels
//  PesaPal will GET /api/callback/pesapal-redirect?OrderTrackingId=...
//  We just redirect back to the app; the IPN above has already updated the balance
// ─────────────────────────────────────────────
router.get('/pesapal-redirect', async (req, res) => {
  // Just close the tab / redirect home — STK push users never leave the app
  // so this only fires for edge cases (e.g. browser fallback)
  res.redirect(process.env.APP_URL || '/');
});

// ─────────────────────────────────────────────
//  LEGACY ROUTES — kept so existing withdraw
//  and timeout callbacks still work
// ─────────────────────────────────────────────

// Old Daraja STK callback (no longer used for deposits, kept for safety)
router.post('/mpesa', async (req, res) => {
  try {
    const { Body } = req.body;
    const { stkCallback } = Body;
    const checkoutId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;

    if (resultCode === 0) {
      const items = stkCallback.CallbackMetadata.Item;
      const amount = items.find(i => i.Name === 'Amount')?.Value;

      const { data: tx } = await supabase
        .from('transactions')
        .select('*')
        .eq('checkout_id', checkoutId)
        .eq('status', 'pending')
        .single();

      if (tx) {
        await supabase.from('transactions')
          .update({ status: 'completed', description: 'M-Pesa Deposit' })
          .eq('checkout_id', checkoutId);

        const { data: user } = await supabase.from('users').select('balance').eq('id', tx.user_id).single();
        const newBalance = (user?.balance || 0) + (amount || tx.amount);
        await supabase.from('users').update({ balance: newBalance }).eq('id', tx.user_id);
      }
    } else {
      await supabase.from('transactions')
        .update({ status: 'failed' })
        .eq('checkout_id', checkoutId);
    }
  } catch (e) {
    console.error('Legacy Daraja callback error:', e.message);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

router.post('/withdraw', (req, res) => res.json({ ResultCode: 0 }));
router.post('/timeout', (req, res) => res.json({ ResultCode: 0 }));

module.exports = router;
