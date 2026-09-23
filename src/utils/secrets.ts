/**
 * Where the app's device secrets live, and the order in which they are chosen.
 *
 * The receipt signing secret is the weakest link in "a borrower can prove their receipt is
 * genuine": whoever holds it can forge a receipt that verifies. It must therefore never sit in the
 * SQLite file (unencrypted, per §20.8) and never inside a backup file — a backup is the artefact
 * the app tells the treasurer to send to themselves over email or Drive (MASWE-0003 / MASWE-0006).
 *
 * Kept pure so the precedence rules are covered by the harness: the device copy always wins, a
 * legacy in-database copy is adopted exactly once (so receipts already handed out keep verifying)
 * and then removed, and a fresh secret is generated only when there is nothing to adopt.
 */

/** Setting keys that must never be written into a backup file. */
export const DEVICE_SECRET_SETTING_KEYS = ['receipt_secret'] as const;

export type ReceiptSecretSource = 'device' | 'legacy' | 'new';

export interface ReceiptSecretPlan {
  secret: string;
  source: ReceiptSecretSource;
  /** True when the in-database copy was adopted and must now be deleted. */
  clearLegacy: boolean;
}

/** Removes device-only settings from rows on their way into a backup file. */
export function stripDeviceSecrets(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[] = DEVICE_SECRET_SETTING_KEYS
): Record<string, unknown>[] {
  return rows.map((row) => {
    const { key } = row as { key?: unknown };
    if (typeof key === 'string' && keys.includes(key)) return null;
    return row;
  }).filter((row): row is Record<string, unknown> => row !== null);
}

/**
 * Decides which receipt secret this device should use.
 *
 * `generated` is passed in rather than created here so the caller owns the crypto call and this
 * function stays pure.
 */
export function planReceiptSecret(
  deviceSecret: string | null | undefined,
  legacySecret: string | null | undefined,
  generated: string
): ReceiptSecretPlan {
  const device = (deviceSecret ?? '').trim();
  if (device) return { secret: device, source: 'device', clearLegacy: false };

  const legacy = (legacySecret ?? '').trim();
  if (legacy) return { secret: legacy, source: 'legacy', clearLegacy: true };

  return { secret: generated, source: 'new', clearLegacy: false };
}
