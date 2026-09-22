import { getDatabase, type WriteHandle } from '../client';
import { AuditAction, AuditEntity, AuditLogEntry } from '../types';

/**
 * Append-only audit trail.
 *
 * Financial rows are never deleted in this app: they are *voided* and every create/edit/void
 * is recorded here with a reason and a before/after snapshot. This is what makes a
 * single-operator ledger defensible in a co-op audit.
 *
 * Entries are written through the same transaction handle as the change they describe, so a
 * failed write can never leave a trail entry behind (or vice versa).
 */

const MAX_SNAPSHOT_CHARS = 2000;

export interface AuditWriteInput {
  entity: AuditEntity;
  entityId: string;
  action: AuditAction;
  reason?: string;
  /** Snapshot of the row before the change (serialised, truncated). */
  before?: unknown;
  /** Snapshot of the row after the change (serialised, truncated). */
  after?: unknown;
  actor?: string;
}

function serialise(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const json = JSON.stringify(value);
    return json.length > MAX_SNAPSHOT_CHARS ? `${json.slice(0, MAX_SNAPSHOT_CHARS)}…` : json;
  } catch {
    return null;
  }
}

function newAuditId(): string {
  return 'aud_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
}

const AUDIT_COLUMNS = `
  id,
  entity,
  entity_id as entityId,
  action,
  reason,
  before_json as beforeJson,
  after_json as afterJson,
  actor,
  created_at as createdAt
`;

export const auditRepo = {
  /**
   * Appends an entry using an existing transaction handle.
   * Always prefer this over `log()` from inside a write path.
   */
  async logWith(handle: Pick<WriteHandle, 'runAsync'>, input: AuditWriteInput): Promise<string> {
    const id = newAuditId();
    await handle.runAsync(
      `INSERT INTO audit_log (
        id, entity, entity_id, action, reason, before_json, after_json, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        id,
        input.entity,
        input.entityId,
        input.action,
        input.reason ?? null,
        serialise(input.before),
        serialise(input.after),
        input.actor ?? 'treasurer',
      ]
    );
    return id;
  },

  /** Convenience wrapper that opens its own connection (non-transactional use only). */
  async log(input: AuditWriteInput): Promise<string> {
    const db = await getDatabase();
    return this.logWith(db, input);
  },

  /** Full trail for one entity, newest first. */
  async getForEntity(entity: AuditEntity, entityId: string, limit: number = 20): Promise<AuditLogEntry[]> {
    const db = await getDatabase();
    return db.getAllAsync<AuditLogEntry>(
      `SELECT ${AUDIT_COLUMNS}
       FROM audit_log
       WHERE entity = ? AND entity_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [entity, entityId, limit]
    );
  },

  /** Recent activity across the whole book — useful for a "what changed lately" view. */
  async getRecent(limit: number = 50): Promise<AuditLogEntry[]> {
    const db = await getDatabase();
    return db.getAllAsync<AuditLogEntry>(
      `SELECT ${AUDIT_COLUMNS}
       FROM audit_log
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [limit]
    );
  },

  /** Count of recorded changes — surfaced in Reports as a tamper-evidence signal. */
  async count(): Promise<number> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ total: number }>(`SELECT COUNT(*) as total FROM audit_log`);
    return Number(row?.total ?? 0);
  },
};
