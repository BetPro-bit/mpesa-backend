const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }, // needed for FXS Pay webhook signature verification
}));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Routes
const { router: authRouter } = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api/payments', require('./routes/payments'));
app.use('/api/games', require('./routes/games'));
app.use('/api/callback', require('./routes/callback'));
app.use('/api/support', require('./routes/support'));
app.use('/api/matches', require('./routes/matches'));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = app;
