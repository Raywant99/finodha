const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'finodha.sqlite');
const db = new DatabaseSync(dbPath);

// Enable WAL mode and foreign key enforcement
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

// Initialize database tables
function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      client_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 150000.0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS market_instruments (
      symbol TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'NSE',
      category TEXT NOT NULL CHECK (category IN ('LARGE_CAP', 'MID_CAP', 'SMALL_CAP', 'ETF', 'GOVT_BOND')),
      current_price REAL NOT NULL,
      open_price REAL NOT NULL,
      high_price REAL NOT NULL,
      low_price REAL NOT NULL,
      day_change REAL NOT NULL DEFAULT 0.0,
      day_change_pct REAL NOT NULL DEFAULT 0.0,
      volume INTEGER NOT NULL DEFAULT 1500000,
      haircut_pct REAL NOT NULL CHECK (haircut_pct >= 0 AND haircut_pct < 100),
      is_collateral_eligible INTEGER NOT NULL DEFAULT 1,
      last_tick_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_holdings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL REFERENCES market_instruments(symbol),
      total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0),
      pledged_quantity INTEGER NOT NULL DEFAULT 0 CHECK (pledged_quantity >= 0),
      average_buy_price REAL NOT NULL CHECK (average_buy_price > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS margin_loans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      principal_amount REAL NOT NULL CHECK (principal_amount > 0),
      current_principal REAL NOT NULL CHECK (current_principal >= 0),
      accrued_interest REAL NOT NULL DEFAULT 0.0,
      interest_rate_annual REAL NOT NULL DEFAULT 10.50,
      initial_collateral_value REAL NOT NULL,
      initial_ltv_pct REAL NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'MARGIN_CALL', 'UNDER_LIQUIDATION', 'REPAID', 'DEFAULTED')) DEFAULT 'ACTIVE',
      disbursed_at TEXT NOT NULL DEFAULT (datetime('now')),
      due_at TEXT NOT NULL,
      closed_at TEXT,
      last_interest_accrual_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS financial_ledger (
      sequence_num INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      loan_id TEXT REFERENCES margin_loans(id),
      entry_type TEXT NOT NULL,
      account_debited TEXT NOT NULL,
      account_credited TEXT NOT NULL,
      amount REAL NOT NULL,
      user_cash_balance_after REAL NOT NULL,
      user_total_debt_after REAL NOT NULL,
      description TEXT NOT NULL,
      reference_id TEXT,
      prev_entry_hash TEXT NOT NULL,
      audit_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS margin_calls (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      loan_id TEXT REFERENCES margin_loans(id),
      ltv_triggered_pct REAL NOT NULL,
      threshold_ltv_pct REAL NOT NULL DEFAULT 75.0,
      total_debt REAL NOT NULL,
      collateral_value REAL NOT NULL,
      shortfall_amount REAL NOT NULL,
      cure_deadline TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CURED_BY_REPAYMENT', 'CURED_BY_COLLATERAL', 'AUTO_LIQUIDATED', 'DISMISSED')),
      resolved_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS security_audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      user_agent TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_holdings_user ON user_holdings(user_id);
    CREATE INDEX IF NOT EXISTS idx_loans_user ON margin_loans(user_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON financial_ledger(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_margin_calls_user ON margin_calls(user_id, status);
  `);

  seedInitialData();
}

// Initial Instruments and Demo Client
function seedInitialData() {
  const userCheck = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (userCheck.count > 0) return; // already seeded

  console.log('[Finodha DB] Seeding initial NSE equities and demo client...');

  // 1. Seed Equities Master with real NSE stocks and SEBI-aligned haircuts
  const insertInstrument = db.prepare(`
    INSERT OR REPLACE INTO market_instruments 
    (symbol, company_name, exchange, category, current_price, open_price, high_price, low_price, day_change, day_change_pct, volume, haircut_pct, is_collateral_eligible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const instruments = [
    ['RELIANCE', 'Reliance Industries Ltd.', 'NSE', 'LARGE_CAP', 2942.50, 2920.00, 2955.00, 2912.00, 22.50, 0.77, 4520000, 15.0, 1],
    ['TCS', 'Tata Consultancy Services Ltd.', 'NSE', 'LARGE_CAP', 4125.80, 4100.00, 4150.00, 4085.00, 25.80, 0.63, 1850000, 15.0, 1],
    ['HDFCBANK', 'HDFC Bank Ltd.', 'NSE', 'LARGE_CAP', 1684.20, 1695.00, 1702.00, 1675.00, -10.80, -0.64, 8210000, 15.0, 1],
    ['INFY', 'Infosys Ltd.', 'NSE', 'LARGE_CAP', 1872.40, 1850.00, 1888.00, 1845.00, 22.40, 1.21, 3940000, 15.0, 1],
    ['ICICIBANK', 'ICICI Bank Ltd.', 'NSE', 'LARGE_CAP', 1238.60, 1225.00, 1245.00, 1220.00, 13.60, 1.11, 6120000, 15.0, 1],
    ['TATAMOTORS', 'Tata Motors Ltd.', 'NSE', 'LARGE_CAP', 968.40, 980.00, 985.00, 962.00, -11.60, -1.18, 5400000, 20.0, 1],
    ['BAJFINANCE', 'Bajaj Finance Ltd.', 'NSE', 'LARGE_CAP', 7240.00, 7180.00, 7290.00, 7150.00, 60.00, 0.84, 1120000, 20.0, 1],
    ['ITC', 'ITC Ltd.', 'NSE', 'LARGE_CAP', 488.50, 486.00, 492.00, 484.50, 2.50, 0.51, 7800000, 15.0, 1],
    ['KOTAKBANK', 'Kotak Mahindra Bank', 'NSE', 'LARGE_CAP', 1795.00, 1805.00, 1812.00, 1788.00, -10.00, -0.55, 2100000, 15.0, 1],
    ['LT', 'Larsen & Toubro Ltd.', 'NSE', 'LARGE_CAP', 3620.00, 3590.00, 3645.00, 3580.00, 30.00, 0.84, 1420000, 18.0, 1],
    ['DIXON', 'Dixon Technologies Ltd.', 'NSE', 'MID_CAP', 12450.00, 12300.00, 12600.00, 12250.00, 150.00, 1.22, 450000, 25.0, 1],
    ['POLYCAB', 'Polycab India Ltd.', 'NSE', 'MID_CAP', 6850.00, 6920.00, 6950.00, 6810.00, -70.00, -1.01, 380000, 25.0, 1]
  ];

  for (const item of instruments) {
    insertInstrument.run(...item);
  }

  // 2. Demo User: Abhishek Sharma (Zerodha Client ID: ZD8842)
  const userId = 'usr_' + crypto.randomBytes(8).toString('hex');
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync('demo1234', salt);
  const userClientId = 'ZD8842';

  db.prepare(`
    INSERT INTO users (id, client_id, name, email, password_hash, cash_balance)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, userClientId, 'Abhishek Sharma', 'abhishek@finodha.trade', passwordHash, 185000.0);

  // 3. User Demat Holdings with initial pledge
  const insertHolding = db.prepare(`
    INSERT INTO user_holdings (id, user_id, symbol, total_quantity, pledged_quantity, average_buy_price)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const holdings = [
    ['RELIANCE', 120, 80, 2750.00],    // 120 total, 80 pledged
    ['TCS', 60, 40, 3850.00],          // 60 total, 40 pledged
    ['HDFCBANK', 250, 150, 1540.00],   // 250 total, 150 pledged
    ['INFY', 100, 0, 1680.00],         // 100 total, 0 pledged (free)
    ['TATAMOTORS', 200, 100, 890.00],  // 200 total, 100 pledged
    ['BAJFINANCE', 30, 20, 6800.00]    // 30 total, 20 pledged
  ];

  for (const [sym, qty, pledged, avg] of holdings) {
    insertHolding.run('hld_' + crypto.randomBytes(8).toString('hex'), userId, sym, qty, pledged, avg);
  }

  // 4. Initial Margin Loan disbursed against pledged collateral
  const loanId = 'LN-2026-8842';
  const principalAmount = 250000.00;
  const initialCollateral = 620000.00;
  const initialLtv = (principalAmount / initialCollateral) * 100.0; // ~40.32%

  const dueDate = new Date();
  dueDate.setMonth(dueDate.getMonth() + 6);

  db.prepare(`
    INSERT INTO margin_loans 
    (id, user_id, principal_amount, current_principal, accrued_interest, interest_rate_annual, initial_collateral_value, initial_ltv_pct, status, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
  `).run(loanId, userId, principalAmount, principalAmount, 1450.50, 10.50, initialCollateral, initialLtv, dueDate.toISOString());

  // 5. Initial Ledger Audit Entries with SHA-256 hash chaining
  let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
  
  function createLedgerEntry(entryType, dr, cr, amount, cashAfter, debtAfter, desc, refId, loanRef = null) {
    const entryId = 'led_' + crypto.randomBytes(8).toString('hex');
    const timestamp = new Date().toISOString();
    const hashPayload = [
      entryId,
      userId,
      loanRef || 'NOLON',
      entryType,
      dr,
      cr,
      Number(amount).toFixed(4),
      Number(cashAfter).toFixed(4),
      Number(debtAfter).toFixed(4),
      prevHash,
      timestamp
    ].join('|');
    const hash = crypto.createHash('sha256').update(hashPayload).digest('hex');

    db.prepare(`
      INSERT INTO financial_ledger 
      (id, user_id, loan_id, entry_type, account_debited, account_credited, amount, user_cash_balance_after, user_total_debt_after, description, reference_id, prev_entry_hash, audit_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entryId, userId, loanRef, entryType, dr, cr, amount, cashAfter, debtAfter, desc, refId, prevHash, hash, timestamp);

    prevHash = hash;
  }

  // Opening Demat Deposit
  createLedgerEntry('CASH_DEPOSIT', 'CASH_BALANCE', 'CLIENT_CAPITAL', 100000.00, 100000.00, 0.00, 'Initial bank deposit via UPI (HDFC Bank)', 'UPI-99210948');
  // Collateral pledge entry
  createLedgerEntry('COLLATERAL_PLEDGE', 'HOLDINGS_PLEDGED', 'HOLDINGS_FREE', 620000.00, 100000.00, 0.00, 'Securities pledge recorded for MTF loan facility', 'PLG-2026-01');
  // Margin loan disbursement
  createLedgerEntry('LOAN_DISBURSEMENT', 'CASH_BALANCE', 'LOAN_LIABILITY', 250000.00, 350000.00, 250000.00, 'Automated Instant Margin Loan disbursement (LAS facility)', 'DISB-LN-8842', loanId);
  // Trading position settlement (bought extra shares)
  createLedgerEntry('CASH_WITHDRAWAL', 'EQUITY_SETTLEMENT', 'CASH_BALANCE', 165000.00, 185000.00, 250000.00, 'CNC Equity delivery trade settlement', 'TRD-NSE-88120');
  // Interest accrual
  createLedgerEntry('INTEREST_ACCRUAL', 'INTEREST_EXPENSE', 'LOAN_LIABILITY', 1450.50, 185000.00, 251450.50, 'Daily compound interest accrual (10.5% p.a.)', 'INT-ACCR-01', loanId);

  console.log('[Finodha DB] Seeding completed. Demo credentials: abhishek@finodha.trade / demo1234');
}

// Helper methods for clean abstraction
const dbHelper = {
  getRawDb: () => db,

  queryAll: (sql, params = []) => {
    const stmt = db.prepare(sql);
    return stmt.all(...params);
  },

  queryOne: (sql, params = []) => {
    const stmt = db.prepare(sql);
    return stmt.get(...params);
  },

  run: (sql, params = []) => {
    const stmt = db.prepare(sql);
    return stmt.run(...params);
  },

  transaction: (fn) => {
    db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
};

initializeDatabase();

module.exports = dbHelper;
