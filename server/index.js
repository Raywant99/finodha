const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const db = require('./db');
const { generalApiRateLimiter } = require('./middleware/rateLimiter');
const authRoutes = require('./routes/auth');
const portfolioRoutes = require('./routes/portfolio');
const loansRoutes = require('./routes/loans');
const ledgerRoutes = require('./routes/ledger');
const marginRoutes = require('./routes/margin');
const marketRoutes = require('./routes/market');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

// Security and middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(generalApiRateLimiter);

// Serve static frontend UI
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    system: 'Finodha Brokerage & Margin Facility Ledger',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    database: 'SQLite (Node.js Native WAL) / PostgreSQL 14+ Compatible',
    features: [
      'Real-Time Portfolio Valuation',
      'SEBI Collateral Haircut Computation',
      'Automated Margin Call Trigger (75% LTV)',
      'Automated Collateral Liquidation (85% LTV)',
      'Immutable Financial Ledger with SHA-256 Chaining',
      'JWT Authentication & Rate-Limiting Protection'
    ]
  });
});

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/loans', loansRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/margin', marginRoutes);
app.use('/api/market', marketRoutes);

// Fallback to index.html for Single-Page Application routing
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    return res.sendFile(path.join(__dirname, '../public/index.html'));
  }
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[Finodha Global Error]:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.name || 'ServerError',
    message: err.message || 'An unexpected internal error occurred.'
  });
});

// WebSocket server for real-time market ticks broadcast
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // Send initial ticker dump
  try {
    const ticks = db.queryAll('SELECT symbol, current_price, day_change, day_change_pct FROM market_instruments');
    ws.send(JSON.stringify({ type: 'TICKER_SNAPSHOT', ticks }));
  } catch (e) {}

  ws.on('error', console.error);
});

// Broadcast live ticks every 3 seconds
setInterval(() => {
  if (wss.clients.size === 0) return;

  try {
    const ticks = db.queryAll('SELECT symbol, current_price, day_change, day_change_pct FROM market_instruments');
    const message = JSON.stringify({
      type: 'PRICE_UPDATE',
      timestamp: new Date().toISOString(),
      ticks
    });

    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    });
  } catch (e) {}
}, 3000);

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` Finodha Core Brokerage Server Running`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(` WebSocket: ws://localhost:${PORT}/ws`);
  console.log(` Demo Login: abhishek@finodha.trade / demo1234`);
  console.log(`=======================================================`);
});

module.exports = { app, server };
