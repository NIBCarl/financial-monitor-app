import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  StatusBar,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  Wallet,
  TrendingUp,
  AlertTriangle,
  Users,
  UserPlus,
  PlusCircle,
  ArrowDownLeft,
  Calendar,
  DollarSign,
  Share2,
  CheckCircle2,
  ChevronRight,
  Receipt,
} from 'lucide-react-native';
import { MetricCard } from '../components/MetricCard';
import { AddBorrowerModal } from '../components/AddBorrowerModal';
import { LoanOriginationModal } from '../components/LoanOriginationModal';
import { AddLedgerModal } from '../components/AddLedgerModal';
import { BorrowerDetailModal } from '../components/BorrowerDetailModal';
import { PaymentModal } from '../components/PaymentModal';
import { ShareableReceiptModal } from '../components/ShareableReceiptModal';
import { TransactionDetailModal } from '../components/TransactionDetailModal';
import { DueSoonCard } from '../components/DueSoonCard';
import { reportsRepo, type DueItem } from '../db/repositories/reportsRepo';
import { ledgerRepo } from '../db/repositories/ledgerRepo';
import { loanRepo } from '../db/repositories/loanRepo';
import { borrowerRepo } from '../db/repositories/borrowerRepo';
import { paymentRepo } from '../db/repositories/paymentRepo';
import {
  DashboardMetrics,
  Borrower,
  Loan,
  LoanSchedule,
  ReceiptData,
  CollectionSummary,
} from '../db/types';
import { useAppStore } from '../stores/useAppStore';
import {
  formatCurrency,
  formatDatePretty,
  formatDbDate,
  checkIsOverdue,
  checkIsDueToday,
  getScheduleRemaining,
} from '../utils/financial';
import { getPaymentMethodLabel } from '../utils/labels';
import { runAutoBackupIfDue } from '../services/backupService';
import { sharePaymentReminder } from '../services/receiptService';

export default function DashboardScreen() {
  const { currencySymbol, organizationName, refreshKey, triggerRefresh } = useAppStore();

  const [metrics, setMetrics] = useState<DashboardMetrics>({
    liquidCash: 0,
    totalInflows: 0,
    totalOutflows: 0,
    outstandingPrincipal: 0,
    expectedInterest: 0,
    overdueAmount: 0,
    activeBorrowersCount: 0,
    overdueBorrowersCount: 0,
    totalCollectedThisMonth: 0,
  });

  const [schedules, setSchedules] = useState<
    (LoanSchedule & { borrowerName: string; borrowerPhone: string; principalAmount: number })[]
  >([]);
  const [refreshing, setRefreshing] = useState(false);

  // Recent collections overview (this month) + voucher detail modal
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [detailVisible, setDetailVisible] = useState(false);
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);

  // Modals state
  const [addBorrowerVisible, setAddBorrowerVisible] = useState(false);
  const [issueLoanVisible, setIssueLoanVisible] = useState(false);
  const [addLedgerVisible, setAddLedgerVisible] = useState(false);
  const [borrowerDetailVisible, setBorrowerDetailVisible] = useState(false);
  const [selectedBorrower, setSelectedBorrower] = useState<Borrower | null>(null);

  // Payment from Due Today / Overdue tray
  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [payingLoan, setPayingLoan] = useState<Loan | null>(null);
  const [payingSchedule, setPayingSchedule] = useState<LoanSchedule | null>(null);
  const [payingBorrowerName, setPayingBorrowerName] = useState('');
  const [payingBorrowerPhone, setPayingBorrowerPhone] = useState('');

  // Receipt modal
  const [receiptModalVisible, setReceiptModalVisible] = useState(false);
  const [currentReceipt, setCurrentReceipt] = useState<ReceiptData | null>(null);

  // Installments due within the week (or already late) — drives the reminders card.
  const [dueItems, setDueItems] = useState<DueItem[]>([]);

  // Backup health, shown as a nag when the book has gone too long without a copy.
  const [backupAgeLabel, setBackupAgeLabel] = useState('');
  const [backupStale, setBackupStale] = useState(false);

  const loadDashboardData = useCallback(async () => {
    try {
      const [m, scheds, recentCollections, dueItems] = await Promise.all([
        ledgerRepo.getMetrics(),
        loanRepo.getDueAndOverdueSchedules(),
        paymentRepo.getCollectionsThisMonth(6),
        reportsRepo.getDueItems(7),
      ]);
      setMetrics(m);
      setSchedules(scheds);
      setCollections(recentCollections);
      setDueItems(dueItems);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }, []);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData, refreshKey]);

  /**
   * The app backs itself up (report §20.9).
   *
   * Opening the app is the moment the schedule is checked: a phone that is used daily therefore
   * never falls more than a day behind, and the treasurer is told when the book has gone a week
   * without a copy. Failure here is deliberately silent in the UI — a missing automatic backup must
   * never block the work in front of the treasurer.
   */
  useEffect(() => {
    let active = true;

    const checkBackup = async () => {
      try {
        const outcome = await runAutoBackupIfDue();
        if (!active) return;
        setBackupAgeLabel(outcome.ageLabel);
        setBackupStale(outcome.stale);
      } catch (err) {
        console.warn('Automatic backup skipped:', err);
        if (active) setBackupStale(false);
      }
    };

    void checkBackup();
    return () => {
      active = false;
    };
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadDashboardData();
    setRefreshing(false);
  };

  // Grouped once per data change instead of on every re-render.
  const overdueList = useMemo(() => schedules.filter((s) => checkIsOverdue(s.dueDate)), [schedules]);
  const dueTodayList = useMemo(() => schedules.filter((s) => checkIsDueToday(s.dueDate)), [schedules]);

  const handleSendReminder = async (item: typeof schedules[0]) => {
    try {
      await sharePaymentReminder(
        {
          borrowerName: item.borrowerName,
          orgName: organizationName,
          installmentNumber: item.installmentNumber,
          amountDue: getScheduleRemaining(item),
          dueDate: item.dueDate,
        },
        currencySymbol
      );
    } catch (err) {
      console.error(err);
    }
  };

  const handleOpenPayFromTray = async (item: typeof schedules[0]) => {
    const loan = await loanRepo.getLoanById(item.loanId);
    if (!loan) return;
    setPayingLoan(loan);
    setPayingSchedule(item);
    setPayingBorrowerName(item.borrowerName);
    setPayingBorrowerPhone(item.borrowerPhone);
    setPaymentModalVisible(true);
  };

  const handlePaymentSuccess = (receipt: ReceiptData) => {
    setPaymentModalVisible(false);
    setTimeout(() => {
      setCurrentReceipt(receipt);
      setReceiptModalVisible(true);
      triggerRefresh();
    }, Platform.OS === 'ios' ? 350 : 50);
  };

  const handleBorrowerSelected = async (borrowerId: string) => {
    const b = await borrowerRepo.getById(borrowerId);
    if (b) {
      setSelectedBorrower(b);
      setBorrowerDetailVisible(true);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#0284c7']} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerOrg} numberOfLines={1}>{organizationName}</Text>
            <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
              Treasurer Dashboard
            </Text>
          </View>
          <View style={styles.dateBadge}>
            <Calendar size={12} color="#0284c7" />
            <Text style={styles.dateBadgeText}>
              {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </Text>
          </View>
        </View>

        {/* Backup nag: the book has gone long enough without a copy to say so (report §20.9) */}
        {backupStale ? (
          <View style={styles.backupNag}>
            <AlertTriangle size={15} color="#b45309" />
            <View style={{ flex: 1 }}>
              <Text style={styles.backupNagTitle}>
                {backupAgeLabel || 'No backup on this device yet'}
              </Text>
              <Text style={styles.backupNagText}>
                Reports → Backup &amp; Restore keeps a copy that survives a lost or broken phone.
              </Text>
            </View>
          </View>
        ) : null}

        {/* Top 4 Metrics Grid */}
        <View style={styles.metricsGrid}>
          <View style={styles.metricsRow}>
            <MetricCard
              title="Liquid Cash Fund"
              value={formatCurrency(metrics.liquidCash, currencySymbol)}
              subtitle="Cash on Hand"
              variant="success"
              icon={<Wallet size={18} color="#0284c7" />}
            />
            <MetricCard
              title="Total Lent Out"
              value={formatCurrency(metrics.outstandingPrincipal, currencySymbol)}
              subtitle={`${metrics.activeBorrowersCount} active borrowers`}
              variant="default"
              icon={<Users size={18} color="#0c4a6e" />}
            />
          </View>

          <View style={styles.metricsRow}>
            <MetricCard
              title="Expected Interest"
              value={formatCurrency(metrics.expectedInterest, currencySymbol)}
              subtitle="Projected Return"
              variant="default"
              icon={<TrendingUp size={18} color="#0284c7" />}
            />
            <MetricCard
              title="Total Overdue"
              value={formatCurrency(metrics.overdueAmount, currencySymbol)}
              subtitle={`${metrics.overdueBorrowersCount} borrowers late`}
              variant={metrics.overdueAmount > 0 ? 'danger' : 'success'}
              icon={<AlertTriangle size={18} color={metrics.overdueAmount > 0 ? '#dc2626' : '#0284c7'} />}
            />
          </View>
        </View>

        {/* Quick Action Tray */}
        <View style={styles.quickActionsBar}>
          <TouchableOpacity
            style={styles.quickActionBtn}
            onPress={() => setAddBorrowerVisible(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.actionIconBg, { backgroundColor: '#e0f2fe' }]}>
              <UserPlus size={20} color="#0284c7" />
            </View>
            <Text style={styles.actionBtnText}>Add Borrower</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.quickActionBtn}
            onPress={() => setIssueLoanVisible(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.actionIconBg, { backgroundColor: '#e0f2fe' }]}>
              <PlusCircle size={20} color="#0c4a6e" />
            </View>
            <Text style={styles.actionBtnText}>Issue Loan</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.quickActionBtn}
            onPress={() => setAddLedgerVisible(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.actionIconBg, { backgroundColor: '#f0f9ff' }]}>
              <ArrowDownLeft size={20} color="#0284c7" />
            </View>
            <Text style={styles.actionBtnText}>Cash In / Out</Text>
          </TouchableOpacity>
        </View>

        {/* Alerts: Delinquent & Overdue Tray */}
        {overdueList.length > 0 && (
          <View style={styles.alertSection}>
            <View style={styles.alertHeader}>
              <View style={styles.alertTitleRow}>
                <AlertTriangle size={16} color="#dc2626" />
                <Text style={styles.alertTitle}>Overdue Payments ({overdueList.length})</Text>
              </View>
            </View>

            <View style={styles.alertList}>
              {overdueList.map((item) => (
                <View key={item.id} style={styles.alertCard}>
                  <View style={styles.alertCardLeft}>
                    <Text style={styles.alertBorrowerName}>{item.borrowerName}</Text>
                    <Text style={styles.alertDueDate}>
                      Due: {formatDatePretty(item.dueDate)} • Inst #{item.installmentNumber}
                    </Text>
                    <Text style={styles.alertAmount}>
                      {formatCurrency(getScheduleRemaining(item), currencySymbol)}
                    </Text>
                  </View>

                  <View style={styles.alertActions}>
                    <TouchableOpacity
                      style={styles.reminderBtn}
                      onPress={() => handleSendReminder(item)}
                    >
                      <Share2 size={13} color="#0284c7" />
                      <Text style={styles.reminderBtnText}>Remind</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.collectBtn}
                      onPress={() => handleOpenPayFromTray(item)}
                    >
                      <DollarSign size={13} color="#ffffff" />
                      <Text style={styles.collectBtnText}>Collect</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Due Today Tray */}
        {dueTodayList.length > 0 && (
          <View style={styles.dueTodaySection}>
            <View style={styles.alertTitleRow}>
              <Calendar size={16} color="#0284c7" />
              <Text style={[styles.alertTitle, { color: '#0c4a6e' }]}>
                Collections Due Today ({dueTodayList.length})
              </Text>
            </View>

            <View style={styles.alertList}>
              {dueTodayList.map((item) => (
                <View key={item.id} style={styles.dueTodayCard}>
                  <View style={styles.alertCardLeft}>
                    <Text style={styles.alertBorrowerName}>{item.borrowerName}</Text>
                    <Text style={styles.alertDueDate}>Installment #{item.installmentNumber}</Text>
                    <Text style={[styles.alertAmount, { color: '#0284c7' }]}>
                      {formatCurrency(getScheduleRemaining(item), currencySymbol)}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={styles.collectBtnToday}
                    onPress={() => handleOpenPayFromTray(item)}
                  >
                    <CheckCircle2 size={14} color="#ffffff" />
                    <Text style={styles.collectBtnText}>Mark Paid</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Monthly Summary Footer Banner */}
        <View style={styles.monthlySummaryBanner}>
          <Text style={styles.monthlySummaryLabel}>Collections This Month</Text>
          <Text style={styles.monthlySummaryVal}>
            {formatCurrency(metrics.totalCollectedThisMonth, currencySymbol)}
          </Text>
        </View>

        {/* Due & overdue with one-tap reminders */}
        <DueSoonCard
          items={dueItems}
          orgName={organizationName}
          currencySymbol={currencySymbol}
          onOpenBorrower={handleBorrowerSelected}
        />

        {/* Recent Collections Overview */}
        <View style={styles.collectionsCard}>
          <View style={styles.collectionsHeader}>
            <View style={styles.collectionsTitleRow}>
              <Receipt size={16} color="#0c4a6e" />
              <Text style={styles.collectionsTitle}>Recent Collections</Text>
            </View>
            <TouchableOpacity
              style={styles.viewAllBtn}
              onPress={() => router.push('/ledger')}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="View all transactions in the General Ledger"
            >
              <Text style={styles.viewAllBtnText}>View All in Ledger</Text>
              <ChevronRight size={14} color="#0284c7" />
            </TouchableOpacity>
          </View>

          {collections.length === 0 ? (
            <View style={styles.collectionsEmpty}>
              <Text style={styles.collectionsEmptyText}>
                No collections recorded yet this month
              </Text>
            </View>
          ) : (
            collections.map((collection) => (
              <TouchableOpacity
                key={collection.paymentId}
                style={styles.collectionRow}
                onPress={() => {
                  setSelectedTransactionId(collection.transactionId);
                  setDetailVisible(true);
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Collection from ${collection.borrowerName} of ${formatCurrency(
                  collection.amountPaid,
                  currencySymbol
                )}. Tap to view the receipt.`}
              >
                <View style={styles.collectionMain}>
                  <Text style={styles.collectionName} numberOfLines={1}>
                    {collection.borrowerName}
                  </Text>
                  <Text style={styles.collectionDate}>{formatDbDate(collection.paidAt)}</Text>
                </View>

                <View style={styles.collectionAmountCol}>
                  <Text style={styles.collectionAmount}>
                    +{formatCurrency(collection.amountPaid, currencySymbol)}
                  </Text>
                  <View style={styles.methodPill}>
                    <Text style={styles.methodPillText}>
                      {getPaymentMethodLabel(collection.paymentMethod)}
                    </Text>
                  </View>
                </View>

                <ChevronRight size={16} color="#94a3b8" />
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>

      {/* Modals */}
      <AddBorrowerModal
        visible={addBorrowerVisible}
        onClose={() => setAddBorrowerVisible(false)}
        onSuccess={(id) => {
          setAddBorrowerVisible(false);
          triggerRefresh();
          handleBorrowerSelected(id);
        }}
      />

      <LoanOriginationModal
        visible={issueLoanVisible}
        borrower={selectedBorrower}
        onClose={() => setIssueLoanVisible(false)}
        onSuccess={() => {
          setIssueLoanVisible(false);
          triggerRefresh();
        }}
        currencySymbol={currencySymbol}
      />

      <AddLedgerModal
        visible={addLedgerVisible}
        onClose={() => setAddLedgerVisible(false)}
        onSuccess={() => {
          setAddLedgerVisible(false);
          triggerRefresh();
        }}
        currencySymbol={currencySymbol}
      />

      <BorrowerDetailModal
        visible={borrowerDetailVisible}
        borrower={selectedBorrower}
        onClose={() => setBorrowerDetailVisible(false)}
        onDataChanged={triggerRefresh}
        currencySymbol={currencySymbol}
        orgName={organizationName}
      />

      {/* Keyed so the payment form remounts (and re-reads the balance) for each loan/installment. */}
      <PaymentModal
        key={`${payingLoan?.id ?? 'none'}-${payingSchedule?.id ?? 'all'}`}
        visible={paymentModalVisible}
        loan={payingLoan}
        schedule={payingSchedule}
        borrowerName={payingBorrowerName}
        borrowerPhone={payingBorrowerPhone}
        onClose={() => setPaymentModalVisible(false)}
        onSuccess={handlePaymentSuccess}
        currencySymbol={currencySymbol}
        orgName={organizationName}
      />

      <ShareableReceiptModal
        visible={receiptModalVisible}
        receipt={currentReceipt}
        onClose={() => setReceiptModalVisible(false)}
        currencySymbol={currencySymbol}
      />

      {/* Receipt / voucher detail opened from the Recent Collections list */}
      <TransactionDetailModal
        visible={detailVisible}
        transactionId={selectedTransactionId}
        onClose={() => setDetailVisible(false)}
        currencySymbol={currencySymbol}
        orgName={organizationName}
        onOpenBorrower={handleBorrowerSelected}
        onChanged={triggerRefresh}
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
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerLeft: {
    flex: 1,
    marginRight: 10,
  },
  headerOrg: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0284c7',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0c4a6e',
    letterSpacing: -0.5,
  },
  dateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    flexShrink: 0,
  },
  dateBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0c4a6e',
  },
  metricsGrid: {
    gap: 10,
    marginBottom: 16,
  },
  backupNag: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    marginBottom: 14,
    borderRadius: 12,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  backupNagTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#92400e',
  },
  backupNagText: {
    fontSize: 11,
    lineHeight: 15,
    color: '#a16207',
    marginTop: 2,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  quickActionsBar: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 12,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: '#e0f2fe',
    justifyContent: 'space-around',
    shadowColor: '#0c4a6e',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  quickActionBtn: {
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minHeight: 48,
    justifyContent: 'center',
  },
  actionIconBg: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0c4a6e',
  },
  alertSection: {
    backgroundColor: '#fff1f2',
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  alertHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  alertTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  alertTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#991b1b',
  },
  alertList: {
    gap: 8,
  },
  alertCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fee2e2',
  },
  alertCardLeft: {
    flex: 1,
    marginRight: 8,
  },
  alertBorrowerName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  alertDueDate: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  alertAmount: {
    fontSize: 14,
    fontWeight: '800',
    color: '#dc2626',
    marginTop: 2,
  },
  alertActions: {
    flexDirection: 'row',
    gap: 6,
    flexShrink: 0,
  },
  reminderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#f0f9ff',
    paddingHorizontal: 10,
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  reminderBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0284c7',
  },
  collectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: '#dc2626',
    paddingHorizontal: 12,
    minHeight: 44,
    borderRadius: 8,
  },
  collectBtnToday: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    minHeight: 44,
    borderRadius: 8,
  },
  collectBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ffffff',
  },
  dueTodaySection: {
    backgroundColor: '#f0f9ff',
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  dueTodayCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  monthlySummaryBanner: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  monthlySummaryLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
  },
  monthlySummaryVal: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  collectionsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  collectionsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  collectionsTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  collectionsTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  viewAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minHeight: 48,
    paddingHorizontal: 8,
    flexShrink: 0,
  },
  viewAllBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0284c7',
  },
  collectionsEmpty: {
    paddingVertical: 18,
    alignItems: 'center',
  },
  collectionsEmptyText: {
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
  },
  collectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: 8,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  collectionMain: {
    flex: 1,
    marginRight: 10,
  },
  collectionName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  collectionDate: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  collectionAmountCol: {
    alignItems: 'flex-end',
    marginRight: 6,
    flexShrink: 0,
  },
  collectionAmount: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0284c7',
  },
  methodPill: {
    marginTop: 3,
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  methodPillText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0369a1',
  },
});
