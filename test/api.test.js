const { app, server } = require('../server/index');
const assert = require('assert');

const BASE_URL = 'http://localhost:4000';

async function runTestSuite() {
  console.log('\n======================================================');
  console.log(' RUNNING FINODHA VERIFICATION TEST SUITE');
  console.log('======================================================\n');

  let authToken = null;
  let testUserId = null;
  let activeLoanId = null;

  try {
    // 1. Health check
    console.log('[Test 1] Health Check...');
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const healthData = await healthRes.json();
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(healthData.status, 'ONLINE');
    console.log(' Health check passed:', healthData.system);

    // 2. Authentication Login (Demo User)
    console.log('\n[Test 2] Demo User Authentication (abhishek@finodha.trade)...');
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'abhishek@finodha.trade', password: 'demo1234' })
    });
    const loginData = await loginRes.json();
    assert.strictEqual(loginRes.status, 200);
    assert.strictEqual(loginData.success, true);
    assert.ok(loginData.token);
    authToken = loginData.token;
    testUserId = loginData.user.id;
    console.log(` Login succeeded! Client ID: ${loginData.user.clientId}, Token generated.`);

    // 3. User Identity Check (/api/auth/me)
    console.log('\n[Test 3] JWT Token Verification (/api/auth/me)...');
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const meData = await meRes.json();
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meData.user.email, 'abhishek@finodha.trade');
    console.log(' Token correctly decoded and user verified.');

    // 4. Portfolio & Collateral Valuation
    console.log('\n[Test 4] Real-Time Portfolio & Collateral Valuation (/api/portfolio)...');
    const portfolioRes = await fetch(`${BASE_URL}/api/portfolio`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const portData = await portfolioRes.json();
    assert.strictEqual(portfolioRes.status, 200);
    assert.ok(portData.data.holdings.length > 0);
    const m = portData.data.metrics;
    console.log(` Gross Portfolio: ₹${m.grossPortfolioValue.toLocaleString('en-IN')}`);
    console.log(` Eligible Collateral Value: ₹${m.eligibleCollateralValue.toLocaleString('en-IN')}`);
    console.log(` Total Outstanding Debt: ₹${m.totalDebt.toLocaleString('en-IN')}`);
    console.log(` Current LTV: ${m.currentLtv}% (Health: ${m.healthStatus})`);
    console.log(` Available Margin to Borrow: ₹${m.availableMarginToBorrow.toLocaleString('en-IN')}`);
    assert.ok(m.eligibleCollateralValue > 0);

    // 5. Apply for an Instant Margin Loan
    console.log('\n[Test 5] Automated Margin Loan Application (/api/loans/apply)...');
    const loanBorrowAmt = 35000;
    const loanRes = await fetch(`${BASE_URL}/api/loans/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ amount: loanBorrowAmt })
    });
    const loanData = await loanRes.json();
    assert.strictEqual(loanRes.status, 201);
    assert.strictEqual(loanData.success, true);
    activeLoanId = loanData.loan.id;
    console.log(` Loan Approved & Disbursed: #${activeLoanId} for ₹${loanBorrowAmt.toLocaleString('en-IN')}`);
    console.log(` Updated Cash Balance: ₹${loanData.portfolio.cashBalance.toLocaleString('en-IN')}`);

    // 6. Partial Repayment Endpoint
    console.log('\n[Test 6] Partial Repayment Processing (/api/loans/:id/repay)...');
    const repayAmt = 15000;
    const repayRes = await fetch(`${BASE_URL}/api/loans/${activeLoanId}/repay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ amount: repayAmt, source: 'CASH_BALANCE' })
    });
    const repayData = await repayRes.json();
    assert.strictEqual(repayRes.status, 200);
    assert.strictEqual(repayData.success, true);
    console.log(` Repaid ₹${repayAmt.toLocaleString('en-IN')}. Remaining Principal: ₹${repayData.loan.current_principal.toLocaleString('en-IN')}`);

    // 7. Ledger Statement & SHA-256 Chaining Integrity
    console.log('\n[Test 7] Financial Ledger Cryptographic Audit (/api/ledger/verify)...');
    const auditRes = await fetch(`${BASE_URL}/api/ledger/verify`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const auditData = await auditRes.json();
    console.log('Audit Report:', auditData.auditReport);
    assert.strictEqual(auditRes.status, 200);
    assert.strictEqual(auditData.auditReport.isValid, true);
    console.log(` Cryptographic Audit Success! ${auditData.auditReport.totalEntries} entries audited. Checksum: ${auditData.auditReport.lastAuditHash.substring(0, 16)}...`);

    // 8. Market Shock Simulation -> Trigger Margin Call
    console.log('\n[Test 8] Market Shock Simulation (-35% Crash) -> Trigger Margin Call...');
    const shockRes = await fetch(`${BASE_URL}/api/margin/simulate-shock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ shockPct: -35 })
    });
    const shockData = await shockRes.json();
    assert.strictEqual(shockRes.status, 200);
    const postShockM = shockData.portfolio.metrics;
    console.log(` Post-Shock LTV: ${postShockM.currentLtv}% | Status: ${postShockM.healthStatus}`);
    console.log(` Shortfall Amount to Cure: ₹${postShockM.shortfallAmount.toLocaleString('en-IN')}`);

    // 9. Automated Liquidation Execution
    console.log('\n[Test 9] Automated Collateral Liquidation (/api/margin/liquidate)...');
    const liqRes = await fetch(`${BASE_URL}/api/margin/liquidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    });
    const liqData = await liqRes.json();
    assert.strictEqual(liqRes.status, 200);
    assert.strictEqual(liqData.success, true);
    console.log(` Liquidation Executed: Sold ${liqData.liquidation.sharesSold} shares of ${liqData.liquidation.liquidatedSymbol} for ₹${liqData.liquidation.grossProceeds.toLocaleString('en-IN')}`);
    console.log(` Debt paid off: ₹${(liqData.liquidation.principalPaid + liqData.liquidation.interestPaid).toLocaleString('en-IN')}`);

    // 10. Reset Market Prices
    console.log('\n[Test 10] Market Reset to Baseline (/api/margin/reset-market)...');
    const resetRes = await fetch(`${BASE_URL}/api/margin/reset-market`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    });
    const resetData = await resetRes.json();
    assert.strictEqual(resetRes.status, 200);
    console.log(' Market baseline restored successfully.');

    console.log('\n======================================================');
    console.log(' ALL 10 FINODHA TESTS PASSED PERFECTLY!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('Test Suite Failed:', err);
    process.exit(1);
  } finally {
    server.close();
    process.exit(0);
  }
}

// Give server time to listen, then run test suite
setTimeout(runTestSuite, 1000);
