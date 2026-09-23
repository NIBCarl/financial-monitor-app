import * as Crypto from 'expo-crypto';
import { getDatabase, type WriteHandle } from '../client';
import { AuditAction, AuditEntity, AuditLogEntry } from '../types';

/**
 * Append-only audit trail, now hash-chained.
 *
 * Financial rows are never deleted in this app: they are *voided* and every create/edit/void
 * is recorded here with a reason and a before/after snapshot. This is what makes a
 * single-operator ledger defensible in a co-op audit.
 *
 * Entries are written through the same transaction handle as the change they describe, so a
 * failed write can never leave a trail entry behind (or vice versa).
 *
 * Tamper-evidence: each entry stores the hash of the entry before it (`prev_hash`) and its own
 * hash (`entry_hash`), so editing or deleting any historical row breaks every later hash. The
 * hash is only as trustworthy as the device, which is why `integrityService` lets the treasury
 * *publish* the chain head each month — after that, even a rewritten database is detectable.
 */

const MAX_SNAPSHOT_CHARS = 2000;

/** `prev_hash` of the first signed entry. */
export const CHAIN_GENESIS = 'GENESIS';

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

export interface ChainVerification {
  ok: boolean;
  /** Signed entries whose hash was recomputed and matched. */
  checked: number;
  /** Entries written before the chain existed (no hash) — reported, never a failure. */
  unsigned: number;
  /** Id of the first entry that did not match, when `ok` is false. */
  brokenAtId?: string;
  /** Human-readable explanation of the break. */
  reason?: string;
  head?: string;
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

/**
 * `datetime('now')` equivalent, produced in JS so the timestamp can be hashed *before* the
 * insert. SQLite's own default would be computed inside the statement, too late to sign.
 */
function utcNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Canonical, order-stable string for one entry. Every field that a verifier can see is
 * included, so changing any of them invalidates the hash.
 */
function chainMessage(entry: {
  id: string;
  entity: string;
  entityId: string;
  action: string;
  reason: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  actor: string;
  createdAt: string;
}): string {
  return [
    entry.id,
    entry.entity,
    entry.entityId,
    entry.action,
    entry.reason ?? '',
    entry.beforeJson ?? '',
    entry.afterJson ?? '',
    entry.actor,
    entry.createdAt,
  ].join('\u0001');
}

async function hashOf(prevHash: string, message: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${prevHash}\u0002${message}`);
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

/** Row shape used when re-walking the chain. */
interface ChainRow {
  id: string;
  entity: string;
  entityId: string;
  action: string;
  reason: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  actor: string;
  createdAt: string;
  prevHash: string | null;
  entryHash: string | null;
}

export const auditRepo = {
  /**
   * Appends an entry using an existing transaction handle.
   * Always prefer this over `log()` from inside a write path.
   */
  async logWith(handle: Pick<WriteHandle, 'runAsync' | 'getFirstAsync'>, input: AuditWriteInput): Promise<string> {
    const id = newAuditId();
    const createdAt = utcNow();
    const reason = input.reason ?? null;
    const beforeJson = serialise(input.before);
    const afterJson = serialise(input.after);
    const actor = input.actor ?? 'treasurer';

    // Chain link: the newest signed entry in insertion order. `rowid` is what the chain
    // follows — `created_at` only has second resolution and several rows can share it.
    const prev = await handle.getFirstAsync<{ entry_hash: string | null }>(
      `SELECT entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`
    );
    const prevHash = prev?.entry_hash ?? CHAIN_GENESIS;

    const entryHash = await hashOf(
      prevHash,
      chainMessage({
        id,
        entity: input.entity,
        entityId: input.entityId,
        action: input.action,
        reason,
        beforeJson,
        afterJson,
        actor,
        createdAt,
      })
    );

    await handle.runAsync(
      `INSERT INTO audit_log (
        id, entity, entity_id, action, reason, before_json, after_json, actor, created_at,
        prev_hash, entry_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.entity, input.entityId, input.action, reason, beforeJson, afterJson, actor, createdAt, prevHash, entryHash]
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

  /** Current head of the chain (the newest signed entry's hash), or null when nothing is signed. */
  async getChainHead(): Promise<string | null> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ entry_hash: string | null }>(
      `SELECT entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`
    );
    return row?.entry_hash ?? null;
  },

  /**
   * Recomputes the whole chain from the genesis entry forward.
   *
   * Walks in `rowid` order (true insertion order) and, for every signed row, rebuilds the
   * expected hash from the row's own fields linked to the previous signed row's hash. Any
   * edit to a field, a swapped reason, a deleted middle entry or a re-ordered trail shows up
   * as a mismatch. Rows written before the chain existed are counted as `unsigned`.
   */
  async verifyChain(): Promise<ChainVerification> {
    const db = await getDatabase();
    const rows = await db.getAllAsync<ChainRow>(
      `SELECT
        id,
        entity,
        entity_id as entityId,
        action,
        reason,
        before_json as beforeJson,
        after_json as afterJson,
        actor,
        created_at as createdAt,
        prev_hash as prevHash,
        entry_hash as entryHash
      FROM audit_log
      ORDER BY rowid ASC`
    );

    let expectedPrev = CHAIN_GENESIS;
    let checked = 0;
    let unsigned = 0;
    let head: string | null = null;

    for (const row of rows) {
      if (!row.entryHash) {
        unsigned += 1;
        continue;
      }

      if (row.prevHash !== expectedPrev) {
        return {
          ok: false,
          checked,
          unsigned,
          brokenAtId: row.id,
          reason: `Entry ${row.id} claims to follow a different entry than the trail shows (its link was rewritten or an entry was removed).`,
          head: head ?? undefined,
        };
      }

      const recomputed = await hashOf(
        expectedPrev,
        chainMessage({
          id: row.id,
          entity: row.entity,
          entityId: row.entityId,
          action: row.action,
          reason: row.reason,
          beforeJson: row.beforeJson,
          afterJson: row.afterJson,
          actor: row.actor,
          createdAt: row.createdAt,
        })
      );

      if (recomputed !== row.entryHash) {
        return {
          ok: false,
          checked,
          unsigned,
          brokenAtId: row.id,
          reason: `Entry ${row.id} does not match its recorded hash — its content was changed after it was written.`,
          head: head ?? undefined,
        };
      }

      expectedPrev = row.entryHash;
      head = row.entryHash;
      checked += 1;
    }

    return { ok: true, checked, unsigned, head: head ?? undefined };
  },
};
