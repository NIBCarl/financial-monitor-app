import { getDatabase, runWriteTransaction } from '../client';
import { CollectionSummary, LoanPayment, LoanSchedule, PaymentMethod } from '../types';
import {
  allocatePayment,
  applyAllocationsToSchedules,
  getNextUnpaidSchedule,
  getScheduleRemaining,
  rebuildScheduleStates,
} from '../../utils/financial';
import { canonicalMoney } from '../../utils/money';
import { splitPaymentAcrossCharges } from '../../utils/penalties';
import { auditRepo } from './auditRepo';
import { penaltyRepo } from './penaltyRepo';

/** Money comparisons tolerate half a cent so 2-decimal rounding can never block a full settlement. */
const MONEY_EPSILON = 0.004;

export interface RecordPaymentInput {
  loanId: string;
  /** Installment the treasurer tapped; allocation itself always uses the FIFO waterfall. */
  scheduleId?: string;
  amountPaid: number;
  paymentMethod: PaymentMethod;
  referenceNo?: string;
  notes?: string;
}

export interface RecordPaymentResult {
  payment: LoanPayment;
  /** Authoritative balance after the payment (from the write path, not client state). */
  remainingBalance: number;
  /** Next installment still owed, or null when the loan is settled. */
  nextDueDate: string | null;
  nextDueAmount: number | null;
  settled: boolean;
  /** Which installments the cash was applied to, oldest first. */
  allocations: { installmentNumber: number; amount: number }[];
  /** Cash that could not be applied to any installment (legacy drifted data only). */
  unallocated: number;
  /** Of the payment, how much went to assessed penalties rather than installments. */
  penaltyPaid: number;
}

const SCHEDULE_COLUMNS = `
  id,
  loan_id as loanId,
  installment_number as installmentNumber,
  due_date as dueDate,
  expected_amount as expectedAmount,
  paid_amount as paidAmount,
  status,
  settled_date as settledDate
`;

export const paymentRepo = {
  /**
   * Records a repayment and keeps every dependent row consistent inside one exclusive
   * transaction:
   *   1. rejects amounts above the outstanding balance (no overstated cash),
   *   2. inserts the payment,
   *   3. applies the cash to the oldest unpaid installments (FIFO waterfall),
   *   4. updates the loan balance/status,
   *   5. writes the matching ledger inflow,
   *   6. returns the authoritative balance + next due date for the receipt.
   */
  async recordPayment(input: RecordPaymentInput): Promise<RecordPaymentResult> {
    const amount = canonicalMoney(input.amountPaid);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Payment amount must be greater than zero.');
    }

    const holder: { value: RecordPaymentResult | null } = { value: null };

    await runWriteTransaction(async (txn) => {
      const loan = await txn.getFirstAsync<{ remaining_balance: number; status: string }>(
        `SELECT remaining_balance, status FROM loans WHERE id = ?`,
        [input.loanId]
      );

      if (!loan) {
        throw new Error('Loan not found.');
      }
      if (loan.status === 'SETTLED') {
        throw new Error('This loan is already fully settled.');
      }

      const outstanding = canonicalMoney(loan.remaining_balance);

      // Assessed penalties are collectable alongside the balance, so the ceiling is both together.
      const openCharges = await penaltyRepo.getOpenChargesForLoanWith(txn, input.loanId);
      const openPenaltyTotal = canonicalMoney(
        openCharges.reduce((sum, charge) => sum + Math.max(0, charge.amount - charge.paidAmount), 0)
      );

      if (outstanding <= MONEY_EPSILON && openPenaltyTotal <= MONEY_EPSILON) {
        throw new Error('This loan has no outstanding balance.');
      }

      const collectable = canonicalMoney(outstanding + openPenaltyTotal);
      if (amount > collectable + MONEY_EPSILON) {
        throw new Error(
          `Payment cannot exceed ${collectable.toFixed(2)} (balance plus outstanding penalties). Please enter a smaller amount.`
        );
      }

      const schedules = await txn.getAllAsync<LoanSchedule>(
        `SELECT ${SCHEDULE_COLUMNS} FROM loan_schedules WHERE loan_id = ? ORDER BY installment_number ASC`,
        [input.loanId]
      );

      const { allocations, unallocated } = allocatePayment(schedules, amount);

      const paymentId = 'pay_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      const primaryScheduleId = allocations[0]?.scheduleId ?? input.scheduleId ?? null;

      await txn.runAsync(
        `INSERT INTO loan_payments (
          id, loan_id, schedule_id, amount_paid, payment_method, reference_no, notes, paid_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          paymentId,
          input.loanId,
          primaryScheduleId,
          amount,
          input.paymentMethod,
          input.referenceNo || null,
          input.notes || null,
        ]
      );

      for (const allocation of allocations) {
        await txn.runAsync(
          `UPDATE loan_schedules
              SET paid_amount = ?,
                  status = ?,
                  settled_date = CASE WHEN ? = 'PAID' THEN datetime('now') ELSE settled_date END
            WHERE id = ?`,
          [allocation.newPaidAmount, allocation.newStatus, allocation.newStatus, allocation.scheduleId]
        );
      }

      // Any cash left after the installments goes to assessed penalties, oldest first, before it
      // can be treated as unapplied credit — otherwise a treasurer collecting "balance + fine"
      // would see the fine money sitting as a credit while the penalty stayed open. The allocation
      // itself is a pure function so the harness can prove the centavos add up.
      const penaltySplit = splitPaymentAcrossCharges(
        unallocated,
        openCharges.map((charge) => ({
          id: charge.id,
          amount: charge.amount,
          paidAmount: charge.paidAmount,
        }))
      );
      const penaltyApplied = penaltySplit.penaltyApplied;

      for (const update of penaltySplit.updates) {
        await penaltyRepo.applyPaymentWith(txn, update.id, update.newPaidAmount);
      }

      const remainingAfterPayment = canonicalMoney(outstanding - (amount - penaltyApplied));
      const settled = remainingAfterPayment <= MONEY_EPSILON;
      const persistedBalance = settled ? 0 : remainingAfterPayment;

      await txn.runAsync(`UPDATE loans SET remaining_balance = ?, status = ? WHERE id = ?`, [
        persistedBalance,
        settled ? 'SETTLED' : 'ACTIVE',
        input.loanId,
      ]);

      const leftoverCredit = penaltySplit.leftover;
      const unappliedNote =
        leftoverCredit > 0 ? ` — ${leftoverCredit.toFixed(2)} held as unapplied credit` : '';

      // The ledger is split so the cash reconciles: installment money under LOAN_REPAYMENT and
      // penalty money under PENALTY. A single row would mislabel one of them.
      const repaymentPortion = canonicalMoney(amount - penaltyApplied);
      if (repaymentPortion > MONEY_EPSILON || penaltyApplied <= MONEY_EPSILON) {
        await txn.runAsync(
          `INSERT INTO ledger_transactions (
            id, type, category, amount, description, related_loan_id, transaction_date
          ) VALUES (?, 'INFLOW', 'LOAN_REPAYMENT', ?, ?, ?, datetime('now'))`,
          [
            'tx_pay_' + paymentId,
            repaymentPortion,
            `Loan repayment received (${input.paymentMethod})${unappliedNote}`,
            input.loanId,
          ]
        );
      }

      if (penaltyApplied > MONEY_EPSILON) {
        await txn.runAsync(
          `INSERT INTO ledger_transactions (
            id, type, category, amount, description, related_loan_id, transaction_date
          ) VALUES (?, 'INFLOW', 'PENALTY', ?, ?, ?, datetime('now'))`,
          [
            'tx_pen_' + paymentId,
            penaltyApplied,
            `Penalty collected with payment (${input.paymentMethod})`,
            input.loanId,
          ]
        );
      }

      const stored = await txn.getFirstAsync<{ paid_at: string }>(
        `SELECT paid_at FROM loan_payments WHERE id = ?`,
        [paymentId]
      );

      const updatedSchedules = applyAllocationsToSchedules(schedules, allocations);
      const nextDue = settled ? null : getNextUnpaidSchedule(updatedSchedules);

      const paidAtValue = stored?.paid_at ?? new Date().toISOString();

      // Audit trail: every money movement is recorded with a reason slot for later changes.
      await auditRepo.logWith(txn, {
        entity: 'loan_payment',
        entityId: paymentId,
        action: 'CREATE',
        after: {
          loanId: input.loanId,
          amountPaid: amount,
          paymentMethod: input.paymentMethod,
          paidAt: paidAtValue,
          remainingBalance: persistedBalance,
          penaltyPaid: penaltyApplied,
        },
      });

      holder.value = {
        payment: {
          id: paymentId,
          loanId: input.loanId,
          scheduleId: primaryScheduleId,
          amountPaid: amount,
          paymentMethod: input.paymentMethod,
          referenceNo: input.referenceNo || null,
          notes: input.notes || null,
          paidAt: paidAtValue,
          voidedAt: null,
          voidReason: null,
        },
        remainingBalance: persistedBalance,
        nextDueDate: nextDue?.dueDate ?? null,
        nextDueAmount: nextDue ? getScheduleRemaining(nextDue) : null,
        settled,
        allocations: allocations.map((a) => ({
          installmentNumber: a.installmentNumber,
          amount: a.appliedAmount,
        })),
        unallocated: leftoverCredit,
        penaltyPaid: penaltyApplied,
      };
    });

    if (!holder.value) {
      throw new Error('Failed to record payment.');
    }
    return holder.value;
  },

  /**
   * Reverses a payment without deleting anything.
   *
   * 1. flags the payment as voided (kept forever, excluded from totals),
   * 2. flags its ledger inflow as voided,
   * 3. rebuilds every installment of the loan by replaying the surviving payments,
   * 4. recomputes the loan balance from `total_payable − sum(surviving payments)`,
   * 5. writes the loan/payment back and records an audit entry with the reason.
   *
   * To *correct* an amount, void the wrong payment and record the right one — that keeps the
   * trail intact instead of silently rewriting history.
   */
  async voidPayment(params: {
    paymentId: string;
    reason: string;
    loanId?: string;
  }): Promise<{ loanId: string; reversedAmount: number; remainingBalance: number }> {
    const reason = params.reason.trim();
    if (!reason) {
      throw new Error('A reason is required when voiding a payment.');
    }

    const holder: {
      value: { loanId: string; reversedAmount: number; remainingBalance: number } | null;
    } = { value: null };

    await runWriteTransaction(async (txn) => {
      const payment = await txn.getFirstAsync<LoanPayment & { voided_at: string | null }>(
        `SELECT
          id,
          loan_id as loanId,
          schedule_id as scheduleId,
          amount_paid as amountPaid,
          payment_method as paymentMethod,
          reference_no as referenceNo,
          notes,
          paid_at as paidAt,
          voided_at
        FROM loan_payments
        WHERE id = ?`,
        [params.paymentId]
      );

      if (!payment) {
        throw new Error('Payment not found.');
      }
      if (payment.voided_at) {
        throw new Error('This payment has already been voided.');
      }
      if (params.loanId && params.loanId !== payment.loanId) {
        throw new Error('That payment does not belong to the selected loan.');
      }

      const loan = await txn.getFirstAsync<{ total_payable: number }>(
        `SELECT total_payable FROM loans WHERE id = ?`,
        [payment.loanId]
      );
      if (!loan) {
        throw new Error('The loan for this payment could not be found.');
      }

      // 1. Void the payment row (kept, flagged).
      await txn.runAsync(
        `UPDATE loan_payments SET voided_at = datetime('now'), void_reason = ? WHERE id = ?`,
        [reason, payment.id]
      );

      // 2. Void the matching ledger inflow (id convention first, then a tolerant fallback).
      const voidedLedger = await txn.runAsync(
        `UPDATE ledger_transactions
            SET voided_at = datetime('now'), void_reason = ?
          WHERE id = ? AND voided_at IS NULL`,
        [reason, 'tx_pay_' + payment.id]
      );
      if (!voidedLedger.changes) {
        await txn.runAsync(
          `UPDATE ledger_transactions
              SET voided_at = datetime('now'), void_reason = ?
            WHERE related_loan_id = ?
              AND category = 'LOAN_REPAYMENT'
              AND amount = ?
              AND transaction_date = ?
              AND voided_at IS NULL`,
          [reason, payment.loanId, payment.amountPaid, payment.paidAt]
        );
      }

      // 3. Replay the surviving payments to rebuild installment state.
      const schedules = await txn.getAllAsync<LoanSchedule>(
        `SELECT ${SCHEDULE_COLUMNS} FROM loan_schedules WHERE loan_id = ? ORDER BY installment_number ASC`,
        [payment.loanId]
      );
      const survivingPayments = await txn.getAllAsync<{
        id: string;
        amountPaid: number;
        paidAt: string;
      }>(
        `SELECT id, amount_paid as amountPaid, paid_at as paidAt
           FROM loan_payments
          WHERE loan_id = ? AND voided_at IS NULL
          ORDER BY paid_at ASC, id ASC`,
        [payment.loanId]
      );

      const rebuild = rebuildScheduleStates(schedules, survivingPayments);

      for (const state of rebuild.states) {
        await txn.runAsync(
          `UPDATE loan_schedules SET paid_amount = ?, status = ?, settled_date = ? WHERE id = ?`,
          [state.paidAmount, state.status, state.settledDate, state.scheduleId]
        );
      }

      // 4. Balance is derived from the surviving cash, not from subtracting the void.
      const totalPaid = canonicalMoney(
        survivingPayments.reduce((sum, row) => sum + canonicalMoney(row.amountPaid), 0)
      );
      const remainingBalance = Math.max(0, canonicalMoney(loan.total_payable - totalPaid));
      const settled = remainingBalance <= MONEY_EPSILON;

      await txn.runAsync(`UPDATE loans SET remaining_balance = ?, status = ? WHERE id = ?`, [
        settled ? 0 : remainingBalance,
        settled ? 'SETTLED' : 'ACTIVE',
        payment.loanId,
      ]);

      // 5. Audit trail.
      await auditRepo.logWith(txn, {
        entity: 'loan_payment',
        entityId: payment.id,
        action: 'VOID',
        reason,
        before: {
          amountPaid: payment.amountPaid,
          paymentMethod: payment.paymentMethod,
          paidAt: payment.paidAt,
          voidedAt: null,
        },
        after: {
          amountPaid: payment.amountPaid,
          remainingBalance,
          unallocatedAfterRebuild: rebuild.unallocated,
        },
      });

      holder.value = {
        loanId: payment.loanId,
        reversedAmount: payment.amountPaid,
        remainingBalance: settled ? 0 : remainingBalance,
      };
    });

    if (!holder.value) {
      throw new Error('Failed to void the payment.');
    }
    return holder.value;
  },

  /**
   * Edits a payment's *metadata* only (method, reference, notes). Amounts and dates are
   * deliberately immutable — correcting money means voiding and re-recording, so the audit
   * trail always explains what happened.
   */
  async updatePaymentMeta(params: {
    paymentId: string;
    paymentMethod?: PaymentMethod;
    referenceNo?: string | null;
    notes?: string | null;
    reason?: string;
  }): Promise<void> {
    await runWriteTransaction(async (txn) => {
      const current = await txn.getFirstAsync<LoanPayment & { voided_at: string | null }>(
        `SELECT
          id,
          loan_id as loanId,
          amount_paid as amountPaid,
          payment_method as paymentMethod,
          reference_no as referenceNo,
          notes,
          paid_at as paidAt,
          voided_at
         FROM loan_payments
         WHERE id = ?`,
        [params.paymentId]
      );

      if (!current) {
        throw new Error('Payment not found.');
      }
      if (current.voided_at) {
        throw new Error('A voided payment can no longer be edited.');
      }

      const nextMethod = params.paymentMethod ?? current.paymentMethod;
      const nextReference =
        params.referenceNo === undefined ? current.referenceNo ?? null : params.referenceNo;
      const nextNotes = params.notes === undefined ? current.notes ?? null : params.notes;

      await txn.runAsync(
        `UPDATE loan_payments SET payment_method = ?, reference_no = ?, notes = ? WHERE id = ?`,
        [nextMethod, nextReference, nextNotes, params.paymentId]
      );

      await auditRepo.logWith(txn, {
        entity: 'loan_payment',
        entityId: params.paymentId,
        action: 'UPDATE',
        reason: params.reason?.trim() || 'Payment details edited',
        before: {
          paymentMethod: current.paymentMethod,
          referenceNo: current.referenceNo,
          notes: current.notes,
        },
        after: { paymentMethod: nextMethod, referenceNo: nextReference, notes: nextNotes },
      });
    });
  },

  async getPaymentsByLoan(loanId: string): Promise<LoanPayment[]> {
    return this.getPaymentsByLoanIds([loanId]);
  },

  /** Batched payment history for many loans in one query (removes the per-loan N+1 load). */
  async getPaymentsByLoanIds(loanIds: string[]): Promise<LoanPayment[]> {
    if (loanIds.length === 0) return [];

    const db = await getDatabase();
    const placeholders = loanIds.map(() => '?').join(', ');
    return db.getAllAsync<LoanPayment>(
      `SELECT
        id,
        loan_id as loanId,
        schedule_id as scheduleId,
        amount_paid as amountPaid,
        payment_method as paymentMethod,
        reference_no as referenceNo,
        notes,
        paid_at as paidAt,
        voided_at as voidedAt,
        void_reason as voidReason
      FROM loan_payments
      WHERE loan_id IN (${placeholders})
      ORDER BY paid_at DESC`,
      loanIds
    );
  },

  async getAllPayments(limit: number = 20): Promise<(LoanPayment & { borrowerName: string })[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<any>(
      `SELECT
        p.id,
        p.loan_id as loanId,
        p.schedule_id as scheduleId,
        p.amount_paid as amountPaid,
        p.payment_method as paymentMethod,
        p.reference_no as referenceNo,
        p.notes,
        p.paid_at as paidAt,
        p.voided_at as voidedAt,
        p.void_reason as voidReason,
        b.full_name as borrowerName
      FROM loan_payments p
      JOIN loans l ON p.loan_id = l.id
      JOIN borrowers b ON l.borrower_id = b.id
      WHERE p.voided_at IS NULL
      ORDER BY p.paid_at DESC
      LIMIT ?`,
      [limit]
    );
    return rows;
  },

  /**
   * Payments received in the current (device-local) month, newest first — the data behind
   * the dashboard "Recent Collections" overview. Each row carries its ledger transaction
   * id so tapping it can open the shared transaction detail modal.
   */
  async getCollectionsThisMonth(limit: number = 8): Promise<CollectionSummary[]> {
    const db = await getDatabase();
    return db.getAllAsync<CollectionSummary>(
      `SELECT
        'tx_pay_' || p.id as transactionId,
        p.id as paymentId,
        p.loan_id as loanId,
        b.id as borrowerId,
        b.full_name as borrowerName,
        p.amount_paid as amountPaid,
        p.payment_method as paymentMethod,
        p.paid_at as paidAt
      FROM loan_payments p
      JOIN loans l ON p.loan_id = l.id
      JOIN borrowers b ON l.borrower_id = b.id
      WHERE p.voided_at IS NULL
        AND strftime('%Y-%m', p.paid_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')
      ORDER BY p.paid_at DESC
      LIMIT ?`,
      [limit]
    );
  },
};

