import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { getDatabase, runWriteTransaction } from '../db/client';
import { SCHEMA_VERSION } from '../db/migrations';
import { settingsRepo } from '../db/repositories/settingsRepo';
import {
  AUTO_BACKUP_KEEP,
  AUTO_BACKUP_PREFIX,
  autoBackupFileName,
  checksumOf,
  describeBackupAge,
  isAutoBackupDue,
  isBackupStale,
  selectAutoBackupsToDelete,
  serialiseBackupTables,
} from '../utils/backup';

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

/**
 * Every table that carries business meaning, with the schema version that introduced it.
 *
 * `since` matters on restore: a backup written by an older app legitimately has no `signatures`
 * section, and refusing to restore it because of a table that did not exist yet would strand the
 * very backups this feature exists to bring back.
 */
const TABLE_SPECS = [
  { name: 'borrowers', since: 1, label: 'Borrowers' },
  { name: 'loans', since: 1, label: 'Loans' },
  { name: 'loan_schedules', since: 1, label: 'Installments' },
  { name: 'loan_payments', since: 1, label: 'Payments' },
  { name: 'ledger_transactions', since: 1, label: 'Ledger entries' },
  { name: 'app_settings', since: 1, label: 'Preferences' },
  { name: 'audit_log', since: 2, label: 'Audit entries' },
  { name: 'ledger_seals', since: 3, label: 'Month seals' },
  { name: 'penalty_rules', since: 4, label: 'Penalty rules' },
  { name: 'penalty_charges', since: 4, label: 'Penalty charges' },
  { name: 'signatures', since: 5, label: 'Signatures' },
] as const;

export type BackupTable = (typeof TABLE_SPECS)[number]['name'];

/** Insert order respects foreign keys; deletion happens in reverse. */
const BACKUP_TABLES: readonly BackupTable[] = TABLE_SPECS.map((spec) => spec.name);

const TABLE_SINCE: Record<BackupTable, number> = TABLE_SPECS.reduce(
  (acc, spec) => ({ ...acc, [spec.name]: spec.since }),
  {} as Record<BackupTable, number>
);

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

/**
 * The checksum of a full backup: every table, in insert order. Restore re-verifies against the
 * tables the file itself declares, which is why that direction passes its own list.
 */
function serialiseData(data: BackupData, tables: readonly BackupTable[] = BACKUP_TABLES): string {
  return serialiseBackupTables(data as unknown as Record<string, unknown[] | undefined>, tables);
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

// ---------------------------------------------------------------------------
// Automatic rotating backups (report §20.9)
// ---------------------------------------------------------------------------

export interface StoredBackup {
  uri: string;
  fileName: string;
  generatedAt: string;
  sizeBytes: number;
}

export interface AutoBackupOutcome {
  /** False when the cadence says "not yet" (or the app was already backed up today). */
  created: boolean;
  summary: BackupSummary | null;
  lastBackupAt: string;
  ageLabel: string;
  stale: boolean;
}

/** The folder the app's own rotating backups live in (kept out of the documents root). */
function autoBackupFolder(): Directory {
  const folder = new Directory(Paths.document, 'backups');
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  return folder;
}

/** Timestamp out of a file name written by `autoBackupFileName`; falls back to the file's mtime. */
function generatedAtFromFileName(file: File, fileName: string): string {
  const match = fileName.match(/(\d{8})-(\d{4})\.json$/);
  if (match) {
    const [, day, time] = match;
    return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(
      0,
      2
    )}:${time.slice(2, 4)}:00.000Z`;
  }
  const modified = file.modificationTime;
  return new Date(modified ?? Date.now()).toISOString();
}

/**
 * Writes one automatic backup into `documents/backups` and rotates the folder down to the newest
 * `AUTO_BACKUP_KEEP` versions. This is the part that closes the "lost phone" hole: the treasurer no
 * longer has to remember anything for the book to have a recent copy on the device.
 */
export async function createAutoBackup(): Promise<BackupSummary> {
  const { json, payload } = await buildBackupJson();
  const folder = autoBackupFolder();
  const fileName = autoBackupFileName(payload.generatedAt);
  const file = new File(folder, fileName);

  file.write(json);

  await pruneAutoBackups();

  return {
    uri: file.uri,
    fileName,
    generatedAt: payload.generatedAt,
    counts: payload.counts,
  };
}

/** Deletes every automatic backup past the newest `AUTO_BACKUP_KEEP`. */
export async function pruneAutoBackups(keep: number = AUTO_BACKUP_KEEP): Promise<string[]> {
  try {
    const folder = new Directory(Paths.document, 'backups');
    if (!folder.exists) return [];

    const fileNames = folder
      .list()
      .filter((entry): entry is File => entry instanceof File)
      .map((entry) => entry.name);

    const doomed = selectAutoBackupsToDelete(fileNames, keep);
    for (const name of doomed) {
      try {
        new File(folder, name).delete();
      } catch (err) {
        // A file that cannot be deleted is not a reason to fail the backup that just succeeded.
        console.warn(`Could not delete old backup ${name}:`, err);
      }
    }
    return doomed;
  } catch (err) {
    console.warn('Backup rotation skipped:', err);
    return [];
  }
}

/** The automatic backups on this device, newest first. */
export async function listAutoBackups(): Promise<StoredBackup[]> {
  const folder = new Directory(Paths.document, 'backups');
  if (!folder.exists) return [];

  return folder
    .list()
    .filter((entry): entry is File => entry instanceof File)
    .filter((entry) => entry.name.startsWith(AUTO_BACKUP_PREFIX))
    .map((entry) => ({
      uri: entry.uri,
      fileName: entry.name,
      generatedAt: generatedAtFromFileName(entry, entry.name),
      sizeBytes: entry.size ?? 0,
    }))
    .sort((a, b) => (a.fileName < b.fileName ? 1 : a.fileName > b.fileName ? -1 : 0));
}

/** Reads the date of the last backup of any kind, or null when there has never been one. */
export async function getLastBackupAt(): Promise<string | null> {
  const value = await settingsRepo.get('last_backup_at');
  return value ? value : null;
}

/**
 * Runs an automatic backup when the cadence says it is due, and stamps the time so the next app
 * open can tell. Called when the app opens: a phone that is used daily is therefore never more
 * than a day behind, without the treasurer doing anything.
 */
export async function runAutoBackupIfDue(): Promise<AutoBackupOutcome> {
  const lastBackupAt = await getLastBackupAt();
  const now = new Date();

  if (!isAutoBackupDue(lastBackupAt, now)) {
    return {
      created: false,
      summary: null,
      lastBackupAt: lastBackupAt ?? '',
      ageLabel: describeBackupAge(lastBackupAt, now),
      stale: isBackupStale(lastBackupAt, now),
    };
  }

  const summary = await createAutoBackup();
  await settingsRepo.set('last_backup_at', summary.generatedAt);

  return {
    created: true,
    summary,
    lastBackupAt: summary.generatedAt,
    ageLabel: describeBackupAge(summary.generatedAt, now),
    stale: false,
  };
}

/** Restores from one of the device's own rotating backups, after the caller confirms. */
export async function restoreFromStoredBackup(uri: string): Promise<BackupPayload> {
  const validation = await readAndValidateBackup(uri);
  if (!validation.valid || !validation.payload) {
    throw new Error(validation.error ?? 'That backup could not be used.');
  }
  return validation.payload;
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
  const declaredTables: BackupTable[] = [];

  for (const spec of TABLE_SPECS) {
    const rows = (payload.data as BackupData)[spec.name];

    // A table that did not exist when this backup was written is simply empty, not invalid.
    if (!Array.isArray(rows)) {
      if (payload.schemaVersion >= TABLE_SINCE[spec.name]) {
        return { valid: false, error: `The backup is missing the "${spec.name}" table.` };
      }
      data[spec.name] = [];
      continue;
    }

    data[spec.name] = rows;
    declaredTables.push(spec.name);
  }

  // Verified against the tables the file actually carries, so a backup from an older app version
  // (fewer tables, checksum over just those) still validates.
  const expectedChecksum = checksumOf(serialiseData(data, declaredTables));
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
  return TABLE_SPECS.map((spec) => `${spec.label}: ${counts[spec.name] ?? 0}`).join('\n');
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

