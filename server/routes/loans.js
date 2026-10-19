const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { financialTxRateLimiter } = require('../middleware/rateLimiter');
const MarginEngine = require('../services/marginEngine');
const LedgerService = require('../services/ledgerService');

// GET /api/loans - Retrieve active loans and credit history
router.get('/', authenticateToken, (req, res) => {
  try {
    const loans = db.queryAll(`
      SELECT 
        l.*,
        (l.current_principal + l.accrued_interest) AS total_outstanding
      FROM margin_loans l
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC
    `, [req.user.id]);

    const activeMarginCalls = db.queryAll(`
      SELECT * FROM margin_calls
      WHERE user_id = ? AND status = 'OPEN'
      ORDER BY created_at DESC
    `, [req.user.id]);

    res.json({
      success: true,
      loans,
      activeMarginCalls
    });
  } catch (err) {
    console.error('Error fetching loans:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/loans/apply - Automated margin loan application & disbursement
router.post('/apply', authenticateToken, financialTxRateLimiter, (req, res) => {
  try {
    const { amount } = req.body;
    const loanAmount = parseFloat(amount);

    if (isNaN(loanAmount) || loanAmount < 5000) {
      return res.status(400).json({
        success: false,
        message: 'Minimum loan amount is ₹5,000.'
      });
    }

    const portfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);
    const { availableMarginToBorrow, eligibleCollateralValue, thresholds } = portfolio.metrics;

    if (eligibleCollateralValue <= 0) {
      return res.status(400).json({
        success: false,
        message: 'No eligible pledged collateral found. Please pledge shares from your Demat Holdings first.'
      });
    }

    if (loanAmount > availableMarginToBorrow) {
      return res.status(400).json({
        success: false,
        message: `Requested loan of ₹${loanAmount.toLocaleString('en-IN')} exceeds your available borrowing limit of ₹${Math.floor(availableMarginToBorrow).toLocaleString('en-IN')} (capped at ${thresholds.maxBorrowable}% LTV).`
      });
    }

    // Generate unique loan reference
    const loanSeq = Math.floor(1000 + Math.random() * 9000);
    const loanId = `LN-2026-${loanSeq}`;
    const initialLtv = (loanAmount / eligibleCollateralValue) * 100.0;
    const dueDate = new Date();
    dueDate.setMonth(dueDate.getMonth() + 6); // 6-month term

    const user = db.queryOne('SELECT cash_balance FROM users WHERE id = ?', [req.user.id]);
    const newCashBalance = user.cash_balance + loanAmount;

    let createdLoan;

    db.transaction(() => {
      // 1. Insert new loan
      db.run(`
        INSERT INTO margin_loans 
        (id, user_id, principal_amount, current_principal, accrued_interest, interest_rate_annual, initial_collateral_value, initial_ltv_pct, status, due_at)
        VALUES (?, ?, ?, ?, 0.0, 10.50, ?, ?, 'ACTIVE', ?)
      `, [loanId, req.user.id, loanAmount, loanAmount, eligibleCollateralValue, initialLtv, dueDate.toISOString()]);

      // 2. Disburse funds directly to user cash balance
      db.run('UPDATE users SET cash_balance = ? WHERE id = ?', [newCashBalance, req.user.id]);

      // 3. Append immutable double-entry ledger entry
      LedgerService.recordEntry({
        userId: req.user.id,
        loanId,
        entryType: 'LOAN_DISBURSEMENT',
        accountDebited: 'CASH_BALANCE',
        accountCredited: 'LOAN_LIABILITY',
        amount: loanAmount,
        userCashBalanceAfter: newCashBalance,
        userTotalDebtAfter: (portfolio.metrics.totalDebt + loanAmount),
        description: `Instant Automated Margin Loan Disbursed (#${loanId}) @ 10.5% p.a.`,
        referenceId: `DISB-${loanId}`
      });

      createdLoan = db.queryOne('SELECT * FROM margin_loans WHERE id = ?', [loanId]);
    });

    const updatedPortfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);

    res.status(201).json({
      success: true,
      message: `Margin loan #${loanId} approved and ₹${loanAmount.toLocaleString('en-IN')} disbursed instantly to your trading balance.`,
      loan: createdLoan,
      portfolio: updatedPortfolio
    });
  } catch (err) {
    console.error('Error applying for loan:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/loans/:id/repay - Partial or full repayment processing endpoint
router.post('/:id/repay', authenticateToken, financialTxRateLimiter, (req, res) => {
  try {
    const loanId = req.params.id;
    const { amount, source = 'CASH_BALANCE' } = req.body; // source: 'CASH_BALANCE' or 'EXTERNAL_UPI'
    const repayAmount = parseFloat(amount);

    if (isNaN(repayAmount) || repayAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Repayment amount must be a positive number.'
      });
    }

    const loan = db.queryOne('SELECT * FROM margin_loans WHERE id = ? AND user_id = ?', [loanId, req.user.id]);
    if (!loan) {
      return res.status(404).json({ success: false, message: 'Loan contract not found.' });
    }

    if (['REPAID', 'DEFAULTED'].includes(loan.status)) {
      return res.status(400).json({ success: false, message: `Loan is already ${loan.status.toLowerCase()}.` });
    }

    const totalOutstandingOnLoan = loan.current_principal + loan.accrued_interest;
    const actualRepay = Math.min(repayAmount, totalOutstandingOnLoan);

    const user = db.queryOne('SELECT id, cash_balance FROM users WHERE id = ?', [req.user.id]);

    if (source === 'CASH_BALANCE' && user.cash_balance < actualRepay) {
      return res.status(400).json({
        success: false,
        message: `Insufficient trading cash balance. Available: ₹${user.cash_balance.toFixed(2)}, required: ₹${actualRepay.toFixed(2)}. Top up funds or select UPI payment.`
      });
    }

    db.transaction(() => {
      // 1. Calculate Interest vs Principal payoff
      let interestPaid = 0;
      let principalPaid = 0;
      let remainingPayment = actualRepay;

      // Pay accrued interest first
      if (loan.accrued_interest > 0) {
        interestPaid = Math.min(loan.accrued_interest, remainingPayment);
        remainingPayment -= interestPaid;
      }

      // Remainder pays down principal
      principalPaid = Math.min(loan.current_principal, remainingPayment);

      const newPrincipal = loan.current_principal - principalPaid;
      const newInterest = loan.accrued_interest - interestPaid;
      const isFullyRepaid = (newPrincipal <= 0 && newInterest <= 0);
      const newStatus = isFullyRepaid ? 'REPAID' : loan.status;

      // Update loan balance
      db.run(`
        UPDATE margin_loans 
        SET current_principal = ?,
            accrued_interest = ?,
            status = ?,
            closed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE closed_at END
        WHERE id = ?
      `, [newPrincipal, newInterest, newStatus, isFullyRepaid ? 1 : 0, loan.id]);

      // Deduct from cash balance if paid from trading account
      let newCashBalance = user.cash_balance;
      if (source === 'CASH_BALANCE') {
        newCashBalance = user.cash_balance - actualRepay;
        db.run('UPDATE users SET cash_balance = ? WHERE id = ?', [newCashBalance, user.id]);
      }

      // 2. Ledger Entries
      if (interestPaid > 0) {
        LedgerService.recordEntry({
          userId: user.id,
          loanId: loan.id,
          entryType: 'LOAN_REPAYMENT_INTEREST',
          accountDebited: 'LOAN_LIABILITY',
          accountCredited: source === 'CASH_BALANCE' ? 'CASH_BALANCE' : 'EXTERNAL_GATEWAY',
          amount: interestPaid,
          userCashBalanceAfter: newCashBalance,
          userTotalDebtAfter: 0,
          description: `Repayment of accrued interest for loan #${loan.id}`,
          referenceId: `REP-INT-${Date.now()}`
        });
      }

      if (principalPaid > 0) {
        LedgerService.recordEntry({
          userId: user.id,
          loanId: loan.id,
          entryType: 'LOAN_REPAYMENT_PRINCIPAL',
          accountDebited: 'LOAN_LIABILITY',
          accountCredited: source === 'CASH_BALANCE' ? 'CASH_BALANCE' : 'EXTERNAL_GATEWAY',
          amount: principalPaid,
          userCashBalanceAfter: newCashBalance,
          userTotalDebtAfter: 0,
          description: `Repayment of principal for loan #${loan.id} (${isFullyRepaid ? 'Full Settlement' : 'Partial Repayment'})`,
          referenceId: `REP-PRIN-${Date.now()}`
        });
      }
    });

    // Check if margin calls are now resolved due to improved LTV
    MarginEngine.monitorAndTriggerMarginCall(req.user.id);

    const updatedPortfolio = MarginEngine.getPortfolioAndCollateral(req.user.id);
    const updatedLoan = db.queryOne('SELECT * FROM margin_loans WHERE id = ?', [loanId]);

    res.json({
      success: true,
      message: `Repayment of ₹${actualRepay.toLocaleString('en-IN')} processed successfully.`,
      repaymentDetails: {
        loanId,
        amountPaid: actualRepay,
        principalPaid: actualRepay - Math.min(loan.accrued_interest, actualRepay),
        interestPaid: Math.min(loan.accrued_interest, actualRepay),
        remainingPrincipal: updatedLoan.current_principal,
        isFullyRepaid: updatedLoan.status === 'REPAID'
      },
      loan: updatedLoan,
      portfolio: updatedPortfolio
    });
  } catch (err) {
    console.error('Repayment processing error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
