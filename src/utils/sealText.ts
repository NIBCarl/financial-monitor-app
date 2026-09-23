import { formatCurrency, formatDbDateTime } from './financial';

/**
 * Seal payload + published text.
 *
 * Kept free of database and platform imports for two reasons: the payload string is the thing
 * the seal code is computed from (so it must be stable and unit-tested), and `utils/reminders`-
 * style separation keeps the SQL layer out of the verification harness.
 */

export interface SealPayload {
  period: string;
  orgName: string;
  chainHead: string;
  auditCount: number;
  inflowTotal: number;
  outflowTotal: number;
  outstandingTotal: number;
  overdueTotal: number;
  activeLoans: number;
  borrowerCount: number;
}

/** Structural shape of a stored seal — avoids importing the repository here. */
export interface SealLike {
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

/**
 * Canonical seal payload — the exact string that gets digested.
 *
 * Every field is fixed-width-ordered and money is formatted with `toFixed(2)` so the digest
 * cannot depend on how a number happened to be rendered. Changing this layout changes every
 * future seal code, which is why it carries its own version tag.
 */
export function buildSealPayload(input: SealPayload): string {
  return [
    'TREASURER-VAULT-SEAL-v1',
    input.period,
    input.orgName,
    input.chainHead,
    String(input.auditCount),
    input.inflowTotal.toFixed(2),
    input.outflowTotal.toFixed(2),
    input.outstandingTotal.toFixed(2),
    input.overdueTotal.toFixed(2),
    String(input.activeLoans),
    String(input.borrowerCount),
  ].join('|');
}

/** Human-readable seal, suitable for minutes, a group chat or a printed page. */
export function formatSealText(seal: SealLike, orgName: string, symbol: string): string {
  return [
    `${orgName} — LEDGER SEAL`,
    `Period: ${seal.period}`,
    `Recorded: ${formatDbDateTime(seal.createdAt)}`,
    '',
    `Chain head: ${seal.chainHead}`,
    `Chain entries: ${seal.auditCount}`,
    `Seal code: ${seal.sealCode}`,
    '',
    `Collections (all time): ${formatCurrency(seal.inflowTotal, symbol)}`,
    `Disbursements + expenses: ${formatCurrency(seal.outflowTotal, symbol)}`,
    `Outstanding receivables: ${formatCurrency(seal.outstandingTotal, symbol)}`,
    `Overdue: ${formatCurrency(seal.overdueTotal, symbol)}`,
    `Active loans: ${seal.activeLoans} across ${seal.borrowerCount} borrower(s)`,
    '',
    'Keep this message. If the book is ever changed, the chain head above will no longer match.',
  ].join('\n');
}
