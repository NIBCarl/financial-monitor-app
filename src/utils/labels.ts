import { PaymentMethod, TransactionCategory } from '../db/types';

/**
 * Shared display labels for ledger categories and payment methods.
 *
 * These were previously duplicated as inline switches inside screens; keeping one copy
 * means the ledger list, the detail modal and the dashboard collections card can never
 * drift apart.
 */

export function getCategoryLabel(category: TransactionCategory | string): string {
  switch (category) {
    case 'LOAN_DISBURSEMENT':
      return 'Loan Disbursed';
    case 'LOAN_REPAYMENT':
      return 'Loan Repayment';
    case 'MEMBERSHIP_DUES':
      return 'Membership Dues';
    case 'DONATION':
      return 'Donation / Capital';
    case 'EXPENSE':
      return 'Supplies / Expense';
    default:
      return 'General Transaction';
  }
}

/** Longer, voucher-style heading used by the transaction detail modal. */
export function getCategoryHeadline(category: TransactionCategory | string): string {
  switch (category) {
    case 'LOAN_DISBURSEMENT':
      return 'Loan Disbursement Voucher';
    case 'LOAN_REPAYMENT':
      return 'Payment Receipt';
    case 'MEMBERSHIP_DUES':
      return 'Membership Dues Receipt';
    case 'DONATION':
      return 'Donation / Capital Receipt';
    case 'EXPENSE':
      return 'Expense Voucher';
    default:
      return 'Transaction Voucher';
  }
}

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  GCASH: 'GCash / Maya',
  BANK_TRANSFER: 'Bank Transfer',
  CHEQUE: 'Cheque',
  MAYA: 'Maya',
  OTHER: 'Other',
};

export function getPaymentMethodLabel(method: PaymentMethod | string): string {
  return PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? String(method);
}

/** Human-friendly repayment frequency, e.g. BI_WEEKLY → Bi-Weekly. */
export function getFrequencyLabel(frequency: string): string {
  if (frequency === 'BI_WEEKLY') return 'Bi-Weekly';
  if (frequency === 'LUMP_SUM') return 'Lump Sum';
  return frequency.charAt(0) + frequency.slice(1).toLowerCase();
}
