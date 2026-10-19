const crypto = require('crypto');
const db = require('../db');

class LedgerService {
  /**
   * Appends an immutable record to the financial ledger with SHA-256 chaining
   */
  static recordEntry({
    userId,
    loanId = null,
    entryType,
    accountDebited,
    accountCredited,
    amount,
    userCashBalanceAfter,
    userTotalDebtAfter,
    description,
    referenceId = null
  }) {
    // 1. Fetch previous entry's audit hash for cryptographic chaining
    const lastEntry = db.queryOne(
      'SELECT audit_hash, sequence_num FROM financial_ledger WHERE user_id = ? ORDER BY sequence_num DESC LIMIT 1',
      [userId]
    );

    const prevHash = lastEntry ? lastEntry.audit_hash : '0000000000000000000000000000000000000000000000000000000000000000';
    const entryId = 'led_' + crypto.randomBytes(8).toString('hex');
    const timestamp = new Date().toISOString();

    // 2. Compute canonical SHA-256 hash
    const hashPayload = [
      entryId,
      userId,
      loanId || 'NOLON',
      entryType,
      accountDebited,
      accountCredited,
      amount.toFixed(4),
      userCashBalanceAfter.toFixed(4),
      userTotalDebtAfter.toFixed(4),
      prevHash,
      timestamp
    ].join('|');

    const auditHash = crypto.createHash('sha256').update(hashPayload).digest('hex');

    // 3. Insert immutable ledger row
    db.run(
      `INSERT INTO financial_ledger 
      (id, user_id, loan_id, entry_type, account_debited, account_credited, amount, user_cash_balance_after, user_total_debt_after, description, reference_id, prev_entry_hash, audit_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        userId,
        loanId,
        entryType,
        accountDebited,
        accountCredited,
        amount,
        userCashBalanceAfter,
        userTotalDebtAfter,
        description,
        referenceId,
        prevHash,
        auditHash,
        timestamp
      ]
    );

    return {
      entryId,
      auditHash,
      prevHash,
      timestamp,
      entryType,
      amount
    };
  }

  /**
   * Verifies the cryptographic integrity of the ledger chain for a given user
   */
  static verifyLedgerIntegrity(userId) {
    const entries = db.queryAll(
      'SELECT * FROM financial_ledger WHERE user_id = ? ORDER BY sequence_num ASC',
      [userId]
    );

    if (entries.length === 0) {
      return { isValid: true, totalEntries: 0, message: 'Ledger is empty, chain intact.' };
    }

    let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Check chaining link
      if (entry.prev_entry_hash !== expectedPrevHash) {
        return {
          isValid: false,
          compromisedSequence: entry.sequence_num,
          entryId: entry.id,
          message: `Chain broken at sequence #${entry.sequence_num}. Previous hash mismatch.`
        };
      }

      // Recompute SHA-256
      const hashPayload = [
        entry.id,
        entry.user_id,
        entry.loan_id || 'NOLON',
        entry.entry_type,
        entry.account_debited,
        entry.account_credited,
        Number(entry.amount).toFixed(4),
        Number(entry.user_cash_balance_after).toFixed(4),
        Number(entry.user_total_debt_after).toFixed(4),
        entry.prev_entry_hash,
        entry.created_at
      ].join('|');

      const computedHash = crypto.createHash('sha256').update(hashPayload).digest('hex');

      if (computedHash !== entry.audit_hash) {
        return {
          isValid: false,
          compromisedSequence: entry.sequence_num,
          entryId: entry.id,
          message: `Data tampering detected at sequence #${entry.sequence_num}. Checksum mismatch.`
        };
      }

      expectedPrevHash = entry.audit_hash;
    }

    return {
      isValid: true,
      totalEntries: entries.length,
      lastAuditHash: expectedPrevHash,
      verifiedAt: new Date().toISOString(),
      message: 'All ledger entries mathematically verified. Chain is 100% tamper-evident.'
    };
  }
}

module.exports = LedgerService;
