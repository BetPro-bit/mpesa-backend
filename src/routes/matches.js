const router = require('express').Router();
const axios = require('axios');
const NodeCache = require('node-cache');

// Cache responses for 60 seconds to avoid hitting rate limits on free tier
const cache = new NodeCache({ stdTTL: 60 });

const FOOTBALL_API = 'https://api.football-data.org/v4';
const HEADERS = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };

// Free-tier supported competition codes
const FREE_COMPETITIONS = ['PL', 'CL', 'BL1', 'SA', 'PD', 'FL1', 'ELC', 'EC', 'WC'];

// Helper: fetch from football-data with caching
async function fetchFootball(path, params = {}) {
  const cacheKey = path + JSON.stringify(params);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const response = await axios.get(`${FOOTBALL_API}${path}`, {
    headers: HEADERS,
    params
  });
  cache.set(cacheKey, response.data);
  return response.data;
}

// GET /api/matches
// Returns today's matches — supports ?status=FINISHED for settlement
router.get('/', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const params = req.query.status
      ? { dateFrom: yesterday, dateTo: today, status: req.query.status }
      : { dateFrom: today, dateTo: today };
    const data = await fetchFootball('/matches', params);
    res.json({ success: true, matches: data.matches || [] });
  } catch (e) {
    const status = e.response?.status || 500;
    const message = e.response?.data?.message || e.message;
    console.error('Football API /matches error:', message);
    res.status(status).json({ error: message });
  }
});

// GET /api/matches/live
// Returns currently live / in-play matches
router.get('/live', async (req, res) => {
  try {
    const data = await fetchFootball('/matches', { status: 'IN_PLAY,PAUSED' });
    res.json({ success: true, matches: data.matches || [] });
  } catch (e) {
    const status = e.response?.status || 500;
    const message = e.response?.data?.message || e.message;
    console.error('Football API /live error:', message);
    res.status(status).json({ error: message });
  }
});

// GET /api/matches/upcoming
// Returns scheduled matches for the next 7 days
router.get('/upcoming', async (req, res) => {
  try {
    const today = new Date();
    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);
    const dateFrom = today.toISOString().split('T')[0];
    const dateTo = nextWeek.toISOString().split('T')[0];

    const data = await fetchFootball('/matches', {
      dateFrom,
      dateTo,
      status: 'SCHEDULED,TIMED'
    });
    res.json({ success: true, matches: data.matches || [] });
  } catch (e) {
    const status = e.response?.status || 500;
    const message = e.response?.data?.message || e.message;
    console.error('Football API /upcoming error:', message);
    res.status(status).json({ error: message });
  }
});

// GET /api/matches/competitions
// Returns list of supported free-tier competitions
router.get('/competitions', async (req, res) => {
  try {
    const data = await fetchFootball('/competitions');
    const free = (data.competitions || []).filter(c =>
      FREE_COMPETITIONS.includes(c.code)
    );
    res.json({ success: true, competitions: free });
  } catch (e) {
    const status = e.response?.status || 500;
    const message = e.response?.data?.message || e.message;
    console.error('Football API /competitions error:', message);
    res.status(status).json({ error: message });
  }
});

// GET /api/matches/:competitionCode
// Returns scheduled/live matches for a specific competition
// e.g. /api/matches/PL  →  Premier League
router.get('/:competitionCode', async (req, res) => {
  const code = req.params.competitionCode.toUpperCase();

  if (!FREE_COMPETITIONS.includes(code)) {
    return res.status(400).json({
      error: `Competition "${code}" is not available on the free tier.`,
      available: FREE_COMPETITIONS
    });
  }

  try {
    const data = await fetchFootball(`/competitions/${code}/matches`, {
      status: 'SCHEDULED,TIMED,IN_PLAY,PAUSED,FINISHED'
    });
    res.json({ success: true, competition: data.competition, matches: data.matches || [] });
  } catch (e) {
    const status = e.response?.status || 500;
    const message = e.response?.data?.message || e.message;
    console.error(`Football API /${code} error:`, message);
    res.status(status).json({ error: message });
  }
});

// GET /api/matches/match/:matchId
// Returns details + odds-relevant info for a single match
router.get('/match/:matchId', async (req, res) => {
  try {
    const data = await fetchFootball(`/matches/${req.params.matchId}`);
    res.json({ success: true, match: data });
  } catch (e) {
    const status = e.response?.status || 500;
    const message = e.response?.data?.message || e.message;
    console.error('Football API match detail error:', message);
    res.status(status).json({ error: message });
  }
});

module.exports = router;
