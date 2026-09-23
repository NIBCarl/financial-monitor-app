import { getDatabase } from '../client';
import { round2 } from '../../utils/validation';
import { daysBetweenDates, localTodayString } from '../../utils/financial';

/**
 * Reporting queries: how old the arrears are, how much of the book is at risk, what should
 * come in next, and who needs reminding.
 *
 * All of it is derived from `loan_schedules` (the source of truth for what is owed and when)
 * rather than from cached columns, so these figures stay honest even if a status flag drifts.
 */

/** Buckets used by the aging schedule. `CURRENT` is not-yet-due; the rest are days late. */
export type AgingBucket = 'CURRENT' | 'DUE_SOON' | '1-30' | '31-60' | '61-90' | '90+';

export interface AgingRow {
  bucket: AgingBucket;
  installmentCount: number;
  borrowerCount: number;
  amount: number;
}

export interface PortfolioRisk {
  /** Outstanding principal on loans that have at least one overdue installment. */
  atRiskAmount: number;
  /** Outstanding principal across all active loans. */
  totalOutstanding: number;
  /** `atRiskAmount / totalOutstanding` as a percentage (0 when the book is empty). */
  parPercent: number;
  /** Active loans with at least one overdue installment. */
  atRiskLoanCount: number;
  activeLoanCount: number;
}

export interface ForecastRow {
  /** `YYYY-MM` */
  period: string;
  expected: number;
  installmentCount: number;
}

export interface DueItem {
  scheduleId: string;
  loanId: string;
  borrowerId: string;
  borrowerName: string;
  borrowerPhone: string;
  dueDate: string;
  amountDue: number;
  daysLate: number;
}

const AGING_ORDER: AgingBucket[] = ['DUE_SOON', '1-30', '31-60', '61-90', '90+', 'CURRENT'];

/** Days between a `YYYY-MM-DD` due date and today (positive = late). */
export function daysLateFor(dueDate: string, today: string = localTodayString()): number {
  return daysBetweenDates(dueDate, today);
}

/** Local calendar date as `YYYY-MM-DD` — matches the `due_date` column's format. */
export function localToday(): string {
  return localTodayString();
}


export const reportsRepo = {
  /**
   * Aging schedule: unpaid installments grouped by how late they are.
   *
   * `DUE_SOON` is the next 7 days and `CURRENT` is everything due later — shown alongside the
   * arrears so the treasurer sees the whole pipeline, not just the problem.
   */
  async getAgingSchedule(soonDays: number = 7): Promise<AgingRow[]> {
    const db = await getDatabase();

    const overdue = await db.getAllAsync<{
      bucket: string;
      installmentCount: number;
      borrowerCount: number;
      amount: number;
    }>(
      `SELECT
        CASE
          WHEN CAST(julianday(date('now', 'localtime')) - julianday(s.due_date) AS INTEGER) <= 30 THEN '1-30'
          WHEN CAST(julianday(date('now', 'localtime')) - julianday(s.due_date) AS INTEGER) <= 60 THEN '31-60'
          WHEN CAST(julianday(date('now', 'localtime')) - julianday(s.due_date) AS INTEGER) <= 90 THEN '61-90'
          ELSE '90+'
        END as bucket,
        COUNT(*) as installmentCount,
        COUNT(DISTINCT l.borrower_id) as borrowerCount,
        COALESCE(SUM(s.expected_amount - s.paid_amount), 0) as amount
      FROM loan_schedules s
      JOIN loans l ON l.id = s.loan_id
      WHERE s.status != 'PAID'
        AND s.expected_amount > s.paid_amount
        AND s.due_date < date('now', 'localtime')
      GROUP BY bucket`
    );

    const upcoming = await db.getAllAsync<{
      bucket: string;
      installmentCount: number;
      borrowerCount: number;
      amount: number;
    }>(
      `SELECT
        CASE WHEN s.due_date <= date('now', 'localtime', ?) THEN 'DUE_SOON' ELSE 'CURRENT' END as bucket,
        COUNT(*) as installmentCount,
        COUNT(DISTINCT l.borrower_id) as borrowerCount,
        COALESCE(SUM(s.expected_amount - s.paid_amount), 0) as amount
      FROM loan_schedules s
      JOIN loans l ON l.id = s.loan_id
      WHERE s.status != 'PAID'
        AND s.expected_amount > s.paid_amount
        AND s.due_date >= date('now', 'localtime')
      GROUP BY bucket`,
      [`+${soonDays} day`]
    );

    const byBucket = new Map<string, AgingRow>();
    for (const row of [...overdue, ...upcoming]) {
      byBucket.set(row.bucket, {
        bucket: row.bucket as AgingBucket,
        installmentCount: Number(row.installmentCount ?? 0),
        borrowerCount: Number(row.borrowerCount ?? 0),
        amount: round2(Number(row.amount ?? 0)),
      });
    }

    return AGING_ORDER.map(
      (bucket) => byBucket.get(bucket) ?? { bucket, installmentCount: 0, borrowerCount: 0, amount: 0 }
    );
  },

  /** Portfolio at risk: the share of the outstanding book that is behind. */
  async getPortfolioRisk(): Promise<PortfolioRisk> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{
      atRiskAmount: number;
      totalOutstanding: number;
      atRiskLoanCount: number;
      activeLoanCount: number;
    }>(`
      SELECT
        COALESCE(SUM(CASE WHEN risk.id IS NOT NULL THEN l.remaining_balance ELSE 0 END), 0) as atRiskAmount,
        COALESCE(SUM(l.remaining_balance), 0) as totalOutstanding,
        COALESCE(SUM(CASE WHEN risk.id IS NOT NULL THEN 1 ELSE 0 END), 0) as atRiskLoanCount,
        COUNT(*) as activeLoanCount
      FROM loans l
      LEFT JOIN (
        SELECT DISTINCT loan_id as id
        FROM loan_schedules
        WHERE status != 'PAID'
          AND expected_amount > paid_amount
          AND due_date < date('now', 'localtime')
      ) risk ON risk.id = l.id
      WHERE l.status IN ('ACTIVE', 'OVERDUE')
    `);

    const totalOutstanding = round2(Number(row?.totalOutstanding ?? 0));
    const atRiskAmount = round2(Number(row?.atRiskAmount ?? 0));

    return {
      atRiskAmount,
      totalOutstanding,
      parPercent: totalOutstanding > 0 ? round2((atRiskAmount / totalOutstanding) * 100) : 0,
      atRiskLoanCount: Number(row?.atRiskLoanCount ?? 0),
      activeLoanCount: Number(row?.activeLoanCount ?? 0),
    };
  },

  /**
   * Expected collections for the next `months` months, straight from the installment schedule.
   *
   * Overdue amounts are deliberately excluded — they appear as their own line in the UI, so a
   * hope of catch-up is never mistaken for a scheduled inflow.
   */
  async getForecast(months: number = 3): Promise<ForecastRow[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<{ period: string; expected: number; installmentCount: number }>(
      `SELECT
        strftime('%Y-%m', s.due_date) as period,
        COALESCE(SUM(s.expected_amount - s.paid_amount), 0) as expected,
        COUNT(*) as installmentCount
      FROM loan_schedules s
      WHERE s.status != 'PAID'
        AND s.expected_amount > s.paid_amount
        AND s.due_date >= date('now', 'localtime')
      GROUP BY period
      ORDER BY period ASC
      LIMIT ?`,
      [months]
    );
    return rows.map((r) => ({
      period: r.period,
      expected: round2(Number(r.expected ?? 0)),
      installmentCount: Number(r.installmentCount ?? 0),
    }));
  },

  /** One row per unpaid installment due within `withinDays` (0 = overdue only), oldest first. */
  async getDueItems(withinDays: number = 7): Promise<DueItem[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<{
      scheduleId: string;
      loanId: string;
      borrowerId: string;
      borrowerName: string;
      borrowerPhone: string;
      dueDate: string;
      amountDue: number;
    }>(
      `SELECT
        s.id as scheduleId,
        l.id as loanId,
        b.id as borrowerId,
        b.full_name as borrowerName,
        b.phone_number as borrowerPhone,
        s.due_date as dueDate,
        (s.expected_amount - s.paid_amount) as amountDue
      FROM loan_schedules s
      JOIN loans l ON l.id = s.loan_id
      JOIN borrowers b ON b.id = l.borrower_id
      WHERE s.status != 'PAID'
        AND s.expected_amount > s.paid_amount
        AND s.due_date <= date('now', 'localtime', ?)
      ORDER BY s.due_date ASC`,
      [`+${withinDays} day`]
    );

    const today = localToday();
    return rows.map((r) => ({
      scheduleId: r.scheduleId,
      loanId: r.loanId,
      borrowerId: r.borrowerId,
      borrowerName: r.borrowerName,
      borrowerPhone: r.borrowerPhone,
      dueDate: r.dueDate,
      amountDue: round2(Number(r.amountDue ?? 0)),
      daysLate: daysLateFor(r.dueDate, today),
    }));
  },
};
