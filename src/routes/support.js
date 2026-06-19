const router = require('express').Router();
const axios = require('axios');

const SYSTEM_PROMPT = `You are BetPro Support Assistant, a helpful AI for the BetPro betting platform in Kenya.
You help users with:
- Betting: how to place bets, understanding odds, 1X2, GG/NG (Both Teams Score), Over/Under 2.5 goals, Corners markets, accumulator bets, bet slip
- Deposits: M-Pesa STK Push (instant PIN prompt on phone) and Paybill (Business No: 400200, Account Reference: user's phone number)
- Withdrawals: minimum KSh 100, sent to M-Pesa, usually takes a few minutes
- Account: registration with phone number, login issues, password reset
- Games: Crash, Dice, Mines, Plinko available in the casino section. Minimum bet KSh 10.
- General: responsible gambling, 18+ only, contact support@betpro.com for escalations

Keep responses short, friendly and helpful. Use simple English. Format with line breaks for readability.
If you cannot help with something, direct them to support@betpro.com.
Do not discuss topics unrelated to BetPro.`;

router.post('/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama3-8b-8192',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.slice(-20)
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
      }
    });

    const reply = response.data.choices?.[0]?.message?.content || "I'm unable to respond right now. Please email support@betpro.com.";
    res.json({ success: true, reply });
  } catch (e) {
    console.error('AI support error:', e.response?.data || e.message);
    res.status(500).json({ error: 'AI unavailable', reply: "I'm having trouble right now. Please email support@betpro.com or try again shortly." });
  }
});

module.exports = router;
