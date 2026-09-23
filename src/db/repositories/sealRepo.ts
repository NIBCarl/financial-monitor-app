import { getDatabase } from '../client';

/**
 * Published monthly seals.
 *
 * A hash chain on its own proves nothing to an outsider: the whole database could be rewritten
 * together with its hashes. A seal captures the chain head *and* the month's financial totals
 * at a point in time, and the treasurer publishes that digest (printed, emailed, pasted into the
 * minutes). If the book is later rewritten, the published head no longer appears in the chain
 * and the seal check fails — which is exactly the evidence a co-op audit needs.
 */

export interface LedgerSeal {
  id: string;
  /** `YYYY-MM` the seal covers. */
  period: string;
  chainHead: string;
  auditCount: number;
  inflowTotal: number;
  outflowTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  activeLoans: number;
  borrowerCount: number;
  sealCode: string;
  note?: string | null;
  createdAt: string;
}

const SEAL_COLUMNS = `
  id,
  period,
  chain_head as chainHead,
  audit_count as auditCount,
  inflow_total as inflowTotal,
  outflow_total as outflowTotal,
  outstanding_total as outstandingTotal,
  overdue_total as overdueTotal,
  active_loans as activeLoans,
  borrower_count as borrowerCount,
  seal_code as sealCode,
  note,
  created_at as createdAt
`;

export interface SealInput {
  period: string;
  chainHead: string;
  auditCount: number;
  inflowTotal: number;
  outflowTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  activeLoans: number;
  borrowerCount: number;
  sealCode: string;
  note?: string;
}

export const sealRepo = {
  async create(input: SealInput): Promise<LedgerSeal> {
    const db = await getDatabase();
    const id = 'seal_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    await db.runAsync(
      `INSERT INTO ledger_seals (
        id, period, chain_head, audit_count, inflow_total, outflow_total, outstanding_total,
        overdue_total, active_loans, borrower_count, seal_code, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.period,
        input.chainHead,
        input.auditCount,
        input.inflowTotal,
        input.outflowTotal,
        input.outstandingTotal,
        input.overdueTotal,
        input.activeLoans,
        input.borrowerCount,
        input.sealCode,
        input.note ?? null,
      ]
    );
    const created = await db.getFirstAsync<LedgerSeal>(
      `SELECT ${SEAL_COLUMNS} FROM ledger_seals WHERE id = ?`,
      [id]
    );
    if (!created) throw new Error('The seal was written but could not be read back.');
    return created;
  },

  /** Newest first. */
  async getAll(): Promise<LedgerSeal[]> {
    const db = await getDatabase();
    return db.getAllAsync<LedgerSeal>(
      `SELECT ${SEAL_COLUMNS} FROM ledger_seals ORDER BY created_at DESC, period DESC`
    );
  },

  async getLatestForPeriod(period: string): Promise<LedgerSeal | null> {
    const db = await getDatabase();
    return (
      (await db.getFirstAsync<LedgerSeal>(
        `SELECT ${SEAL_COLUMNS}
         FROM ledger_seals
         WHERE period = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [period]
      )) ?? null
    );
  },

  async count(): Promise<number> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ total: number }>(`SELECT COUNT(*) as total FROM ledger_seals`);
    return Number(row?.total ?? 0);
  },
};
