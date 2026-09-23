/**
 * The one list of tables this app owns.
 *
 * Backup, restore and the "reset database" action all derive their table lists from here, because
 * when those three kept their own copies they drifted: the wipe cleared 5 tables while a backup
 * carried 11, so a wipe left orphan fines and signatures behind, and a restore of an older file
 * quietly deleted the audit trail.
 *
 * `kind` decides what happens to a table:
 *  - **business** — the treasurer's records (borrowers, loans, payments, ledger, fines,
 *    signatures, preferences). A restore replaces them; a reset erases them.
 *  - **evidence** — the tamper-evident trail and the seals published from it. A restore *merges*
 *    them (never deletes newer evidence); a reset erases them too, because a treasurer who asks
 *    for the book to be wiped is asking for the names in it to be gone as well — and the wipe
 *    itself is recorded as the first entry of the fresh chain.
 *
 * Pure data: no imports, so it is covered by the verification harness.
 */

export type TableKind = 'business' | 'evidence';

export interface TableSpec {
  name: string;
  /** Schema version that introduced the table; older backups legitimately omit it. */
  since: number;
  /** Label used in the "what is inside this file" dialog. */
  label: string;
  kind: TableKind;
}

/** Insert order respects foreign keys: parents, then children, then evidence. */
export const TABLE_SPECS: readonly TableSpec[] = [
  { name: 'borrowers', since: 1, label: 'Borrowers', kind: 'business' },
  { name: 'loans', since: 1, label: 'Loans', kind: 'business' },
  { name: 'loan_schedules', since: 1, label: 'Installments', kind: 'business' },
  { name: 'loan_payments', since: 1, label: 'Payments', kind: 'business' },
  { name: 'ledger_transactions', since: 1, label: 'Ledger entries', kind: 'business' },
  { name: 'app_settings', since: 1, label: 'Preferences', kind: 'business' },
  { name: 'penalty_rules', since: 4, label: 'Penalty rules', kind: 'business' },
  { name: 'penalty_charges', since: 4, label: 'Penalty charges', kind: 'business' },
  { name: 'signatures', since: 5, label: 'Signatures', kind: 'business' },
  { name: 'audit_log', since: 2, label: 'Audit entries', kind: 'evidence' },
  { name: 'ledger_seals', since: 3, label: 'Month seals', kind: 'evidence' },
];

export type BackupTable = (typeof TABLE_SPECS)[number]['name'];

/** Every table, in the order a backup writes (and a restore inserts) them. */
export const BACKUP_TABLE_ORDER: readonly BackupTable[] = TABLE_SPECS.map((spec) => spec.name);

export const TABLE_SINCE: Record<BackupTable, number> = TABLE_SPECS.reduce(
  (acc, spec) => ({ ...acc, [spec.name]: spec.since }),
  {} as Record<BackupTable, number>
);

/** Names of the tables with the given kind, in insert order. */
export function tablesOfKind(kind: TableKind): BackupTable[] {
  return TABLE_SPECS.filter((spec) => spec.kind === kind).map((spec) => spec.name);
}

/** True when a table holds evidence (the audit trail, the published seals) rather than records. */
export function isEvidenceTable(name: string): boolean {
  return TABLE_SPECS.some((spec) => spec.name === name && spec.kind === 'evidence');
}

/** How many tables carry the given kind — used by the dialogs ("11 tables are replaced"). */
export function countTables(kind: TableKind): number {
  return TABLE_SPECS.filter((spec) => spec.kind === kind).length;
}
