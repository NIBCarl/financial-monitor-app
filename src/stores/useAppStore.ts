import { create } from 'zustand';
import { Borrower } from '../db/types';

/**
 * What a write can change, and therefore which screens need to reload.
 *
 * A single global `refreshKey` meant one payment reloaded *every* mounted tab: the dashboard's four
 * queries, the ledger's two, the borrower directory, and the reports screen's five plus a directory
 * listing. On a cheap phone that is the difference between a snappy app and a sluggish one.
 */
export type RefreshScope = 'ledger' | 'loans' | 'borrowers' | 'settings' | 'evidence';

export const REFRESH_SCOPES: RefreshScope[] = ['ledger', 'loans', 'borrowers', 'settings', 'evidence'];

type Versions = Record<RefreshScope, number>;

interface AppState {
  /** Per-scope counters. A screen listens only to the scopes it actually displays. */
  versions: Versions;
  /**
   * Bumps the given scopes. Pass nothing (or `'all'`) after an operation that touches everything —
   * a restore, a wipe, an integrity action.
   */
  triggerRefresh: (scopes?: RefreshScope[] | 'all') => void;
  /** Sum of every scope; kept for the rare component that genuinely depends on all of them. */
  refreshKey: number;
  currencySymbol: string;
  setCurrencySymbol: (symbol: string) => void;
  organizationName: string;
  setOrganizationName: (name: string) => void;
  selectedBorrower: Borrower | null;
  setSelectedBorrower: (borrower: Borrower | null) => void;
}

const initialVersions: Versions = REFRESH_SCOPES.reduce(
  (acc, scope) => ({ ...acc, [scope]: 0 }),
  {} as Versions
);

const totalOf = (versions: Versions): number =>
  REFRESH_SCOPES.reduce((sum, scope) => sum + versions[scope], 0);

export const useAppStore = create<AppState>((set) => ({
  versions: initialVersions,
  refreshKey: 0,
  triggerRefresh: (scopes) =>
    set((state) => {
      const bump = scopes === undefined || scopes === 'all' ? REFRESH_SCOPES : scopes;
      const versions = { ...state.versions };
      for (const scope of bump) versions[scope] += 1;
      return { versions, refreshKey: totalOf(versions) };
    }),
  currencySymbol: '₱',
  setCurrencySymbol: (symbol) => set({ currencySymbol: symbol }),
  organizationName: 'Community Treasury',
  setOrganizationName: (name) => set({ organizationName: name }),
  selectedBorrower: null,
  setSelectedBorrower: (borrower) => set({ selectedBorrower: borrower }),
}));

/**
 * A stable string that changes exactly when one of `scopes` moves.
 *
 * The string form matters: it is a primitive, so a store update that does not touch these scopes
 * cannot make a screen look like its data changed.
 */
export function versionKeyFor(versions: Versions, scopes: RefreshScope[]): string {
  return scopes.map((scope) => versions[scope]).join('.');
}

