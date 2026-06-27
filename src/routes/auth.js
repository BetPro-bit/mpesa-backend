const router = require('express').Router();
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');

// ─── Firebase Admin for push notifications ───────────────────────────────────
let firebaseAdmin = null;
async function getFirebaseAdmin() {
  if (firebaseAdmin) return firebaseAdmin;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
      });
    }
    firebaseAdmin = admin;
  } catch (e) {
    console.error('Firebase admin init error:', e.message);
  }
  return firebaseAdmin;
}

async function sendPushNotification(fcmToken, title, body) {
  try {
    const admin = await getFirebaseAdmin();
    if (!admin) return;
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      android: { notification: { icon: 'ic_launcher', color: '#00ff87' } },
      webpush: {
        notification: { icon: '/icons/icon-192.png', badge: '/icons/icon-72.png' },
        fcmOptions: { link: 'https://betpro-bit.github.io/betpro-pwa/' }
      }
    });
    console.log('Push notification sent to:', fcmToken.slice(0, 20) + '...');
  } catch (e) {
    console.error('Push notification error:', e.message);
  }
}

// ─── Register ─────────────────────────────────────────────────────────────────
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

// ─── Login ────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  const sbEmail = phone.replace(/^0/, '254') + '@betpro.app';
  const { data, error } = await supabase.auth.signInWithPassword({ email: sbEmail, password });
  if (error) return res.status(401).json({ error: 'Invalid credentials' });
  const { data: user } = await supabase.from('users').select('*').eq('id', data.user.id).single();
  res.json({ success: true, token: data.session.access_token, user });
});

// ─── Save FCM Token ──────────────────────────────────────────────────────────
router.post('/save-fcm-token', auth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    await supabase.from('users').update({ fcm_token: token }).eq('id', req.user.id);

    // Send welcome notification
    await sendPushNotification(token,
      '🎯 Welcome to BetPro Win!',
      'Deposit KSh 50+ and get 100% BONUS! Bet smart, win big! 🏆'
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Save FCM token error:', e.message);
    res.status(500).json({ error: 'Failed to save token' });
  }
});

// ─── Send notification to all users (admin use) ───────────────────────────────
router.post('/notify-all', async (req, res) => {
  const { title, body, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { data: users } = await supabase.from('users').select('fcm_token').not('fcm_token', 'is', null);
    let sent = 0;
    for (const user of users) {
      if (user.fcm_token) {
        await sendPushNotification(user.fcm_token, title, body);
        sent++;
      }
    }
    res.json({ success: true, sent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, sendPushNotification };
