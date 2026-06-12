# M-Pesa Daraja STK Push API

A production-ready Node.js backend for integrating **Safaricom Daraja Sandbox STK Push** payments with mobile or web applications.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Project Structure](#project-structure)
3. [Installation](#installation)
4. [Environment Variables](#environment-variables)
5. [API Reference](#api-reference)
6. [Daraja Sandbox Setup](#daraja-sandbox-setup)
7. [Testing with Sandbox](#testing-with-sandbox)
8. [Example Callback Payload](#example-callback-payload)
9. [Deployment](#deployment)
10. [Security](#security)

---

## Tech Stack

| Layer        | Technology                                      |
|--------------|-------------------------------------------------|
| Runtime      | Node.js ≥ 18                                    |
| Framework    | Express.js                                      |
| Database     | MongoDB + Mongoose                              |
| Auth         | JWT (jsonwebtoken)                              |
| HTTP Client  | Axios                                           |
| Security     | Helmet, CORS, express-mongo-sanitize, xss-clean |
| Rate Limiting| express-rate-limit                              |
| Logging      | Winston + Morgan                                |
| Config       | dotenv                                          |

---

## Project Structure

```
mpesa-daraja-api/
│
├── src/
│   ├── config/
│   │   └── db.js                 MongoDB connection
│   │
│   ├── controllers/
│   │   └── paymentController.js  Route handlers
│   │
│   ├── middleware/
│   │   └── auth.js               JWT protect middleware
│   │
│   ├── models/
│   │   └── Payment.js            Mongoose schema
│   │
│   ├── routes/
│   │   └── paymentRoutes.js      Express router
│   │
│   ├── services/
│   │   └── darajaService.js      Daraja API (token, STK, query)
│   │
│   ├── utils/
│   │   └── logger.js             Winston logger
│   │
│   └── app.js                    Express app factory
│
├── logs/                         Auto-created log files
├── server.js                     Entry point
├── package.json
├── .env                          Environment config
├── postman_collection.json       Postman collection
└── MpesaPayment.jsx              React Native example
```

---

## Installation

```bash
# 1. Clone & install
git clone <repo-url>
cd mpesa-daraja-api
npm install

# 2. Copy and fill in environment variables
cp .env .env.local
# Edit .env with your Daraja credentials

# 3. (Development) Expose your local server via ngrok for callbacks
npx ngrok http 5000
# Copy the https URL → set as CALLBACK_URL in .env

# 4. Start dev server
npm run dev

# 5. Start production server
npm start
```

---

## Environment Variables

| Variable               | Description                                    | Example                                        |
|------------------------|------------------------------------------------|------------------------------------------------|
| `PORT`                 | HTTP server port                               | `5000`                                         |
| `NODE_ENV`             | Environment flag                               | `development` / `production`                   |
| `CONSUMER_KEY`         | Daraja app consumer key                        | From Safaricom Developer Portal                |
| `CONSUMER_SECRET`      | Daraja app consumer secret                     | From Safaricom Developer Portal                |
| `BUSINESS_SHORT_CODE`  | Paybill or Buy Goods shortcode                 | `174379` (sandbox test shortcode)              |
| `PASSKEY`              | Lipa na M-Pesa Online passkey                  | From Daraja portal (long hex string)           |
| `DARAJA_BASE_URL`      | Daraja base URL                                | `https://sandbox.safaricom.co.ke`              |
| `CALLBACK_URL`         | Publicly accessible callback endpoint          | `https://abc.ngrok.io/api/payments/callback`   |
| `MONGO_URI`            | MongoDB connection string                      | `mongodb://localhost:27017/mpesa`              |
| `JWT_SECRET`           | Secret for signing JWTs                        | Long random string                             |
| `JWT_EXPIRE`           | Token expiry duration                          | `30d`                                          |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in milliseconds              | `900000` (15 min)                              |
| `RATE_LIMIT_MAX`       | Max requests per window                        | `100`                                          |

---

## API Reference

All `/api/payments` routes (except `/callback`) require:

```
Authorization: Bearer <JWT_TOKEN>
```

---

### POST `/api/payments/stkpush`

Initiates an STK Push prompt on the customer's phone.

**Request body:**
```json
{
  "phone": "254712345678",
  "amount": 10,
  "accountReference": "ORDER123",
  "transactionDesc": "Payment"
}
```

| Field              | Type   | Required | Notes                                           |
|--------------------|--------|----------|-------------------------------------------------|
| `phone`            | string | ✅        | Accepts `07XXXXXXXX`, `2547XXXXXXXX`, `7XXXXXXXX` |
| `amount`           | number | ✅        | Minimum 1 KES, integer                          |
| `accountReference` | string | ✅        | Max 12 characters                               |
| `transactionDesc`  | string | ❌        | Max 13 characters (default: "Payment")          |

**Success Response (200):**
```json
{
  "success": true,
  "message": "Success. Request accepted for processing",
  "data": {
    "checkoutRequestId": "ws_CO_191220191020363925",
    "merchantRequestId": "29115-34620561-1",
    "responseCode": "0",
    "responseDescription": "Success. Request accepted for processing",
    "customerMessage": "Success. Request accepted for processing"
  }
}
```

**Error Response (400):**
```json
{
  "success": false,
  "message": "Invalid phone number. Use format: 07XXXXXXXX or 2547XXXXXXXX"
}
```

---

### POST `/api/payments/callback`

Receives the asynchronous result from Safaricom. **No authentication required** — Safaricom calls this directly.

Always returns `200` to prevent Safaricom retries.

---

### GET `/api/payments/:checkoutRequestId`

Returns the current status of a transaction.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "status": "SUCCESS",
    "amount": 10,
    "receipt": "QGH123456",
    "phone": "254712345678",
    "accountReference": "ORDER123",
    "resultDesc": "The service request is processed successfully.",
    "transactionDate": "2024-01-01T12:00:00",
    "createdAt": "2024-01-01T11:59:55.000Z"
  }
}
```

**Status values:**

| Status      | Meaning                          |
|-------------|----------------------------------|
| `PENDING`   | Waiting for customer PIN entry   |
| `SUCCESS`   | Payment confirmed by Safaricom   |
| `FAILED`    | Transaction failed               |
| `CANCELLED` | Customer cancelled (ResultCode 1032) |
| `TIMEOUT`   | No callback received in 10 min   |

---

### GET `/api/payments`

Returns paginated list of all payments (admin use).

**Query params:** `?page=1&limit=20&status=SUCCESS&phone=254712345678`

---

## Daraja Sandbox Setup

1. Go to [developer.safaricom.co.ke](https://developer.safaricom.co.ke)
2. Create an account and log in
3. Go to **My Apps** → **Add New App**
4. Enable the **Lipa Na M-Pesa Sandbox** API
5. Copy your **Consumer Key** and **Consumer Secret**
6. Go to **APIs** → **Lipa Na M-Pesa** → copy the **Online Passkey**
7. Use shortcode `174379` for sandbox testing

---

## Testing with Sandbox

### 1. Start ngrok (for callbacks)
```bash
npx ngrok http 5000
# Example output: https://abc123.ngrok.io
# Set CALLBACK_URL=https://abc123.ngrok.io/api/payments/callback in .env
```

### 2. Generate a JWT for testing
```javascript
// Quick script — run once to get a test token
const jwt = require('jsonwebtoken');
require('dotenv').config();
const token = jwt.sign({ id: 'test-user', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
console.log(token);
```

### 3. Import Postman Collection
Import `postman_collection.json` into Postman. Set the `jwt_token` collection variable to the token from step 2.

### 4. Initiate a test payment
Use sandbox test phone numbers from the Daraja portal (e.g. `254708374149`).

### 5. Approve the STK Push
The sandbox simulates the push. In sandbox mode, Safaricom auto-completes the transaction after a few seconds — no real phone needed.

### 6. Check transaction status
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:5000/api/payments/ws_CO_191220191020363925
```

---

## Example Callback Payload

### Successful payment
```json
{
  "Body": {
    "stkCallback": {
      "MerchantRequestID": "29115-34620561-1",
      "CheckoutRequestID": "ws_CO_191220191020363925",
      "ResultCode": 0,
      "ResultDesc": "The service request is processed successfully.",
      "CallbackMetadata": {
        "Item": [
          { "Name": "Amount", "Value": 10.00 },
          { "Name": "MpesaReceiptNumber", "Value": "QGH123456" },
          { "Name": "Balance" },
          { "Name": "TransactionDate", "Value": 20240101120000 },
          { "Name": "PhoneNumber", "Value": 254712345678 }
        ]
      }
    }
  }
}
```

### Cancelled by user (ResultCode 1032)
```json
{
  "Body": {
    "stkCallback": {
      "MerchantRequestID": "29115-34620561-1",
      "CheckoutRequestID": "ws_CO_191220191020363925",
      "ResultCode": 1032,
      "ResultDesc": "Request cancelled by user."
    }
  }
}
```

### Common Result Codes

| Code   | Meaning                                   |
|--------|-------------------------------------------|
| `0`    | Success                                   |
| `1`    | Insufficient funds                        |
| `1032` | Cancelled by user                         |
| `1037` | Timeout — user did not respond            |
| `2001` | Wrong PIN entered                         |
| `17`   | M-Pesa system internal error              |

---

## Deployment

### Render (free tier available)

1. Push your code to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your repo
4. Set **Build Command**: `npm install`
5. Set **Start Command**: `node server.js`
6. Add all environment variables under **Environment**
7. Set `NODE_ENV=production`
8. Update `CALLBACK_URL` to your Render URL

### Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway variables set PORT=5000 NODE_ENV=production MONGO_URI=... # etc.
```

### VPS (Ubuntu/Debian)

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2
sudo npm install -g pm2

# Clone and install
git clone <repo> /var/www/mpesa-api
cd /var/www/mpesa-api
npm install --production

# Configure environment
cp .env.example .env
nano .env   # fill in your values

# Start with PM2
pm2 start server.js --name mpesa-api
pm2 save
pm2 startup  # auto-start on reboot

# Nginx reverse proxy (optional but recommended)
sudo apt install nginx
# Configure nginx to proxy_pass to localhost:5000
```

### MongoDB Atlas (cloud database)

Replace `MONGO_URI` with your Atlas connection string:
```
MONGO_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/mpesa?retryWrites=true&w=majority
```

---

## Security

| Feature                | Implementation                          |
|------------------------|-----------------------------------------|
| Security headers       | `helmet` middleware                     |
| CORS                   | Configured origin whitelist             |
| Rate limiting          | Global + per-route limits               |
| JWT auth               | All routes except `/callback`           |
| Input sanitization     | `express-mongo-sanitize` + `validator`  |
| Request size limit     | 10kb JSON body limit                    |
| Environment secrets    | `dotenv` — never commit `.env`          |
| Error messages         | Generic in production mode              |
| Logging                | Winston file + console, redacted secrets|
