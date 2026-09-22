import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { migrateDatabase } from './migrations';

const DATABASE_NAME = 'financial_monitor.db';

let dbInstance: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

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
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
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
 * Native: `withExclusiveTransactionAsync`, so no other async query can interleave with a
 * money-moving write. Web: that API is **not supported** (per the expo-sqlite docs), so it
 * falls back to `withTransactionAsync` — web is only a preview surface for this app.
 */
export async function runWriteTransaction<T>(task: (handle: WriteHandle) => Promise<T>): Promise<T> {
  const db = await getDatabase();
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

/**
 * Deletes every business record (borrowers, loans, schedules, payments, ledger)
 * while keeping treasurer preferences. Runs in one transaction so a failure cannot
 * leave a partially wiped database behind.
 */
export async function resetEntireDatabase(): Promise<void> {
  await runWriteTransaction(async (handle) => {
    await handle.execAsync(`
      DELETE FROM loan_payments;
      DELETE FROM loan_schedules;
      DELETE FROM loans;
      DELETE FROM borrowers;
      DELETE FROM ledger_transactions;
    `);
  });

  const db = await getDatabase();
  await db.execAsync(`PRAGMA optimize;`);
}

