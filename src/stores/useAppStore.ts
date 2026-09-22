import { create } from 'zustand';
import { Borrower } from '../db/types';

interface AppState {
  refreshKey: number;
  triggerRefresh: () => void;
  currencySymbol: string;
  setCurrencySymbol: (symbol: string) => void;
  organizationName: string;
  setOrganizationName: (name: string) => void;
  selectedBorrower: Borrower | null;
  setSelectedBorrower: (borrower: Borrower | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  refreshKey: 0,
  triggerRefresh: () => set((state) => ({ refreshKey: state.refreshKey + 1 })),
  currencySymbol: '₱',
  setCurrencySymbol: (symbol) => set({ currencySymbol: symbol }),
  organizationName: 'Community Treasury',
  setOrganizationName: (name) => set({ organizationName: name }),
  selectedBorrower: null,
  setSelectedBorrower: (borrower) => set({ selectedBorrower: borrower }),
}));
