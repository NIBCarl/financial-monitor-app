import { addDays, format } from 'date-fns';
import { getDatabase, runWriteTransaction } from '../client';
import { Loan, LoanSchedule, InterestType, RepaymentFrequency } from '../types';
import { calculateAmortization } from '../../utils/financial';

export const loanRepo = {
  async createLoan(params: {
    borrowerId: string;
    principalAmount: number;
    interestRate: number;
    interestType: InterestType;
    frequency: RepaymentFrequency;
    termCount: number;
    startDate: string;
  }): Promise<string> {
    const loanId = 'loan_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

    const calc = calculateAmortization({
      principal: params.principalAmount,
      interestRate: params.interestRate,
      interestType: params.interestType,
      frequency: params.frequency,
      termCount: params.termCount,
      startDate: params.startDate,
    });

    const lastInstallment = calc.installments[calc.installments.length - 1];
    const endDate = lastInstallment ? lastInstallment.dueDate : params.startDate;

    // `calc.termCount` is the number of schedules actually generated, so term_count
    // and the schedule rows can never disagree (LUMP_SUM collapses to a single row).
    await runWriteTransaction(async (txn) => {
      await txn.runAsync(
        `INSERT INTO loans (
          id, borrower_id, principal_amount, interest_rate, interest_type,
          frequency, term_count, total_payable, remaining_balance, status,
          start_date, end_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        [
          loanId,
          params.borrowerId,
          calc.principal,
          params.interestRate,
          params.interestType,
          params.frequency,
          calc.termCount,
          calc.totalPayable,
          calc.totalPayable, // remaining initial balance
          params.startDate,
          endDate,
        ]
      );

      // One prepared statement reused for every installment instead of re-preparing the SQL N times.
      const insertSchedule = await txn.prepareAsync(
        `INSERT INTO loan_schedules (
          id, loan_id, installment_number, due_date, expected_amount, paid_amount, status
        ) VALUES (?, ?, ?, ?, ?, 0.0, 'PENDING')`
      );

      try {
        for (const inst of calc.installments) {
          await insertSchedule.executeAsync([
            'sch_' + loanId + '_' + inst.installmentNumber,
            loanId,
            inst.installmentNumber,
            inst.dueDate,
            inst.expectedAmount,
          ]);
        }
      } finally {
        await insertSchedule.finalizeAsync();
      }

      await txn.runAsync(
        `INSERT INTO ledger_transactions (
          id, type, category, amount, description, related_loan_id, transaction_date
        ) VALUES (?, 'OUTFLOW', 'LOAN_DISBURSEMENT', ?, ?, ?, datetime('now'))`,
        ['tx_disb_' + loanId, calc.principal, `Loan disbursed to borrower`, loanId]
      );
    });

    return loanId;
  },

  async getLoansByBorrower(borrowerId: string): Promise<Loan[]> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<any>(
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
      WHERE l.borrower_id = ?
      ORDER BY l.created_at DESC`,
      [borrowerId]
    );
    return rows;
  },

  async getLoanById(id: string): Promise<Loan | null> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<any>(
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
      [id]
    );
    return row || null;
  },

  async getSchedulesByLoanId(loanId: string): Promise<LoanSchedule[]> {
    return this.getSchedulesByLoanIds([loanId]);
  },

  /** Batched schedule load for many loans in one query (removes the per-loan N+1 load). */
  async getSchedulesByLoanIds(loanIds: string[]): Promise<LoanSchedule[]> {
    if (loanIds.length === 0) return [];

    const db = await getDatabase();
    const placeholders = loanIds.map(() => '?').join(', ');
    return db.getAllAsync<LoanSchedule>(
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
      WHERE loan_id IN (${placeholders})
      ORDER BY loan_id ASC, installment_number ASC`,
      loanIds
    );
  },

  /**
   * Unpaid installments due on or before `untilDate` (default: 7 days out), ordered by due
   * date. Bounding the window and row count keeps the dashboard query flat as the ledger
   * grows, instead of returning every future installment.
   *
   * `due_date` is stored as 'YYYY-MM-DD' (see calculateAmortization), so a plain string
   * comparison stays index-friendly — no `date()` wrapper on the column.
   */
  async getDueAndOverdueSchedules(
    untilDate: string = format(addDays(new Date(), 7), 'yyyy-MM-dd'),
    limit: number = 200
  ): Promise<Array<LoanSchedule & { borrowerName: string; borrowerPhone: string; principalAmount: number }>> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<any>(
      `SELECT 
        s.id,
        s.loan_id as loanId,
        s.installment_number as installmentNumber,
        s.due_date as dueDate,
        s.expected_amount as expectedAmount,
        s.paid_amount as paidAmount,
        s.status,
        s.settled_date as settledDate,
        b.full_name as borrowerName,
        b.phone_number as borrowerPhone,
        l.principal_amount as principalAmount
      FROM loan_schedules s
      JOIN loans l ON s.loan_id = l.id
      JOIN borrowers b ON l.borrower_id = b.id
      WHERE s.status IN ('PENDING', 'PARTIAL', 'OVERDUE')
        AND s.due_date <= ?
      ORDER BY s.due_date ASC
      LIMIT ?`,
      [untilDate, limit]
    );
    return rows;
  }
};
