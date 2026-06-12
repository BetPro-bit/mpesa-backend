/**
 * server.js
 *
 * Entry point. Connects to MongoDB, then starts the HTTP server.
 * Handles graceful shutdown on SIGTERM / SIGINT.
 */

require('dotenv').config();

const app = require('./src/app');
const connectDB = require('./src/config/db');
const logger = require('./src/utils/logger');

const PORT = parseInt(process.env.PORT, 10) || 5000;

// Ensure logs directory exists
const fs = require('fs');
if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const startServer = async () => {
  // Connect to MongoDB
  await connectDB();

  const server = app.listen(PORT, () => {
    logger.info(`
─────────────────────────────────────────────
  M-Pesa Daraja API
  Environment : ${process.env.NODE_ENV || 'development'}
  Port        : ${PORT}
  Health      : http://localhost:${PORT}/health
─────────────────────────────────────────────
    `);
  });

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
      logger.info('HTTP server closed');
      const mongoose = require('mongoose');
      await mongoose.connection.close();
      logger.info('MongoDB connection closed');
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 15000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    server.close(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.message}\n${err.stack}`);
    process.exit(1);
  });
};

startServer();
