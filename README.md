# Finodha: Zerodha-Style Margin Loan & Portfolio Ledger

> An institutional-grade stock-brokerage web application modeled after Zerodha's trading infrastructure and SEBI's Margin Trading Facility (MTF / LAS) regulatory framework.

Finodha allows users to track their asset portfolios in real time, calculate collateral borrowing power after regulatory haircuts, apply for automated instant margin loans, monitor Loan-To-Value (LTV) risk thresholds, process partial repayments, and audit an immutable double-entry financial ledger secured by SHA-256 cryptographic chaining.

---

## 🌟 Key Features

### 1. Real-Time Portfolio Valuation & Collateral Engine
- **Live Ticker Streaming**: Powered by a background micro-tick exchange simulation and WebSocket feed (`ws://localhost:4000/ws`).
- **SEBI-Aligned Regulatory Haircuts**:
  - Bluechips / Large Caps (`RELIANCE`, `TCS`, `HDFCBANK`, `INFY`): **15% - 20% haircut**
  - Midcaps (`DIXON`, `POLYCAB`): **25% haircut**
- **Net Collateral Value**: Automatically computed as $\sum (\text{Pledged Qty} \times \text{CMP} \times (1 - \text{Haircut\%}))$.
- **Borrowing Headroom**: Instant automated calculation of maximum borrowable limit (capped at 65% LTV per SEBI rules) minus active debt.

### 2. Automated Margin Call Triggers & Repayment Endpoints
- **LTV Risk Thresholds**:
  - **Safe Zone (< 60% LTV)**: Normal trading operations.
  - **Caution Zone (60% - 75% LTV)**: Yellow alert on gauge.
  - **Margin Call Trigger ( $\ge$ 75% LTV)**: System automatically generates an open Margin Call event, flags loan status, and presents an urgent warning banner with required shortfall amount.
  - **Critical Liquidation ( $\ge$ 85% LTV)**: Automated liquidation engine (`POST /api/margin/liquidate`) sells just enough collateral at current market price to cure the deficit and restore the account to a safe 60% LTV.
- **Partial Repayment Processing**:
  - `POST /api/loans/:id/repay`
  - Flexible repayment from trading cash balance or external simulated UPI transfer.
  - Strict priority allocation: Accrued interest is settled first, followed by principal reduction.
  - Automatically resolves margin calls when LTV improves below threshold.

### 3. Immutable Double-Entry Financial Ledger
- **Console-Style Financial Statement**: Track debits, credits, running cash balance, and debt liability across all events (`LOAN_DISBURSEMENT`, `LOAN_REPAYMENT_PRINCIPAL`, `LOAN_REPAYMENT_INTEREST`, `COLLATERAL_PLEDGE`, `MARGIN_LIQUIDATION_EXECUTION`).
- **Cryptographic SHA-256 Chaining**: Every ledger block incorporates the SHA-256 hash of the preceding entry, forming a tamper-evident audit chain.
- **Tamper-Evidence Proof Endpoint**: `GET /api/ledger/verify` mathematically audits the entire chain from block #1 to present.

### 4. Security & Rate-Limiting
- **JWT Authentication**: HMAC SHA-256 signed bearer tokens with 7-day expiration.
- **Multi-Tier Rate Limiting**:
  - Strict authentication limiter: 30 requests per 15 minutes.
  - Financial order & repayment limiter: 60 transactions per minute.
  - General API limiter: 300 requests per minute.
- **Password Protection**: Salted bcrypt hashing (10 salt rounds).

### 5. Antigravity Full-Stack PostgreSQL Architecture
- Full production PostgreSQL DDL provided in `server/schema-postgres.sql` with UUID primary keys, `NUMERIC(18, 4)` precision, foreign key integrity, check constraints, indexes, and analytical views.
- Zero-setup local runtime powered by Node.js 24 native `node:sqlite` in WAL mode with matching schema and data structures.

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ (tested on Node.js 24 LTS)
- npm

### 1. Installation
```powershell
cd "c:\New folder\finodha"
npm install
```

### 2. Run Test Suite
Verify all 10 core integration tests (Authentication, Collateral math, Loans, Repayment, Ledger audit, Market shock, Auto-liquidation):
```powershell
npm test
```

### 3. Start Application
```powershell
npm start
```
Open your browser and navigate to:
**`http://localhost:4000`**

---

## 🔑 Demo Account Credentials

| Parameter | Value |
|---|---|
| **Email** | `abhishek@finodha.trade` |
| **Password** | `demo1234` |
| **Client ID** | `ZD8842` |
| **Starter Cash** | ₹1,85,000.00 |
| **Starter Holdings** | Reliance, TCS, HDFC Bank, Infosys, Tata Motors, Bajaj Finance |

*(New users can also register freely on the UI or via `POST /api/auth/register`)*

---

## 📡 API Reference

### Authentication
- `POST /api/auth/register`: Create user account and provision starter portfolio.
- `POST /api/auth/login`: Authenticate and receive JWT Bearer token.
- `GET /api/auth/me`: Fetch authenticated client profile.

### Portfolio & Collateral
- `GET /api/portfolio`: Real-time portfolio valuation, haircut breakdown, and LTV metrics.
- `POST /api/portfolio/pledge`: Pledge or unpledge shares (`{ symbol, quantity, action: 'PLEDGE' | 'UNPLEDGE' }`).
- `POST /api/portfolio/order`: Place simulated Buy / Sell market orders.

### Margin Loans & Repayment
- `GET /api/loans`: List active and historical margin loan contracts.
- `POST /api/loans/apply`: Automated margin loan application (`{ amount: 50000 }`).
- `POST /api/loans/:id/repay`: Partial or full repayment (`{ amount: 15000, source: 'CASH_BALANCE' | 'EXTERNAL_UPI' }`).

### Ledger & Verification
- `GET /api/ledger`: View ledger statement with running balances and SHA-256 hashes.
- `GET /api/ledger/verify`: Cryptographic verification of ledger block chain integrity.

### Margin Stress Testing & Liquidation
- `POST /api/margin/simulate-shock`: Simulate market crash or rally (`{ shockPct: -35 }`).
- `POST /api/margin/liquidate`: Execute automated collateral liquidation to cure shortfall.
- `POST /api/margin/reset-market`: Restore market instruments to baseline prices.
