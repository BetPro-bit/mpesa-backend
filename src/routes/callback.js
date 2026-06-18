const router = require('express').Router();
const supabase = require('../config/supabase');

// M-Pesa STK Push callback
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
    console.error('Callback error:', e.message);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

router.post('/withdraw', (req, res) => res.json({ ResultCode: 0 }));
router.post('/timeout', (req, res) => res.json({ ResultCode: 0 }));

module.exports = router;
