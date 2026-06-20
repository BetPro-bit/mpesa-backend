const router = require('express').Router();
const auth = require('../middleware/auth');
const supabase = require('../config/supabase');
const axios = require('axios');

// Get M-Pesa access token
async function getMpesaToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

// STK Push
router.post('/stkpush', auth, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 20) return res.status(400).json({ error: 'Minimum deposit is KSh 20' });

  try {
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    const response = await axios.post('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: process.env.MPESA_SHORTCODE, // Head office shortcode (174379 for Till)
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: Math.floor(amount),
      PartyA: phone,
      PartyB: '3488107',
      PhoneNumber: phone,
      CallBackURL: `${process.env.BACKEND_URL}/api/callback/mpesa`,
      AccountReference: 'BETPRO',
      TransactionDesc: 'BetPro Deposit'
    }, { headers: { Authorization: `Bearer ${token}` } });

    const checkoutId = response.data.CheckoutRequestID;

    // Save pending transaction
    await supabase.from('transactions').insert({
      user_id: req.user.id,
      amount,
      description: 'M-Pesa Deposit (pending)',
      status: 'pending',
      checkout_id: checkoutId,
      created_at: new Date()
    });

    res.json({ success: true, CheckoutRequestID: checkoutId });
  } catch (e) {
    console.error('STK Push error:', e.response?.data || e.message);
    res.status(500).json({ error: 'STK Push failed. Check Daraja credentials.' });
  }
});

// Check payment status
router.get('/status/:checkoutId', auth, async (req, res) => {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('checkout_id', req.params.checkoutId)
    .eq('user_id', req.user.id)
    .single();

  if (!data) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ status: data.status, amount: data.amount });
});

// Withdraw
router.post('/withdraw', auth, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is KSh 100' });

  const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
  if (!user || user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  try {
    const token = await getMpesaToken();
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
    }, { headers: { Authorization: `Bearer ${token}` } });

    // Deduct balance
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

module.exports = router;

// ── PAYBILL ────────────────────────────────────────────────────────────────
// Safaricom sends a C2B callback here when user pays via Paybill 400200
// Register this URL in Daraja portal: POST /api/payments/paybill/callback
router.post('/buygoods/callback', async (req, res) => {
  try {
    const { TransactionType, TransID, TransAmount, BillRefNumber, MSISDN } = req.body;
    // BillRefNumber = account reference the user entered (their phone number)
    // MSISDN = the phone that paid
    const amount = parseFloat(TransAmount);
    const accountRef = BillRefNumber?.toString().trim();

    // Normalize phone formats for lookup
    const digits = accountRef?.replace(/^\+?254/, '').replace(/^0/, '');
    const formats = [
      digits,
      '0' + digits,
      '+254' + digits,
      '254' + digits,
      accountRef
    ];

    // Find user by phone
    const { data: user } = await supabase
      .from('users')
      .select('id, balance, phone')
      .in('phone', formats)
      .single();

    if (!user) {
      console.warn('Paybill: no user found for account ref:', accountRef);
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    // Save transaction as completed
    await supabase.from('transactions').insert({
      user_id: user.id,
      amount,
      description: `Buy Goods Deposit (${TransID})`,
      status: 'completed',
      checkout_id: TransID,
      created_at: new Date()
    });

    // Credit balance
    const newBalance = (user.balance || 0) + amount;
    await supabase.from('users').update({ balance: newBalance }).eq('id', user.id);

    console.log(`Paybill: credited KSh ${amount} to user ${user.id}`);
  } catch (e) {
    console.error('Paybill callback error:', e.message);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Check for a recent confirmed paybill deposit for a user
router.post('/buygoods/check', auth, async (req, res) => {
  try {
    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'completed')
      .ilike('description', 'Buy Goods Deposit%')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!tx) return res.json({ success: false, message: 'No recent paybill payment found' });

    // Only return if paid in last 10 minutes and not yet acknowledged
    const paidAt = new Date(tx.created_at);
    const now = new Date();
    const ageMinutes = (now - paidAt) / 60000;
    if (ageMinutes > 10) return res.json({ success: false, message: 'No recent payment found' });

    res.json({ success: true, amount: tx.amount, transactionId: tx.checkout_id });
  } catch (e) {
    res.json({ success: false, message: 'No recent payment found' });
  }
});
