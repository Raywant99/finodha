-- ============================================================================
-- FINODHA: ZERODHA-STYLE MARGIN LOAN & PORTFOLIO LEDGER
-- PRODUCTION POSTGRESQL SCHEMA SPECIFICATION (v1.0)
-- Compatible with PostgreSQL 14+, AWS RDS, Supabase, Neon
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Clean teardown if needed (for fresh setup)
-- DROP SCHEMA IF EXISTS finodha CASCADE;
-- CREATE SCHEMA finodha;
-- SET search_path TO finodha, public;

-- ----------------------------------------------------------------------------
-- 1. USERS TABLE: Brokerage client identities and master account settings
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id VARCHAR(16) UNIQUE NOT NULL, -- Zerodha-style Client ID e.g., 'ZD9021'
    name VARCHAR(128) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    cash_balance NUMERIC(18, 4) NOT NULL DEFAULT 100000.0000 CHECK (cash_balance >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ----------------------------------------------------------------------------
-- 2. MARKET INSTRUMENTS: SEBI/NSE Equities Master with category-based haircuts
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_instruments (
    symbol VARCHAR(32) PRIMARY KEY, -- e.g., 'RELIANCE', 'TCS', 'HDFCBANK'
    company_name VARCHAR(255) NOT NULL,
    exchange VARCHAR(16) NOT NULL DEFAULT 'NSE',
    category VARCHAR(32) NOT NULL CHECK (category IN ('LARGE_CAP', 'MID_CAP', 'SMALL_CAP', 'ETF', 'GOVT_BOND')),
    current_price NUMERIC(18, 4) NOT NULL CHECK (current_price > 0),
    open_price NUMERIC(18, 4) NOT NULL CHECK (open_price > 0),
    high_price NUMERIC(18, 4) NOT NULL,
    low_price NUMERIC(18, 4) NOT NULL,
    day_change NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
    day_change_pct NUMERIC(8, 4) NOT NULL DEFAULT 0.0000,
    volume BIGINT NOT NULL DEFAULT 1000000,
    haircut_pct NUMERIC(5, 2) NOT NULL CHECK (haircut_pct >= 0 AND haircut_pct < 100), -- Collateral discount %
    is_collateral_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    last_tick_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instruments_category ON market_instruments(category);
CREATE INDEX IF NOT EXISTS idx_instruments_eligible ON market_instruments(is_collateral_eligible);

-- ----------------------------------------------------------------------------
-- 3. USER DEMAT HOLDINGS: Equities owned, with pledge allocation tracking
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_holdings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(32) NOT NULL REFERENCES market_instruments(symbol) ON DELETE RESTRICT,
    total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0),
    pledged_quantity INTEGER NOT NULL DEFAULT 0 CHECK (pledged_quantity >= 0),
    average_buy_price NUMERIC(18, 4) NOT NULL CHECK (average_buy_price > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_pledge_not_exceed_total CHECK (pledged_quantity <= total_quantity),
    CONSTRAINT uq_user_symbol UNIQUE (user_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_holdings_user ON user_holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_holdings_symbol ON user_holdings(symbol);

-- ----------------------------------------------------------------------------
-- 4. MARGIN LOANS (MTF & LAS): Active credit contracts against collateral
-- ----------------------------------------------------------------------------
CREATE TYPE loan_status_enum AS ENUM (
    'ACTIVE',
    'MARGIN_CALL',
    'UNDER_LIQUIDATION',
    'REPAID',
    'DEFAULTED'
);

CREATE TABLE IF NOT EXISTS margin_loans (
    id VARCHAR(32) PRIMARY KEY, -- e.g., 'LN-2026-9481'
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    principal_amount NUMERIC(18, 4) NOT NULL CHECK (principal_amount > 0),
    current_principal NUMERIC(18, 4) NOT NULL CHECK (current_principal >= 0),
    accrued_interest NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (accrued_interest >= 0),
    interest_rate_annual NUMERIC(5, 2) NOT NULL DEFAULT 10.50, -- 10.50% p.a.
    initial_collateral_value NUMERIC(18, 4) NOT NULL CHECK (initial_collateral_value > 0),
    initial_ltv_pct NUMERIC(6, 2) NOT NULL CHECK (initial_ltv_pct > 0 AND initial_ltv_pct <= 70.00),
    status loan_status_enum NOT NULL DEFAULT 'ACTIVE',
    disbursed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    last_interest_accrual_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loans_user ON margin_loans(user_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON margin_loans(status);

-- ----------------------------------------------------------------------------
-- 5. IMMUTABLE FINANCIAL LEDGER: Double-entry ledger with cryptographic audit chaining
-- ----------------------------------------------------------------------------
CREATE TYPE ledger_entry_type_enum AS ENUM (
    'LOAN_DISBURSEMENT',
    'LOAN_REPAYMENT_PRINCIPAL',
    'LOAN_REPAYMENT_INTEREST',
    'INTEREST_ACCRUAL',
    'COLLATERAL_PLEDGE',
    'COLLATERAL_UNPLEDGE',
    'MARGIN_LIQUIDATION_EXECUTION',
    'MARGIN_LIQUIDATION_DEBT_PAYOFF',
    'CASH_DEPOSIT',
    'CASH_WITHDRAWAL'
);

CREATE TABLE IF NOT EXISTS financial_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_num BIGSERIAL UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    loan_id VARCHAR(32) REFERENCES margin_loans(id) ON DELETE RESTRICT,
    entry_type ledger_entry_type_enum NOT NULL,
    account_debited VARCHAR(64) NOT NULL, -- e.g. 'CASH_BALANCE', 'LOAN_LIABILITY', 'HOLDINGS_PLEDGED'
    account_credited VARCHAR(64) NOT NULL, -- e.g. 'LOAN_LIABILITY', 'CASH_BALANCE', 'HOLDINGS_FREE'
    amount NUMERIC(18, 4) NOT NULL CHECK (amount >= 0),
    user_cash_balance_after NUMERIC(18, 4) NOT NULL,
    user_total_debt_after NUMERIC(18, 4) NOT NULL,
    description TEXT NOT NULL,
    reference_id VARCHAR(64), -- external payment ID, trade order ID, or transaction hash
    prev_entry_hash VARCHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    audit_hash VARCHAR(64) NOT NULL, -- SHA-256 (sequence + user_id + amount + prev_hash + timestamp)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON financial_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_loan ON financial_ledger(loan_id);
CREATE INDEX IF NOT EXISTS idx_ledger_seq ON financial_ledger(sequence_num);

-- ----------------------------------------------------------------------------
-- 6. MARGIN CALLS & LIQUIDATION AUDIT TABLE: Threshold breaches and cure workflows
-- ----------------------------------------------------------------------------
CREATE TYPE margin_call_status_enum AS ENUM (
    'OPEN',
    'CURED_BY_REPAYMENT',
    'CURED_BY_COLLATERAL',
    'AUTO_LIQUIDATED',
    'EXPIRED'
);

CREATE TABLE IF NOT EXISTS margin_calls (
    id VARCHAR(32) PRIMARY KEY, -- e.g., 'MC-2026-0042'
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    loan_id VARCHAR(32) REFERENCES margin_loans(id) ON DELETE RESTRICT,
    ltv_triggered_pct NUMERIC(6, 2) NOT NULL,
    threshold_ltv_pct NUMERIC(6, 2) NOT NULL DEFAULT 75.00,
    total_debt NUMERIC(18, 4) NOT NULL,
    collateral_value NUMERIC(18, 4) NOT NULL,
    shortfall_amount NUMERIC(18, 4) NOT NULL, -- Required payment or collateral to restore LTV to 65%
    cure_deadline TIMESTAMPTZ NOT NULL, -- e.g. 24 hours from trigger
    status margin_call_status_enum NOT NULL DEFAULT 'OPEN',
    resolved_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_margin_calls_user ON margin_calls(user_id, status);

-- ----------------------------------------------------------------------------
-- 7. AUDIT LOGS: Security events, rate-limiting violations, admin inspections
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(64) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_action ON security_audit_logs(user_id, action);

-- ----------------------------------------------------------------------------
-- 8. ANALYTICAL VIEWS: Real-time portfolio valuation & margin health metrics
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW view_portfolio_collateral_summary AS
SELECT 
    h.user_id,
    COUNT(h.id) AS total_instruments,
    SUM(h.total_quantity * m.current_price) AS gross_portfolio_value,
    SUM(h.total_quantity * h.average_buy_price) AS total_invested_value,
    SUM(h.total_quantity * m.current_price) - SUM(h.total_quantity * h.average_buy_price) AS total_unrealized_pnl,
    SUM(h.pledged_quantity * m.current_price) AS gross_pledged_value,
    SUM(h.pledged_quantity * m.current_price * (1.0 - (m.haircut_pct / 100.0))) AS net_collateral_value
FROM user_holdings h
JOIN market_instruments m ON h.symbol = m.symbol
GROUP BY h.user_id;

-- Function to automatically maintain updated_at timestamps
CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
CREATE TRIGGER trg_holdings_updated_at BEFORE UPDATE ON user_holdings FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();
