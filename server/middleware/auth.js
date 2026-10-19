const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'finodha_secret_key_jwt_2026_super_secure';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'AuthenticationRequired',
      message: 'Access denied. Bearer token is missing.'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({
        success: false,
        error: 'InvalidToken',
        message: 'JWT token is invalid or expired. Please sign in again.'
      });
    }

    const user = db.queryOne('SELECT id, client_id, name, email, cash_balance, is_active FROM users WHERE id = ?', [decoded.id]);
    if (!user || !user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'UserInactiveOrNotFound',
        message: 'Account associated with token is suspended or deleted.'
      });
    }

    req.user = user;
    next();
  });
}

module.exports = {
  authenticateToken,
  JWT_SECRET
};
