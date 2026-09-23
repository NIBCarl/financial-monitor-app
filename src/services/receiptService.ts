import { Share } from 'react-native';
import * as Crypto from 'expo-crypto';
import { LoanPayment, ReceiptData } from '../db/types';
import { formatCurrency, formatDatePretty, formatDbDateTime } from '../utils/financial';
import { canonicalMoney } from '../utils/money';
import { settingsRepo } from '../db/repositories/settingsRepo';

/**
 * Single source of truth for receipt and reminder text.
 *
 * Previously this template existed in three places (ShareableReceiptModal,
 * BorrowerDetailModal and the dashboard), and every copy claimed "FULLY SETTLED"
 * because the next due date was never populated. There are now three honest states:
 * settled, partially paid with a next due date, and balance outstanding.
 */

const MONEY_EPSILON = 0.004;
const DIVIDER = '──────────────────────';

/** Version prefix for the machine-readable verification token. */
export const VERIFICATION_TOKEN_PREFIX = 'TV1';

/**
 * Verification payload: the four facts a receipt asserts. Kept to ASCII-safe characters so
 * the token survives SMS/WhatsApp unchanged (no base64 needed).
 */
export interface ReceiptVerificationFields {
  paymentId: string;
  amountPaid: number;
  paidAt: string;
  remainingBalance: number;
}

/** Formats a digest into a human-friendly 8-character code, e.g. "A1B2-C3D4". */
export function formatVerificationCode(hexDigest: string): string {
  const raw = hexDigest.replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 8).padEnd(8, '0');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/** Builds the canonical, order-stable string that is signed. */
export function buildVerificationMessage(fields: ReceiptVerificationFields, secret: string): string {
  return [
    VERIFICATION_TOKEN_PREFIX,
    fields.paymentId,
    canonicalMoney(fields.amountPaid).toFixed(2),
    fields.paidAt,
    canonicalMoney(fields.remainingBalance).toFixed(2),
    secret,
  ].join('|');
}

/** The token embedded in the receipt text: `TV1~paymentId~amount~paidAt~balance~CODE`. */
export function buildVerificationToken(fields: ReceiptVerificationFields, code: string): string {
  return [
    VERIFICATION_TOKEN_PREFIX,
    fields.paymentId,
    canonicalMoney(fields.amountPaid).toFixed(2),
    fields.paidAt,
    canonicalMoney(fields.remainingBalance).toFixed(2),
    code.replace('-', ''),
  ].join('~');
}

/** Parses a token out of arbitrary pasted text (pure — used by the verify screen and tests). */
export function parseVerificationToken(text: string): { fields: ReceiptVerificationFields; code: string } | null {
  const match = /TV1~([A-Za-z0-9_]+)~(\d+(?:\.\d{1,2})?)~([^~]+)~(\d+(?:\.\d{1,2})?)~([0-9A-Fa-f]{8})/.exec(
    text ?? ''
  );
  if (!match) return null;

  return {
    fields: {
      paymentId: match[1],
      amountPaid: Number(match[2]),
      paidAt: match[3],
      remainingBalance: Number(match[4]),
    },
    code: match[5].toUpperCase(),
  };
}

/**
 * The signing secret. Stored with the data (not in a secure element), which is the honest
 * trade-off here: it makes a *shared receipt* impossible to edit after the fact, while anyone
 * with full database access could in principle forge one.
 */
export async function getReceiptSecret(): Promise<string> {
  const existing = await settingsRepo.get('receipt_secret');
  if (existing) return existing;

  const bytes = await Crypto.getRandomBytesAsync(32);
  const secret = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await settingsRepo.set('receipt_secret', secret);
  return secret;
}

/** Computes the short verification code for a receipt (async: HMAC-style SHA-256 digest). */
export async function computeReceiptVerificationCode(
  fields: ReceiptVerificationFields
): Promise<string> {
  const secret = await getReceiptSecret();
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    buildVerificationMessage(fields, secret)
  );
  return formatVerificationCode(digest);
}

/** Signs the receipt's own data so the borrower can prove it was not edited. */
export async function buildReceiptVerification(
  receipt: ReceiptData
): Promise<{ code: string; token: string }> {
  const fields: ReceiptVerificationFields = {
    paymentId: receipt.paymentId,
    amountPaid: receipt.amountPaid,
    paidAt: receipt.paidAt,
    remainingBalance: receipt.remainingBalance,
  };
  const code = await computeReceiptVerificationCode(fields);
  return { code, token: buildVerificationToken(fields, code) };
}

/**
 * Verifies a pasted receipt / token. Returns the extracted facts so the treasurer can eyeball
 * them against the shared message.
 */
export async function verifyReceiptText(
  text: string
): Promise<{ ok: boolean; fields?: ReceiptVerificationFields; reason?: string }> {
  const parsed = parseVerificationToken(text);
  if (!parsed) {
    return {
      ok: false,
      reason: 'No verification token found. Paste the full receipt message (it contains a line starting with "Token: TV1~").',
    };
  }

  const expected = await computeReceiptVerificationCode(parsed.fields);
  const ok = expected.replace('-', '') === parsed.code;

  return {
    ok,
    fields: parsed.fields,
    reason: ok
      ? undefined
      : 'The code does not match these details — the receipt text was edited or belongs to a different ledger.',
  };
}

export function isReceiptSettled(receipt: ReceiptData): boolean {
  return canonicalMoney(receipt.remainingBalance) <= MONEY_EPSILON;
}

export interface PaymentRecordedInput {
  payment: LoanPayment;
  remainingBalance: number;
  nextDueDate: string | null;
  nextDueAmount: number | null;
  allocations?: { installmentNumber: number; amount: number }[];
  unallocated?: number;
  borrowerName: string;
  borrowerPhone: string;
  orgName?: string;
}

/**
 * Builds receipt data straight from a persisted payment, so both payment entry points
 * (dashboard modal and borrower profile) share one mapping and neither can drift from
 * what the database actually stored.
 */
export function buildReceiptFromPayment(input: PaymentRecordedInput): ReceiptData {
  return {
    paymentId: input.payment.id,
    borrowerName: input.borrowerName,
    borrowerPhone: input.borrowerPhone,
    amountPaid: input.payment.amountPaid,
    paymentMethod: input.payment.paymentMethod,
    referenceNo: input.payment.referenceNo ?? null,
    remainingBalance: input.remainingBalance,
    nextDueDate: input.nextDueDate,
    nextDueAmount: input.nextDueAmount,
    allocations: input.allocations,
    unallocated: input.unallocated ?? 0,
    paidAt: input.payment.paidAt,
    orgName: input.orgName,
  };
}

export function getReceiptStatusLine(receipt: ReceiptData, currencySymbol: string): string {
  if (isReceiptSettled(receipt)) {
    return '🎉 *Status:* FULLY SETTLED — thank you!';
  }
  if (receipt.nextDueDate) {
    const amount = receipt.nextDueAmount
      ? ` — ${formatCurrency(receipt.nextDueAmount, currencySymbol)}`
      : '';
    return `⏳ *Next Due:* ${formatDatePretty(receipt.nextDueDate)}${amount}`;
  }
  return `⏳ *Balance Outstanding:* ${formatCurrency(receipt.remainingBalance, currencySymbol)}`;
}

/** Plain-text receipt suitable for WhatsApp / SMS / Messenger. */
export function buildReceiptText(
  receipt: ReceiptData,
  currencySymbol: string,
  verification?: { code: string; token: string } | null
): string {
  const orgName = receipt.orgName?.trim() || 'Community Treasury';
  const applied = receipt.allocations?.length
    ? `\n📌 *Applied To:*\n${receipt.allocations
        .map((a) => `   • Installment #${a.installmentNumber}: ${formatCurrency(a.amount, currencySymbol)}`)
        .join('\n')}`
    : '';
  const verificationLines = verification
    ? `\n${DIVIDER}\n🔒 *Verification Code:* ${verification.code}\n🔒 Token: ${verification.token}\n   (tap Verify in the Treasurer app to check this receipt)`
    : '';

  return `
🧾 *OFFICIAL PAYMENT RECEIPT*
🏛 *${orgName}*
${DIVIDER}
👤 *Borrower:* ${receipt.borrowerName}
📅 *Date:* ${formatDbDateTime(receipt.paidAt, 'PPpp')}
💵 *Amount Paid:* ${formatCurrency(receipt.amountPaid, currencySymbol)}
💳 *Payment Method:* ${receipt.paymentMethod}${receipt.referenceNo ? ` (Ref: ${receipt.referenceNo})` : ''}${applied}
${DIVIDER}
⚖️ *Remaining Balance:* ${formatCurrency(receipt.remainingBalance, currencySymbol)}
${getReceiptStatusLine(receipt, currencySymbol)}${verificationLines}
${DIVIDER}
✅ Recorded by the Group Treasurer in the offline ledger.
Ref ID: ${receipt.paymentId}
  `.trim();
}

/**
 * Shares a receipt, attaching a fresh verification code so the borrower can prove the text
 * was not edited after it was sent.
 */
export async function shareReceipt(
  receipt: ReceiptData,
  currencySymbol: string,
  verification?: { code: string; token: string } | null
): Promise<void> {
  const signed = verification ?? (await buildReceiptVerification(receipt));

  await Share.share({
    message: buildReceiptText(receipt, currencySymbol, signed),
    title: `Receipt for ${receipt.borrowerName}`,
  });
}

export interface ReminderInput {
  borrowerName: string;
  orgName: string;
  installmentNumber: number;
  amountDue: number;
  dueDate: string;
}

/** Gentle payment reminder, centred on one specific installment. */
export function buildPaymentReminderText(input: ReminderInput, currencySymbol: string): string {
  return `
Hello ${input.borrowerName}, this is a gentle reminder from ${input.orgName} regarding your loan installment #${input.installmentNumber} of ${formatCurrency(input.amountDue, currencySymbol)}, which was due on ${formatDatePretty(input.dueDate)}. Please let us know when you can settle this. Thank you!
  `.trim();
}

export async function sharePaymentReminder(input: ReminderInput, currencySymbol: string): Promise<void> {
  await Share.share({
    message: buildPaymentReminderText(input, currencySymbol),
    title: `Payment Reminder for ${input.borrowerName}`,
  });
}
