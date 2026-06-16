const router = require('express').Router();
const auth = require('../middleware/auth');
const supabase = require('../config/supabase');
const crypto = require('crypto');

// Helper: get user balance
async function getBalance(userId) {
  const { data } = await supabase.from('users').select('balance').eq('id', userId).single();
  return data?.balance || 0;
}

// Helper: update balance and save transaction
async function updateBalance(userId, amount, desc) {
  const current = await getBalance(userId);
  const newBalance = Math.max(0, current + amount);
  await supabase.from('users').update({ balance: newBalance }).eq('id', userId);
  await supabase.from('transactions').insert({
    user_id: userId,
    amount,
    description: desc,
    balance_after: newBalance,
    created_at: new Date()
  });
  return newBalance;
}

// Helper: provably fair random (server-side, cannot be manipulated)
function fairRandom(min = 0, max = 1) {
  const bytes = crypto.randomBytes(4);
  const val = bytes.readUInt32BE(0) / 0xFFFFFFFF;
  return min + val * (max - min);
}

// ── CRASH GAME ─────────────────────────────────────────────────────────────
// Generate crash multiplier (house edge ~5%)
function generateCrashMultiplier() {
  const r = fairRandom();
  if (r < 0.05) return 1.0; // instant crash 5% of the time
  return Math.max(1.0, parseFloat((1 / (1 - r) * 0.95).toFixed(2)));
}

router.post('/crash/start', auth, async (req, res) => {
  const { betAmount } = req.body;
  if (!betAmount || betAmount < 10) return res.status(400).json({ error: 'Minimum bet is KSh 10' });
  const balance = await getBalance(req.user.id);
  if (balance < betAmount) return res.status(400).json({ error: 'Insufficient balance' });

  // Deduct bet immediately
  await updateBalance(req.user.id, -betAmount, `Crash game bet`);

  // Generate crash point (hidden from client until cashout/crash)
  const crashAt = generateCrashMultiplier();
  const gameId = crypto.randomUUID();

  // Store game session in DB
  await supabase.from('game_sessions').insert({
    id: gameId,
    user_id: req.user.id,
    game: 'crash',
    bet_amount: betAmount,
    crash_at: crashAt,
    status: 'active',
    created_at: new Date()
  });

  res.json({ success: true, gameId, message: 'Game started' });
});

router.post('/crash/cashout', auth, async (req, res) => {
  const { gameId, multiplier } = req.body;

  const { data: session } = await supabase
    .from('game_sessions').select('*').eq('id', gameId).eq('user_id', req.user.id).single();

  if (!session || session.status !== 'active')
    return res.status(400).json({ error: 'Invalid game session' });

  // Check if cashed out before crash
  if (multiplier >= session.crash_at) {
    // Player held too long — they crashed
    await supabase.from('game_sessions').update({ status: 'crashed' }).eq('id', gameId);
    return res.json({ success: false, crashed: true, crashAt: session.crash_at, won: 0 });
  }

  // Player cashed out in time
  const winAmount = parseFloat((session.bet_amount * multiplier).toFixed(2));
  const newBalance = await updateBalance(req.user.id, winAmount, `Crash win x${multiplier}`);
  await supabase.from('game_sessions').update({ status: 'won', cashout_at: multiplier, win_amount: winAmount }).eq('id', gameId);

  res.json({ success: true, crashed: false, crashAt: session.crash_at, won: winAmount, balance: newBalance });
});

// ── DICE GAME ──────────────────────────────────────────────────────────────
router.post('/dice/roll', auth, async (req, res) => {
  const { betAmount, prediction, isOver } = req.body;
  // prediction: number 1-98, isOver: true/false
  if (!betAmount || betAmount < 10) return res.status(400).json({ error: 'Minimum bet is KSh 10' });
  if (!prediction || prediction < 2 || prediction > 98) return res.status(400).json({ error: 'Invalid prediction' });

  const balance = await getBalance(req.user.id);
  if (balance < betAmount) return res.status(400).json({ error: 'Insufficient balance' });

  const roll = Math.floor(fairRandom(1, 100));
  const won = isOver ? roll > prediction : roll < prediction;

  // Calculate multiplier based on win chance (house edge 2%)
  const winChance = isOver ? (99 - prediction) : (prediction - 1);
  const multiplier = parseFloat(((98 / winChance)).toFixed(4));
  const winAmount = won ? parseFloat((betAmount * multiplier).toFixed(2)) : 0;
  const netChange = won ? winAmount - betAmount : -betAmount;

  const newBalance = await updateBalance(req.user.id, netChange, won ? `Dice win x${multiplier}` : 'Dice loss');

  res.json({ success: true, roll, won, multiplier: won ? multiplier : 0, winAmount, balance: newBalance });
});

// ── MINES GAME ─────────────────────────────────────────────────────────────
router.post('/mines/start', auth, async (req, res) => {
  const { betAmount, minesCount } = req.body;
  if (!betAmount || betAmount < 10) return res.status(400).json({ error: 'Minimum bet is KSh 10' });
  if (!minesCount || minesCount < 1 || minesCount > 24) return res.status(400).json({ error: 'Invalid mines count' });

  const balance = await getBalance(req.user.id);
  if (balance < betAmount) return res.status(400).json({ error: 'Insufficient balance' });

  // Generate mine positions (hidden from client)
  const allCells = Array.from({length: 25}, (_, i) => i);
  const mines = [];
  const available = [...allCells];
  for (let i = 0; i < minesCount; i++) {
    const idx = Math.floor(fairRandom(0, available.length));
    mines.push(available.splice(idx, 1)[0]);
  }

  await updateBalance(req.user.id, -betAmount, 'Mines game bet');
  const gameId = crypto.randomUUID();

  await supabase.from('game_sessions').insert({
    id: gameId, user_id: req.user.id, game: 'mines',
    bet_amount: betAmount, mines_count: minesCount,
    mine_positions: mines, revealed: [], status: 'active',
    created_at: new Date()
  });

  res.json({ success: true, gameId });
});

router.post('/mines/reveal', auth, async (req, res) => {
  const { gameId, cell } = req.body;
  const { data: session } = await supabase
    .from('game_sessions').select('*').eq('id', gameId).eq('user_id', req.user.id).single();

  if (!session || session.status !== 'active')
    return res.status(400).json({ error: 'Invalid game session' });

  const isMine = session.mine_positions.includes(cell);

  if (isMine) {
    await supabase.from('game_sessions').update({ status: 'lost', revealed: [...session.revealed, cell] }).eq('id', gameId);
    return res.json({ success: true, isMine: true, minePositions: session.mine_positions });
  }

  const revealed = [...session.revealed, cell];
  const gemsFound = revealed.length;
  const totalSafe = 25 - session.mines_count;
  const multiplier = parseFloat((0.97 * (totalSafe / (totalSafe - gemsFound + 1)) ** gemsFound).toFixed(4));

  await supabase.from('game_sessions').update({ revealed, current_multiplier: multiplier }).eq('id', gameId);
  res.json({ success: true, isMine: false, gemsFound, multiplier });
});

router.post('/mines/cashout', auth, async (req, res) => {
  const { gameId } = req.body;
  const { data: session } = await supabase
    .from('game_sessions').select('*').eq('id', gameId).eq('user_id', req.user.id).single();

  if (!session || session.status !== 'active')
    return res.status(400).json({ error: 'Invalid game session' });

  const multiplier = session.current_multiplier || 1;
  const winAmount = parseFloat((session.bet_amount * multiplier).toFixed(2));
  const newBalance = await updateBalance(req.user.id, winAmount, `Mines win x${multiplier}`);
  await supabase.from('game_sessions').update({ status: 'won', win_amount: winAmount }).eq('id', gameId);

  res.json({ success: true, winAmount, multiplier, balance: newBalance, minePositions: session.mine_positions });
});

// ── PLINKO GAME ────────────────────────────────────────────────────────────
router.post('/plinko/drop', auth, async (req, res) => {
  const { betAmount, risk } = req.body;
  if (!betAmount || betAmount < 10) return res.status(400).json({ error: 'Minimum bet is KSh 10' });

  const balance = await getBalance(req.user.id);
  if (balance < betAmount) return res.status(400).json({ error: 'Insufficient balance' });

  // Plinko multipliers based on risk level
  const multipliers = {
    low:    [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high:   [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29]
  };

  const buckets = multipliers[risk] || multipliers.low;
  // Simulate ball path (8 rows, each 50/50 left or right)
  let pos = 0;
  const path = [];
  for (let i = 0; i < 8; i++) {
    const goRight = fairRandom() > 0.5;
    path.push(goRight ? 'R' : 'L');
    if (goRight) pos++;
  }

  const multiplier = buckets[pos];
  const winAmount = parseFloat((betAmount * multiplier).toFixed(2));
  const netChange = winAmount - betAmount;
  const newBalance = await updateBalance(req.user.id, netChange, `Plinko x${multiplier}`);

  res.json({ success: true, path, bucket: pos, multiplier, winAmount, balance: newBalance });
});

// Get user balance
router.get('/balance', auth, async (req, res) => {
  const balance = await getBalance(req.user.id);
  res.json({ balance });
});

module.exports = router;
