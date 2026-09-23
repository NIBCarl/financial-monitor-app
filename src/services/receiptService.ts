import { Share } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { LoanPayment, ReceiptData } from '../db/types';
import { formatCurrency, formatDatePretty, formatDbDateTime } from '../utils/financial';
import { canonicalMoney } from '../utils/money';
import { planReceiptSecret } from '../utils/secrets';
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

/** Key under which the receipt signing secret is held in the OS keystore. */
const RECEIPT_SECRET_KEY = 'receipt_secret';

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
 * The signing secret, kept in the OS keystore (Android Keystore / iOS Keychain).
 *
 * It used to live in `app_settings`, which had two consequences that made the whole
 * "your receipt cannot be edited" claim weaker than it looked: the SQLite file is unencrypted
 * (§20.8), and `app_settings` is one of the tables a backup exports — so the secret travelled
 * inside the very file the app tells the treasurer to email to themselves. Anyone holding a
 * backup could forge a receipt that verifies (OWASP MASWE-0003 and MASWE-0006).
 *
 * The precedence rules live in `utils/secrets` (pure, harness-tested): the keystore copy wins; a
 * legacy in-database copy is adopted exactly once so receipts already in borrowers' hands keep
 * verifying, and then deleted; a new secret is generated only when there is nothing to adopt.
 */
export async function getReceiptSecret(): Promise<string> {
  const deviceSecret = await readDeviceSecret();
  const legacySecret = await settingsRepo.get('receipt_secret');

  // An empty `generated` keeps the CSPRNG call out of the common path (a secret already exists).
  const plan = planReceiptSecret(deviceSecret, legacySecret, '');
  if (plan.source === 'device') {
    // A restore can put a foreign secret back into the database (a backup written before this
    // change carries one). The keystore copy is authoritative, so the stray row is removed —
    // otherwise it would linger on the device and inside "the trail" for no reason.
    if (legacySecret && legacySecret !== plan.secret) {
      await settingsRepo.clear('receipt_secret');
    }
    return plan.secret;
  }

  const secret = plan.source === 'legacy' ? plan.secret : await generateSecret();

  await writeDeviceSecret(secret);
  if (plan.clearLegacy) {
    // Remove the in-database copy: from here on the secret is device-only, so it can never
    // travel inside a backup again.
    await settingsRepo.clear('receipt_secret');
  }

  return secret;
}

/** 32 random bytes as hex. `getRandomBytesAsync` is the platform CSPRNG. */
async function generateSecret(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Reads the keystore copy. Returns null when the platform has no keystore (web preview). */
async function readDeviceSecret(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(RECEIPT_SECRET_KEY);
  } catch (err) {
    console.warn('Secure storage unavailable; falling back to the database copy:', err);
    return null;
  }
}

/** Writes the keystore copy; on a platform without one, keeps the in-database copy instead. */
async function writeDeviceSecret(secret: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(RECEIPT_SECRET_KEY, secret);
  } catch (err) {
    console.warn('Secure storage unavailable; keeping the secret in the database:', err);
    await settingsRepo.set('receipt_secret', secret);
  }
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
  penaltyPaid?: number;
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
    penaltyPaid: input.penaltyPaid ?? 0,
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

  // Penalty money is called out separately: the borrower must be able to see that part of what
  // they handed over cleared a fine rather than reducing the loan.
  const penaltyLine =
    (receipt.penaltyPaid ?? 0) > 0
      ? `\n⚠️ *Of which penalties:* ${formatCurrency(receipt.penaltyPaid ?? 0, currencySymbol)}`
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
💵 *Amount Paid:* ${formatCurrency(receipt.amountPaid, currencySymbol)}${penaltyLine}
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
