import { getDatabase } from '../client';
import {
  LedgerTransaction,
  DashboardMetrics,
  TransactionType,
  TransactionCategory,
  TransactionDetail,
  Loan,
  LoanPayment,
  LoanSchedule,
} from '../types';
import { round2 } from '../../utils/validation';
import { auditRepo } from './auditRepo';

export const ledgerRepo = {
  async getMetrics(): Promise<DashboardMetrics> {
    const db = await getDatabase();

    // 1. Calculate liquid cash from ledger transactions (voided entries are excluded —
    //    they are kept for the record but no longer represent money that moved).
    const cashResult = await db.getFirstAsync<{ inflows: number; outflows: number }>(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'INFLOW' THEN amount ELSE 0 END), 0) as inflows,
        COALESCE(SUM(CASE WHEN type = 'OUTFLOW' THEN amount ELSE 0 END), 0) as outflows
      FROM ledger_transactions
      WHERE voided_at IS NULL
    `);
    const totalInflows = Number((cashResult?.inflows || 0).toFixed(2));
    const totalOutflows = Number((cashResult?.outflows || 0).toFixed(2));
    const liquidCash = Number((totalInflows - totalOutflows).toFixed(2));

    // 2. Active loan metrics
    const loanResult = await db.getFirstAsync<{
      outstandingBalance: number;
      activeCount: number;
    }>(`
      SELECT 
        COALESCE(SUM(remaining_balance), 0) as outstandingBalance,
        COUNT(DISTINCT borrower_id) as activeCount
      FROM loans
      WHERE status IN ('ACTIVE', 'OVERDUE')
    `);

    // 3. Expected interest
    const interestResult = await db.getFirstAsync<{ totalPayable: number; totalPrincipal: number }>(`
      SELECT 
        COALESCE(SUM(total_payable), 0) as totalPayable,
        COALESCE(SUM(principal_amount), 0) as totalPrincipal
      FROM loans
      WHERE status IN ('ACTIVE', 'OVERDUE')
    `);
    const expectedInterest = Number(
      Math.max(0, (interestResult?.totalPayable || 0) - (interestResult?.totalPrincipal || 0)).toFixed(2)
    );

    // 4. Overdue amounts from schedules where due_date < today and not paid.
    //    `due_date` is a 'YYYY-MM-DD' string, so comparing it directly keeps the
    //    due-date index usable; 'localtime' matches the client-side date predicates.
    const overdueResult = await db.getFirstAsync<{ overdueSum: number; overdueBorrowers: number }>(`
      SELECT 
        COALESCE(SUM(CASE WHEN s.expected_amount > s.paid_amount THEN s.expected_amount - s.paid_amount ELSE 0 END), 0) as overdueSum,
        COUNT(DISTINCT l.borrower_id) as overdueBorrowers
      FROM loan_schedules s
      JOIN loans l ON s.loan_id = l.id
      WHERE s.status != 'PAID' AND s.due_date < date('now', 'localtime')
    `);

    // 5. Total collected this month — voided payments excluded, converted to the device's
    //    local month so payments taken on the 1st before 08:00 (UTC+8) are not counted in
    //    the previous month.
    const monthlyResult = await db.getFirstAsync<{ monthTotal: number }>(`
      SELECT COALESCE(SUM(amount_paid), 0) as monthTotal
      FROM loan_payments
      WHERE voided_at IS NULL
        AND strftime('%Y-%m', paid_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')
    `);

    return {
      liquidCash,
      totalInflows,
      totalOutflows,
      outstandingPrincipal: Number((loanResult?.outstandingBalance || 0).toFixed(2)),
      expectedInterest,
      overdueAmount: Number((overdueResult?.overdueSum || 0).toFixed(2)),
      activeBorrowersCount: Number(loanResult?.activeCount || 0),
      overdueBorrowersCount: Number(overdueResult?.overdueBorrowers || 0),
      totalCollectedThisMonth: Number((monthlyResult?.monthTotal || 0).toFixed(2)),
    };
  },

  async getTransactions(limit: number = 50): Promise<LedgerTransaction[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<any>(
      `SELECT 
        id,
        type,
        category,
        amount,
        description,
        related_loan_id as relatedLoanId,
        transaction_date as transactionDate,
        voided_at as voidedAt,
        void_reason as voidReason
      FROM ledger_transactions
      ORDER BY transaction_date DESC
      LIMIT ?`,
      [limit]
    );
    return rows;
  },

  async addTransaction(params: {
    type: TransactionType;
    category: TransactionCategory;
    amount: number;
    description?: string;
  }): Promise<string> {
    const db = await getDatabase();
    const id = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

    await db.runAsync(
      `INSERT INTO ledger_transactions (id, type, category, amount, description, transaction_date)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [id, params.type, params.category, params.amount, params.description || null]
    );

    return id;
  },

  /**
   * Resolves one ledger entry into everything the detail modal shows.
   *
   * Loans are located from `related_loan_id`, falling back to the id convention used when
   * the entry was written (`tx_disb_<loanId>`, `tx_pay_<paymentId>`), so historical rows
   * created before the column was populated still resolve.
   */
  async getTransactionDetail(id: string): Promise<TransactionDetail | null> {
    const db = await getDatabase();

    const transaction = await db.getFirstAsync<LedgerTransaction>(
      `SELECT
        id,
        type,
        category,
        amount,
        description,
        related_loan_id as relatedLoanId,
        transaction_date as transactionDate,
        voided_at as voidedAt,
        void_reason as voidReason
      FROM ledger_transactions
      WHERE id = ?`,
      [id]
    );
    if (!transaction) return null;

    const detail: TransactionDetail = { transaction };

    const paymentIdFromTx = id.startsWith('tx_pay_') ? id.slice('tx_pay_'.length) : null;
    const loanIdFromTx = id.startsWith('tx_disb_') ? id.slice('tx_disb_'.length) : null;

    if (paymentIdFromTx) {
      detail.payment =
        (await db.getFirstAsync<LoanPayment>(
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
          WHERE id = ?`,
          [paymentIdFromTx]
        )) ?? undefined;

      // Append-only history for whichever record this voucher points at.
      detail.auditTrail = await auditRepo.getForEntity('loan_payment', paymentIdFromTx, 10);
    } else {
      detail.auditTrail = await auditRepo.getForEntity('ledger_transaction', id, 10);
    }

    const loanId = detail.payment?.loanId ?? loanIdFromTx ?? transaction.relatedLoanId ?? null;

    if (loanId) {
      detail.loan =
        (await db.getFirstAsync<Loan>(
          `SELECT
            l.id,
            l.borrower_id as borrowerId,
            b.full_name as borrowerName,
            b.phone_number as borrowerPhone,
            l.principal_amount as principalAmount,
            l.interest_rate as interestRate,
            l.interest_type as interestType,
            l.frequency,
            l.term_count as termCount,
            l.total_payable as totalPayable,
            l.remaining_balance as remainingBalance,
            l.status,
            l.start_date as startDate,
            l.end_date as endDate,
            l.created_at as createdAt
          FROM loans l
          JOIN borrowers b ON l.borrower_id = b.id
          WHERE l.id = ?`,
          [loanId]
        )) ?? undefined;
    }

    if (detail.payment && detail.loan) {
      // Balance immediately after that payment: total payable minus every payment up to it.
      const balanceRow = await db.getFirstAsync<{ remaining: number }>(
        `SELECT ? - COALESCE(
            (SELECT SUM(amount_paid) FROM loan_payments WHERE loan_id = ? AND paid_at <= ?), 0
          ) as remaining`,
        [detail.loan.totalPayable, detail.loan.id, detail.payment.paidAt]
      );
      detail.balanceAfter = balanceRow ? Math.max(0, round2(balanceRow.remaining)) : null;

      if (detail.payment.scheduleId) {
        detail.schedule =
          (await db.getFirstAsync<LoanSchedule>(
            `SELECT
              id,
              loan_id as loanId,
              installment_number as installmentNumber,
              due_date as dueDate,
              expected_amount as expectedAmount,
              paid_amount as paidAmount,
              status,
              settled_date as settledDate
            FROM loan_schedules
            WHERE id = ?`,
            [detail.payment.scheduleId]
          )) ?? undefined;
      }
    }

    return detail;
  },

  /**
   * Expense totals grouped by category + description, for the printable report.
   *
   * Grouped rather than listed line-by-line because a treasurer wants "how much did we spend on
   * snacks this month", not forty identical rows.
   */
  async getExpenseBreakdown(): Promise<
    { category: TransactionCategory; description: string; total: number; entries: number }[]
  > {
    const db = await getDatabase();
    const rows = await db.getAllAsync<{
      category: TransactionCategory;
      description: string;
      total: number;
      entries: number;
    }>(
      `SELECT
        category,
        COALESCE(NULLIF(TRIM(description), ''), '') as description,
        COALESCE(SUM(amount), 0) as total,
        COUNT(*) as entries
      FROM ledger_transactions
      WHERE voided_at IS NULL AND type = 'OUTFLOW'
      GROUP BY category, description
      ORDER BY total DESC`
    );
    return rows.map((r) => ({
      category: r.category,
      description: r.description,
      total: round2(Number(r.total ?? 0)),
      entries: Number(r.entries ?? 0),
    }));
  },
};
