const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { financialTxRateLimiter } = require('../middleware/rateLimiter');
const MarginEngine = require('../services/marginEngine');
const LedgerService = require('../services/ledgerService');

// GET /api/portfolio - Real-time portfolio valuation and collateral threshold monitoring
router.get('/', authenticateToken, (req, res) => {
  try {
    const portfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);
    res.json({
      success: true,
      data: portfolio
    });
  } catch (err) {
    console.error('Error fetching portfolio:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/portfolio/pledge - Pledge or unpledge holdings for margin facility
router.post('/pledge', authenticateToken, financialTxRateLimiter, (req, res) => {
  try {
    const { symbol, quantity, action } = req.body; // action: 'PLEDGE' or 'UNPLEDGE'

    if (!symbol || !quantity || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Valid symbol and positive quantity are required.' });
    }

    if (!['PLEDGE', 'UNPLEDGE'].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be either 'PLEDGE' or 'UNPLEDGE'." });
    }

    const holding = db.queryOne(`
      SELECT h.*, m.current_price, m.haircut_pct, m.is_collateral_eligible 
      FROM user_holdings h
      JOIN market_instruments m ON h.symbol = m.symbol
      WHERE h.user_id = ? AND h.symbol = ?
    `, [req.user.id, symbol.toUpperCase()]);

    if (!holding) {
      return res.status(404).json({ success: false, message: `Holding for ${symbol} not found in your demat account.` });
    }

    if (action === 'PLEDGE') {
      const freeQty = holding.total_quantity - holding.pledged_quantity;
      if (quantity > freeQty) {
        return res.status(400).json({
          success: false,
          message: `Cannot pledge ${quantity} shares. Only ${freeQty} free shares available (${holding.pledged_quantity} already pledged).`
        });
      }

      if (!holding.is_collateral_eligible) {
        return res.status(400).json({
          success: false,
          message: `${symbol} is not eligible as collateral under regulatory guidelines.`
        });
      }

      db.transaction(() => {
        db.run(`
          UPDATE user_holdings 
          SET pledged_quantity = pledged_quantity + ?, updated_at = datetime('now')
          WHERE id = ?
        `, [quantity, holding.id]);

        const pledgeValue = quantity * holding.current_price;
        const netCollateralAdded = pledgeValue * (1.0 - (holding.haircut_pct / 100.0));

        LedgerService.recordEntry({
          userId: req.user.id,
          entryType: 'COLLATERAL_PLEDGE',
          accountDebited: 'HOLDINGS_PLEDGED',
          accountCredited: 'HOLDINGS_FREE',
          amount: pledgeValue,
          userCashBalanceAfter: req.user.cash_balance,
          userTotalDebtAfter: 0,
          description: `Pledged ${quantity} shares of ${symbol} (Collateral credit: ₹${netCollateralAdded.toFixed(2)})`,
          referenceId: `PLG-${symbol}-${Date.now()}`
        });
      });

      // Recalculate portfolio & check if margin calls can be cleared
      MarginEngine.monitorAndTriggerMarginCall(req.user.id);
      const updated = MarginEngine.getPortfolioAndCollateral(req.user.id);

      return res.json({
        success: true,
        message: `Successfully pledged ${quantity} shares of ${symbol}. Collateral limit increased.`,
        data: updated
      });
    }

    if (action === 'UNPLEDGE') {
      if (quantity > holding.pledged_quantity) {
        return res.status(400).json({
          success: false,
          message: `Cannot unpledge ${quantity} shares. You currently have ${holding.pledged_quantity} pledged.`
        });
      }

      // Check if unpledging will breach margin requirement (LTV would exceed 70%)
      const curPortfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);
      const totalDebt = curPortfolio.metrics.totalDebt;

      if (totalDebt > 0) {
        const netCollateralLost = (quantity * holding.current_price) * (1.0 - (holding.haircut_pct / 100.0));
        const projectedCollateral = curPortfolio.metrics.eligibleCollateralValue - netCollateralLost;
        const projectedLtv = projectedCollateral > 0 ? (totalDebt / projectedCollateral) * 100 : 100;

        if (projectedLtv > 70.0) {
          return res.status(400).json({
            success: false,
            message: `Unpledge rejected: Would increase LTV to ${projectedLtv.toFixed(1)}%, breaching the 70% threshold. Repay debt before unpledging.`
          });
        }
      }

      db.transaction(() => {
        db.run(`
          UPDATE user_holdings 
          SET pledged_quantity = pledged_quantity - ?, updated_at = datetime('now')
          WHERE id = ?
        `, [quantity, holding.id]);

        const unpledgeValue = quantity * holding.current_price;

        LedgerService.recordEntry({
          userId: req.user.id,
          entryType: 'COLLATERAL_UNPLEDGE',
          accountDebited: 'HOLDINGS_FREE',
          accountCredited: 'HOLDINGS_PLEDGED',
          amount: unpledgeValue,
          userCashBalanceAfter: req.user.cash_balance,
          userTotalDebtAfter: totalDebt,
          description: `Unpledged ${quantity} shares of ${symbol}`,
          referenceId: `UNPLG-${symbol}-${Date.now()}`
        });
      });

      const updated = MarginEngine.getPortfolioAndCollateral(req.user.id);

      return res.json({
        success: true,
        message: `Successfully unpledged ${quantity} shares of ${symbol}.`,
        data: updated
      });
    }
  } catch (err) {
    console.error('Error handling pledge:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/portfolio/order - Execute trade (BUY/SELL)
router.post('/order', authenticateToken, financialTxRateLimiter, (req, res) => {
  try {
    const { symbol, quantity, side } = req.body; // side: 'BUY' or 'SELL'
    const qty = parseInt(quantity, 10);

    if (!symbol || !qty || qty <= 0 || !['BUY', 'SELL'].includes(side)) {
      return res.status(400).json({ success: false, message: 'Invalid order parameters.' });
    }

    const instrument = db.queryOne('SELECT * FROM market_instruments WHERE symbol = ?', [symbol.toUpperCase()]);
    if (!instrument) {
      return res.status(404).json({ success: false, message: 'Instrument not found.' });
    }

    const orderValue = qty * instrument.current_price;
    const user = db.queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);

    if (side === 'BUY') {
      if (user.cash_balance < orderValue) {
        return res.status(400).json({
          success: false,
          message: `Insufficient cash funds. Order requires ₹${orderValue.toFixed(2)}, available: ₹${user.cash_balance.toFixed(2)}.`
        });
      }

      db.transaction(() => {
        const newCash = user.cash_balance - orderValue;
        db.run('UPDATE users SET cash_balance = ? WHERE id = ?', [newCash, user.id]);

        const existing = db.queryOne('SELECT * FROM user_holdings WHERE user_id = ? AND symbol = ?', [user.id, instrument.symbol]);
        if (existing) {
          const totalShares = existing.total_quantity + qty;
          const totalCost = (existing.total_quantity * existing.average_buy_price) + orderValue;
          const newAvgPrice = totalCost / totalShares;

          db.run(`
            UPDATE user_holdings 
            SET total_quantity = ?, average_buy_price = ?, updated_at = datetime('now')
            WHERE id = ?
          `, [totalShares, newAvgPrice, existing.id]);
        } else {
          db.run(`
            INSERT INTO user_holdings (id, user_id, symbol, total_quantity, pledged_quantity, average_buy_price)
            VALUES (?, ?, ?, ?, 0, ?)
          `, ['hld_' + crypto.randomBytes(8).toString('hex'), user.id, instrument.symbol, qty, instrument.current_price]);
        }

        LedgerService.recordEntry({
          userId: user.id,
          entryType: 'CASH_WITHDRAWAL',
          accountDebited: 'EQUITY_DELIVERY',
          accountCredited: 'CASH_BALANCE',
          amount: orderValue,
          userCashBalanceAfter: newCash,
          userTotalDebtAfter: 0,
          description: `CNC BUY ${qty} shares of ${instrument.symbol} @ ₹${instrument.current_price.toFixed(2)}`,
          referenceId: `ORD-${Date.now()}`
        });
      });
    } else { // SELL
      const existing = db.queryOne('SELECT * FROM user_holdings WHERE user_id = ? AND symbol = ?', [user.id, instrument.symbol]);
      const freeQty = existing ? (existing.total_quantity - existing.pledged_quantity) : 0;

      if (!existing || freeQty < qty) {
        return res.status(400).json({
          success: false,
          message: `Cannot sell ${qty} shares. Only ${freeQty} free shares available (${existing ? existing.pledged_quantity : 0} pledged as loan collateral).`
        });
      }

      db.transaction(() => {
        const newCash = user.cash_balance + orderValue;
        db.run('UPDATE users SET cash_balance = ? WHERE id = ?', [newCash, user.id]);

        const newTotalQty = existing.total_quantity - qty;
        if (newTotalQty === 0) {
          db.run('DELETE FROM user_holdings WHERE id = ?', [existing.id]);
        } else {
          db.run(`
            UPDATE user_holdings 
            SET total_quantity = ?, updated_at = datetime('now')
            WHERE id = ?
          `, [newTotalQty, existing.id]);
        }

        LedgerService.recordEntry({
          userId: user.id,
          entryType: 'CASH_DEPOSIT',
          accountDebited: 'CASH_BALANCE',
          accountCredited: 'EQUITY_DELIVERY',
          amount: orderValue,
          userCashBalanceAfter: newCash,
          userTotalDebtAfter: 0,
          description: `CNC SELL ${qty} shares of ${instrument.symbol} @ ₹${instrument.current_price.toFixed(2)}`,
          referenceId: `ORD-${Date.now()}`
        });
      });
    }

    const updated = MarginEngine.getPortfolioAndCollateral(req.user.id);
    res.json({
      success: true,
      message: `Executed ${side} order for ${qty} shares of ${symbol}.`,
      data: updated
    });
  } catch (err) {
    console.error('Order execution error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
