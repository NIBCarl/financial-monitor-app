import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  StatusBar,
  RefreshControl,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Plus,
  ChevronRight,
} from 'lucide-react-native';
import { AddLedgerModal } from '../components/AddLedgerModal';
import { LoadErrorBanner } from '../components/LoadErrorBanner';
import { useScopedReload } from '../hooks/use-scoped-reload';
import { BorrowerDetailModal } from '../components/BorrowerDetailModal';
import { TransactionDetailModal } from '../components/TransactionDetailModal';
import { borrowerRepo } from '../db/repositories/borrowerRepo';
import { ledgerRepo } from '../db/repositories/ledgerRepo';
import { Borrower, LedgerTransaction } from '../db/types';
import { useAppStore } from '../stores/useAppStore';
import { formatCurrency, formatDbDate } from '../utils/financial';
import { getCategoryLabel } from '../utils/labels';

interface LedgerTransactionRowProps {
  transaction: LedgerTransaction;
  currencySymbol: string;
  onPress: (transaction: LedgerTransaction) => void;
}

/** Memoized so the transaction list does not re-render every row on filter/search changes. */
const LedgerTransactionRow = React.memo(
  ({ transaction, currencySymbol, onPress }: LedgerTransactionRowProps) => {
    const isInflow = transaction.type === 'INFLOW';

    return (
      <TouchableOpacity
        style={styles.txRow}
        onPress={() => onPress(transaction)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${getCategoryLabel(transaction.category)}, ${
          isInflow ? 'inflow' : 'outflow'
        } of ${formatCurrency(transaction.amount, currencySymbol)}. Tap for voucher details.`}
      >
        <View style={[styles.txIcon, { backgroundColor: isInflow ? '#e0f2fe' : '#fef2f2' }]}>
          {isInflow ? (
            <ArrowDownLeft size={18} color="#0284c7" />
          ) : (
            <ArrowUpRight size={18} color="#dc2626" />
          )}
        </View>

        <View style={styles.txInfo}>
          <View style={styles.txTitleRow}>
            <Text style={styles.txCategory}>{getCategoryLabel(transaction.category)}</Text>
            {transaction.voidedAt ? (
              <View style={styles.voidPill}>
                <Text style={styles.voidPillText}>VOIDED</Text>
              </View>
            ) : null}
          </View>
          {transaction.description ? (
            <Text style={styles.txDesc} numberOfLines={1}>
              {transaction.description}
            </Text>
          ) : null}
          <Text style={styles.txDate}>{formatDbDate(transaction.transactionDate)}</Text>
        </View>

        <View style={styles.txRightCol}>
          <Text
            style={[
              styles.txAmount,
              { color: isInflow ? '#0284c7' : '#dc2626' },
              transaction.voidedAt ? styles.txAmountVoided : null,
            ]}
          >
            {isInflow ? '+' : '-'}
            {formatCurrency(transaction.amount, currencySymbol)}
          </Text>
          <ChevronRight size={18} color="#94a3b8" />
        </View>
      </TouchableOpacity>
    );
  }
);
LedgerTransactionRow.displayName = 'LedgerTransactionRow';

export default function LedgerScreen() {
  const { currencySymbol, organizationName, triggerRefresh } = useAppStore();

  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [filterType, setFilterType] = useState<string>('ALL');
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cashBalance, setCashBalance] = useState(0);
  const [totalInflows, setTotalInflows] = useState(0);
  const [totalOutflows, setTotalOutflows] = useState(0);
  /** Set when a load fails, so the screen can say so instead of showing an empty book. */
  const [loadError, setLoadError] = useState<string | null>(null);

  // Voucher detail + borrower profile modals
  const [detailVisible, setDetailVisible] = useState(false);
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
  const [borrowerDetailVisible, setBorrowerDetailVisible] = useState(false);
  const [selectedBorrower, setSelectedBorrower] = useState<Borrower | null>(null);

  const loadLedger = useCallback(async () => {
    try {
      const [txs, metrics] = await Promise.all([
        ledgerRepo.getTransactions(100),
        ledgerRepo.getMetrics(),
      ]);
      setTransactions(txs);
      setCashBalance(metrics.liquidCash);
      setTotalInflows(metrics.totalInflows);
      setTotalOutflows(metrics.totalOutflows);
      setLoadError(null);
    } catch (err) {
      console.error('Failed to load ledger:', err);
      setLoadError(err instanceof Error ? err.message : 'The database did not respond.');
    }
  }, []);

  // The ledger shows the transaction stream and the cash position: purely ledger-scoped.
  useScopedReload(['ledger'], loadLedger);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadLedger();
    setRefreshing(false);
  };

  const filteredTransactions = useMemo(
    () => transactions.filter((tx) => (filterType === 'ALL' ? true : tx.type === filterType)),
    [transactions, filterType]
  );

  const keyExtractor = useCallback((item: LedgerTransaction) => item.id, []);

  // Stable row press handler so memoized rows never re-render when unrelated state changes.
  const handleRowPress = useCallback((transaction: LedgerTransaction) => {
    setSelectedTransactionId(transaction.id);
    setDetailVisible(true);
  }, []);

  const renderTransaction = useCallback(
    ({ item }: { item: LedgerTransaction }) => (
      <LedgerTransactionRow
        transaction={item}
        currencySymbol={currencySymbol}
        onPress={handleRowPress}
      />
    ),
    [currencySymbol, handleRowPress]
  );

  const handleOpenBorrower = useCallback(async (borrowerId: string) => {
    const borrower = await borrowerRepo.getById(borrowerId);
    if (borrower) {
      setSelectedBorrower(borrower);
      setBorrowerDetailVisible(true);
    }
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
              General Ledger
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>Cash Inflow & Outflow Record</Text>
          </View>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => setAddModalVisible(true)}
            activeOpacity={0.8}
          >
            <Plus size={16} color="#ffffff" style={{ marginRight: 4 }} />
            <Text style={styles.addBtnText}>Log Entry</Text>
          </TouchableOpacity>
        </View>

        {/* Live Running Balance Card */}
        <View style={styles.balanceCard}>
          <View style={styles.balanceHeader}>
            <Text style={styles.balanceLabel}>CURRENT TREASURY CASH BALANCE</Text>
          </View>
          <Text style={styles.balanceAmount}>
            {formatCurrency(cashBalance, currencySymbol)}
          </Text>

          <View style={styles.breakdownRow}>
            <View style={styles.breakdownPillIn}>
              <ArrowDownLeft size={13} color="#0284c7" />
              <Text style={styles.breakdownTextIn}>
                Inflows: +{formatCurrency(totalInflows, currencySymbol)}
              </Text>
            </View>
            <View style={styles.breakdownPillOut}>
              <ArrowUpRight size={13} color="#dc2626" />
              <Text style={styles.breakdownTextOut}>
                Outflows: -{formatCurrency(totalOutflows, currencySymbol)}
              </Text>
            </View>
          </View>

          <Text style={styles.balanceNote}>
            Calculated in real-time: Total Inflows minus Disbursed Loans & Expenses
          </Text>
        </View>

        {/* A failed load must be visible, not an empty book (see LoadErrorBanner) */}
        {loadError ? (
          <View style={styles.bannerWrap}>
            <LoadErrorBanner
              what="the ledger"
              detail={loadError}
              retrying={refreshing}
              onRetry={() => void onRefresh()}
            />
          </View>
        ) : null}

        {/* Filter Tabs */}
        <View style={styles.filterRow}>
          {[
            { label: 'All Transactions', value: 'ALL' },
            { label: 'Inflows (+)', value: 'INFLOW' },
            { label: 'Outflows (-)', value: 'OUTFLOW' },
          ].map((tab) => (
            <TouchableOpacity
              key={tab.value}
              style={[styles.filterTab, filterType === tab.value && styles.filterTabActive]}
              onPress={() => setFilterType(tab.value)}
            >
              <Text
                style={[
                  styles.filterTabText,
                  filterType === tab.value && styles.filterTabTextActive,
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Transaction Stream */}
        <FlatList
          data={filteredTransactions}
          keyExtractor={keyExtractor}
          renderItem={renderTransaction}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#0284c7']} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Image
                source={require('../../assets/images/empty-ledger.png')}
                style={styles.emptyImage}
                resizeMode="contain"
              />
              <Text style={styles.emptyTitle}>Everything is safe & clear</Text>
              <Text style={styles.emptyDesc}>
                {'No transactions recorded yet. Tap "+ Log Entry" above whenever you are ready to record dues, capital, or expenses.'}
              </Text>
            </View>
          }
        />
      </View>

      {/* Add Entry Modal */}
      <AddLedgerModal
        visible={addModalVisible}
        onClose={() => setAddModalVisible(false)}
        onSuccess={() => {
          setAddModalVisible(false);
          triggerRefresh(['ledger']);
        }}
        currencySymbol={currencySymbol}
      />

      {/* Voucher / receipt detail for the tapped transaction */}
      <TransactionDetailModal
        visible={detailVisible}
        transactionId={selectedTransactionId}
        onClose={() => setDetailVisible(false)}
        currencySymbol={currencySymbol}
        orgName={organizationName}
        onOpenBorrower={handleOpenBorrower}
        onChanged={() => triggerRefresh('all')}
      />

      {/* Borrower profile opened from the detail modal */}
      <BorrowerDetailModal
        visible={borrowerDetailVisible}
        borrower={selectedBorrower}
        onClose={() => setBorrowerDetailVisible(false)}
        onDataChanged={() => triggerRefresh(['borrowers', 'loans', 'ledger'])}
        currencySymbol={currencySymbol}
        orgName={organizationName}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    backgroundColor: '#ffffff',
  },
  headerLeft: {
    flex: 1,
    marginRight: 10,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0c4a6e',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748b',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0284c7',
    paddingHorizontal: 14,
    minHeight: 44,
    borderRadius: 12,
    flexShrink: 0,
    shadowColor: '#0284c7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  addBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
  },
  balanceCard: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 12,
    backgroundColor: '#0c4a6e',
    borderRadius: 16,
    padding: 18,
    shadowColor: '#0c4a6e',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 3,
  },
  balanceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  balanceLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#bae6fd',
    letterSpacing: 0.5,
  },
  balanceAmount: {
    fontSize: 28,
    fontWeight: '800',
    color: '#38bdf8',
    letterSpacing: -0.5,
  },
  balanceNote: {
    fontSize: 11,
    color: '#e0f2fe',
    marginTop: 6,
  },
  breakdownRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  breakdownPillIn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  breakdownTextIn: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0369a1',
  },
  breakdownPillOut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#fee2e2',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  breakdownTextOut: {
    fontSize: 11,
    fontWeight: '700',
    color: '#b91c1c',
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 10,
  },
  bannerWrap: {
    paddingHorizontal: 16,
  },
  filterTab: {
    flex: 1,
    minHeight: 42,
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  filterTabActive: {
    backgroundColor: '#0c4a6e',
    borderColor: '#0c4a6e',
  },
  filterTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  filterTabTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 14,
    borderRadius: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  txIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  txInfo: {
    flex: 1,
    marginRight: 8,
  },
  txCategory: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0c4a6e',
  },
  txDesc: {
    fontSize: 12,
    color: '#475569',
    marginTop: 1,
  },
  txDate: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  txRightCol: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 2,
    flexShrink: 0,
  },
  txTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  voidPill: {
    backgroundColor: '#fee2e2',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  voidPillText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#b91c1c',
    letterSpacing: 0.4,
  },
  txAmountVoided: {
    textDecorationLine: 'line-through',
    color: '#94a3b8',
  },
  txAmount: {
    fontSize: 15,
    fontWeight: '800',
    flexShrink: 0,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 36,
    paddingHorizontal: 20,
  },
  emptyImage: {
    width: 190,
    height: 129,
    marginBottom: 10,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  emptyDesc: {
    fontSize: 14,
    color: '#334155',
    textAlign: 'center',
    marginTop: 6,
    maxWidth: 290,
    lineHeight: 21,
  },
});
