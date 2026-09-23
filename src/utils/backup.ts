import { parseDbTimestamp } from './financial';

/**
 * Backup policy (report §20.9).
 *
 * The rules that decide *when* a backup happens and *what* is kept, kept as pure functions so they
 * can be tested without a device and so the Reports screen and the boot path can never disagree
 * about whether the book is overdue for a backup.
 */

/** How many automatic versions stay on the device. */
export const AUTO_BACKUP_KEEP = 5;

/** Automatic backups run at most this often. */
export const AUTO_BACKUP_INTERVAL_HOURS = 20;

/** After this long without any backup at all, the treasurer is nagged. */
export const BACKUP_STALE_DAYS = 7;

/** Automatic backups are named so that sorting them alphabetically sorts them by age. */
export const AUTO_BACKUP_PREFIX = 'treasurer-vault-auto-';

const DAY_MS = 86400000;

/**
 * FNV-1a (32-bit) over the serialised data. Fast, deterministic, dependency-free.
 *
 * This detects corruption and accidental edits; it is not a signature and is not meant to resist a
 * determined attacker who already has the file.
 */
export function checksumOf(serialised: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialised.length; i++) {
    hash ^= serialised.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Serialises exactly the tables named, in that order, filling absent ones with an empty list.
 *
 * The table list is a parameter because a checksum can only be re-verified against the tables the
 * file itself declares: a backup written before `signatures` existed must still validate, or every
 * older backup the treasurer holds would be rejected as "damaged".
 */
export function serialiseBackupTables(
  data: Record<string, unknown[] | undefined>,
  tables: readonly string[]
): string {
  return JSON.stringify(
    tables.reduce<Record<string, unknown>>((acc, table) => {
      acc[table] = data[table] ?? [];
      return acc;
    }, {})
  );
}

/** Age of the last backup in whole days, or `null` when there has never been one. */
export function backupAgeDays(
  lastBackupAt: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!lastBackupAt) return null;

  const at = parseDbTimestamp(lastBackupAt);
  const elapsed = now.getTime() - at.getTime();
  if (!Number.isFinite(elapsed)) return null;

  return Math.max(0, Math.floor(elapsed / DAY_MS));
}

/** True when an automatic backup is due: never backed up, or the last one has aged out. */
export function isAutoBackupDue(
  lastBackupAt: string | null | undefined,
  now: Date = new Date(),
  intervalHours: number = AUTO_BACKUP_INTERVAL_HOURS
): boolean {
  if (!lastBackupAt) return true;

  const elapsedHours = (now.getTime() - parseDbTimestamp(lastBackupAt).getTime()) / 3600000;
  if (!Number.isFinite(elapsedHours)) return true;

  // A clock that moved backwards must not stop backups for good.
  if (elapsedHours < 0) return true;

  return elapsedHours >= intervalHours;
}

/** True when the book has gone long enough without a backup to warn the treasurer. */
export function isBackupStale(
  lastBackupAt: string | null | undefined,
  now: Date = new Date(),
  staleDays: number = BACKUP_STALE_DAYS
): boolean {
  const age = backupAgeDays(lastBackupAt, now);
  return age === null || age >= staleDays;
}

/** Short human phrasing of the backup age, for the dashboard and the Reports card. */
export function describeBackupAge(
  lastBackupAt: string | null | undefined,
  now: Date = new Date()
): string {
  const age = backupAgeDays(lastBackupAt, now);
  if (age === null) return 'Never backed up';
  if (age === 0) return 'Backed up today';
  if (age === 1) return 'Backed up yesterday';
  return `Backed up ${age} days ago`;
}

/** Timestamp-sortable file name for an automatic backup. */
export function autoBackupFileName(generatedAt: string): string {
  const stamp = generatedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${AUTO_BACKUP_PREFIX}${stamp}.json`;
}

/** True for names this app created for its own rotating backups. */
export function isAutoBackupFileName(fileName: string): boolean {
  return fileName.startsWith(AUTO_BACKUP_PREFIX) && fileName.endsWith('.json');
}

/**
 * Which files a rotation deletes: everything past the newest `keep`.
 *
 * Names are timestamp-sortable, so newest-first is a plain string sort. Names this app did not
 * create are left alone — the folder is the app's own, but deleting a file we cannot identify is
 * not this function's call.
 */
export function selectAutoBackupsToDelete(fileNames: string[], keep: number = AUTO_BACKUP_KEEP): string[] {
  const ours = fileNames.filter(isAutoBackupFileName).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return ours.slice(Math.max(0, keep));
}
