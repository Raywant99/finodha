const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { financialTxRateLimiter } = require('../middleware/rateLimiter');
const MarginEngine = require('../services/marginEngine');

// GET /api/margin/health - Fetch current margin health, LTV gauge, and margin calls
router.get('/health', authenticateToken, (req, res) => {
  try {
    const portfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);
    const activeCalls = db.queryAll(`
      SELECT * FROM margin_calls 
      WHERE user_id = ? AND status = 'OPEN' 
      ORDER BY created_at DESC
    `, [req.user.id]);

    res.json({
      success: true,
      metrics: portfolio.metrics,
      activeMarginCalls: activeCalls
    });
  } catch (err) {
    console.error('Error fetching margin health:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/margin/check - Manual or background margin monitoring trigger
router.post('/check', authenticateToken, (req, res) => {
  try {
    const result = MarginEngine.monitorAndTriggerMarginCall(req.user.id);
    const portfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);

    res.json({
      success: true,
      result,
      portfolio
    });
  } catch (err) {
    console.error('Error checking margin:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/margin/liquidate - Automated partial liquidation execution
router.post('/liquidate', authenticateToken, financialTxRateLimiter, (req, res) => {
  try {
    const result = MarginEngine.executeAutoLiquidation(req.user.id);
    const updatedPortfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);

    res.json({
      success: true,
      message: `Automated liquidation executed: Sold ${result.sharesSold} shares of ${result.liquidatedSymbol} at ₹${result.pricePerShare.toFixed(2)}. Margin recovered.`,
      liquidation: result,
      portfolio: updatedPortfolio
    });
  } catch (err) {
    console.error('Liquidation error:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/margin/simulate-shock - Market crash / rally simulator to test real-time margin triggers
router.post('/simulate-shock', authenticateToken, (req, res) => {
  try {
    const { shockPct } = req.body; // e.g. -15 for 15% drop, +10 for rally
    const shock = parseFloat(shockPct);

    if (isNaN(shock) || shock < -80 || shock > 100) {
      return res.status(400).json({ success: false, message: 'Shock percentage must be between -80% and +100%.' });
    }

    db.transaction(() => {
      // Adjust all market instrument prices
      const instruments = db.queryAll('SELECT symbol, current_price, open_price FROM market_instruments');
      const multiplier = 1.0 + (shock / 100.0);

      for (const inst of instruments) {
        const newPrice = Math.max(1.0, inst.current_price * multiplier);
        const dayChange = newPrice - inst.open_price;
        const dayChangePct = (dayChange / inst.open_price) * 100.0;

        db.run(`
          UPDATE market_instruments 
          SET current_price = ?, day_change = ?, day_change_pct = ?, last_tick_at = datetime('now')
          WHERE symbol = ?
        `, [newPrice, dayChange, dayChangePct, inst.symbol]);
      }
    });

    // Check margin triggers
    const triggerResult = MarginEngine.monitorAndTriggerMarginCall(req.user.id);
    const updatedPortfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);

    res.json({
      success: true,
      message: `Simulated market movement of ${shock > 0 ? '+' : ''}${shock}%. Collateral recalculated.`,
      shockPct: shock,
      triggerResult,
      portfolio: updatedPortfolio
    });
  } catch (err) {
    console.error('Error simulating market shock:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/margin/reset-market - Reset market prices to base levels
router.post('/reset-market', authenticateToken, (req, res) => {
  try {
    const basePrices = {
      'RELIANCE': 2942.50,
      'TCS': 4125.80,
      'HDFCBANK': 1684.20,
      'INFY': 1872.40,
      'ICICIBANK': 1238.60,
      'TATAMOTORS': 968.40,
      'BAJFINANCE': 7240.00,
      'ITC': 488.50,
      'KOTAKBANK': 1795.00,
      'LT': 3620.00,
      'DIXON': 12450.00,
      'POLYCAB': 6850.00
    };

    db.transaction(() => {
      for (const [sym, price] of Object.entries(basePrices)) {
        db.run(`
          UPDATE market_instruments 
          SET current_price = ?, day_change = 0, day_change_pct = 0, last_tick_at = datetime('now')
          WHERE symbol = ?
        `, [price, sym]);
      }
    });

    MarginEngine.monitorAndTriggerMarginCall(req.user.id);
    const updatedPortfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);

    res.json({
      success: true,
      message: 'Market prices restored to standard baseline.',
      portfolio: updatedPortfolio
    });
  } catch (err) {
    console.error('Error resetting market prices:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
