require('dotenv').config();
const app = require('./src/app');
const PORT = parseInt(process.env.PORT, 10) || 5000;

app.listen(PORT, () => {
  console.log(`BetPro Backend running on port ${PORT}`);
});
