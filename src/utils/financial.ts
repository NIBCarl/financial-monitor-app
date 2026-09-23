import { addDays, addWeeks, addMonths, format, parseISO, isBefore, startOfDay, differenceInCalendarDays } from 'date-fns';
import { InterestType, LoanSchedule, RepaymentFrequency, ScheduleStatus } from '../db/types';
import {
  fromCents,
  percentOfCents,
  roundHalfAwayFromZero,
  splitCents,
  toCents,
} from './money';

export interface CalculatedInstallment {
  installmentNumber: number;
  dueDate: string;
  expectedAmount: number;
}

export interface CalculationResult {
  principal: number;
  interestAmount: number;
  totalPayable: number;
  installmentAmount: number;
  /** Effective number of schedules generated (LUMP_SUM always yields 1). */
  termCount: number;
  installments: CalculatedInstallment[];
}

export function calculateAmortization(params: {
  principal: number;
  interestRate: number; // percentage, e.g. 5 for 5%
  interestType: InterestType;
  frequency: RepaymentFrequency;
  termCount: number;
  startDate: Date | string;
}): CalculationResult {
  const { principal, interestRate, interestType, frequency, termCount, startDate } = params;

  const start = typeof startDate === 'string' ? parseISO(startDate) : startDate;
  // A lump-sum loan is settled by a single payment, regardless of the requested term count.
  const effectiveTermCount = frequency === 'LUMP_SUM' ? 1 : Math.max(1, Math.trunc(termCount));

  // Everything below runs on whole centavos so the schedule sums exactly to the total payable.
  const principalCents = toCents(principal);
  let interestCents = 0;

  if (interestType === 'FLAT') {
    interestCents = percentOfCents(principalCents, interestRate);
  } else if (interestType === 'MONTHLY_SIMPLE') {
    // Interest accrues per month; the term is expressed in months for the chosen frequency.
    let months = 1;
    if (frequency === 'WEEKLY') months = effectiveTermCount / 4;
    else if (frequency === 'BI_WEEKLY') months = effectiveTermCount / 2;
    else if (frequency === 'MONTHLY') months = effectiveTermCount;
    else if (frequency === 'DAILY') months = effectiveTermCount / 30;
    interestCents = roundHalfAwayFromZero(principalCents * (interestRate / 100) * Math.max(1, months));
  }

  const totalPayableCents = principalCents + interestCents;
  const installmentAmounts = splitCents(totalPayableCents, effectiveTermCount);

  const installments: CalculatedInstallment[] = [];

  for (let i = 1; i <= effectiveTermCount; i++) {
    let dueDate: Date;
    switch (frequency) {
      case 'DAILY':
        dueDate = addDays(start, i);
        break;
      case 'WEEKLY':
        dueDate = addWeeks(start, i);
        break;
      case 'BI_WEEKLY':
        dueDate = addWeeks(start, i * 2);
        break;
      case 'MONTHLY':
        dueDate = addMonths(start, i);
        break;
      case 'LUMP_SUM':
      default:
        // Settled one month after disbursement (single installment).
        dueDate = addMonths(start, 1);
        break;
    }

    installments.push({
      installmentNumber: i,
      dueDate: format(dueDate, 'yyyy-MM-dd'),
      expectedAmount: fromCents(installmentAmounts[i - 1]),
    });
  }

  return {
    principal,
    interestAmount: fromCents(interestCents),
    totalPayable: fromCents(totalPayableCents),
    installmentAmount: fromCents(installmentAmounts[0] ?? 0),
    termCount: effectiveTermCount,
    installments,
  };
}

export function formatCurrency(amount: number, symbol: string = '₱'): string {
  if (isNaN(amount)) return `${symbol}0.00`;
  return `${symbol}${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDatePretty(dateString: string): string {
  try {
    const d = parseISO(dateString);
    return format(d, 'MMM dd, yyyy');
  } catch {
    return dateString;
  }
}

/**
 * Parses a timestamp the way SQLite stores it.
 *
 * SQLite `datetime('now')` produces UTC as "YYYY-MM-DD HH:MM:SS" with no zone marker,
 * which `parseISO` would read as *local* time (skewing every record by the device's
 * UTC offset). This normalises both storage formats —
 * "YYYY-MM-DD HH:MM:SS" (UTC) and "YYYY-MM-DDTHH:MM:SS.sssZ" — into the real moment.
 */
export function parseDbTimestamp(value: string): Date {
  if (!value) return new Date();

  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const parsed = new Date(hasZone ? normalized : `${normalized}Z`);

  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** Formats a stored DB date in the device's local timezone. */
export function formatDbDate(value: string, pattern: string = 'MMM dd, yyyy'): string {
  try {
    return format(parseDbTimestamp(value), pattern);
  } catch {
    return value;
  }
}

/** Formats a stored DB timestamp (date + time) in the device's local timezone. */
export function formatDbDateTime(value: string, pattern: string = 'MMM dd, yyyy • h:mm a'): string {
  return formatDbDate(value, pattern);
}

export function checkIsOverdue(dueDateString: string): boolean {
  try {
    const due = startOfDay(parseISO(dueDateString));
    const today = startOfDay(new Date());
    return isBefore(due, today);
  } catch {
    return false;
  }
}

export function checkIsDueToday(dueDateString: string): boolean {
  try {
    const due = format(parseISO(dueDateString), 'yyyy-MM-dd');
    const today = format(new Date(), 'yyyy-MM-dd');
    return due === today;
  } catch {
    return false;
  }
}

/** A schedule is overdue when it is not fully paid and its due date has passed. */
export function isScheduleOverdue(schedule: Pick<LoanSchedule, 'status' | 'dueDate'>): boolean {
  return schedule.status !== 'PAID' && checkIsOverdue(schedule.dueDate);
}

/** Whole days a due date is late (0 when not late yet). */
export function getDaysLate(dueDateString: string): number {
  try {
    const due = startOfDay(parseISO(dueDateString));
    const today = startOfDay(new Date());
    const days = differenceInCalendarDays(today, due);
    return days > 0 ? days : 0;
  } catch {
    return 0;
  }
}

/** Today's local calendar date as `YYYY-MM-DD` — the format `due_date` is stored in. */
export function localTodayString(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Signed day difference between two calendar dates (positive when `dueDate` is in the past).
 *
 * Unlike `getDaysLate` this takes "today" as an argument, which makes it testable and lets the
 * SQL-side buckets and the TypeScript-side pills agree on the same date.
 */
export function daysBetweenDates(dueDate: string, today: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.round((now - due) / 86400000);
}

/** Outstanding amount of a single installment (never negative). */
export function getScheduleRemaining(schedule: Pick<LoanSchedule, 'expectedAmount' | 'paidAmount'>): number {
  const expectedCents = toCents(schedule.expectedAmount);
  const paidCents = toCents(schedule.paidAmount);
  return fromCents(Math.max(0, expectedCents - paidCents));
}

/** Outstanding amount of a single installment, in centavos (used by the money paths). */
export function getScheduleRemainingCents(
  schedule: Pick<LoanSchedule, 'expectedAmount' | 'paidAmount'>
): number {
  return Math.max(0, toCents(schedule.expectedAmount) - toCents(schedule.paidAmount));
}

/** Next installment the borrower still owes, in schedule order (null when settled). */
export function getNextUnpaidSchedule(schedules: LoanSchedule[]): LoanSchedule | null {
  const pending = schedules
    .filter((s) => s.status !== 'PAID' && getScheduleRemaining(s) > 0)
    .sort((a, b) => a.installmentNumber - b.installmentNumber);
  return pending.length > 0 ? pending[0] : null;
}

export interface PaymentAllocation {
  scheduleId: string;
  installmentNumber: number;
  appliedAmount: number;
  newPaidAmount: number;
  newStatus: ScheduleStatus;
}

export interface AllocationResult {
  allocations: PaymentAllocation[];
  /** Cash that could not be applied to an installment (only possible on drifted legacy data). */
  unallocated: number;
}

/**
 * Applies a payment to the oldest unpaid installments first (FIFO waterfall),
 * returning the exact row values to persist. Pure function: no I/O.
 *
 * Example: 4 x 2,625.00 installments, payment of 5,000.00
 *   -> installment 1 fully paid (2,625) + installment 2 partial (2,375)
 */
export function allocatePayment(schedules: LoanSchedule[], amount: number): AllocationResult {
  const allocations: PaymentAllocation[] = [];
  let remainingCents = toCents(amount);

  const ordered = [...schedules].sort((a, b) => a.installmentNumber - b.installmentNumber);

  for (const schedule of ordered) {
    if (remainingCents <= 0) break;
    if (schedule.status === 'PAID') continue;

    const dueCents = getScheduleRemainingCents(schedule);
    if (dueCents <= 0) continue;

    const appliedCents = Math.min(dueCents, remainingCents);
    const newPaidCents = toCents(schedule.paidAmount) + appliedCents;
    const newStatus: ScheduleStatus = newPaidCents >= toCents(schedule.expectedAmount) ? 'PAID' : 'PARTIAL';

    allocations.push({
      scheduleId: schedule.id,
      installmentNumber: schedule.installmentNumber,
      appliedAmount: fromCents(appliedCents),
      newPaidAmount: fromCents(newPaidCents),
      newStatus,
    });

    remainingCents -= appliedCents;
  }

  return { allocations, unallocated: remainingCents > 0 ? fromCents(remainingCents) : 0 };
}

/**
 * Returns a copy of `schedules` with a FIFO allocation already applied, so callers can
 * derive the post-payment state (next due date, outstanding total) without re-reading
 * the database inside the transaction.
 */
/**
 * Returns a copy of `schedules` with a FIFO allocation already applied, so callers can
 * derive the post-payment state (next due date, outstanding total) without re-reading
 * the database inside the transaction.
 */
export function applyAllocationsToSchedules(
  schedules: LoanSchedule[],
  allocations: PaymentAllocation[]
): LoanSchedule[] {
  if (allocations.length === 0) return schedules;

  const byScheduleId = new Map(allocations.map((a) => [a.scheduleId, a]));

  return schedules.map((schedule) => {
    const allocation = byScheduleId.get(schedule.id);
    if (!allocation) return schedule;
    return {
      ...schedule,
      paidAmount: allocation.newPaidAmount,
      status: allocation.newStatus,
    };
  });
}

export interface RebuiltScheduleState {
  scheduleId: string;
  paidAmount: number;
  status: ScheduleStatus;
  /** When this installment was completed (set from the payment that filled it). */
  settledDate: string | null;
}

export interface ScheduleRebuild {
  states: RebuiltScheduleState[];
  /** Cash that was successfully applied to installments. */
  totalApplied: number;
  /** Cash that could not be applied (only possible on legacy/over-paid data). */
  unallocated: number;
}

/**
 * Rebuilds installment state from scratch by replaying the surviving payments in
 * chronological order through the same FIFO waterfall used when recording them.
 *
 * Used when a payment is voided: instead of trying to "subtract" the payment (which cannot
 * say which installments it had filled once later payments exist), the whole allocation is
 * recomputed. That is deterministic, idempotent, and self-heals any past drift.
 */
export function rebuildScheduleStates(
  schedules: LoanSchedule[],
  payments: { amountPaid: number; paidAt: string; id: string }[]
): ScheduleRebuild {
  let working: LoanSchedule[] = schedules.map((schedule) => ({
    ...schedule,
    paidAmount: 0,
    status: 'PENDING' as ScheduleStatus,
    settledDate: null,
  }));

  const settledDates = new Map<string, string>();
  const ordered = [...payments].sort((a, b) =>
    a.paidAt === b.paidAt ? a.id.localeCompare(b.id) : a.paidAt < b.paidAt ? -1 : 1
  );

  let totalAppliedCents = 0;
  let unallocatedCents = 0;

  for (const payment of ordered) {
    const before = new Map(working.map((s) => [s.id, s.status]));
    const { allocations, unallocated: leftover } = allocatePayment(working, payment.amountPaid);

    working = applyAllocationsToSchedules(working, allocations);

    for (const schedule of working) {
      // Record the date the installment was completed by *this* payment.
      if (before.get(schedule.id) !== 'PAID' && schedule.status === 'PAID' && !settledDates.has(schedule.id)) {
        settledDates.set(schedule.id, payment.paidAt);
      }
    }

    totalAppliedCents += toCents(payment.amountPaid) - toCents(leftover);
    unallocatedCents += toCents(leftover);
  }

  return {
    states: working.map((schedule) => ({
      scheduleId: schedule.id,
      paidAmount: schedule.paidAmount,
      status: schedule.status,
      settledDate: settledDates.get(schedule.id) ?? null,
    })),
    totalApplied: fromCents(totalAppliedCents),
    unallocated: fromCents(unallocatedCents),
  };
}
