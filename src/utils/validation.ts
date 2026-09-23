/**
 * Input validation & money parsing.
 *
 * Money inputs used to be parsed with raw `parseFloat`, which silently mis-reads
 * thousands separators ("10,000" -> 10) and accepts scientific notation ("1e5").
 * Everything money-related must go through `parseMoney` / `parsePositiveMoney`.
 */

/** Largest amount the treasurer can enter (guards typos like 100000000000). */
export const MAX_MONEY = 999_999_999.99;

/** Max installment count accepted for a loan. */
export const MAX_TERM_COUNT = 260;

/** Max free-text length stored for borrower notes/address/guarantor fields. */
export const MAX_TEXT_LENGTH = 300;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Digits with optional proper thousands grouping and at most 2 decimal places. */
const MONEY_PATTERN = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;

/**
 * Rounds to 2 decimals using a half-up policy (mitigates binary float artefacts
 * such as 1.0049999999999999 and 1.005 -> 1.01).
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Parses treasurer-typed money text into a number.
 * Accepts "1000", "1,000", "1,234.56", "  250  ".
 * Rejects "", "10,00", "1e5", "1.234,56", "12.345" (more than 2 decimals), "abc".
 */
export function parseMoney(input: string): ParseResult<number> {
  const raw = (input ?? '').replace(/\s+/g, '');
  if (!raw) {
    return { ok: false, error: 'Please enter an amount.' };
  }
  if (!MONEY_PATTERN.test(raw)) {
    return {
      ok: false,
      error: 'Enter a valid amount using digits only (for example 1000 or 1,234.56, up to 2 decimals).',
    };
  }

  const value = round2(Number(raw.replace(/,/g, '')));
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'That amount is not a valid number.' };
  }
  if (Math.abs(value) > MAX_MONEY) {
    return { ok: false, error: `Amount cannot be greater than ${MAX_MONEY.toLocaleString('en-US')}.` };
  }
  return { ok: true, value };
}

/** Like `parseMoney`, but rejects zero and negative amounts (payments, principal). */
export function parsePositiveMoney(input: string): ParseResult<number> {
  const parsed = parseMoney(input);
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0) {
    return { ok: false, error: 'Amount must be greater than zero.' };
  }
  return parsed;
}

/** Parses a whole-number installment/term count within 1..MAX_TERM_COUNT. */
export function parseTermCount(input: string): ParseResult<number> {
  const raw = (input ?? '').replace(/\s+/g, '');
  if (!raw || !/^\d+$/.test(raw)) {
    return { ok: false, error: 'Number of installments must be a whole number.' };
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_TERM_COUNT) {
    return { ok: false, error: `Number of installments must be between 1 and ${MAX_TERM_COUNT}.` };
  }
  return { ok: true, value };
}

/** Parses an interest rate percentage within 0..100 with at most 2 decimals. */
export function parseInterestRate(input: string): ParseResult<number> {
  const raw = (input ?? '').replace(/\s+/g, '');
  if (!raw || !/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, error: 'Interest rate must be a number like 5 or 2.5 (no negative values).' };
  }
  const value = round2(Number(raw));
  if (value > 100) {
    return { ok: false, error: 'Interest rate cannot exceed 100%.' };
  }
  return { ok: true, value };
}

/**
 * Keeps only characters that are safe inside a `tel:` / `sms:` URI
 * (blocks `;`, `#`, `?` which can retarget the intent on some platforms).
 */
export function sanitizePhoneForUri(raw: string): string {
  const plusPrefixed = (raw ?? '').trim().startsWith('+');
  const digits = (raw ?? '').replace(/\D/g, '');
  return plusPrefixed ? `+${digits}` : digits;
}

/** True when the text contains 7-15 digits (loose international-friendly check). */
export function isValidPhone(raw: string): boolean {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** Trims and caps free-text fields so a stray paste cannot bloat a row. */
export function clampText(value: string | undefined | null, max: number = MAX_TEXT_LENGTH): string | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Renders one CSV cell safely.
 *
 * Two separate problems are handled here, and both are real defect classes rather than theory:
 *
 *  1. **Formula injection.** Excel, LibreOffice and Google Sheets treat a cell beginning with
 *     `=`, `+`, `-`, `@`, tab or CR as a formula. A borrower named `=HYPERLINK(...)` — or a
 *     description pasted from somewhere else — would then *execute* when the treasurer opens the
 *     export. Such values get a leading apostrophe, which spreadsheets read as "text starts here".
 *     Genuine numbers (`-500`) are exempt so negative amounts stay numeric.
 *  2. **Quoting.** Per RFC 4180 every field is quoted and embedded quotes are doubled, so a name
 *     containing a comma, quote or newline can no longer break the column structure.
 */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const isPlainNumber = /^-?\d+(\.\d+)?$/.test(raw);
  const needsFormulaGuard = !isPlainNumber && /^[=+\-@\t\r]/.test(raw);
  const guarded = needsFormulaGuard ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Joins one row of CSV cells, each rendered through `csvCell`. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

