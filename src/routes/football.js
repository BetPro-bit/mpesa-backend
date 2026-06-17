const router = require('express').Router();
const axios = require('axios');

const FOOTBALL_API_KEY = 'c0fdb14df2c8457ab9f35e886e41a2bb';
const FOOTBALL_API = 'https://api.football-data.org/v4';

// Proxy matches from football-data.org
router.get('/matches', async (req, res) => {
  try {
    const response = await axios.get(`${FOOTBALL_API}/matches`, {
      headers: { 'X-Auth-Token': FOOTBALL_API_KEY },
      params: {
        competitions: '2021,2014,2019,2002,2001,2015,2016',
        status: 'LIVE,SCHEDULED,TIMED'
      }
    });
    res.json({ success: true, matches: response.data.matches });
  } catch (e) {
    console.error('Football API error:', e.message);
    res.status(500).json({ success: false, error: 'Could not fetch matches' });
  }
});

module.exports = router;
