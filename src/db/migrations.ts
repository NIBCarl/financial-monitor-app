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

export const SCHEMA_VERSION = 5;

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
  {
    version: 3,
    name: 'audit_hash_chain_and_seals',
    /**
     * Tamper-evidence upgrade.
     *
     * v2 already records *what* changed, but a single-operator device could rewrite the trail
     * itself. Each audit entry now carries the hash of the entry before it, so silently editing
     * or deleting history breaks every hash after the change point.
     *
     * Rows written before this migration have no hash (NULL) and are reported as "unsigned";
     * the chain starts at the first signed entry, so existing installs upgrade cleanly.
     */
    up: async (db) => {
      await db.execAsync(`
        ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
        ALTER TABLE audit_log ADD COLUMN entry_hash TEXT;

        CREATE TABLE IF NOT EXISTS ledger_seals (
          id TEXT PRIMARY KEY NOT NULL,
          period TEXT NOT NULL,
          chain_head TEXT NOT NULL,
          audit_count INTEGER NOT NULL,
          inflow_total REAL NOT NULL,
          outflow_total REAL NOT NULL,
          outstanding_total REAL NOT NULL,
          overdue_total REAL NOT NULL,
          active_loans INTEGER NOT NULL,
          borrower_count INTEGER NOT NULL,
          seal_code TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_seals_period ON ledger_seals(period, created_at);
      `);
    },
  },
  {
    version: 4,
    name: 'configurable_penalties',
    /**
     * Penalties the treasury configures rather than the app inventing.
     *
     * `penalty_rules` is the policy ("2% per week after 3 days grace, on this loan"); a rule can be
     * scoped to one loan or to one borrower. `penalty_charges` is a policy *applied* — a concrete
     * amount attached to one overdue installment, written only when the treasurer assesses it, so
     * money never appears on a borrower's account as a surprise.
     *
     * Both tables are append-only in spirit: nothing is deleted, charges are waived (with a reason,
     * audited) and rules are superseded by adding a new one.
     */
    up: async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS penalty_rules (
          id TEXT PRIMARY KEY NOT NULL,
          scope TEXT NOT NULL,
          borrower_id TEXT NOT NULL,
          loan_id TEXT,
          basis TEXT NOT NULL,
          amount REAL NOT NULL,
          period TEXT NOT NULL,
          grace_days INTEGER NOT NULL DEFAULT 0,
          cap_amount REAL,
          reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          waived_at TEXT,
          waived_reason TEXT,
          FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE CASCADE,
          FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_penalty_rules_borrower ON penalty_rules(borrower_id, waived_at);
        CREATE INDEX IF NOT EXISTS idx_penalty_rules_loan ON penalty_rules(loan_id);

        CREATE TABLE IF NOT EXISTS penalty_charges (
          id TEXT PRIMARY KEY NOT NULL,
          rule_id TEXT NOT NULL,
          loan_id TEXT NOT NULL,
          borrower_id TEXT NOT NULL,
          schedule_id TEXT,
          installment_number INTEGER,
          amount REAL NOT NULL,
          days_late INTEGER NOT NULL DEFAULT 0,
          periods INTEGER NOT NULL DEFAULT 0,
          paid_amount REAL NOT NULL DEFAULT 0,
          waived_at TEXT,
          waived_reason TEXT,
          assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
          FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_penalty_charges_loan ON penalty_charges(loan_id, waived_at);
        CREATE INDEX IF NOT EXISTS idx_penalty_charges_borrower ON penalty_charges(borrower_id, waived_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_penalty_charges_unique
          ON penalty_charges(rule_id, schedule_id) WHERE schedule_id IS NOT NULL;
      `);
    },
  },
  {
    version: 5,
    name: 'borrower_signatures',
    /**
     * The borrower's own mark on the money (report §20.6).
     *
     * Until now the app was the treasurer's private notebook: nothing recorded that the borrower
     * agreed to the loan or acknowledged receiving/handing over cash. These rows are that
     * acknowledgment — captured on the phone at the moment it happened and attached to the exact
     * record, so "I never got that money" has something to answer it.
     *
     * `strokes` is normalised JSON ([[{x,y}, …], …] with 0..1 coordinates) rather than a bitmap:
     * it stays crisp at any size, embeds directly in a PDF as an SVG path, and cannot smuggle in a
     * photograph of someone else's signature. One signature per record; re-signing replaces it and
     * the previous version stays in the audit log.
     */
    up: async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS signatures (
          id TEXT PRIMARY KEY NOT NULL,
          entity TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          borrower_id TEXT,
          signer_name TEXT,
          strokes TEXT NOT NULL,
          taken_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_signatures_unique ON signatures(entity, entity_id);
        CREATE INDEX IF NOT EXISTS idx_signatures_borrower ON signatures(borrower_id);
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

