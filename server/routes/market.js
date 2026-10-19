const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/market/instruments - Get list of market instruments
router.get('/instruments', (req, res) => {
  try {
    const instruments = db.queryAll('SELECT * FROM market_instruments ORDER BY category, symbol');
    res.json({
      success: true,
      instruments
    });
  } catch (err) {
    console.error('Error fetching instruments:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/market/ticker - Fast ticker polling endpoint
router.get('/ticker', (req, res) => {
  try {
    const ticks = db.queryAll(`
      SELECT symbol, current_price, day_change, day_change_pct, haircut_pct, is_collateral_eligible, last_tick_at
      FROM market_instruments
    `);
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      ticks
    });
  } catch (err) {
    console.error('Error fetching ticks:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Background micro-tick simulator for realistic exchange live activity
let tickInterval = null;
function startMarketSimulator() {
  if (tickInterval) return;

  tickInterval = setInterval(() => {
    try {
      const instruments = db.queryAll('SELECT symbol, current_price, open_price FROM market_instruments');
      // Pick 2-3 random instruments to tick
      const randomCount = Math.floor(Math.random() * 3) + 2;
      const shuffled = instruments.sort(() => 0.5 - Math.random()).slice(0, randomCount);

      for (const inst of shuffled) {
        // Random micro tick between -0.3% and +0.3%
        const deltaPct = (Math.random() * 0.6 - 0.3) / 100.0;
        const newPrice = Math.round((inst.current_price * (1.0 + deltaPct)) * 100) / 100;
        const dayChange = Math.round((newPrice - inst.open_price) * 100) / 100;
        const dayChangePct = Math.round(((dayChange / inst.open_price) * 100) * 100) / 100;

        db.run(`
          UPDATE market_instruments 
          SET current_price = ?, day_change = ?, day_change_pct = ?, last_tick_at = datetime('now')
          WHERE symbol = ?
        `, [newPrice, dayChange, dayChangePct, inst.symbol]);
      }
    } catch (e) {
      // ignore simulation errors
    }
  }, 3500); // Ticks every 3.5 seconds
}

startMarketSimulator();

module.exports = router;
