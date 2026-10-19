const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const LedgerService = require('../services/ledgerService');

// GET /api/ledger - Fetch account financial ledger statements
router.get('/', authenticateToken, (req, res) => {
  try {
    const { type, limit = 100 } = req.query;

    let sql = 'SELECT * FROM financial_ledger WHERE user_id = ?';
    const params = [req.user.id];

    if (type) {
      sql += ' AND entry_type = ?';
      params.push(type);
    }

    sql += ' ORDER BY sequence_num DESC LIMIT ?';
    params.push(parseInt(limit, 10));

    const entries = db.queryAll(sql, params);

    // Summary totals
    const summary = db.queryOne(`
      SELECT 
        COUNT(*) AS total_transactions,
        SUM(CASE WHEN entry_type LIKE '%DISBURSEMENT%' OR entry_type LIKE '%DEPOSIT%' THEN amount ELSE 0 END) AS total_inflows,
        SUM(CASE WHEN entry_type LIKE '%REPAYMENT%' OR entry_type LIKE '%WITHDRAWAL%' THEN amount ELSE 0 END) AS total_outflows
      FROM financial_ledger
      WHERE user_id = ?
    `, [req.user.id]);

    res.json({
      success: true,
      summary,
      entries
    });
  } catch (err) {
    console.error('Error fetching ledger statement:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/ledger/verify - Cryptographic audit hash integrity verification
router.get('/verify', authenticateToken, (req, res) => {
  try {
    const auditReport = LedgerService.verifyLedgerIntegrity(req.user.id);
    res.json({
      success: true,
      auditReport
    });
  } catch (err) {
    console.error('Error verifying ledger:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
