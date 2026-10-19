const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');
const { authRateLimiter } = require('../middleware/rateLimiter');
const LedgerService = require('../services/ledgerService');

// POST /api/auth/register
router.post('/register', authRateLimiter, (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const existing = db.queryOne('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }

    // Generate Zerodha style client ID (e.g. ZD7421)
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const clientId = `ZD${randomSuffix}`;
    const userId = 'usr_' + crypto.randomBytes(8).toString('hex');
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const initialCash = 100000.0; // ₹1,00,000 starter margin capital

    db.transaction(() => {
      // 1. Insert user
      db.run(`
        INSERT INTO users (id, client_id, name, email, password_hash, cash_balance)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, clientId, name.trim(), email.toLowerCase().trim(), passwordHash, initialCash]);

      // 2. Provision starter portfolio holdings (Reliance, TCS, HDFC)
      const starterHoldings = [
        ['RELIANCE', 50, 20, 2800.00],
        ['TCS', 25, 10, 3950.00],
        ['HDFCBANK', 100, 50, 1600.00],
        ['INFY', 60, 0, 1750.00]
      ];

      for (const [sym, qty, pledged, avg] of starterHoldings) {
        db.run(`
          INSERT INTO user_holdings (id, user_id, symbol, total_quantity, pledged_quantity, average_buy_price)
          VALUES (?, ?, ?, ?, ?, ?)
        `, ['hld_' + crypto.randomBytes(8).toString('hex'), userId, sym, qty, pledged, avg]);
      }

      // 3. Initial Ledger Deposit Entry
      LedgerService.recordEntry({
        userId,
        entryType: 'CASH_DEPOSIT',
        accountDebited: 'CASH_BALANCE',
        accountCredited: 'CLIENT_EQUITY',
        amount: initialCash,
        userCashBalanceAfter: initialCash,
        userTotalDebtAfter: 0.0,
        description: 'Account Opening Cash Allocation & Demat Provisioning',
        referenceId: `ACC-OPEN-${clientId}`
      });
    });

    const token = jwt.sign({ id: userId, client_id: clientId, email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      success: true,
      message: 'Brokerage account created successfully.',
      token,
      user: {
        id: userId,
        clientId,
        name: name.trim(),
        email: email.toLowerCase().trim(),
        cashBalance: initialCash
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Internal server error during registration.' });
  }
});

// POST /api/auth/login
router.post('/login', authRateLimiter, (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = db.queryOne('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const token = jwt.sign({ id: user.id, client_id: user.client_id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: {
        id: user.id,
        clientId: user.client_id,
        name: user.name,
        email: user.email,
        cashBalance: user.cash_balance
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Internal server error during login.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

module.exports = router;
