import { getDatabase, type WriteHandle } from '../client';
import { PenaltyBasis, PenaltyCharge, PenaltyPeriod, PenaltyRule, PenaltyScope } from '../types';
import { canonicalMoney } from '../../utils/money';

/**
 * Configurable penalties: the policy (`penalty_rules`) and its applications (`penalty_charges`).
 *
 * Nothing here invents money. A rule only *describes* an arrangement; a charge is written when the
 * treasurer assesses the penalties they can see, which is why the service exposes a preview next to
 * the assessment — the confirm dialog shows the total before anything is recorded.
 */

const RULE_COLUMNS = `
  id,
  scope,
  borrower_id as borrowerId,
  loan_id as loanId,
  basis,
  amount,
  period,
  grace_days as graceDays,
  cap_amount as capAmount,
  reason,
  created_at as createdAt,
  waived_at as waivedAt,
  waived_reason as waivedReason
`;

const CHARGE_COLUMNS = `
  id,
  rule_id as ruleId,
  loan_id as loanId,
  borrower_id as borrowerId,
  schedule_id as scheduleId,
  installment_number as installmentNumber,
  amount,
  days_late as daysLate,
  periods,
  paid_amount as paidAmount,
  waived_at as waivedAt,
  waived_reason as waivedReason,
  assessed_at as assessedAt
`;

function newRuleId(): string {
  return 'pen_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
}

function newChargeId(): string {
  return 'chg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
}

/** Money columns leave the repository as canonical peso amounts. */
function toRule(row: PenaltyRule): PenaltyRule {
  return {
    ...row,
    amount: canonicalMoney(Number(row.amount)),
    capAmount:
      row.capAmount === null || row.capAmount === undefined
        ? null
        : canonicalMoney(Number(row.capAmount)),
  };
}

function toCharge(row: PenaltyCharge): PenaltyCharge {
  return {
    ...row,
    amount: canonicalMoney(Number(row.amount)),
    paidAmount: canonicalMoney(Number(row.paidAmount ?? 0)),
  };
}

export interface PenaltyRuleInput {
  scope: PenaltyScope;
  borrowerId: string;
  loanId?: string | null;
  basis: PenaltyBasis;
  amount: number;
  period: PenaltyPeriod;
  graceDays: number;
  capAmount?: number | null;
  reason?: string;
}

export interface PenaltyChargeInput {
  ruleId: string;
  loanId: string;
  borrowerId: string;
  scheduleId?: string | null;
  installmentNumber?: number | null;
  amount: number;
  daysLate: number;
  periods: number;
}

export const penaltyRepo = {
  // --- rules -------------------------------------------------------------

  async createRule(input: PenaltyRuleInput): Promise<PenaltyRule> {
    const db = await getDatabase();
    const id = newRuleId();
    await db.runAsync(
      `INSERT INTO penalty_rules (
        id, scope, borrower_id, loan_id, basis, amount, period, grace_days, cap_amount, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scope,
        input.borrowerId,
        input.scope === 'LOAN' ? input.loanId ?? null : null,
        input.basis,
        input.amount,
        input.period,
        Math.max(0, Math.trunc(input.graceDays || 0)),
        input.capAmount === null || input.capAmount === undefined ? null : input.capAmount,
        input.reason || null,
      ]
    );
    const created = await db.getFirstAsync<PenaltyRule>(
      `SELECT ${RULE_COLUMNS} FROM penalty_rules WHERE id = ?`,
      [id]
    );
    if (!created) throw new Error('The penalty rule was written but could not be read back.');
    return toRule(created);
  },

  /** Active (non-waived) rules for a borrower, including any loan-scoped ones. */
  async getActiveRulesForBorrower(borrowerId: string): Promise<PenaltyRule[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<PenaltyRule>(
      `SELECT ${RULE_COLUMNS}
       FROM penalty_rules
       WHERE borrower_id = ? AND waived_at IS NULL
       ORDER BY created_at DESC`,
      [borrowerId]
    );
    return rows.map(toRule);
  },

  async getAllRulesForBorrower(borrowerId: string): Promise<PenaltyRule[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<PenaltyRule>(
      `SELECT ${RULE_COLUMNS} FROM penalty_rules WHERE borrower_id = ? ORDER BY created_at DESC`,
      [borrowerId]
    );
    return rows.map(toRule);
  },

  /** Rules that apply to one loan: its own loan-scoped rules plus the borrower's. */
  async getRulesForLoanWith(
    handle: Pick<WriteHandle, 'getAllAsync'>,
    loanId: string
  ): Promise<PenaltyRule[]> {
    const rows = await handle.getAllAsync<PenaltyRule>(
      `SELECT ${RULE_COLUMNS}
       FROM penalty_rules
       WHERE waived_at IS NULL
         AND (
           (scope = 'LOAN' AND loan_id = ?)
           OR (scope = 'BORROWER' AND borrower_id = (SELECT borrower_id FROM loans WHERE id = ?))
         )
       ORDER BY created_at DESC`,
      [loanId, loanId]
    );
    return rows.map(toRule);
  },

  async waiveRule(id: string, reason: string): Promise<void> {
    const db = await getDatabase();
    await this.waiveRuleWith(db, id, reason);
  },

  /** `txn`-aware variant: the waiver and its audit entry must share one transaction. */
  async waiveRuleWith(
    handle: Pick<WriteHandle, 'runAsync'>,
    id: string,
    reason: string
  ): Promise<void> {
    await handle.runAsync(
      `UPDATE penalty_rules SET waived_at = datetime('now'), waived_reason = ? WHERE id = ? AND waived_at IS NULL`,
      [reason, id]
    );
  },

  // --- charges -----------------------------------------------------------

  async createChargeWith(
    handle: Pick<WriteHandle, 'runAsync'>,
    input: PenaltyChargeInput
  ): Promise<string> {
    const id = newChargeId();
    await handle.runAsync(
      `INSERT INTO penalty_charges (
        id, rule_id, loan_id, borrower_id, schedule_id, installment_number, amount, days_late, periods
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ruleId,
        input.loanId,
        input.borrowerId,
        input.scheduleId ?? null,
        input.installmentNumber ?? null,
        input.amount,
        input.daysLate,
        input.periods,
      ]
    );
    return id;
  },

  /** Existing charge for this rule + installment, so assessment can never double-charge. */
  async findExistingCharge(
    ruleId: string,
    scheduleId: string
  ): Promise<{ id: string; amount: number } | null> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ id: string; amount: number }>(
      `SELECT id, amount FROM penalty_charges WHERE rule_id = ? AND schedule_id = ? LIMIT 1`,
      [ruleId, scheduleId]
    );
    return row ? { id: row.id, amount: canonicalMoney(Number(row.amount)) } : null;
  },

  /**
   * Raises an already-assessed charge because more periods have elapsed.
   *
   * Only ever upward: the assessment recomputes the penalty from the due date, and a later review
   * can legitimately find a larger figure, but it must never quietly reduce what the borrower was
   * already told they owe.
   */
  async raiseChargeWith(
    handle: Pick<WriteHandle, 'runAsync'>,
    chargeId: string,
    amount: number,
    daysLate: number,
    periods: number
  ): Promise<void> {
    await handle.runAsync(
      `UPDATE penalty_charges
          SET amount = ?, days_late = ?, periods = ?, assessed_at = datetime('now')
        WHERE id = ?`,
      [amount, daysLate, periods, chargeId]
    );
  },

  /** Charges still collectable, oldest first. */
  async getOpenChargesForLoanWith(
    handle: Pick<WriteHandle, 'getAllAsync'>,
    loanId: string
  ): Promise<PenaltyCharge[]> {
    const rows = await handle.getAllAsync<PenaltyCharge>(
      `SELECT ${CHARGE_COLUMNS}
       FROM penalty_charges
       WHERE loan_id = ? AND waived_at IS NULL AND paid_amount < amount
       ORDER BY assessed_at ASC, installment_number ASC`,
      [loanId]
    );
    return rows.map(toCharge);
  },

  async getOpenChargesForLoan(loanId: string): Promise<PenaltyCharge[]> {
    const db = await getDatabase();
    return this.getOpenChargesForLoanWith(db, loanId);
  },

  /** Every charge on a loan, including fully paid and waived ones (statement history). */
  async getChargesForLoan(loanId: string): Promise<PenaltyCharge[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<PenaltyCharge>(
      `SELECT ${CHARGE_COLUMNS} FROM penalty_charges WHERE loan_id = ? ORDER BY assessed_at ASC`,
      [loanId]
    );
    return rows.map(toCharge);
  },

  async getAllChargesForBorrower(borrowerId: string): Promise<PenaltyCharge[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<PenaltyCharge>(
      `SELECT ${CHARGE_COLUMNS}
       FROM penalty_charges
       WHERE borrower_id = ?
       ORDER BY assessed_at DESC`,
      [borrowerId]
    );
    return rows.map(toCharge);
  },

  /** Records cash applied to a charge. Called from inside the payment transaction only. */
  async applyPaymentWith(
    handle: Pick<WriteHandle, 'runAsync'>,
    chargeId: string,
    newPaidAmount: number
  ): Promise<void> {
    await handle.runAsync(`UPDATE penalty_charges SET paid_amount = ? WHERE id = ?`, [
      newPaidAmount,
      chargeId,
    ]);
  },

  async waiveCharge(id: string, reason: string): Promise<void> {
    const db = await getDatabase();
    await this.waiveChargeWith(db, id, reason);
  },

  /** `txn`-aware variant: the waiver and its audit entry must share one transaction. */
  async waiveChargeWith(
    handle: Pick<WriteHandle, 'runAsync'>,
    id: string,
    reason: string
  ): Promise<void> {
    await handle.runAsync(
      `UPDATE penalty_charges SET waived_at = datetime('now'), waived_reason = ? WHERE id = ? AND waived_at IS NULL`,
      [reason, id]
    );
  },
};

