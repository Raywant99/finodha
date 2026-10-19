const rateLimit = require('express-rate-limit');

// Strict rate limiter for Authentication endpoints to prevent credential stuffing & brute-force
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 authentication requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RateLimitExceeded',
    message: 'Too many authentication attempts from this IP address. Please try again after 15 minutes.'
  }
});

// Strict rate limiter for Financial transactions (loans, repayments, pledges, liquidations)
const financialTxRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 transactions per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RateLimitExceeded',
    message: 'Financial transaction rate limit exceeded. Please wait a moment before submitting further orders or repayments.'
  }
});

// General API rate limiter
const generalApiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // Limit each IP to 300 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RateLimitExceeded',
    message: 'High request traffic detected. Rate limit applied.'
  }
});

module.exports = {
  authRateLimiter,
  financialTxRateLimiter,
  generalApiRateLimiter
};
