const router = require('express').Router();
const auth = require('../middleware/auth');
const supabase = require('../config/supabase');
const axios = require('axios');

// ─────────────────────────────────────────────
//  FXS PAY CONFIG
//  FXSPAY_BASE_URL   e.g. https://fxspay.onrender.com
//  FXSPAY_API_KEY    BetPro Win's own fxs_live_... key
// ─────────────────────────────────────────────
function fxsHeaders() {
  return {
    Authorization: `Bearer ${process.env.FXSPAY_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ─────────────────────────────────────────────
//  REFERRAL BONUS — pays KSh 50 to the inviter
//  the FIRST time their invited friend deposits.
// ─────────────────────────────────────────────
const REFERRAL_BONUS = 50;

async function payReferralBonusIfEligible(newUserId) {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, referred_by, referral_bonus_paid')
      .eq('id', newUserId)
      .single();

    if (!user || !user.referred_by || user.referral_bonus_paid) return;

    const { data: referrer } = await supabase
      .from('users')
      .select('id, balance, referral_earnings')
      .eq('id', user.referred_by)
      .single();

    if (!referrer) return;

    await supabase.from('users').update({
      balance: (referrer.balance || 0) + REFERRAL_BONUS,
      referral_earnings: (referrer.referral_earnings || 0) + REFERRAL_BONUS
    }).eq('id', referrer.id);

    await supabase.from('users').update({ referral_bonus_paid: true }).eq('id', newUserId);

    await supabase.from('transactions').insert({
      user_id: referrer.id,
      amount: REFERRAL_BONUS,
      description: 'Referral Bonus — Friend Deposited 🎉',
      status: 'completed',
      created_at: new Date()
    });

    console.log(`Referral bonus: KSh ${REFERRAL_BONUS} paid to ${referrer.id} for inviting ${newUserId}`);
  } catch (e) {
    console.error('Referral bonus error:', e.message);
  }
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return '254' + digits.slice(1);
  if (digits.startsWith('7') || digits.startsWith('1')) return '254' + digits;
  return digits;
}

// ─────────────────────────────────────────────
//  STK PUSH via FXS PAY
//  Frontend calls POST /api/payments/stkpush — unchanged contract:
//  returns { success, CheckoutRequestID, redirect_url }
// ─────────────────────────────────────────────
router.post('/stkpush', auth, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 20) return res.status(400).json({ error: 'Minimum deposit is KSh 20' });

  try {
    const msisdn = normalizePhone(phone);
    console.log(`FXS Pay STK: phone=${msisdn} amount=${amount} user=${req.user.id}`);

    const fxsRes = await axios.post(
      `${process.env.FXSPAY_BASE_URL}/api/mpesa/stk-push`,
      { phone: msisdn, amount, description: 'BetPro Deposit' },
      { headers: fxsHeaders() }
    );

    const { transactionId } = fxsRes.data;

    const { error: insertError } = await supabase.from('transactions').insert({
      user_id: req.user.id,
      amount,
      description: 'M-Pesa Deposit (pending)',
      status: 'pending',
      checkout_id: transactionId,
      created_at: new Date()
    });
    if (insertError) console.error('Transaction insert error:', insertError.message);

    res.json({
      success: true,
      CheckoutRequestID: transactionId,
      redirect_url: null
    });
  } catch (e) {
    console.error('FXS Pay STK error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Deposit initiation failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  PAYMENT STATUS
// ─────────────────────────────────────────────
router.get('/status/:checkoutId', auth, async (req, res) => {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('checkout_id', req.params.checkoutId)
    .eq('user_id', req.user.id)
    .single();

  if (!data) return res.status(404).json({ error: 'Transaction not found' });

  if (data.status === 'pending') {
    try {
      const statusRes = await axios.get(
        `${process.env.FXSPAY_BASE_URL}/api/mpesa/status/${req.params.checkoutId}`,
        { headers: fxsHeaders() }
      );
      const fxsStatus = statusRes.data.transaction?.status;
      console.log('FXS Pay status check:', fxsStatus);

      if (fxsStatus === 'success') {
        await supabase.from('transactions')
          .update({ status: 'completed', description: 'M-Pesa Deposit' })
          .eq('checkout_id', req.params.checkoutId);

        const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
        const newBalance = (user?.balance || 0) + data.amount;
        await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);

        await payReferralBonusIfEligible(req.user.id);

        return res.json({ status: 'completed', amount: data.amount });
      } else if (fxsStatus === 'failed') {
        await supabase.from('transactions')
          .update({ status: 'failed' })
          .eq('checkout_id', req.params.checkoutId);
        return res.json({ status: 'failed', amount: data.amount });
      }
    } catch (e) {
      console.error('Status check error:', e.response?.data || e.message);
    }
  }

  res.json({ status: data.status, amount: data.amount });
});

// ─────────────────────────────────────────────
//  WITHDRAW (Manual — admin pays via PesaPal dashboard)
//  UNCHANGED — FXS Pay doesn't have a payout/transfer
//  endpoint yet, so withdrawals stay manual for now.
// ─────────────────────────────────────────────
router.post('/withdraw', auth, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is KSh 100' });

  const { data: user } = await supabase.from('users').select('balance, phone').eq('id', req.user.id).single();
  if (!user || user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  try {
    const newBalance = user.balance - amount;
    await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);

    await supabase.from('transactions').insert({
      user_id: req.user.id,
      amount: -amount,
      description: `M-Pesa Withdrawal to ${phone}`,
      status: 'pending',
      created_at: new Date()
    });

    try {
      await axios.post('https://api.resend.com/emails', {
        from: 'BetPro Win <onboarding@resend.dev>',
        to: process.env.ADMIN_EMAIL,
        subject: `💸 New Withdrawal Request — KSh ${amount}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
            <h2 style="color:#00ff87">🏆 BetPro Win — Withdrawal Request</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px;font-weight:bold">Amount:</td><td style="padding:8px;color:#e74c3c;font-size:20px;font-weight:bold">KSh ${amount.toLocaleString()}</td></tr>
              <tr style="background:#f9f9f9"><td style="padding:8px;font-weight:bold">Send to:</td><td style="padding:8px;font-size:18px;font-weight:bold">${phone}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">User Phone:</td><td style="padding:8px">${user.phone}</td></tr>
              <tr style="background:#f9f9f9"><td style="padding:8px;font-weight:bold">User ID:</td><td style="padding:8px">${req.user.id}</td></tr>
              <tr><td style="padding:8px;font-weight:bold">Time:</td><td style="padding:8px">${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}</td></tr>
            </table>
            <p style="margin-top:20px;color:#666">Please send KSh ${amount} to <strong>${phone}</strong> via M-Pesa or PesaPal dashboard.</p>
            <p style="color:#999;font-size:12px">BetPro Win Admin Panel</p>
          </div>
        `
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      console.log(`Withdrawal email sent: KSh ${amount} to ${phone}`);
    } catch (emailErr) {
      console.error('Email notification error:', emailErr.response?.data || emailErr.message);
    }

    res.json({
      success: true,
      message: `Withdrawal request of KSh ${amount} submitted. You will receive your money within 24 hours.`,
      balance: newBalance
    });
  } catch (e) {
    console.error('Withdraw error:', e.message);
    res.status(500).json({ error: 'Withdrawal failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  BUY GOODS / TILL callbacks — UNCHANGED
// ─────────────────────────────────────────────
router.post('/buygoods/callback', async (req, res) => {
  try {
    const { TransID, TransAmount, BillRefNumber } = req.body;
    const amount = parseFloat(TransAmount);
    const accountRef = BillRefNumber?.toString().trim();
    const digits = accountRef?.replace(/^\+?254/, '').replace(/^0/, '');
    const formats = [digits, '0' + digits, '+254' + digits, '254' + digits, accountRef];

    const { data: user } = await supabase
      .from('users').select('id, balance, phone').in('phone', formats).single();

    if (!user) {
      console.warn('Paybill: no user found for account ref:', accountRef);
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    await supabase.from('transactions').insert({
      user_id: user.id, amount,
      description: `Buy Goods Deposit (${TransID})`,
      status: 'completed', checkout_id: TransID, created_at: new Date()
    });

    const newBalance = (user.balance || 0) + amount;
    await supabase.from('users').update({ balance: newBalance }).eq('id', user.id);
    console.log(`Buy Goods: credited KSh ${amount} to user ${user.id}`);
  } catch (e) {
    console.error('Buy Goods callback error:', e.message);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

router.post('/buygoods/check', auth, async (req, res) => {
  try {
    const { data: tx } = await supabase
      .from('transactions').select('*')
      .eq('user_id', req.user.id).eq('status', 'completed')
      .ilike('description', 'Buy Goods Deposit%')
      .order('created_at', { ascending: false }).limit(1).single();

    if (!tx) return res.json({ success: false, message: 'No recent paybill payment found' });
    const ageMinutes = (new Date() - new Date(tx.created_at)) / 60000;
    if (ageMinutes > 10) return res.json({ success: false, message: 'No recent payment found' });
    res.json({ success: true, amount: tx.amount, transactionId: tx.checkout_id });
  } catch (e) {
    res.json({ success: false, message: 'No recent payment found' });
  }
});

module.exports = router;
