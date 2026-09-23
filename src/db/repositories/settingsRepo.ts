import { getDatabase, runWriteTransaction } from '../client';

/**
 * Treasurer preferences, persisted in the `app_settings` table.
 *
 * These values previously lived only in Zustand memory, so every "Save Changes"
 * reverted on the next cold start. All reads go through `getAll()` and the store
 * is hydrated from the database on boot.
 */

export type SettingKey =
  | 'currency_symbol'
  | 'org_name'
  | 'last_backup_at'
  /** Fingerprint of the book when the last backup was written (see `backupService`). */
  | 'last_backup_marker'
  /**
   * Legacy home of the receipt signing secret. It now lives in the OS keystore (see
   * `services/receiptService` and `utils/secrets`); this key is still read once so an upgrade
   * adopts the existing secret — which keeps receipts already handed out verifiable — and is then
   * deleted. It is also the fallback on platforms with no keystore (the web preview).
   */
  | 'receipt_secret';

export const DEFAULT_SETTINGS: Record<SettingKey, string> = {
  currency_symbol: '₱',
  org_name: 'Community Treasury',
  last_backup_at: '',
  last_backup_marker: '',
  receipt_secret: '',
};

const SETTING_KEYS: SettingKey[] = [
  'currency_symbol',
  'org_name',
  'last_backup_at',
  'last_backup_marker',
  'receipt_secret',
];

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as string[]).includes(key);
}

export const settingsRepo = {
  /** Reads one setting, falling back to the built-in default. */
  async get(key: SettingKey): Promise<string> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM app_settings WHERE key = ?`,
      [key]
    );
    return row?.value ?? DEFAULT_SETTINGS[key];
  },

  /** Reads every setting, merged over the defaults (never returns undefined values). */
  async getAll(): Promise<Record<SettingKey, string>> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings`
    );

    const settings: Record<SettingKey, string> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (isSettingKey(row.key) && row.value) {
        settings[row.key] = row.value;
      }
    }
    return settings;
  },

  /** Upserts a single setting. */
  async set(key: SettingKey, value: string): Promise<void> {
    await this.setMany({ [key]: value } as Partial<Record<SettingKey, string>>);
  },

  /**
   * Removes a setting. Used to delete the legacy receipt-secret copy once it has been adopted into
   * the OS keystore, so it can never travel inside a backup file again.
   */
  async clear(key: SettingKey): Promise<void> {
    await runWriteTransaction(async (txn) => {
      await txn.runAsync(`DELETE FROM app_settings WHERE key = ?`, [key]);
    });
  },

  /** Upserts several settings atomically. */
  async setMany(values: Partial<Record<SettingKey, string>>): Promise<void> {
    const entries = (Object.entries(values) as [SettingKey, string | undefined][]).filter(
      (entry): entry is [SettingKey, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''
    );
    if (entries.length === 0) return;

    await runWriteTransaction(async (txn) => {
      for (const [key, value] of entries) {
        await txn.runAsync(
          `INSERT INTO app_settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [key, value.trim()]
        );
      }
    });
  },
};
