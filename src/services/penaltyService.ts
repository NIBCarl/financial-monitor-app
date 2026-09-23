import { getDatabase, runWriteTransaction } from '../db/client';
import { PenaltyCharge, PenaltyRule } from '../db/types';
import { penaltyRepo } from '../db/repositories/penaltyRepo';
import { auditRepo } from '../db/repositories/auditRepo';
import { canonicalMoney } from '../utils/money';
import { computePenalty } from '../utils/penalties';
import { daysBetweenDates, localTodayString, getScheduleRemaining } from '../utils/financial';

/**
 * Penalty assessment.
 *
 * A rule is a promise the treasury made in advance; this service is where it is applied to the
 * installments that are actually late. Assessment is **explicit** — the treasurer reviews a preview
 * and confirms — so a penalty never appears on someone's account as a surprise, and everything is
 * written in one transaction with an audit entry per change.
 *
 * Re-assessing is safe and idempotent: an installment already charged is skipped, and a charge is
 * only ever raised (never reduced) if more periods have elapsed since it was first assessed.
 */

export interface AssessmentLine {
  ruleId: string;
  rule: PenaltyRule;
  loanId: string;
  scheduleId: string;
  installmentNumber: number;
  dueDate: string;
  daysLate: number;
  periods: number;
  amount: number;
  /** True when this installment already has a charge that would simply grow. */
  isRaise: boolean;
  previousAmount: number;
}

export interface AssessmentPreview {
  lines: AssessmentLine[];
  /** Amount that would be newly recorded (a raise counts only the increase). */
  totalNewAmount: number;
  /** Total penalty standing on the account after assessing. */
  totalAfter: number;
}

interface RuleContext {
  loanId: string;
  borrowerId: string;
  schedules: {
    id: string;
    installmentNumber: number;
    dueDate: string;
    expectedAmount: number;
    paidAmount: number;
    status: string;
  }[];
}

/** Loans a rule applies to, with the installments that matter. */
async function getRuleContext(rule: PenaltyRule): Promise<RuleContext[]> {
  const db = await getDatabase();

  // A loan-scoped rule without a loan id cannot be resolved. Skipping it is safer than binding
  // `undefined` (which SQLite rejects) and it can only arise from a hand-edited database.
  const filterValue = rule.scope === 'LOAN' ? rule.loanId : rule.borrowerId;
  if (!filterValue) return [];

  const loans = await db.getAllAsync<{ id: string; borrowerId: string }>(
    rule.scope === 'LOAN'
      ? `SELECT id, borrower_id as borrowerId FROM loans WHERE id = ?`
      : `SELECT id, borrower_id as borrowerId FROM loans WHERE borrower_id = ? AND status != 'SETTLED'`,
    [filterValue]
  );

  const contexts: RuleContext[] = [];
  for (const loan of loans) {
    if (!loan?.id) continue;
    const schedules = await db.getAllAsync<RuleContext['schedules'][number]>(
      `SELECT
         id,
         installment_number as installmentNumber,
         due_date as dueDate,
         expected_amount as expectedAmount,
         paid_amount as paidAmount,
         status
       FROM loan_schedules
       WHERE loan_id = ? AND status != 'PAID'
       ORDER BY installment_number ASC`,
      [loan.id]
    );
    contexts.push({ loanId: loan.id, borrowerId: loan.borrowerId, schedules });
  }
  return contexts;
}

/**
 * Works out what assessing would do, without writing anything. Powers the confirm dialog and the
 * penalty figure shown on the borrower's profile.
 */
export async function previewAssessment(
  borrowerId: string,
  today = localTodayString()
): Promise<AssessmentPreview> {
  const rules = await penaltyRepo.getActiveRulesForBorrower(borrowerId);
  const lines: AssessmentLine[] = [];

  for (const rule of rules) {
    const contexts = await getRuleContext(rule);

    for (const context of contexts) {
      for (const schedule of context.schedules) {
        const daysLate = daysBetweenDates(schedule.dueDate, today);
        if (daysLate <= 0) continue;

        // The penalty is charged on the money that is actually late, not the whole installment.
        const overdueAmount = getScheduleRemaining(schedule);
        if (overdueAmount <= 0) continue;

        const computed = computePenalty(rule, overdueAmount, daysLate);
        if (computed.amount <= 0) continue;

        const existing = await penaltyRepo.findExistingCharge(rule.id, schedule.id);
        const previousAmount = existing ? existing.amount : 0;

        // Nothing to do when the charge is already at (or above) the recomputed figure.
        if (existing && computed.amount <= previousAmount) continue;

        lines.push({
          ruleId: rule.id,
          rule,
          loanId: context.loanId,
          scheduleId: schedule.id,
          installmentNumber: schedule.installmentNumber,
          dueDate: schedule.dueDate,
          daysLate,
          periods: computed.periods,
          amount: computed.amount,
          isRaise: Boolean(existing),
          previousAmount,
        });
      }
    }
  }

  const openCharges = await penaltyRepo.getAllChargesForBorrower(borrowerId);
  const totalNewAmount = canonicalMoney(
    lines.reduce(
      (sum, line) => sum + (line.isRaise ? line.amount - line.previousAmount : line.amount),
      0
    )
  );
  const existingOpen = canonicalMoney(
    openCharges
      .filter((c) => !c.waivedAt)
      .reduce((sum, c) => sum + Math.max(0, c.amount - c.paidAmount), 0)
  );

  return {
    lines,
    totalNewAmount,
    totalAfter: canonicalMoney(existingOpen + totalNewAmount),
  };
}

export interface AssessmentResult {
  created: number;
  raised: number;
  totalAmount: number;
}

/** Applies the preview for real: one transaction, one audit entry per charge. */
export async function assessPenalties(borrowerId: string): Promise<AssessmentResult> {
  const preview = await previewAssessment(borrowerId);

  const result: AssessmentResult = { created: 0, raised: 0, totalAmount: 0 };
  if (preview.lines.length === 0) return result;

  await runWriteTransaction(async (txn) => {
    for (const line of preview.lines) {
      if (line.isRaise) {
        const existing = await penaltyRepo.findExistingCharge(line.ruleId, line.scheduleId);
        if (!existing) continue;
        await penaltyRepo.raiseChargeWith(txn, existing.id, line.amount, line.daysLate, line.periods);
        await auditRepo.logWith(txn, {
          entity: 'penalty_charge',
          entityId: existing.id,
          action: 'UPDATE',
          reason: 'Additional penalty periods elapsed',
          before: { amount: line.previousAmount },
          after: { amount: line.amount, periods: line.periods, daysLate: line.daysLate },
        });
        result.raised += 1;
      } else {
        const chargeId = await penaltyRepo.createChargeWith(txn, {
          ruleId: line.ruleId,
          loanId: line.loanId,
          borrowerId,
          scheduleId: line.scheduleId,
          installmentNumber: line.installmentNumber,
          amount: line.amount,
          daysLate: line.daysLate,
          periods: line.periods,
        });
        await auditRepo.logWith(txn, {
          entity: 'penalty_charge',
          entityId: chargeId,
          action: 'CREATE',
          reason: `Penalty on installment #${line.installmentNumber} (${line.daysLate} days late)`,
          after: {
            amount: line.amount,
            periods: line.periods,
            ruleId: line.ruleId,
            scheduleId: line.scheduleId,
          },
        });
        result.created += 1;
      }
      result.totalAmount = canonicalMoney(result.totalAmount + line.amount);
    }
  });

  return result;
}

/** Outstanding penalty money for a borrower (open charges, after anything already paid). */
export async function getOpenPenaltyTotal(borrowerId: string): Promise<number> {
  const charges = await penaltyRepo.getAllChargesForBorrower(borrowerId);
  return canonicalMoney(
    charges
      .filter((c) => !c.waivedAt)
      .reduce((sum, c) => sum + Math.max(0, c.amount - c.paidAmount), 0)
  );
}

/** Waives a charge, with the reason recorded (a waiver is itself an auditable decision). */
export async function waiveCharge(charge: PenaltyCharge, reason: string): Promise<void> {
  await runWriteTransaction(async (txn) => {
    await penaltyRepo.waiveChargeWith(txn, charge.id, reason);
    await auditRepo.logWith(txn, {
      entity: 'penalty_charge',
      entityId: charge.id,
      action: 'WAIVE',
      reason,
      before: { amount: charge.amount, paidAmount: charge.paidAmount },
      after: { waived: true },
    });
  });
}

/** Waives a rule so it stops applying from now on. Charges already assessed are untouched. */
export async function waiveRule(rule: PenaltyRule, reason: string): Promise<void> {
  await runWriteTransaction(async (txn) => {
    await penaltyRepo.waiveRuleWith(txn, rule.id, reason);
    await auditRepo.logWith(txn, {
      entity: 'penalty_rule',
      entityId: rule.id,
      action: 'WAIVE',
      reason,
      before: {
        basis: rule.basis,
        amount: rule.amount,
        period: rule.period,
        graceDays: rule.graceDays,
      },
      after: { waived: true },
    });
  });
}

