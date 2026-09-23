import { getDatabase, runWriteTransaction } from './client';
import { tablesOfKind } from './tables';
import { auditRepo } from './repositories/auditRepo';

/**
 * Database maintenance: the two operations that act on the whole book.
 *
 * These live apart from `client.ts` on purpose. They need the audit trail (so a wipe or a restore
 * is itself on the record), and `auditRepo` already imports the client for its own connection —
 * keeping the wipe here avoids a circular import between the connection and the trail.
 */

/**
 * Deletes every record this app owns, in one transaction, and records the wipe.
 *
 * Two things changed after the audit found `client.resetEntireDatabase` had fallen behind the
 * schema:
 *
 *  - The table list is derived from `db/tables.ts`, so a table added later cannot be forgotten
 *    here while being carried by backups. That drift is exactly how orphan fines and signature
 *    rows survived an "Erase All Data".
 *  - The wipe also clears the audit trail and the published seals, because a treasurer asking for
 *    the book to be erased is asking for the names and amounts inside it to be gone. The wipe is
 *    then recorded as the first entry of the fresh chain, so the *fact* of the erase survives even
 *    though its contents do not.
 *
 * Preferences (currency, organisation name, the date of the last backup) are kept: they are app
 * configuration, not records. So is the receipt signing secret — it lives in the OS keystore
 * (see utils/secrets), which is why receipts already handed to borrowers keep verifying. The
 * copies in `documents/backups` are kept too: that is what makes an accidental erase recoverable
 * from Reports → Restore a Device Backup.
 */
export async function resetEntireDatabase(reason?: string): Promise<void> {
  const erased = [...tablesOfKind('business'), ...tablesOfKind('evidence')];

  await runWriteTransaction(async (handle) => {
    for (const table of erased) {
      await handle.execAsync(`DELETE FROM ${table}`);
    }

    // Keep preferences: app_settings rows other than these are not records, and last_backup_at
    // still points at a real copy of the book that was just erased.
    await handle.execAsync(`
      DELETE FROM app_settings
       WHERE key NOT IN ('currency_symbol', 'org_name', 'last_backup_at');
    `);

    await auditRepo.logWith(handle, {
      entity: 'database',
      entityId: new Date().toISOString(),
      action: 'WIPE',
      reason: reason?.trim() || 'The treasurer erased every record on this device.',
      after: { tables: erased },
    });
  });

  const db = await getDatabase();
  await db.execAsync(`PRAGMA optimize;`);
}

/** True when the book holds something worth a backup (an empty book must not rotate real ones away). */
export async function hasAnyRecords(): Promise<boolean> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ total: number }>(`
    SELECT (SELECT COUNT(*) FROM borrowers) + (SELECT COUNT(*) FROM loans)
         + (SELECT COUNT(*) FROM loan_payments) + (SELECT COUNT(*) FROM ledger_transactions) as total
  `);
  return Number(row?.total ?? 0) > 0;
}
