require('dotenv').config();
const http = require('http');

const token = require('jsonwebtoken').sign(
  { id: 'test', role: 'admin' },
  process.env.JWT_SECRET,
  { expiresIn: '90d' }
);

console.log('\n--- Generated Token ---');
console.log(token);
console.log('\n--- Sending STK Push ---');

const body = JSON.stringify({
  phone: '254708374149',
  amount: 1,
  accountReference: 'ORDER123',
  transactionDesc: 'Test'
});

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/payments/stkpush',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('\n--- Response ---');
    console.log(JSON.parse(data));
  });
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(body);
req.end();
