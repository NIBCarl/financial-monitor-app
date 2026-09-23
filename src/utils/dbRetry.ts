/**
 * Retry policy for SQLite write transactions.
 *
 * `expo-sqlite`'s `withExclusiveTransactionAsync` is documented to abort *other* async write
 * queries with a `database is locked` error while it holds the write lock. This app really can try
 * two writes at once — a treasurer saving a payment while the automatic backup stamps its settings
 * row, or two taps that land in the same frame — and losing a payment to a lock error is not an
 * acceptable outcome.
 *
 * Two layers answer that: writes are queued in `db/client.ts` so they take turns, and a lock error
 * that still gets through is retried a couple of times with a short, increasing delay. The policy
 * is pure so the harness can hold it still.
 */

/** Total attempts for one write, including the first. */
export const MAX_WRITE_ATTEMPTS = 3;

/** Delays between attempts, in milliseconds (index 0 is the first retry). */
export const WRITE_RETRY_DELAYS_MS = [40, 120, 300];

/** True when the driver refused a write because another connection/transaction holds the lock. */
export function isDatabaseLocked(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

/** Delay before retry number `attempt` (1-based; 0 means "run now"). */
export function retryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return 0;
  return WRITE_RETRY_DELAYS_MS[attempt - 2] ?? WRITE_RETRY_DELAYS_MS[WRITE_RETRY_DELAYS_MS.length - 1];
}

/** True when another attempt is worth making. */
export function shouldRetryWrite(attempt: number, error: unknown): boolean {
  return attempt < MAX_WRITE_ATTEMPTS && isDatabaseLocked(error);
}

/** Sleeps for the retry delay of `attempt`. */
export function waitBeforeRetry(attempt: number): Promise<void> {
  const delay = retryDelayMs(attempt);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}
