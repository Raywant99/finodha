const db = require('../db');
const crypto = require('crypto');
const LedgerService = require('./ledgerService');

class MarginEngine {
  /**
   * Computes comprehensive real-time portfolio valuation and collateral health
   */
  static getPortfolioAndCollateral(userId) {
    const user = db.queryOne('SELECT id, client_id, name, cash_balance FROM users WHERE id = ?', [userId]);
    if (!user) throw new Error('User not found');

    const holdings = db.queryAll(`
      SELECT 
        h.id AS holding_id,
        h.symbol,
        h.total_quantity,
        h.pledged_quantity,
        (h.total_quantity - h.pledged_quantity) AS free_quantity,
        h.average_buy_price,
        m.company_name,
        m.exchange,
        m.category,
        m.current_price,
        m.day_change,
        m.day_change_pct,
        m.haircut_pct,
        m.is_collateral_eligible
      FROM user_holdings h
      JOIN market_instruments m ON h.symbol = m.symbol
      WHERE h.user_id = ?
    `, [userId]);

    let grossPortfolioValue = 0;
    let totalInvestedValue = 0;
    let grossPledgedValue = 0;
    let eligibleCollateralValue = 0;

    const enrichedHoldings = holdings.map(h => {
      const curValue = h.total_quantity * h.current_price;
      const invValue = h.total_quantity * h.average_buy_price;
      const pnl = curValue - invValue;
      const pnlPct = invValue > 0 ? (pnl / invValue) * 100 : 0;
      
      const pledgedGross = h.pledged_quantity * h.current_price;
      // Net collateral = Pledged Value * (1 - Haircut%)
      const pledgedNetCollateral = h.is_collateral_eligible 
        ? pledgedGross * (1.0 - (h.haircut_pct / 100.0))
        : 0;

      grossPortfolioValue += curValue;
      totalInvestedValue += invValue;
      grossPledgedValue += pledgedGross;
      eligibleCollateralValue += pledgedNetCollateral;

      return {
        ...h,
        current_value: curValue,
        invested_value: invValue,
        unrealized_pnl: pnl,
        unrealized_pnl_pct: pnlPct,
        pledged_gross_value: pledgedGross,
        pledged_net_collateral: pledgedNetCollateral
      };
    });

    // Total outstanding debt from all active margin loans
    const loans = db.queryAll(`
      SELECT * FROM margin_loans 
      WHERE user_id = ? AND status IN ('ACTIVE', 'MARGIN_CALL', 'UNDER_LIQUIDATION')
    `, [userId]);

    let totalPrincipalDebt = 0;
    let totalAccruedInterest = 0;

    loans.forEach(loan => {
      totalPrincipalDebt += loan.current_principal;
      totalAccruedInterest += loan.accrued_interest;
    });

    const totalDebt = totalPrincipalDebt + totalAccruedInterest;

    // Regulatory LTV parameters (SEBI LAS / MTF framework)
    const MAX_BORROWABLE_LTV = 65.0; // Max permitted LTV at loan origination (65%)
    const WARNING_LTV = 70.0;        // Warning threshold (70%)
    const MARGIN_CALL_LTV = 75.0;    // Margin Call trigger threshold (75%)
    const LIQUIDATION_LTV = 85.0;    // Forced Liquidation threshold (85%)
    const SAFE_TARGET_LTV = 60.0;    // Target safe ratio when curing shortfall

    const maxBorrowableLimit = eligibleCollateralValue * (MAX_BORROWABLE_LTV / 100.0);
    const availableMarginToBorrow = Math.max(0, maxBorrowableLimit - totalDebt);

    // Current LTV ratio calculation
    let currentLtv = 0;
    if (eligibleCollateralValue > 0) {
      currentLtv = (totalDebt / eligibleCollateralValue) * 100.0;
    } else if (totalDebt > 0) {
      currentLtv = 100.0;
    }

    // Health categorization
    let healthStatus = 'SAFE';
    let healthColor = '#00d09c'; // Green
    if (currentLtv >= LIQUIDATION_LTV) {
      healthStatus = 'CRITICAL_LIQUIDATION';
      healthColor = '#f6465d'; // Red
    } else if (currentLtv >= MARGIN_CALL_LTV) {
      healthStatus = 'MARGIN_CALL';
      healthColor = '#ff5722'; // Orange
    } else if (currentLtv >= WARNING_LTV) {
      healthStatus = 'CAUTION';
      healthColor = '#f0ad4e'; // Yellow
    }

    // Calculate required shortfall amount to restore LTV to SAFE_TARGET_LTV (60%)
    let shortfallAmount = 0;
    if (currentLtv >= MARGIN_CALL_LTV) {
      const allowedDebtAtTarget = eligibleCollateralValue * (SAFE_TARGET_LTV / 100.0);
      shortfallAmount = Math.max(0, totalDebt - allowedDebtAtTarget);
    }

    return {
      userId: user.id,
      clientId: user.client_id,
      cashBalance: user.cash_balance,
      holdings: enrichedHoldings,
      activeLoans: loans,
      metrics: {
        grossPortfolioValue,
        totalInvestedValue,
        totalUnrealizedPnl: grossPortfolioValue - totalInvestedValue,
        totalUnrealizedPnlPct: totalInvestedValue > 0 ? ((grossPortfolioValue - totalInvestedValue) / totalInvestedValue) * 100 : 0,
        grossPledgedValue,
        eligibleCollateralValue,
        freeHoldingsValue: grossPortfolioValue - grossPledgedValue,
        totalPrincipalDebt,
        totalAccruedInterest,
        totalDebt,
        maxBorrowableLimit,
        availableMarginToBorrow,
        currentLtv: Number(currentLtv.toFixed(2)),
        thresholds: {
          maxBorrowable: MAX_BORROWABLE_LTV,
          warning: WARNING_LTV,
          marginCall: MARGIN_CALL_LTV,
          liquidation: LIQUIDATION_LTV,
          targetSafe: SAFE_TARGET_LTV
        },
        healthStatus,
        healthColor,
        shortfallAmount: Number(shortfallAmount.toFixed(2))
      }
    };
  }

  /**
   * Evaluates current LTV against margin call triggers and updates system state
   */
  static monitorAndTriggerMarginCall(userId) {
    const portfolio = this.getPortfolioAndCollateral(userId);
    const { currentLtv, shortfallAmount, eligibleCollateralValue, totalDebt, thresholds } = portfolio.metrics;

    const existingCall = db.queryOne(
      "SELECT * FROM margin_calls WHERE user_id = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1",
      [userId]
    );

    // 1. If LTV >= 75% and no open margin call, trigger automated alert
    if (currentLtv >= thresholds.marginCall && !existingCall && totalDebt > 0) {
      const callId = 'MC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const deadline = new Date();
      deadline.setHours(deadline.getHours() + 24); // 24-hour cure period

      const activeLoan = portfolio.activeLoans[0];

      db.run(`
        INSERT INTO margin_calls 
        (id, user_id, loan_id, ltv_triggered_pct, threshold_ltv_pct, total_debt, collateral_value, shortfall_amount, cure_deadline, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
      `, [
        callId,
        userId,
        activeLoan ? activeLoan.id : null,
        currentLtv,
        thresholds.marginCall,
        totalDebt,
        eligibleCollateralValue,
        shortfallAmount,
        deadline.toISOString(),
        `Automated margin call: LTV breached ${currentLtv}%. Cure shortfall of ₹${shortfallAmount.toFixed(2)} required.`
      ]);

      // Set loans status to MARGIN_CALL
      db.run(`
        UPDATE margin_loans 
        SET status = 'MARGIN_CALL' 
        WHERE user_id = ? AND status = 'ACTIVE'
      `, [userId]);

      return {
        triggered: true,
        marginCallId: callId,
        currentLtv,
        shortfallAmount,
        deadline: deadline.toISOString()
      };
    }

    // 2. If LTV has recovered below warning threshold (< 70%) and there was an open margin call, resolve it
    if (existingCall && currentLtv < thresholds.warning) {
      db.run(`
        UPDATE margin_calls 
        SET status = 'CURED_BY_REPAYMENT', resolved_at = datetime('now'), notes = notes || ' [Auto-resolved: LTV recovered to safe level]'
        WHERE id = ?
      `, [existingCall.id]);

      // Restore active loans status
      db.run(`
        UPDATE margin_loans 
        SET status = 'ACTIVE' 
        WHERE user_id = ? AND status = 'MARGIN_CALL'
      `, [userId]);

      return {
        cured: true,
        marginCallId: existingCall.id,
        currentLtv
      };
    }

    return {
      triggered: false,
      cured: false,
      currentLtv
    };
  }

  /**
   * Executes automated liquidation of pledged collateral to resolve critical margin deficit
   */
  static executeAutoLiquidation(userId) {
    const portfolio = this.getPortfolioAndCollateral(userId);
    const { currentLtv, totalDebt, eligibleCollateralValue, shortfallAmount } = portfolio.metrics;

    if (totalDebt <= 0) {
      throw new Error('No active debt to liquidate against.');
    }

    // Target shortfall to recover (bringing LTV down to safe 60%)
    const targetRecovery = shortfallAmount > 0 ? shortfallAmount : Math.min(totalDebt, 50000);

    // Find the most suitable pledged holding with sufficient value
    const pledgedCandidates = portfolio.holdings
      .filter(h => h.pledged_quantity > 0)
      .sort((a, b) => b.pledged_gross_value - a.pledged_gross_value);

    if (pledgedCandidates.length === 0) {
      throw new Error('No pledged collateral available for liquidation!');
    }

    const holding = pledgedCandidates[0];
    const sharesNeeded = Math.min(
      holding.pledged_quantity,
      Math.max(1, Math.ceil(targetRecovery / holding.current_price))
    );

    const grossProceeds = sharesNeeded * holding.current_price;

    return db.transaction(() => {
      // 1. Reduce pledged quantity & total quantity
      db.run(`
        UPDATE user_holdings 
        SET pledged_quantity = pledged_quantity - ?,
            total_quantity = total_quantity - ?,
            updated_at = datetime('now')
        WHERE id = ?
      `, [sharesNeeded, sharesNeeded, holding.holding_id]);

      // 2. Pay off debt from proceeds
      const activeLoan = portfolio.activeLoans[0];
      let remainingProceeds = grossProceeds;
      let interestPaid = 0;
      let principalPaid = 0;

      if (activeLoan) {
        // Pay interest first
        interestPaid = Math.min(activeLoan.accrued_interest, remainingProceeds);
        remainingProceeds -= interestPaid;

        // Pay principal
        principalPaid = Math.min(activeLoan.current_principal, remainingProceeds);
        remainingProceeds -= principalPaid;

        const newPrincipal = activeLoan.current_principal - principalPaid;
        const newInterest = activeLoan.accrued_interest - interestPaid;
        const newStatus = (newPrincipal <= 0) ? 'REPAID' : (currentLtv < 75 ? 'ACTIVE' : 'MARGIN_CALL');

        db.run(`
          UPDATE margin_loans
          SET current_principal = ?,
              accrued_interest = ?,
              status = ?,
              closed_at = CASE WHEN ? = 'REPAID' THEN datetime('now') ELSE closed_at END
          WHERE id = ?
        `, [newPrincipal, newInterest, newStatus, newStatus, activeLoan.id]);
      }

      // Any remaining proceeds get credited to user cash balance
      const user = db.queryOne('SELECT cash_balance FROM users WHERE id = ?', [userId]);
      const newCashBalance = user.cash_balance + remainingProceeds;

      db.run('UPDATE users SET cash_balance = ? WHERE id = ?', [newCashBalance, userId]);

      const remainingDebt = (totalDebt - (interestPaid + principalPaid));

      // 3. Record Immutable Financial Ledger Entries
      // Entry A: Liquidation Execution (Securities sold)
      LedgerService.recordEntry({
        userId,
        loanId: activeLoan ? activeLoan.id : null,
        entryType: 'MARGIN_LIQUIDATION_EXECUTION',
        accountDebited: 'EQUITY_LIQUIDATION_ESCROW',
        accountCredited: 'HOLDINGS_PLEDGED',
        amount: grossProceeds,
        userCashBalanceAfter: user.cash_balance,
        userTotalDebtAfter: totalDebt,
        description: `Automated Liquidation: Sold ${sharesNeeded} shares of ${holding.symbol} @ ₹${holding.current_price.toFixed(2)} to cure margin deficit.`,
        referenceId: `LIQ-NSE-${Date.now()}`
      });

      // Entry B: Debt Payoff
      LedgerService.recordEntry({
        userId,
        loanId: activeLoan ? activeLoan.id : null,
        entryType: 'MARGIN_LIQUIDATION_DEBT_PAYOFF',
        accountDebited: 'LOAN_LIABILITY',
        accountCredited: 'EQUITY_LIQUIDATION_ESCROW',
        amount: (principalPaid + interestPaid),
        userCashBalanceAfter: newCashBalance,
        userTotalDebtAfter: remainingDebt,
        description: `Margin Liquidation Payoff: Principal ₹${principalPaid.toFixed(2)} + Interest ₹${interestPaid.toFixed(2)} cured.`,
        referenceId: `PAY-LIQ-${Date.now()}`
      });

      // 4. Update or resolve open margin call
      const openCall = db.queryOne("SELECT id FROM margin_calls WHERE user_id = ? AND status = 'OPEN'", [userId]);
      if (openCall) {
        db.run(`
          UPDATE margin_calls 
          SET status = 'AUTO_LIQUIDATED', resolved_at = datetime('now'), notes = notes || ' [Auto-liquidated collateral to cure deficit]'
          WHERE id = ?
        `, [openCall.id]);
      }

      return {
        liquidatedSymbol: holding.symbol,
        sharesSold: sharesNeeded,
        pricePerShare: holding.current_price,
        grossProceeds,
        principalPaid,
        interestPaid,
        cashRefunded: remainingProceeds,
        remainingDebt,
        newCashBalance
      };
    });
  }
}

module.exports = MarginEngine;
