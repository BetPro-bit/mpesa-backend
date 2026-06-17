const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/games', require('./routes/games'));
app.use('/api/football', require('./routes/football'));
app.use('/api/callback', require('./routes/callback'));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = app;
