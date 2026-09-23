import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { getDatabase, runWriteTransaction } from '../db/client';
import { hasAnyRecords } from '../db/maintenance';
import { SCHEMA_VERSION } from '../db/migrations';
import {
  BACKUP_TABLE_ORDER,
  TABLE_SINCE,
  TABLE_SPECS,
  isEvidenceTable,
  tablesOfKind,
  type BackupTable,
} from '../db/tables';
import { auditRepo } from '../db/repositories/auditRepo';
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
import { stripDeviceSecrets } from '../utils/secrets';

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
 * The tables a backup carries come from the one registry in `db/tables.ts` — the same list the
 * wipe uses, so the two can no longer drift apart (they already had: the wipe cleared 5 tables
 * while a backup carried 6).
 */
const BACKUP_TABLES = BACKUP_TABLE_ORDER;

export type { BackupTable };
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

    // Preferences travel for the currency symbol and the organisation name, but device-only
    // secrets never leave: see utils/secrets — a backup is a file the treasurer emails to
    // themselves, and it must not be a receipt-forging kit.
    const safeRows = table === 'app_settings' ? stripDeviceSecrets(rows) : rows;

    data[table] = safeRows;
    counts[table] = safeRows.length;
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

  // An empty book is not worth a rotation slot: after a deliberate wipe, automatic backups of an
  // empty database would otherwise evict the copies that still hold the erased records — the very
  // files the treasurer would want to restore from.
  if (!(await hasAnyRecords())) {
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

export interface RestoreResult {
  /** Rows written per table. */
  inserted: Record<BackupTable, number>;
  /** Evidence rows the file did **not** carry, which were left in place instead of deleted. */
  evidenceKept: number;
  /** Business rows that were replaced. */
  replaced: number;
}

/**
 * Replaces the records with the contents of a validated backup, in one exclusive transaction.
 *
 * Two rules that matter more than the mechanics:
 *
 *  1. **Business tables are replaced; evidence tables are merged.** The audit trail and the
 *     published seals are the only thing that can prove what happened, and a backup written before
 *     1.0.5 does not carry them at all. Deleting them because the file is silent about them would
 *     destroy evidence the treasurer may already have published to members.
 *  2. **The restore itself is recorded.** The restored trail is followed by one new entry saying
 *     the book was replaced and from which file, chain-linked to whatever head the merged trail
 *     ended on. Otherwise the app's central claim — every change is on the record — would have a
 *     hole exactly where the biggest change happens.
 */
export async function restoreBackup(payload: BackupPayload): Promise<RestoreResult> {
  const inserted = {} as Record<BackupTable, number>;
  let evidenceKept = 0;

  await runWriteTransaction(async (txn) => {
    // Records first: children before parents.
    for (const table of [...tablesOfKind('business')].reverse()) {
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

      const evidence = isEvidenceTable(table);
      if (evidence) {
        const existing = await txn.getFirstAsync<{ total: number }>(
          `SELECT COUNT(*) as total FROM ${table}`
        );
        const existingCount = Number(existing?.total ?? 0);

        // The device's own evidence is authoritative when it has any: it is the same chain the
        // backup came from, only longer. Merging two chains would break verification (the walk
        // requires each entry to link to the one before it) and raise a false tamper alarm, which
        // for a trust feature is nearly as bad as missing a real one. The file's evidence is
        // adopted only when the device has none — a new phone, or after a wipe.
        if (existingCount > 0) {
          evidenceKept += existingCount;
          continue;
        }
      }

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

    const replaced = tablesOfKind('business').reduce((sum, table) => sum + inserted[table], 0);

    await auditRepo.logWith(txn, {
      entity: 'database',
      entityId: payload.generatedAt,
      action: 'RESTORE',
      reason: `Book replaced from backup ${payload.generatedAt} (schema v${payload.schemaVersion})`,
      after: {
        replaced,
        inserted: inserted as unknown as Record<string, number>,
        evidenceKept,
      },
    });
  });

  const replaced = tablesOfKind('business').reduce((sum, table) => sum + inserted[table], 0);
  return { inserted, evidenceKept, replaced };
}

