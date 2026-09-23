import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { migrateDatabase } from './migrations';
import { shouldRetryWrite, waitBeforeRetry } from '../utils/dbRetry';

const DATABASE_NAME = 'financial_monitor.db';

let dbInstance: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Tail of the write queue. Every write transaction chains off it, so two writes can never hold the
 * exclusive lock at the same time (see `runWriteTransaction`).
 */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Returns the single shared database connection, initialising it on first use.
 * The in-flight promise is cached so concurrent callers cannot open two connections.
 */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) {
    return dbInstance;
  }

  if (!initPromise) {
    initPromise = initializeDatabase().catch((error) => {
      initPromise = null; // allow a retry on the next call
      throw error;
    });
  }

  dbInstance = await initPromise;
  return dbInstance;
}

async function initializeDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);

  // WAL + synchronous=NORMAL is the recommended combination for a single-writer
  // app: crash-safe commits with far fewer fsyncs than the default FULL mode.
  // `cache_size` is negative-KiB (4 MB instead of the 2 MB default) and `temp_store = MEMORY`
  // keeps the sorts and GROUP BYs behind the aging/report aggregates out of disk I/O; both are
  // cheap on a modern phone and matter on a five-year book.
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA cache_size = -4000;
    PRAGMA temp_store = MEMORY;
  `);

  const schemaVersion = await migrateDatabase(db);
  if (__DEV__) {
    console.log(`[db] ready — schema v${schemaVersion}`);
  }

  return db;
}

/** Anything a write transaction can run statements on (a Transaction satisfies this). */
export type WriteHandle = Pick<
  SQLite.SQLiteDatabase,
  'execAsync' | 'runAsync' | 'getFirstAsync' | 'getAllAsync' | 'prepareAsync'
>;

/**
 * Runs a write task inside a transaction and returns its result.
 *
 * Two things guard against SQLite's write lock, because both are real in this app:
 *
 *  1. **Writes take turns.** `withExclusiveTransactionAsync` aborts other async writes with
 *     `database is locked` while it holds the lock, and the app can genuinely attempt two at once
 *     (a payment while the automatic backup stamps its settings row, or a double tap landing in the
 *     same frame). Every write therefore goes through one promise chain.
 *  2. **A lock error is retried.** If a write still loses the race — against the driver's own
 *     internal statements, say — it is retried a couple of times with a short delay, because losing
 *     a treasurer's payment to a transient lock is far worse than a 40 ms pause.
 *
 * Native uses `withExclusiveTransactionAsync` so no other async query can interleave with a
 * money-moving write. Web does not support that API (per the expo-sqlite docs), so it falls back to
 * `withTransactionAsync`; web is only a preview surface for this app.
 */
export async function runWriteTransaction<T>(task: (handle: WriteHandle) => Promise<T>): Promise<T> {
  const run = () => executeWriteTransaction(task);

  // `then(run, run)` keeps the queue moving after a failed write instead of stalling every later one.
  const queued = writeQueue.then(run, run);
  writeQueue = queued.then(
    () => undefined,
    () => undefined
  );

  return queued;
}

async function executeWriteTransaction<T>(task: (handle: WriteHandle) => Promise<T>): Promise<T> {
  const db = await getDatabase();

  for (let attempt = 1; ; attempt++) {
    try {
      return await executeOnce(db, task);
    } catch (error) {
      if (!shouldRetryWrite(attempt, error)) throw error;
      if (__DEV__) {
        console.warn(`[db] write blocked by a lock; retrying (attempt ${attempt + 1})`);
      }
      await waitBeforeRetry(attempt + 1);
    }
  }
}

async function executeOnce<T>(
  db: SQLite.SQLiteDatabase,
  task: (handle: WriteHandle) => Promise<T>
): Promise<T> {
  const outcome: { done: boolean; value?: T } = { done: false };

  if (Platform.OS === 'web') {
    await db.withTransactionAsync(async () => {
      outcome.value = await task(db);
      outcome.done = true;
    });
  } else {
    await db.withExclusiveTransactionAsync(async (txn) => {
      outcome.value = await task(txn as unknown as WriteHandle);
      outcome.done = true;
    });
  }

  if (!outcome.done) {
    throw new Error('The database transaction did not complete.');
  }
  return outcome.value as T;
}

/** Refreshes SQLite's query-planner statistics. Cheap; call when the app backgrounds. */
export async function optimizeDatabase(): Promise<void> {
  const db = await getDatabase();
  await db.execAsync(`PRAGMA optimize;`);
}


