/**
 * darajaService.js
 *
 * Handles all Safaricom Daraja API interactions:
 *  - OAuth token generation & caching
 *  - STK Push initiation
 *  - STK Push query
 */

const axios = require('axios');
const logger = require('../utils/logger');

// ── Token cache ───────────────────────────────────────────────────────────────
let _tokenCache = {
  accessToken: null,
  expiresAt: null,
};

/**
 * Fetch or return cached OAuth token.
 * Daraja tokens expire in 3600 s; we refresh 60 s early.
 */
const getAccessToken = async () => {
  const now = Date.now();

  if (_tokenCache.accessToken && _tokenCache.expiresAt > now) {
    logger.debug('Daraja: returning cached access token');
    return _tokenCache.accessToken;
  }

  const { CONSUMER_KEY, CONSUMER_SECRET, DARAJA_BASE_URL } = process.env;

  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    throw new Error('CONSUMER_KEY and CONSUMER_SECRET must be set in .env');
  }

  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

  try {
    const response = await axios.get(
      `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${credentials}` },
        timeout: 10000,
      }
    );

    const { access_token, expires_in } = response.data;

    _tokenCache = {
      accessToken: access_token,
      expiresAt: now + (parseInt(expires_in, 10) - 60) * 1000,
    };

    logger.info('Daraja: new access token fetched');
    return access_token;
  } catch (error) {
    const msg = error.response?.data?.errorMessage || error.message;
    logger.error(`Daraja auth failed: ${msg}`);
    throw new Error(`Failed to get Daraja access token: ${msg}`);
  }
};

/**
 * Generate the Daraja password:
 *   Base64(BusinessShortCode + PassKey + Timestamp)
 */
const generatePassword = (timestamp) => {
  const { BUSINESS_SHORT_CODE, PASSKEY } = process.env;
  const raw = `${BUSINESS_SHORT_CODE}${PASSKEY}${timestamp}`;
  return Buffer.from(raw).toString('base64');
};

/**
 * Get current timestamp in Daraja format: YYYYMMDDHHMMSS
 */
const getTimestamp = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
};

/**
 * Initiate STK Push request.
 *
 * @param {object} params
 * @param {string} params.phone         - Safaricom number in format 2547XXXXXXXX
 * @param {number} params.amount        - Amount in KES (integer)
 * @param {string} params.accountReference - Max 12 chars
 * @param {string} params.transactionDesc  - Max 13 chars
 * @returns {object} Daraja STK Push response
 */
const initiateSTKPush = async ({ phone, amount, accountReference, transactionDesc }) => {
  const accessToken = await getAccessToken();
  const timestamp = getTimestamp();
  const password = generatePassword(timestamp);

  const { BUSINESS_SHORT_CODE, CALLBACK_URL, DARAJA_BASE_URL } = process.env;

  const payload = {
    BusinessShortCode: BUSINESS_SHORT_CODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),            // must be integer
    PartyA: phone,
    PartyB: BUSINESS_SHORT_CODE,
    PhoneNumber: phone,
    CallBackURL: CALLBACK_URL,
    AccountReference: accountReference,
    TransactionDesc: transactionDesc || 'Payment',
  };

  logger.debug(`STK Push payload: ${JSON.stringify({ ...payload, Password: '[REDACTED]' })}`);

  try {
    const response = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    logger.info(`STK Push initiated: ${response.data.CheckoutRequestID}`);
    return response.data;
  } catch (error) {
    const errData = error.response?.data;
    logger.error(`STK Push failed: ${JSON.stringify(errData || error.message)}`);
    throw new Error(errData?.errorMessage || errData?.ResponseDescription || 'STK Push request failed');
  }
};

/**
 * Query the status of an STK Push transaction.
 *
 * @param {string} checkoutRequestId
 * @returns {object} Daraja query response
 */
const querySTKStatus = async (checkoutRequestId) => {
  const accessToken = await getAccessToken();
  const timestamp = getTimestamp();
  const password = generatePassword(timestamp);

  const { BUSINESS_SHORT_CODE, DARAJA_BASE_URL } = process.env;

  const payload = {
    BusinessShortCode: BUSINESS_SHORT_CODE,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  };

  try {
    const response = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/stkpushquery/v1/query`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    return response.data;
  } catch (error) {
    const errData = error.response?.data;
    logger.error(`STK Query failed: ${JSON.stringify(errData || error.message)}`);
    throw new Error(errData?.errorMessage || 'STK Push query failed');
  }
};

module.exports = { getAccessToken, initiateSTKPush, querySTKStatus, getTimestamp };
