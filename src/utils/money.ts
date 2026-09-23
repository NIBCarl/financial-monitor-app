/**
 * Money arithmetic in whole centavos.
 *
 * Why this exists: the book used to store peso amounts as binary floating point. `10.1` is not
 * exactly representable in binary, so sums of many "2-decimal" values can end up a hair off —
 * the classic symptom being a balance that should be exactly zero reading `1e-13` and therefore
 * never closing the loan. Integers cannot drift.
 *
 * The rule this file enforces across the app:
 *   - **Pesos (a plain number) is the display/API unit** — it is what the UI, receipts and PDFs
 *     speak, and what every repository method takes and returns.
 *   - **Centavos (an integer) is the storage and arithmetic unit** — every column holds whole
 *     centavos, and every calculation between reading and writing is done here.
 *
 * Rounding is half-away-from-zero (the convention in Philippine accounting and what a treasurer
 * expects when a 2.5-centavo fraction appears), not JavaScript's `Math.round`, which rounds
 * `.5` toward positive infinity and would make `-0.5` into `-0`.
 */

export const CENTS_PER_PESO = 100;

/** Half away from zero: 2.5 -> 3, -2.5 -> -3 (Math.round would give 3 and -2). */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Pesos -> whole centavos. The only place a peso amount may become storage. */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return roundHalfAwayFromZero(amount * CENTS_PER_PESO);
}

/** Centavos -> pesos, for display and for crossing back out of the money layer. */
export function fromCents(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return roundHalfAwayFromZero(cents) / CENTS_PER_PESO;
}

/**
 * Reads a stored value as centavos.
 *
 * Tolerates a legacy row that was written before the centavo migration (schema < 4) by rounding
 * it — such a row holds pesos, so callers must convert old backups through
 * `legacyPesosToCents` instead of relying on this.
 */
export function storedToCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return roundHalfAwayFromZero(value);
}

/** Converts a pre-centavo (peso-denominated) stored value into centavos. */
export function legacyPesosToCents(value: number): number {
  return toCents(value);
}

/**
 * Adds up **peso** amounts and returns the exact total in centavos.
 *
 * Named for what it takes and what it returns, because the alternative (`sumCents` taking pesos)
 * is exactly the kind of 100x mistake this module exists to prevent.
 */
export function sumPesosToCents(values: number[]): number {
  let totalCents = 0;
  for (const value of values) totalCents += toCents(value);
  return totalCents;
}

/**
 * Canonicalises a peso amount to *exactly* two decimals by round-tripping it through centavos.
 *
 * Every place money crosses a boundary — a value read out of SQL, a total summed by SQL, a value
 * about to be written — passes through here. That is what makes the book drift-free in practice:
 * inside the money layer all arithmetic is integer centavos, and at the edges an amount can never
 * be anything other than a whole number of centavos.
 *
 * Why storage stays peso-denominated: the storage format is not what causes drift, *fractional
 * arithmetic* is. Storing `10.01` as a double and immediately rounding it back to 1001 centavos is
 * lossless, so a schema-wide migration to INTEGER affinity (which would require rebuilding tables
 * with foreign keys, and would silently reinterpret every existing backup) buys nothing for the
 * risk it carries. `toCents`/`fromCents` at the boundaries get the same guarantee.
 */
export function canonicalMoney(amount: number): number {
  return fromCents(toCents(amount));
}

/**
 * `percent` of an integer centavo amount, rounded to a whole centavo.
 * `percentOfCents(10500, 5)` === 525  (5% of ₱105.00 = ₱5.25)
 */
export function percentOfCents(cents: number, percent: number): number {
  if (!Number.isFinite(cents) || !Number.isFinite(percent)) return 0;
  return roundHalfAwayFromZero((cents * percent) / 100);
}

/** The larger of zero and `cents` — money owed is never negative. */
export function nonNegativeCents(cents: number): number {
  return cents > 0 ? cents : 0;
}

/**
 * Splits `totalCents` across `parts` as evenly as whole centavos allow, giving any remainder to
 * the final part. Used so an amortization schedule sums exactly to the total payable.
 */
export function splitCents(totalCents: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents - base * parts;
  return Array.from({ length: parts }, (_, index) => (index === parts - 1 ? base + remainder : base));
}
