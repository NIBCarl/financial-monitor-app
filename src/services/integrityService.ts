import * as Crypto from 'expo-crypto';
import { Share } from 'react-native';
import { getDatabase } from '../db/client';
import { auditRepo } from '../db/repositories/auditRepo';
import { ledgerRepo } from '../db/repositories/ledgerRepo';
import { sealRepo, type LedgerSeal } from '../db/repositories/sealRepo';
import { settingsRepo } from '../db/repositories/settingsRepo';
import { buildSealPayload, formatSealText, type SealPayload } from '../utils/sealText';
import { round2 } from '../utils/validation';

export { buildSealPayload, formatSealText };
export type { SealPayload, SealLike } from '../utils/sealText';

/**
 * Integrity reporting: is the book internally consistent, and has it been rewritten?
 *
 * Three independent checks are offered to the treasurer:
 *
 *  1. **Audit chain** — every recorded change is linked by hash (`auditRepo.verifyChain`).
 *  2. **Books check** — stored balances are recomputed from the raw payments and ledger rows.
 *  3. **Published seals** — the chain head captured when a month was sealed must still exist.
 *
 * None of these need a server; they are what a single-device ledger *can* honestly prove.
 */

/** Short, transcribable digest. 10 hex chars is plenty to compare by eye or over the phone. */
export async function shortDigest(payload: string): Promise<string> {
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload);
  return hex.slice(0, 10).toUpperCase();
}

// ---------------------------------------------------------------------------
// Books check
// ---------------------------------------------------------------------------

export interface BooksCheckIssue {
  kind: 'BALANCE' | 'SCHEDULE' | 'LEDGER' | 'ORPHAN';
  reference: string;
  detail: string;
  expected?: number;
  found?: number;
}

export interface BooksCheckResult {
  ok: boolean;
  checkedLoans: number;
  checkedPayments: number;
  checkedLedgerRows: number;
  issues: BooksCheckIssue[];
  ranAt: string;
}

/**
 * Recomputes the book from its raw records and compares it with what is stored.
 *
 * Deliberately *independent* of the write paths: it sums the payments itself rather than
 * trusting a cached balance column, which is the only way a stale-balance bug could ever be
 * caught on a treasurer's device.
 */
export async function runBooksCheck(): Promise<BooksCheckResult> {
  const db = await getDatabase();
  const issues: BooksCheckIssue[] = [];

  // 1. Loan balances vs. (total payable - non-void payments)
  const loanRows = await db.getAllAsync<{
    id: string;
    borrowerName: string;
    totalPayable: number;
    remainingBalance: number;
    paidSum: number;
  }>(`
    SELECT
      l.id,
      b.full_name as borrowerName,
      l.total_payable as totalPayable,
      l.remaining_balance as remainingBalance,
      COALESCE((
        SELECT SUM(p.amount_paid) FROM loan_payments p
        WHERE p.loan_id = l.id AND p.voided_at IS NULL
      ), 0) as paidSum
    FROM loans l
    JOIN borrowers b ON b.id = l.borrower_id
  `);

  for (const loan of loanRows) {
    const expected = round2(Math.max(0, loan.totalPayable - loan.paidSum));
    const stored = round2(loan.remainingBalance);
    if (Math.abs(expected - stored) > 0.009) {
      issues.push({
        kind: 'BALANCE',
        reference: `${loan.borrowerName} (${loan.id})`,
        detail: 'Stored balance does not match the sum of recorded payments.',
        expected,
        found: stored,
      });
    }
  }

  // 2. Installment statuses vs. what the payments actually cover
  const scheduleRows = await db.getAllAsync<{
    id: string;
    loanId: string;
    installmentNumber: number;
    expectedAmount: number;
    paidAmount: number;
    status: string;
  }>(`
    SELECT
      id,
      loan_id as loanId,
      installment_number as installmentNumber,
      expected_amount as expectedAmount,
      paid_amount as paidAmount,
      status
    FROM loan_schedules
  `);

  for (const row of scheduleRows) {
    const shouldBePaid = row.paidAmount + 0.009 >= row.expectedAmount;
    if (shouldBePaid && row.status !== 'PAID') {
      issues.push({
        kind: 'SCHEDULE',
        reference: `Installment #${row.installmentNumber} of loan ${row.loanId}`,
        detail: 'Fully covered by payments but still marked unpaid.',
        found: row.paidAmount,
        expected: row.expectedAmount,
      });
    }
    if (!shouldBePaid && row.status === 'PAID') {
      issues.push({
        kind: 'SCHEDULE',
        reference: `Installment #${row.installmentNumber} of loan ${row.loanId}`,
        detail: 'Marked paid but the payments recorded against it do not cover it.',
        found: row.paidAmount,
        expected: row.expectedAmount,
      });
    }
  }

  // 3. Ledger cash vs. the records that should have produced it
  const ledgerRows = await db.getAllAsync<{ id: string; category: string; amount: number }>(
    `SELECT id, category, amount FROM ledger_transactions WHERE voided_at IS NULL`
  );

  const paymentTotalRow = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(amount_paid), 0) as total FROM loan_payments WHERE voided_at IS NULL`
  );
  const paymentTotal = round2(Number(paymentTotalRow?.total ?? 0));

  const ledgerRepayments = round2(
    ledgerRows
      .filter((r) => r.category === 'LOAN_REPAYMENT')
      .reduce((sum, r) => sum + Number(r.amount), 0)
  );

  if (Math.abs(ledgerRepayments - paymentTotal) > 0.009) {
    issues.push({
      kind: 'LEDGER',
      reference: 'Ledger repayments vs. payment records',
      detail: 'The repayments posted to the ledger do not add up to the payments recorded.',
      expected: paymentTotal,
      found: ledgerRepayments,
    });
  }

  // 4. Rows pointing at something that is not in the book anymore
  const orphanPayments = await db.getFirstAsync<{ total: number }>(`
    SELECT COUNT(*) as total
    FROM loan_payments p
    LEFT JOIN loans l ON l.id = p.loan_id
    WHERE l.id IS NULL
  `);
  if (Number(orphanPayments?.total ?? 0) > 0) {
    issues.push({
      kind: 'ORPHAN',
      reference: 'Payments',
      detail: `${orphanPayments?.total} payment row(s) reference a loan that is no longer in the book.`,
    });
  }

  const orphanSchedules = await db.getFirstAsync<{ total: number }>(`
    SELECT COUNT(*) as total
    FROM loan_schedules s
    LEFT JOIN loans l ON l.id = s.loan_id
    WHERE l.id IS NULL
  `);
  if (Number(orphanSchedules?.total ?? 0) > 0) {
    issues.push({
      kind: 'ORPHAN',
      reference: 'Installments',
      detail: `${orphanSchedules?.total} installment row(s) reference a loan that is no longer in the book.`,
    });
  }

  const paymentCountRow = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) as total FROM loan_payments`
  );

  return {
    ok: issues.length === 0,
    checkedLoans: loanRows.length,
    checkedPayments: Number(paymentCountRow?.total ?? 0),
    checkedLedgerRows: ledgerRows.length,
    issues,
    ranAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
}



// ---------------------------------------------------------------------------
// Monthly seals
// ---------------------------------------------------------------------------

export interface SealVerification {
  seal: LedgerSeal;
  /** The sealed head was found in the current chain. */
  headFound: boolean;
  /** How many signed entries existed when the seal was taken. */
  position?: number;
  /** Current head of the chain. */
  currentHead?: string;
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Creates and stores a seal for the current month, ready to publish.
 *
 * Sealing twice in a month is allowed on purpose — each seal is an extra checkpoint, and the
 * newest one is the one to quote.
 */
export async function publishSeal(note?: string): Promise<LedgerSeal> {
  const [metrics, chainHead, auditCount, orgName] = await Promise.all([
    ledgerRepo.getMetrics(),
    auditRepo.getChainHead(),
    auditRepo.count(),
    settingsRepo.get('org_name'),
  ]);

  if (!chainHead) {
    throw new Error(
      'There is nothing to seal yet — no change has been recorded on this device, so the trail has no head.'
    );
  }

  const counts = await getBookCounts();
  const payload: SealPayload = {
    period: currentPeriod(),
    orgName: orgName || 'Community Treasury',
    chainHead,
    auditCount,
    inflowTotal: metrics.totalInflows,
    outflowTotal: metrics.totalOutflows,
    outstandingTotal: metrics.outstandingPrincipal,
    overdueTotal: metrics.overdueAmount,
    activeLoans: counts.activeLoans,
    borrowerCount: counts.borrowerCount,
  };

  const sealCode = await shortDigest(buildSealPayload(payload));

  return sealRepo.create({
    period: payload.period,
    chainHead: payload.chainHead,
    auditCount: payload.auditCount,
    inflowTotal: payload.inflowTotal,
    outflowTotal: payload.outflowTotal,
    outstandingTotal: payload.outstandingTotal,
    overdueTotal: payload.overdueTotal,
    activeLoans: payload.activeLoans,
    borrowerCount: payload.borrowerCount,
    sealCode,
    note,
  });
}

/** Active loan count and distinct borrower count, for the seal payload. */
async function getBookCounts(): Promise<{ activeLoans: number; borrowerCount: number }> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ activeLoans: number; borrowerCount: number }>(`
    SELECT
      COUNT(*) as activeLoans,
      COUNT(DISTINCT borrower_id) as borrowerCount
    FROM loans
    WHERE status IN ('ACTIVE', 'OVERDUE')
  `);
  return {
    activeLoans: Number(row?.activeLoans ?? 0),
    borrowerCount: Number(row?.borrowerCount ?? 0),
  };
}

/** Shares the seal through whatever messaging app the treasurer uses. */
export async function shareSeal(seal: LedgerSeal, orgName: string, symbol: string): Promise<void> {
  await Share.share({ message: formatSealText(seal, orgName, symbol) });
}

/**
 * Confirms that the head captured by a seal is still present in the chain.
 *
 * This is the check that catches a *whole-database* rewrite: a freshly regenerated trail would
 * have different hashes, so the published head would be missing.
 */
export async function verifySeal(seal: LedgerSeal): Promise<SealVerification> {
  const db = await getDatabase();
  const exists = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) as total FROM audit_log WHERE entry_hash = ?`,
    [seal.chainHead]
  );
  const headFound = Number(exists?.total ?? 0) > 0;

  let position: number | undefined;
  if (headFound) {
    const row = await db.getFirstAsync<{ position: number }>(
      `SELECT COUNT(*) as position
       FROM audit_log
       WHERE entry_hash IS NOT NULL
         AND rowid <= (SELECT rowid FROM audit_log WHERE entry_hash = ? LIMIT 1)`,
      [seal.chainHead]
    );
    position = Number(row?.position ?? 0);
  }

  return {
    seal,
    headFound,
    position,
    currentHead: (await auditRepo.getChainHead()) ?? undefined,
  };
}

/** Seals newest first, for the Reports list. */
export async function listSeals(): Promise<LedgerSeal[]> {
  return sealRepo.getAll();
}
