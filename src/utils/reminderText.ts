import { formatCurrency, formatDatePretty } from './financial';

/**
 * Reminder *text* only — no platform imports, so it can be unit-tested in plain Node by the
 * verification harness. `utils/reminders.ts` re-exports these and adds the SMS/WhatsApp plumbing.
 */

export interface ReminderInput {
  borrowerName: string;
  orgName: string;
  amountDue: number;
  dueDate: string;
  /** Positive when the installment is late; 0 when due today. */
  daysLate: number;
  currencySymbol: string;
}

/**
 * Digits only, with a Philippine country code applied when the number is local.
 * `0917 123 4567`, `+63 917 123 4567` and `639171234567` all become `639171234567`.
 */
export function normalisePhone(raw: string): string {
  const digits = (raw || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('63')) return digits;
  if (digits.startsWith('0')) return `63${digits.slice(1)}`;
  // Bare 10-digit local number (9171234567)
  if (digits.length === 10) return `63${digits}`;
  return digits;
}

export function buildReminderMessage(input: ReminderInput): string {
  const amount = formatCurrency(input.amountDue, input.currencySymbol);
  const due = formatDatePretty(input.dueDate);

  if (input.daysLate > 0) {
    const days = input.daysLate === 1 ? '1 day' : `${input.daysLate} days`;
    return (
      `Good day ${input.borrowerName}! This is a friendly reminder from ${input.orgName}. ` +
      `Your payment of ${amount} was due on ${due} (${days} ago) and is still outstanding. ` +
      `Kindly settle it at your earliest convenience, or message us if you need to arrange something. Thank you!`
    );
  }

  if (input.daysLate === 0) {
    return (
      `Good day ${input.borrowerName}! This is a reminder from ${input.orgName}. ` +
      `Your payment of ${amount} is due today (${due}). Thank you!`
    );
  }

  return (
    `Good day ${input.borrowerName}! This is a reminder from ${input.orgName}. ` +
    `Your payment of ${amount} is due on ${due}. Thank you!`
  );
}

export interface BulkReminderLine {
  borrowerName: string;
  amountDue: number;
  dueDate: string;
  daysLate: number;
}

/** One message covering several borrowers, for a collection round. */
export function buildBulkReminderMessage(
  lines: BulkReminderLine[],
  orgName: string,
  currencySymbol: string
): string {
  const body = lines
    .map((l) => {
      const amount = formatCurrency(l.amountDue, currencySymbol);
      const when = l.daysLate > 0 ? `${l.daysLate}d overdue` : `due ${formatDatePretty(l.dueDate)}`;
      return `• ${l.borrowerName} — ${amount} (${when})`;
    })
    .join('\n');

  const total = lines.reduce((sum, l) => sum + l.amountDue, 0);

  return (
    `${orgName} — COLLECTION REMINDER\n\n` +
    `${body}\n\n` +
    `Total to collect: ${formatCurrency(total, currencySymbol)}\n` +
    `Thank you!`
  );
}
