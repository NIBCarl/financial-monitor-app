import { fromCents, percentOfCents, toCents } from './money';

/**
 * Penalty arithmetic — pure, so the harness can prove the rules the treasurer configured are the
 * rules the app applies.
 *
 * A rule says three things: how much (`FLAT` pesos or `PERCENT` of the overdue installment), how
 * often it is charged while the installment stays unpaid (`DAY` / `WEEK` / `MONTH`), and how many
 * days of grace come first. An optional cap limits what one installment can accrue.
 *
 * Worked example: ₱2,625 installment, 17 days late, rule = 2% per week after 3 days grace
 *   -> 17 - 3 = 14 chargeable days -> floor(14 / 7) = 2 periods -> 2% x 2 = 4% of ₱2,625 = ₱105.00
 */

export type PenaltyPeriodLike = 'DAY' | 'WEEK' | 'MONTH';
export type PenaltyBasisLike = 'FLAT' | 'PERCENT';

export interface PenaltyRuleLike {
  basis: PenaltyBasisLike;
  /** Pesos for FLAT, percent for PERCENT. */
  amount: number;
  period: PenaltyPeriodLike;
  graceDays: number;
  /** Optional peso ceiling for a single installment's penalty. */
  capAmount?: number | null;
}

export interface PenaltyComputation {
  /** Charged amount in pesos (0 when still inside the grace period). */
  amount: number;
  /** Whole periods charged. */
  periods: number;
  /** Days counted after the grace period was applied. */
  chargeableDays: number;
}

/** Days in one period, used to convert lateness into whole periods. */
const PERIOD_DAYS: Record<PenaltyPeriodLike, number> = {
  DAY: 1,
  WEEK: 7,
  MONTH: 30,
};

export const PENALTY_PERIOD_LABEL: Record<PenaltyPeriodLike, string> = {
  DAY: 'per day',
  WEEK: 'per week',
  MONTH: 'per month',
};

/**
 * Computes one installment's penalty.
 *
 * `daysLate` is measured from the due date; the grace period is subtracted first. Periods are
 * **whole** — a rule of "per week" charges nothing extra on day 8 of week two, and it never charges
 * a partial period, so the amount is reproducible and explainable to the borrower.
 */
export function computePenalty(
  rule: PenaltyRuleLike,
  installmentDue: number,
  daysLate: number
): PenaltyComputation {
  const graceDays = Math.max(0, Math.trunc(rule.graceDays || 0));
  const chargeableDays = Math.max(0, daysLate - graceDays);
  const periods = Math.floor(chargeableDays / PERIOD_DAYS[rule.period]);

  if (periods <= 0) {
    return { amount: 0, periods: 0, chargeableDays };
  }

  const dueCents = toCents(installmentDue);
  const perPeriodCents =
    rule.basis === 'FLAT' ? toCents(rule.amount) : percentOfCents(dueCents, rule.amount);

  let totalCents = perPeriodCents * periods;

  if (rule.capAmount !== null && rule.capAmount !== undefined) {
    const capCents = toCents(rule.capAmount);
    if (capCents >= 0 && totalCents > capCents) totalCents = capCents;
  }

  return { amount: fromCents(totalCents), periods, chargeableDays };
}

/**
 * Splits leftover payment cash across open penalty charges, oldest first.
 *
 * Kept pure and separate from the payment transaction so the allocation itself can be exercised by
 * the verification harness: the risk here is a centavo vanishing (or being double-counted) when a
 * payment straddles the last installment and a fine.
 */
export function splitPaymentAcrossCharges(
  unallocated: number,
  charges: { id: string; amount: number; paidAmount: number }[]
): { penaltyApplied: number; leftover: number; updates: { id: string; newPaidAmount: number }[] } {
  let remaining = toCents(unallocated);
  let penaltyAppliedCents = 0;
  const updates: { id: string; newPaidAmount: number }[] = [];

  for (const charge of charges) {
    if (remaining <= 0) break;

    const outstandingCents = Math.max(0, toCents(charge.amount) - toCents(charge.paidAmount));
    if (outstandingCents <= 0) continue;

    const appliedCents = Math.min(outstandingCents, remaining);
    updates.push({ id: charge.id, newPaidAmount: fromCents(toCents(charge.paidAmount) + appliedCents) });
    penaltyAppliedCents += appliedCents;
    remaining -= appliedCents;
  }

  return {
    penaltyApplied: fromCents(penaltyAppliedCents),
    leftover: fromCents(remaining),
    updates,
  };
}

/** Human-readable rule, e.g. "2% per week after 3 days grace (cap PHP 200.00)". */
export function describePenaltyRule(
  rule: PenaltyRuleLike,
  currencySymbol: string
): string {
  const per =
    rule.basis === 'FLAT'
      ? `${currencySymbol}${rule.amount.toFixed(2)}`
      : `${rule.amount}% of the installment`;
  const grace = rule.graceDays > 0 ? ` after ${rule.graceDays} day${rule.graceDays === 1 ? '' : 's'} grace` : '';
  const cap =
    rule.capAmount !== null && rule.capAmount !== undefined
      ? ` (cap ${currencySymbol}${rule.capAmount.toFixed(2)})`
      : '';
  return `${per} ${PENALTY_PERIOD_LABEL[rule.period]}${grace}${cap}`;
}
