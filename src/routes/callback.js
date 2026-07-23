const router = require('express').Router();
const supabase = require('../config/supabase');
const axios = require('axios');
const crypto = require('crypto');

// ─── Referral bonus helper (duplicated here to keep callback.js self-contained)
const REFERRAL_BONUS = 50;
async function payReferralBonusIfEligible(newUserId) {
  try {
    const { data: user } = await supabase
      .from('users').select('id, referred_by, referral_bonus_paid').eq('id', newUserId).single();
    if (!user || !user.referred_by || user.referral_bonus_paid) return;
    const { data: referrer } = await supabase
      .from('users').select('id, balance, referral_earnings').eq('id', user.referred_by).single();
    if (!referrer) return;
    await supabase.from('users').update({
      balance: (referrer.balance || 0) + REFERRAL_BONUS,
      referral_earnings: (referrer.referral_earnings || 0) + REFERRAL_BONUS
    }).eq('id', referrer.id);
    await supabase.from('users').update({ referral_bonus_paid: true }).eq('id', newUserId);
    await supabase.from('transactions').insert({
      user_id: referrer.id, amount: REFERRAL_BONUS,
      description: 'Referral Bonus — Friend Deposited 🎉',
      status: 'completed', created_at: new Date()
    });
    console.log(`Referral bonus: KSh ${REFERRAL_BONUS} paid to ${referrer.id}`);
  } catch (e) {
    console.error('Referral bonus error:', e.message);
  }
}

// ─── Deposit bonus tiers ─────────────────────────────────────────────────────
// Bonus balance added = deposit * (multiplier - 1), since the deposit itself
// already lands in real balance. E.g. deposit 100 -> multiplier 5 -> bonus
// balance += 400, so total spendable is 100 (real) + 400 (bonus) = 500.
function getDepositBonusMultiplier(amount) {
  if (amount >= 100) return 5;
  if (amount >= 50) return 2;
  if (amount >= 20) return 1.5;
  return 1; // no bonus below KSh 20
}

// ─────────────────────────────────────────────
//  FXS PAY WEBHOOK
//  FXS Pay POSTs here when a deposit succeeds/fails.
//  Register this URL once via:
//    POST {FXSPAY_BASE_URL}/api/webhook/endpoints
//    Authorization: Bearer <BetPro Win's fxs_live_ API key>
//    body: { "url": "<this backend's URL>/api/callback/fxspay" }
//  The response includes a `secret` — save that as FXSPAY_WEBHOOK_SECRET.
//
//  Signature: FXS Pay signs the raw JSON body with HMAC-SHA256 using that
//  secret, sent as header X-FXSPay-Signature. app.js must capture the raw
//  body (req.rawBody) for this to verify correctly — see app.js.
// ─────────────────────────────────────────────
router.post('/fxspay', async (req, res) => {
  const signature = req.headers['x-fxspay-signature'];
  const eventType = req.headers['x-fxspay-event'];

  if (!signature || !req.rawBody) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const expected = crypto
    .createHmac('sha256', process.env.FXSPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (expected !== signature) {
    console.error('FXS Pay webhook: signature mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Acknowledge immediately once verified — FXS Pay retries on failure/timeout
  res.status(200).json({ received: true });

  try {
    const payload = req.body; // { transactionId, amount, currency, ... } or { transactionId, reason }
    const { transactionId, amount, reason } = payload;

    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('checkout_id', transactionId)
      .eq('status', 'pending')
      .single();

    if (!tx) {
      // Already processed (e.g. status polling beat the webhook to it) or unrecognized
      console.log('FXS Pay webhook: no pending tx for', transactionId);
      return;
    }

    if (eventType === 'payment.success') {
      await supabase.from('transactions')
        .update({ status: 'completed', description: 'M-Pesa Deposit' })
        .eq('checkout_id', transactionId);

      const depositAmount = amount || tx.amount;
      const { data: user } = await supabase
        .from('users').select('balance, bonus_balance').eq('id', tx.user_id).single();

      const newBalance = (user?.balance || 0) + depositAmount;

      const multiplier = getDepositBonusMultiplier(depositAmount);
      const bonusAmount = parseFloat((depositAmount * (multiplier - 1)).toFixed(2));
      const newBonusBalance = (user?.bonus_balance || 0) + bonusAmount;

      await supabase.from('users').update({
        balance: newBalance,
        bonus_balance: newBonusBalance
      }).eq('id', tx.user_id);

      if (bonusAmount > 0) {
        await supabase.from('transactions').insert({
          user_id: tx.user_id, amount: bonusAmount,
          description: `Deposit Bonus — ${multiplier}x (play only, not withdrawable)`,
          status: 'completed', created_at: new Date()
        });
      }

      await payReferralBonusIfEligible(tx.user_id);

      console.log(`FXS Pay webhook: credited KES ${depositAmount} to user ${tx.user_id}, bonus ${bonusAmount}`);
    } else if (eventType === 'payment.failed') {
      await supabase.from('transactions')
        .update({ status: 'failed' })
        .eq('checkout_id', transactionId);

      console.log(`FXS Pay webhook: payment failed for ${transactionId} — ${reason || 'no reason given'}`);
    }
  } catch (e) {
    console.error('FXS Pay webhook processing error:', e.message);
  }
});

// ─────────────────────────────────────────────
//  LEGACY — PESAPAL IPN CALLBACK
//  No longer receives traffic (PesaPal isn't called anymore since the
//  FXS Pay switch), kept only as a rollback safety net. Safe to remove
//  once the FXS Pay integration has run cleanly for a while.
// ─────────────────────────────────────────────
router.post('/pesapal', async (req, res) => {
  res.json({ OrderNotificationType: 'IPNCHANGE', OrderTrackingId: req.body.OrderTrackingId, OrderMerchantReference: req.body.OrderMerchantReference });

  try {
    const { OrderTrackingId } = req.body;
    if (!OrderTrackingId) return;

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

    const { payment_status_description, amount } = statusRes.data;

    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('checkout_id', OrderTrackingId)
      .eq('status', 'pending')
      .single();

    if (!tx) {
      console.log('PesaPal IPN: no pending tx for', OrderTrackingId);
      return;
    }

    if (payment_status_description?.toLowerCase() === 'completed') {
      await supabase.from('transactions')
        .update({ status: 'completed', description: 'M-Pesa Deposit' })
        .eq('checkout_id', OrderTrackingId);

      const { data: user } = await supabase
        .from('users').select('balance').eq('id', tx.user_id).single();
      const newBalance = (user?.balance || 0) + (amount || tx.amount);
      await supabase.from('users').update({ balance: newBalance }).eq('id', tx.user_id);

      await payReferralBonusIfEligible(tx.user_id);

      console.log(`PesaPal IPN: credited KES ${amount || tx.amount} to user ${tx.user_id}`);
    } else if (['failed', 'invalid', 'reversed'].includes(payment_status_description?.toLowerCase())) {
      await supabase.from('transactions')
        .update({ status: 'failed' })
        .eq('checkout_id', OrderTrackingId);

      console.log(`PesaPal IPN: payment ${payment_status_description} for ${OrderTrackingId}`);
    }
  } catch (e) {
    console.error('PesaPal IPN processing error:', e.message);
  }
});

router.get('/pesapal-redirect', async (req, res) => {
  res.redirect(process.env.APP_URL || '/');
});

// Old Daraja STK callback — legacy, kept for safety
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
