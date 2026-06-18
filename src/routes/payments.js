const router = require('express').Router();
const auth = require('../middleware/auth');
const supabase = require('../config/supabase');
const axios = require('axios');

// Get M-Pesa access token
async function getMpesaToken() {
  const credentials = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${credentials}` }
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
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.floor(amount),
      PartyA: phone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: `${process.env.BACKEND_URL}/api/callback/mpesa`,
      AccountReference: 'BETPRO',
      TransactionDesc: 'BetPro Deposit'
    }, { headers: { Authorization: `Bearer ${token}` } });

    const checkoutId = response.data.CheckoutRequestID;

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
