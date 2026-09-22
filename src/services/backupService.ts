import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { getDatabase, runWriteTransaction } from '../db/client';
import { SCHEMA_VERSION } from '../db/migrations';

/**
 * Local backup & restore.
 *
 * The app is offline-first *and* was un-backed-up, which made a lost phone a total loss
 * of the organisation's financial history. A backup is a single JSON document holding
 * every business table plus a schema version and a checksum.
 *
 * The checksum detects corruption and accidental edits (it is not a signature and is not
 * intended to resist a determined attacker who already has the file).
 */

export const BACKUP_FORMAT = 'treasurer-vault-backup';

/** Insert order respects foreign keys; deletion happens in reverse. */
const BACKUP_TABLES = [
  'borrowers',
  'loans',
  'loan_schedules',
  'loan_payments',
  'ledger_transactions',
  'app_settings',
] as const;

type BackupTable = (typeof BACKUP_TABLES)[number];

export type BackupData = Record<BackupTable, Record<string, unknown>[]>;

export interface BackupPayload {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  generatedAt: string;
  counts: Record<BackupTable, number>;
  checksum: string;
  data: BackupData;
}

export interface BackupSummary {
  uri: string;
  fileName: string;
  generatedAt: string;
  counts: Record<BackupTable, number>;
}

/** FNV-1a (32-bit) over the serialised data. Fast, deterministic, dependency-free. */
function checksumOf(serialised: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialised.length; i++) {
    hash ^= serialised.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function serialiseData(data: BackupData): string {
  return JSON.stringify(
    BACKUP_TABLES.reduce<Record<string, unknown>>((acc, table) => {
      acc[table] = data[table] ?? [];
      return acc;
    }, {})
  );
}

/** Reads every table into memory and returns the JSON text to persist. */
async function buildBackupJson(): Promise<{ json: string; payload: BackupPayload }> {
  const db = await getDatabase();

  const data = {} as BackupData;
  const counts = {} as Record<BackupTable, number>;

  for (const table of BACKUP_TABLES) {
    const rows = await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM ${table}`);
    data[table] = rows;
    counts[table] = rows.length;
  }

  const payload: BackupPayload = {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    counts,
    checksum: checksumOf(serialiseData(data)),
    data,
  };

  return { json: JSON.stringify(payload, null, 2), payload };
}

function backupFileName(generatedAt: string): string {
  const stamp = generatedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `treasurer-vault-backup-${stamp}.json`;
}

/**
 * Writes a backup into the app's documents directory and returns its summary. The file is
 * kept on disk (so it can be re-shared later); the caller decides whether to push it
 * off-device with `shareBackup`.
 */
export async function createBackup(): Promise<BackupSummary> {
  const { json, payload } = await buildBackupJson();
  const fileName = backupFileName(payload.generatedAt);
  const file = new File(Paths.document, fileName);

  file.write(json);

  return {
    uri: file.uri,
    fileName,
    generatedAt: payload.generatedAt,
    counts: payload.counts,
  };
}

/** Opens the share sheet so the treasurer can store the backup off-device. */
export async function shareBackup(summary: BackupSummary): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(`Sharing is unavailable on this device. The backup is saved as ${summary.fileName}.`);
  }
  await Sharing.shareAsync(summary.uri, {
    mimeType: 'application/json',
    dialogTitle: 'Save your Treasurer Vault backup',
  });
}

/** Lets the treasurer pick a backup file from Drive, email, Downloads, etc. */
export async function pickBackupFile(): Promise<{ uri: string; name: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/plain', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled || !result.assets?.length) {
    return null;
  }
  const asset = result.assets[0];
  return { uri: asset.uri, name: asset.name ?? 'backup.json' };
}

export interface BackupValidation {
  valid: boolean;
  error?: string;
  payload?: BackupPayload;
}

/** Reads and validates a backup file before anything is written to the database. */
export async function readAndValidateBackup(uri: string): Promise<BackupValidation> {
  let text: string;
  try {
    text = await new File(uri).text();
  } catch {
    return { valid: false, error: 'That file could not be read.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: false, error: 'That file is not a valid backup (the JSON could not be parsed).' };
  }

  const payload = parsed as Partial<BackupPayload>;

  if (payload?.format !== BACKUP_FORMAT) {
    return { valid: false, error: 'That file was not created by this app.' };
  }
  if (typeof payload.schemaVersion !== 'number' || payload.schemaVersion > SCHEMA_VERSION) {
    return {
      valid: false,
      error: `This backup was made by a newer version of the app (schema v${String(
        payload.schemaVersion
      )}). Please update the app first.`,
    };
  }
  if (!payload.data || typeof payload.data !== 'object') {
    return { valid: false, error: 'The backup file has no data section.' };
  }

  const data = {} as BackupData;
  for (const table of BACKUP_TABLES) {
    const rows = (payload.data as BackupData)[table];
    if (!Array.isArray(rows)) {
      return { valid: false, error: `The backup is missing the "${table}" table.` };
    }
    data[table] = rows;
  }

  const expectedChecksum = checksumOf(serialiseData(data));
  if (payload.checksum && payload.checksum !== expectedChecksum) {
    return { valid: false, error: 'The backup file appears to be damaged (checksum mismatch).' };
  }

  return {
    valid: true,
    payload: {
      format: BACKUP_FORMAT,
      schemaVersion: payload.schemaVersion,
      generatedAt: payload.generatedAt ?? 'unknown',
      counts: payload.counts ?? ({} as Record<BackupTable, number>),
      checksum: expectedChecksum,
      data,
    },
  };
}

/** Human-readable summary of what a backup contains, for the confirmation dialog. */
export function describeBackup(payload: BackupPayload): string {
  const counts = payload.counts ?? ({} as Record<BackupTable, number>);
  return [
    `Borrowers: ${counts.borrowers ?? 0}`,
    `Loans: ${counts.loans ?? 0}`,
    `Installments: ${counts.loan_schedules ?? 0}`,
    `Payments: ${counts.loan_payments ?? 0}`,
    `Ledger entries: ${counts.ledger_transactions ?? 0}`,
  ].join('\n');
}

/**
 * Replaces the entire database with the contents of a validated backup, in one exclusive
 * transaction: either every table is restored, or nothing changes at all.
 */
export async function restoreBackup(payload: BackupPayload): Promise<Record<BackupTable, number>> {
  const inserted = {} as Record<BackupTable, number>;

  await runWriteTransaction(async (txn) => {
    for (const table of [...BACKUP_TABLES].reverse()) {
      await txn.execAsync(`DELETE FROM ${table}`);
    }

    for (const table of BACKUP_TABLES) {
      const rows = payload.data[table] ?? [];
      inserted[table] = 0;
      if (rows.length === 0) continue;

      // Columns are derived from the backup rows themselves, but every column name is
      // quoted and validated against a strict identifier pattern before it reaches SQL.
      const columns = Object.keys(rows[0]).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
      if (columns.length === 0) continue;

      const columnList = columns.map((c) => `"${c}"`).join(', ');
      const valueList = columns.map(() => '?').join(', ');
      const statement = await txn.prepareAsync(
        `INSERT OR REPLACE INTO ${table} (${columnList}) VALUES (${valueList})`
      );

      try {
        for (const row of rows) {
          await statement.executeAsync(columns.map((column) => (row[column] ?? null) as never));
          inserted[table] += 1;
        }
      } finally {
        await statement.finalizeAsync();
      }
    }
  });

  return inserted;
}

