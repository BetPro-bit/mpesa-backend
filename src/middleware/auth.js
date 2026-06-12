/**
 * auth.js
 *
 * JWT authentication middleware.
 * Attach to any route that requires a valid token.
 *
 * Usage:
 *   router.get('/protected', protect, handler)
 *
 * Token must be sent as:
 *   Authorization: Bearer <token>
 */

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const protect = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ success: false, message: 'Access denied. Token missing.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    logger.warn(`Auth middleware failed: ${error.message}`);

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Invalid token.' });
    }

    return res.status(401).json({ success: false, message: 'Authentication failed.' });
  }
};

/**
 * Generate a signed JWT (call from a login/auth route).
 * @param {object} payload  - e.g. { id, role }
 * @returns {string}        - signed JWT string
 */
const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d',
  });

module.exports = { protect, signToken };
