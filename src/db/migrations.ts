import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';

/**
 * Schema migrations.
 *
 * The database is versioned with SQLite's own `PRAGMA user_version`. Every
 * migration runs exactly once per device, inside an exclusive transaction, so an
 * interrupted upgrade rolls back instead of leaving a half-applied schema.
 *
 * Existing installs report `user_version = 0`; migration 1 is therefore written
 * to be idempotent (CREATE ... IF NOT EXISTS) so it upgrades them in place
 * without touching their data.
 */

export const SCHEMA_VERSION = 2;

/** Subset of the database API a migration may use (a Transaction satisfies this too). */
type SqlRunner = Pick<SQLite.SQLiteDatabase, 'execAsync' | 'runAsync' | 'getFirstAsync' | 'getAllAsync'>;

interface Migration {
  version: number;
  name: string;
  up: (db: SqlRunner) => Promise<void>;
}

/**
 * Baseline schema (equivalent to the original inline DDL) plus the indexes the hot
 * read paths need:
 *   - loan_payments(loan_id, paid_at)        : per-loan payment history
 *   - loan_payments(paid_at)                 : "collected this month" aggregate
 *   - ledger_transactions(transaction_date)  : ledger ordering/filtering
 *   - loan_schedules(loan_id, installment_number), UNIQUE : FIFO allocation + duplicate guard
 */
const BASELINE_DDL = `
  CREATE TABLE IF NOT EXISTS borrowers (
    id TEXT PRIMARY KEY NOT NULL,
    full_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    category_tag TEXT DEFAULT 'General',
    photo_uri TEXT,
    address TEXT,
    guarantor_info TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_borrowers_name ON borrowers(full_name);
  CREATE INDEX IF NOT EXISTS idx_borrowers_phone ON borrowers(phone_number);

  CREATE TABLE IF NOT EXISTS loans (
    id TEXT PRIMARY KEY NOT NULL,
    borrower_id TEXT NOT NULL,
    principal_amount REAL NOT NULL,
    interest_rate REAL NOT NULL,
    interest_type TEXT NOT NULL,
    frequency TEXT NOT NULL,
    term_count INTEGER NOT NULL,
    total_payable REAL NOT NULL,
    remaining_balance REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_id);
  CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);

  CREATE TABLE IF NOT EXISTS loan_schedules (
    id TEXT PRIMARY KEY NOT NULL,
    loan_id TEXT NOT NULL,
    installment_number INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    expected_amount REAL NOT NULL,
    paid_amount REAL NOT NULL DEFAULT 0.0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    settled_date TEXT,
    FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_schedules_due_date ON loan_schedules(due_date);
  CREATE INDEX IF NOT EXISTS idx_schedules_status ON loan_schedules(status);
  CREATE INDEX IF NOT EXISTS idx_schedules_loan ON loan_schedules(loan_id, installment_number);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_schedules_loan_installment
    ON loan_schedules(loan_id, installment_number);

  CREATE TABLE IF NOT EXISTS loan_payments (
    id TEXT PRIMARY KEY NOT NULL,
    loan_id TEXT NOT NULL,
    schedule_id TEXT,
    amount_paid REAL NOT NULL,
    payment_method TEXT NOT NULL,
    reference_no TEXT,
    notes TEXT,
    paid_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE RESTRICT,
    FOREIGN KEY (schedule_id) REFERENCES loan_schedules(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_payments_loan ON loan_payments(loan_id, paid_at);
  CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON loan_payments(paid_at);

  CREATE TABLE IF NOT EXISTS ledger_transactions (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    related_loan_id TEXT,
    transaction_date TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (related_loan_id) REFERENCES loans(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_transactions(transaction_date);
  CREATE INDEX IF NOT EXISTS idx_ledger_related_loan ON ledger_transactions(related_loan_id);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
`;

/** Removes the demo rows that shipped with the first build. Runs once. */
async function purgeLegacySampleRows(db: SqlRunner): Promise<void> {
  await db.execAsync(`
    DELETE FROM loan_payments WHERE loan_id LIKE 'loan-sample%';
    DELETE FROM loan_schedules WHERE loan_id LIKE 'loan-sample%';
    DELETE FROM loans WHERE id LIKE 'loan-sample%';
    DELETE FROM borrowers WHERE id LIKE 'b-sample%';
    DELETE FROM ledger_transactions WHERE id = 'tx-initial';
  `);
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline_schema_and_indexes',
    up: async (db) => {
      await db.execAsync(BASELINE_DDL);
      await db.runAsync(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?), (?, ?)`, [
        'currency_symbol',
        '₱',
        'org_name',
        'Community Treasury',
      ]);
      await purgeLegacySampleRows(db);
    },
  },
  {
    version: 2,
    name: 'audit_log_and_void_support',
    /**
     * Trust layer: financial rows are never deleted — they are *voided* (kept, flagged,
     * excluded from totals) and every change is recorded in an append-only audit log.
     *
     * `ALTER TABLE ... ADD COLUMN` is safe here because each migration runs exactly once
     * per device (guarded by PRAGMA user_version), and fresh installs run v1 then v2.
     */
    up: async (db) => {
      await db.execAsync(`
        ALTER TABLE loan_payments ADD COLUMN voided_at TEXT;
        ALTER TABLE loan_payments ADD COLUMN void_reason TEXT;
        ALTER TABLE ledger_transactions ADD COLUMN voided_at TEXT;
        ALTER TABLE ledger_transactions ADD COLUMN void_reason TEXT;

        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY NOT NULL,
          entity TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          reason TEXT,
          before_json TEXT,
          after_json TEXT,
          actor TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_payments_active ON loan_payments(loan_id, voided_at);
        CREATE INDEX IF NOT EXISTS idx_ledger_voided ON ledger_transactions(voided_at);
      `);
    },
  },
];

export function getCurrentSchemaVersion(): number {
  return SCHEMA_VERSION;
}

/**
 * Runs a migration body in one transaction. `withExclusiveTransactionAsync` is not
 * supported on web (a preview surface only), so web falls back to a plain transaction —
 * this keeps `expo start --web` able to bootstrap a schema for UI work.
 */
async function runMigrationTransaction(
  db: SQLite.SQLiteDatabase,
  work: (handle: SqlRunner) => Promise<void>
): Promise<void> {
  if (Platform.OS === 'web') {
    await db.withTransactionAsync(async () => {
      await work(db);
    });
    return;
  }

  await db.withExclusiveTransactionAsync(async (txn) => {
    await work(txn);
  });
}

/**
 * Brings the database up to `SCHEMA_VERSION` and returns the version now applied.
 * Safe to call on every launch: once up to date it is a single cheap PRAGMA read.
 */
export async function migrateDatabase(db: SQLite.SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const appliedVersion = Number(row?.user_version ?? 0);

  if (appliedVersion >= SCHEMA_VERSION) {
    return appliedVersion;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= appliedVersion) continue;
    if (!Number.isInteger(migration.version)) {
      throw new Error(`Invalid migration version: ${String(migration.version)}`);
    }

    await runMigrationTransaction(db, async (handle) => {
      await migration.up(handle);
      // migration.version is a compile-time integer constant, never user input.
      await handle.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
  }

  return SCHEMA_VERSION;
}

