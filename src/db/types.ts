export type InterestType = 'FLAT' | 'MONTHLY_SIMPLE' | 'NONE';

export type RepaymentFrequency = 'DAILY' | 'WEEKLY' | 'BI_WEEKLY' | 'MONTHLY' | 'LUMP_SUM';

export type LoanStatus = 'ACTIVE' | 'SETTLED' | 'OVERDUE' | 'DEFAULTED';

export type ScheduleStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';

export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'GCASH' | 'MAYA' | 'CHEQUE' | 'OTHER';

export type TransactionType = 'INFLOW' | 'OUTFLOW';

export type TransactionCategory =
  | 'LOAN_DISBURSEMENT'
  | 'LOAN_REPAYMENT'
  | 'MEMBERSHIP_DUES'
  | 'DONATION'
  | 'EXPENSE'
  | 'OTHER';

export interface Borrower {
  id: string;
  fullName: string;
  phoneNumber: string;
  categoryTag: string;
  photoUri?: string | null;
  address?: string | null;
  guarantorInfo?: string | null;
  notes?: string | null;
  createdAt: string;
  // Computed aggregations (for listings)
  activeLoansCount?: number;
  totalOutstanding?: number;
  hasOverdue?: boolean;
}

export interface Loan {
  id: string;
  borrowerId: string;
  borrowerName?: string;
  borrowerPhone?: string;
  principalAmount: number;
  interestRate: number; // e.g. 5 for 5%
  interestType: InterestType;
  frequency: RepaymentFrequency;
  termCount: number;
  totalPayable: number;
  remainingBalance: number;
  status: LoanStatus;
  startDate: string;
  endDate: string;
  createdAt: string;
}

export interface LoanSchedule {
  id: string;
  loanId: string;
  installmentNumber: number;
  dueDate: string;
  expectedAmount: number;
  paidAmount: number;
  status: ScheduleStatus;
  settledDate?: string | null;
}

export type AuditEntity = 'loan_payment' | 'ledger_transaction' | 'loan' | 'borrower' | 'settings';

export type AuditAction = 'CREATE' | 'UPDATE' | 'VOID';

/** One append-only entry in the audit trail. Nothing in the app ever deletes these. */
export interface AuditLogEntry {
  id: string;
  entity: AuditEntity;
  entityId: string;
  action: AuditAction;
  reason?: string | null;
  beforeJson?: string | null;
  afterJson?: string | null;
  actor?: string | null;
  createdAt: string;
}

export interface LoanPayment {
  id: string;
  loanId: string;
  scheduleId?: string | null;
  borrowerName?: string;
  amountPaid: number;
  paymentMethod: PaymentMethod;
  referenceNo?: string | null;
  notes?: string | null;
  paidAt: string;
  /** Set when the payment was reversed; the row is kept forever, excluded from totals. */
  voidedAt?: string | null;
  voidReason?: string | null;
}

export interface LedgerTransaction {
  id: string;
  type: TransactionType;
  category: TransactionCategory;
  amount: number;
  description?: string | null;
  relatedLoanId?: string | null;
  transactionDate: string;
  /** Set when the entry was reversed (its payment was voided); excluded from all totals. */
  voidedAt?: string | null;
  voidReason?: string | null;
}

/**
 * Everything the transaction detail modal needs for one ledger entry, resolved in a
 * single repository call: the ledger row itself plus, where applicable, the linked
 * loan, payment and installment.
 */
export interface TransactionDetail {
  transaction: LedgerTransaction;
  /** Present when the entry is linked to a loan (disbursement or repayment). */
  loan?: Loan;
  /** The payment row for LOAN_REPAYMENT entries. */
  payment?: LoanPayment;
  /** Installment the payment was applied to, when it was recorded against one. */
  schedule?: LoanSchedule;
  /** Loan balance immediately after this payment (repayments only). */
  balanceAfter?: number | null;
  /** Append-only history for this entry: created, edited, voided. */
  auditTrail?: AuditLogEntry[];
}

/** One row in the dashboard "Recent Collections" overview. */
export interface CollectionSummary {
  /** Ledger transaction id, so the row can open the shared detail modal. */
  transactionId: string;
  paymentId: string;
  loanId: string;
  borrowerId: string;
  borrowerName: string;
  amountPaid: number;
  paymentMethod: PaymentMethod;
  paidAt: string;
}

export interface DashboardMetrics {
  liquidCash: number;
  totalInflows: number;
  totalOutflows: number;
  outstandingPrincipal: number;
  expectedInterest: number;
  overdueAmount: number;
  activeBorrowersCount: number;
  overdueBorrowersCount: number;
  totalCollectedThisMonth: number;
}

/**
 * Everything a shareable receipt needs. Built on the data side of the app
 * (paymentRepo) so a receipt can never disagree with the database.
 *
 * `nextDueDate`/`nextDueAmount` are null only when the loan is fully settled —
 * that distinction is what the receipt's three states depend on.
 */
export interface ReceiptData {
  paymentId: string;
  borrowerName: string;
  borrowerPhone: string;
  amountPaid: number;
  paymentMethod: string;
  referenceNo?: string | null;
  remainingBalance: number;
  nextDueDate?: string | null;
  nextDueAmount?: number | null;
  allocations?: { installmentNumber: number; amount: number }[];
  unallocated?: number;
  paidAt: string;
  orgName?: string;
}
