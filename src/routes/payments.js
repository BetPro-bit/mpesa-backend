const router = require('express').Router();
const auth = require('../middleware/auth');
const supabase = require('../config/supabase');
const axios = require('axios');

// ─────────────────────────────────────────────
//  PESAPAL HELPERS
// ─────────────────────────────────────────────

let _pesapalToken = null;
let _pesapalTokenExpiry = 0;

async function getPesapalToken() {
  if (_pesapalToken && Date.now() < _pesapalTokenExpiry) return _pesapalToken;
  const res = await axios.post(
    `${process.env.PESAPAL_BASE_URL}/api/Auth/RequestToken`,
    {
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
    },
    { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
  );
  _pesapalToken = res.data.token;
  _pesapalTokenExpiry = Date.now() + 4.5 * 60 * 1000;
  return _pesapalToken;
}

async function ensureIpnRegistered(token) {
  const ipnUrl = `${process.env.BACKEND_URL}/api/callback/pesapal`;
  const res = await axios.post(
    `${process.env.PESAPAL_BASE_URL}/api/URLSetup/RegisterIPN`,
    { url: ipnUrl, ipn_notification_type: 'POST' },
    {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    }
  );
  return res.data.ipn_id;
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return '254' + digits.slice(1);
  if (digits.startsWith('7') || digits.startsWith('1')) return '254' + digits;
  return digits;
}

// ─────────────────────────────────────────────
//  STK PUSH via PesaPal
//  Frontend calls POST /api/payments/stkpush — unchanged
// ─────────────────────────────────────────────
router.post('/stkpush', auth, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 20) return res.status(400).json({ error: 'Minimum deposit is KSh 20' });

  try {
    const token = await getPesapalToken();
    const merchantRef = `BETPRO-${req.user.id}-${Date.now()}`;
    const msisdn = normalizePhone(phone);

    console.log(`PesaPal STK: phone=${msisdn} amount=${amount} ref=${merchantRef}`);

    const orderPayload = {
      id: merchantRef,
      currency: 'KES',
      amount: Math.floor(amount),
      description: 'BetPro Deposit',
      callback_url: `${process.env.BACKEND_URL}/api/callback/pesapal-redirect`,
      notification_id: process.env.PESAPAL_IPN_ID,
      billing_address: {
        phone_number: msisdn,
        first_name: 'BetPro',
        last_name: 'User',
        email_address: `${msisdn}@betpro.app`
      }
    };

    console.log('PesaPal order payload:', JSON.stringify(orderPayload));

    const orderRes = await axios.post(
      `${process.env.PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`,
      orderPayload,
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      }
    );

    console.log('PesaPal order response:', JSON.stringify(orderRes.data));

    const { order_tracking_id, redirect_url, error } = orderRes.data;

    if (error && error.code !== '200') {
      console.error('PesaPal order error:', error);
      return res.status(500).json({ error: error.message || 'PesaPal order failed' });
    }

    // Save pending transaction
    await supabase.from('transactions').insert({
      user_id: req.user.id,
      amount,
      description: 'M-Pesa Deposit (pending)',
      status: 'pending',
      checkout_id: order_tracking_id,
      merchant_ref: merchantRef,
      created_at: new Date()
    });

    // Return same shape frontend expects
    res.json({
      success: true,
      CheckoutRequestID: order_tracking_id,
      redirect_url // frontend can use this if STK doesn't arrive
    });
  } catch (e) {
    console.error('PesaPal STK error:', e.response?.data || e.message);
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
      const token = await getPesapalToken();
      const statusRes = await axios.get(
        `${process.env.PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${req.params.checkoutId}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      const ps = statusRes.data;
      console.log('PesaPal status check:', JSON.stringify(ps));

      if (ps.payment_status_description === 'COMPLETED') {
        await supabase.from('transactions')
          .update({ status: 'completed', description: 'M-Pesa Deposit' })
          .eq('checkout_id', req.params.checkoutId);

        const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
        const newBalance = (user?.balance || 0) + data.amount;
        await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);
        return res.json({ status: 'completed', amount: data.amount });
      }
    } catch (e) {
      console.error('Status check error:', e.response?.data || e.message);
    }
  }

  res.json({ status: data.status, amount: data.amount });
});

// ─────────────────────────────────────────────
//  WITHDRAW (Daraja B2C — PesaPal doesn't do payouts)
// ─────────────────────────────────────────────
router.post('/withdraw', auth, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is KSh 100' });

  const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
  if (!user || user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  try {
    const mpesaAuth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');
    const tokenRes = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${mpesaAuth}` } }
    );
    const mpesaToken = tokenRes.data.access_token;

    await axios.post('https://api.safaricom.co.ke/mpesa/b2c/v3/paymentrequest', {
      OriginatorConversationID: `BETPRO-${Date.now()}`,
      InitiatorName: process.env.MPESA_INITIATOR_NAME,
      SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
      CommandID: 'BusinessPayment',
      Amount: Math.floor(amount),
      PartyA: process.env.MPESA_SHORTCODE,
      PartyB: phone,
      Remarks: 'BetPro Withdrawal',
      QueueTimeOutURL: `${process.env.BACKEND_URL}/api/callback/timeout`,
      ResultURL: `${process.env.BACKEND_URL}/api/callback/withdraw`
    }, { headers: { Authorization: `Bearer ${mpesaToken}` } });

    const newBalance = user.balance - amount;
    await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);
    await supabase.from('transactions').insert({
      user_id: req.user.id, amount: -amount,
      description: 'M-Pesa Withdrawal', status: 'completed',
      created_at: new Date()
    });

    res.json({ success: true, message: `KSh ${amount} sent to ${phone}`, balance: newBalance });
  } catch (e) {
    console.error('Withdraw error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// ─────────────────────────────────────────────
//  IPN REGISTRATION HELPER (run once)
// ─────────────────────────────────────────────
router.post('/register-ipn', async (req, res) => {
  try {
    const token = await getPesapalToken();
    const ipnId = await ensureIpnRegistered(token);
    res.json({ success: true, ipn_id: ipnId, message: 'Save this as PESAPAL_IPN_ID in your .env' });
  } catch (e) {
    console.error('IPN registration error:', e.response?.data || e.message);
    res.status(500).json({ error: 'IPN registration failed', detail: e.response?.data });
  }
});

// ─────────────────────────────────────────────
//  BUY GOODS / TILL callbacks (kept from original)
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
