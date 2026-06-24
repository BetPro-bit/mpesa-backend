const router = require('express').Router();
const auth = require('../middleware/auth');
const supabase = require('../config/supabase');
const axios = require('axios');

// ─────────────────────────────────────────────
//  PESAPAL HELPERS
// ─────────────────────────────────────────────

/** Cache token so we don't re-auth on every request */
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
  // PesaPal tokens last 5 minutes; refresh 30 s early
  _pesapalTokenExpiry = Date.now() + 4.5 * 60 * 1000;
  return _pesapalToken;
}

/** Register IPN URL once (idempotent — PesaPal deduplicates by URL) */
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
  return res.data.ipn_id;  // store this in env as PESAPAL_IPN_ID after first run
}

/** Normalize phone to 2547XXXXXXXX format required by PesaPal */
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return '254' + digits.slice(1);
  if (digits.startsWith('7') || digits.startsWith('1')) return '254' + digits;
  return digits;
}

// ─────────────────────────────────────────────
//  STK PUSH  (now powered by PesaPal)
//  Same endpoint /api/payments/stkpush — frontend unchanged
// ─────────────────────────────────────────────
router.post('/stkpush', auth, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 20) return res.status(400).json({ error: 'Minimum deposit is KSh 20' });

  try {
    const token = await getPesapalToken();

    // Build a unique merchant reference for this transaction
    const merchantRef = `BETPRO-${req.user.id}-${Date.now()}`;
    const msisdn = normalizePhone(phone);

    // Submit order to PesaPal — this triggers the M-Pesa STK push to the user
    const orderRes = await axios.post(
      `${process.env.PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`,
      {
        id: merchantRef,
        currency: 'KES',
        amount: Math.floor(amount),
        description: 'BetPro Deposit',
        callback_url: `${process.env.BACKEND_URL}/api/callback/pesapal-redirect`,
        notification_id: process.env.PESAPAL_IPN_ID,   // set this after registering IPN
        billing_address: {
          phone_number: msisdn,
          // first/last name optional but helps PesaPal records
          first_name: 'BetPro',
          last_name: 'User'
        },
        // Tell PesaPal to go straight to M-Pesa STK push
        payment_method: 'MPESA_STK'
      },
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      }
    );

    const { order_tracking_id, redirect_url, status } = orderRes.data;

    // Save pending transaction — use order_tracking_id as checkout_id
    await supabase.from('transactions').insert({
      user_id: req.user.id,
      amount,
      description: 'M-Pesa Deposit (pending)',
      status: 'pending',
      checkout_id: order_tracking_id,   // same column, different value
      merchant_ref: merchantRef,
      created_at: new Date()
    });

    // Return the same shape the frontend already expects
    res.json({ success: true, CheckoutRequestID: order_tracking_id });
  } catch (e) {
    console.error('PesaPal STK error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Deposit initiation failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  PAYMENT STATUS  (unchanged endpoint)
// ─────────────────────────────────────────────
router.get('/status/:checkoutId', auth, async (req, res) => {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('checkout_id', req.params.checkoutId)
    .eq('user_id', req.user.id)
    .single();

  if (!data) return res.status(404).json({ error: 'Transaction not found' });

  // Optionally do a live check against PesaPal if still pending
  if (data.status === 'pending') {
    try {
      const token = await getPesapalToken();
      const statusRes = await axios.get(
        `${process.env.PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${req.params.checkoutId}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      const ps = statusRes.data;
      // payment_status_description: 'COMPLETED' | 'FAILED' | 'INVALID' | 'REVERSED'
      if (ps.payment_status_description === 'COMPLETED') {
        await supabase.from('transactions')
          .update({ status: 'completed', description: 'M-Pesa Deposit' })
          .eq('checkout_id', req.params.checkoutId);

        const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
        const newBalance = (user?.balance || 0) + data.amount;
        await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);

        return res.json({ status: 'completed', amount: data.amount });
      }
    } catch (_) { /* fall through to DB status */ }
  }

  res.json({ status: data.status, amount: data.amount });
});

// ─────────────────────────────────────────────
//  WITHDRAW  (still uses Daraja B2C — PesaPal
//  does not support B2C payouts via their API)
// ─────────────────────────────────────────────
router.post('/withdraw', auth, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is KSh 100' });

  const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
  if (!user || user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  try {
    // B2C still uses Daraja (PesaPal only handles collections)
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
//  IPN REGISTRATION HELPER ROUTE
//  Call once: POST /api/payments/register-ipn
//  Copy the returned ipn_id into .env as PESAPAL_IPN_ID
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

module.exports = router;
