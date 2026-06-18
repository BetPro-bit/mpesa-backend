const router = require('express').Router();
const supabase = require('../config/supabase');

// Register
router.post('/register', async (req, res) => {
  const { phone, email, password, country } = req.body;
  if (!phone || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const sbEmail = phone.replace(/^0/, '254') + '@betpro.app';
  const { data, error } = await supabase.auth.admin.createUser({
    email: sbEmail, password,
    user_metadata: { phone, real_email: email, country },
    email_confirm: true
  });
  if (error) return res.status(400).json({ error: error.message });
  await supabase.from('users').insert({ id: data.user.id, phone, email, balance: 0, country });
  res.json({ success: true, message: 'Account created successfully' });
});

// Login
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  const sbEmail = phone.replace(/^0/, '254') + '@betpro.app';
  const { data, error } = await supabase.auth.signInWithPassword({ email: sbEmail, password });
  if (error) return res.status(401).json({ error: 'Invalid credentials' });
  const { data: user } = await supabase.from('users').select('*').eq('id', data.user.id).single();
  res.json({ success: true, token: data.session.access_token, user });
});

module.exports = router;
