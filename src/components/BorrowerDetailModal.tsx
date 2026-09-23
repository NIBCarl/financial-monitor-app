import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Linking,
  Alert,
  Platform,
  ActivityIndicator,
} from 'react-native';
import {
  X,
  ArrowLeft,
  Phone,
  MessageCircle,
  PlusCircle,
  Calendar,
  AlertCircle,
  CheckCircle2,
  Clock,
  DollarSign,
  Tag,
  MapPin,
  Trash2,
  Percent,
  CreditCard,
  Share2,
  ShieldCheck,
  FileText,
} from 'lucide-react-native';
import {
  Borrower,
  Loan,
  LoanSchedule,
  LoanPayment,
  InterestType,
  RepaymentFrequency,
  PaymentMethod,
  ReceiptData,
  PenaltyCharge,
  PenaltyRule,
} from '../db/types';
import { loanRepo } from '../db/repositories/loanRepo';
import { paymentRepo } from '../db/repositories/paymentRepo';
import { borrowerRepo } from '../db/repositories/borrowerRepo';
import { penaltyRepo } from '../db/repositories/penaltyRepo';
import { assessPenalties, previewAssessment, waiveCharge } from '../services/penaltyService';
import { describePenaltyRule } from '../utils/penalties';
import { canonicalMoney } from '../utils/money';
import { ConfirmReasonModal } from './ConfirmReasonModal';
import { PenaltyRulesModal } from './PenaltyRulesModal';
import {
  calculateAmortization,
  formatCurrency,
  formatDatePretty,
  formatDbDate,
  formatDbDateTime,
  getScheduleRemaining,
  isScheduleOverdue,
  getDaysLate,
} from '../utils/financial';
import { parseMoney, parsePositiveMoney, parseInterestRate, parseTermCount, sanitizePhoneForUri, round2 } from '../utils/validation';
import { isReceiptSettled, buildReceiptFromPayment, shareReceipt } from '../services/receiptService';
import { exportLoanStatementPdf } from '../services/pdfService';
import { format } from 'date-fns';

interface BorrowerDetailModalProps {
  visible: boolean;
  borrower: Borrower | null;
  onClose: () => void;
  onDataChanged: () => void;
  currencySymbol?: string;
  orgName?: string;
}

type ModalViewMode = 'DETAILS' | 'PAYMENT' | 'ISSUE_LOAN' | 'RECEIPT';

export const BorrowerDetailModal: React.FC<BorrowerDetailModalProps> = ({
  visible,
  borrower,
  onClose,
  onDataChanged,
  currencySymbol = '₱',
  orgName = 'Community Treasury',
}) => {
  const [viewMode, setViewMode] = useState<ModalViewMode>('DETAILS');
  const [loans, setLoans] = useState<Loan[]>([]);
  const [schedulesMap, setSchedulesMap] = useState<Record<string, LoanSchedule[]>>({});
  const [paymentsMap, setPaymentsMap] = useState<Record<string, LoanPayment[]>>({});
  const [loading, setLoading] = useState(false);

  // Payment form state
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [selectedSchedule, setSelectedSchedule] = useState<LoanSchedule | null>(null);
  const [payAmountStr, setPayAmountStr] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('CASH');
  const [payReference, setPayReference] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payLoading, setPayLoading] = useState(false);

  // Loan origination state
  const [principalStr, setPrincipalStr] = useState('10000');
  const [interestRateStr, setInterestRateStr] = useState('5');
  const [interestType, setInterestType] = useState<InterestType>('FLAT');
  const [frequency, setFrequency] = useState<RepaymentFrequency>('WEEKLY');
  const [termCountStr, setTermCountStr] = useState('4');
  const [loanLoading, setLoanLoading] = useState(false);

  // Receipt state
  const [currentReceipt, setCurrentReceipt] = useState<ReceiptData | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  // Penalty state: rules describe the arrangement, charges are what is actually owed.
  const [penaltyRules, setPenaltyRules] = useState<PenaltyRule[]>([]);
  const [penaltyCharges, setPenaltyCharges] = useState<PenaltyCharge[]>([]);
  const [rulesModalVisible, setRulesModalVisible] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [waiveChargeTarget, setWaiveChargeTarget] = useState<PenaltyCharge | null>(null);

  const openPenaltyTotal = useMemo(
    () =>
      canonicalMoney(
        penaltyCharges
          .filter((charge) => !charge.waivedAt)
          .reduce((sum, charge) => sum + Math.max(0, charge.amount - charge.paidAmount), 0)
      ),
    [penaltyCharges]
  );

  const activePenaltyRules = useMemo(
    () => penaltyRules.filter((rule) => !rule.waivedAt),
    [penaltyRules]
  );

  const openPenaltyCharges = useMemo(
    () => penaltyCharges.filter((charge) => !charge.waivedAt && charge.amount - charge.paidAmount > 0),
    [penaltyCharges]
  );

  const loadBorrowerData = useCallback(async () => {
    if (!borrower) return;
    try {
      setLoading(true);
      const borrowerLoans = await loanRepo.getLoansByBorrower(borrower.id);
      setLoans(borrowerLoans);

      // Two batched queries for all loans instead of two queries per loan.
      const loanIds = borrowerLoans.map((loan) => loan.id);
      const [allSchedules, allPayments] = await Promise.all([
        loanRepo.getSchedulesByLoanIds(loanIds),
        paymentRepo.getPaymentsByLoanIds(loanIds),
      ]);

      const schedMap: Record<string, LoanSchedule[]> = {};
      const payMap: Record<string, LoanPayment[]> = {};

      for (const loan of borrowerLoans) {
        schedMap[loan.id] = [];
        payMap[loan.id] = [];
      }
      for (const schedule of allSchedules) {
        (schedMap[schedule.loanId] ??= []).push(schedule);
      }
      for (const payment of allPayments) {
        (payMap[payment.loanId] ??= []).push(payment);
      }

      setSchedulesMap(schedMap);
      setPaymentsMap(payMap);

      // Penalties load alongside the rest; a database that predates migration v4 must not break
      // the profile, so a failure here simply leaves the penalty section empty.
      try {
        const [rules, charges] = await Promise.all([
          penaltyRepo.getAllRulesForBorrower(borrower.id),
          penaltyRepo.getAllChargesForBorrower(borrower.id),
        ]);
        setPenaltyRules(rules);
        setPenaltyCharges(charges);
      } catch (penaltyErr) {
        console.warn('Penalty data unavailable:', penaltyErr);
        setPenaltyRules([]);
        setPenaltyCharges([]);
      }
    } catch (err) {
      console.error('Failed to load borrower data:', err);
    } finally {
      setLoading(false);
    }
  }, [borrower]);

  useEffect(() => {
    if (visible && borrower) {
      setViewMode('DETAILS');
      loadBorrowerData();
    }
  }, [visible, borrower, loadBorrowerData]);

  // Loan origination preview — parsed with the same strict parser used when saving, so the
  // preview can never show a different figure from the one that gets persisted.
  const principalResult = parseMoney(principalStr);
  const principal = principalResult.ok ? principalResult.value : 0;
  const interestResult = parseInterestRate(interestRateStr);
  const interestRate = interestResult.ok ? interestResult.value : 0;
  const termResult = parseTermCount(termCountStr);
  const termCount = termResult.ok ? termResult.value : 1;

  const calculation = useMemo(() => {
    if (principal <= 0 || termCount <= 0) return null;
    return calculateAmortization({
      principal,
      interestRate,
      interestType,
      frequency,
      termCount,
      startDate: format(new Date(), 'yyyy-MM-dd'),
    });
  }, [principal, interestRate, interestType, frequency, termCount]);

  if (!borrower) return null;

  const handleCall = () => {
    Linking.openURL(`tel:${sanitizePhoneForUri(borrower.phoneNumber)}`);
  };

  const handleSMS = () => {
    Linking.openURL(`sms:${sanitizePhoneForUri(borrower.phoneNumber)}`);
  };

  const handleDeleteBorrower = () => {
    Alert.alert(
      'Delete Borrower',
      `Are you sure you want to delete ${borrower.fullName}? Only borrowers without active loans can be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await borrowerRepo.delete(borrower.id);
              if (!res.success) {
                Alert.alert('Cannot Delete', res.message || 'Active loans present.');
              } else {
                onDataChanged();
                onClose();
              }
            } catch (err) {
              // e.g. a settled loan still references this borrower (FK RESTRICT).
              Alert.alert(
                'Cannot Delete',
                err instanceof Error
                  ? err.message
                  : 'This borrower is referenced by existing loan records and cannot be deleted.'
              );
            }
          },
        },
      ]
    );
  };

  // Open internal payment form
  const openPayForSchedule = (loan: Loan, schedule: LoanSchedule) => {
    setSelectedLoan(loan);
    setSelectedSchedule(schedule);
    const remaining = getScheduleRemaining(schedule);
    setPayAmountStr(remaining > 0 ? remaining.toFixed(2) : round2(schedule.expectedAmount).toFixed(2));
    setPayMethod('CASH');
    setPayReference('');
    setPayNotes('');
    setViewMode('PAYMENT');
  };

  const openPayForLoanGeneral = (loan: Loan) => {
    setSelectedLoan(loan);
    setSelectedSchedule(null);
    setPayAmountStr(round2(loan.remainingBalance).toFixed(2));
    setPayMethod('CASH');
    setPayReference('');
    setPayNotes('');
    setViewMode('PAYMENT');
  };

  /**
   * Builds and shares a printable statement of account for one loan.
   *
   * `borrower` is guaranteed here — the button only renders inside the profile.
   */
  const handleShareStatement = async (loanId: string) => {
    if (!borrower) return;
    try {
      setPdfBusy(true);
      await exportLoanStatementPdf({
        borrowerId: borrower.id,
        loanId,
        orgName,
        currencySymbol,
      });
    } catch (err) {
      Alert.alert(
        'Statement failed',
        err instanceof Error ? err.message : 'Could not build the statement.'
      );
    } finally {
      setPdfBusy(false);
    }
  };

  const handleAssessPenalties = async () => {
    if (!borrower) return;
    try {
      setAssessing(true);

      // Preview first — the treasurer sees the exact total before anything is written.
      const preview = await previewAssessment(borrower.id);

      if (preview.lines.length === 0) {
        Alert.alert(
          'Nothing to Assess',
          activePenaltyRules.length === 0
            ? 'This borrower has no penalty rules, so no penalty can be charged. Add a rule first.'
            : 'Every overdue installment is already charged up to date. Nothing to add.'
        );
        return;
      }

      const lines = preview.lines
        .slice(0, 8)
        .map(
          (line) =>
            `• Installment #${line.installmentNumber}: ${line.daysLate} day${line.daysLate === 1 ? '' : 's'} late → ${formatCurrency(line.amount, currencySymbol)}${line.isRaise ? ` (up from ${formatCurrency(line.previousAmount, currencySymbol)})` : ''}`
        )
        .join('\n');
      const more =
        preview.lines.length > 8 ? `\n…and ${preview.lines.length - 8} more installment(s).` : '';

      Alert.alert(
        'Assess Penalties?',
        `${lines}${more}\n\nNewly recorded: ${formatCurrency(preview.totalNewAmount, currencySymbol)}\nTotal penalties on the account: ${formatCurrency(preview.totalAfter, currencySymbol)}`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Assess',
            onPress: () => {
              void (async () => {
                try {
                  const result = await assessPenalties(borrower.id);
                  await loadBorrowerData();
                  onDataChanged();
                  const chargedCount = result.created + result.raised;
                  Alert.alert(
                    'Penalties Assessed',
                    chargedCount === 0
                      ? 'Nothing new was recorded.'
                      : `${formatCurrency(result.totalAmount, currencySymbol)} recorded across ${chargedCount} installment${chargedCount === 1 ? '' : 's'} (${result.created} new, ${result.raised} increased).`
                  );
                } catch (err) {
                  Alert.alert(
                    'Assessment Failed',
                    err instanceof Error ? err.message : 'Could not assess penalties.'
                  );
                }
              })();
            },
          },
        ]
      );
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not preview penalties.');
    } finally {
      setAssessing(false);
    }
  };

  const handleWaiveCharge = (charge: PenaltyCharge) => {
    const outstanding = canonicalMoney(charge.amount - charge.paidAmount);
    Alert.alert(
      'Waive this penalty?',
      `${formatCurrency(outstanding, currencySymbol)} on installment #${charge.installmentNumber ?? '—'} will be forgiven and will no longer be collected. The waiver is recorded in the audit log.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => setWaiveChargeTarget(charge),
        },
      ]
    );
  };

  const submitPayment = async (amount: number) => {
    if (!selectedLoan) return;

    try {
      setPayLoading(true);
      const result = await paymentRepo.recordPayment({
        loanId: selectedLoan.id,
        scheduleId: selectedSchedule?.id,
        amountPaid: amount,
        paymentMethod: payMethod,
        referenceNo: payReference.trim() || undefined,
        notes: payNotes.trim() || undefined,
      });

      setCurrentReceipt(
        buildReceiptFromPayment({
          payment: result.payment,
          remainingBalance: result.remainingBalance,
          nextDueDate: result.nextDueDate,
          nextDueAmount: result.nextDueAmount,
          allocations: result.allocations,
          unallocated: result.unallocated,
          borrowerName: borrower.fullName,
          borrowerPhone: borrower.phoneNumber,
          orgName,
        })
      );

      await loadBorrowerData();
      onDataChanged();
      setViewMode('RECEIPT');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to record payment.');
    } finally {
      setPayLoading(false);
    }
  };

  const handleRecordPayment = () => {
    if (!selectedLoan) return;

    const parsed = parsePositiveMoney(payAmountStr);
    if (!parsed.ok) {
      Alert.alert('Invalid Amount', parsed.error);
      return;
    }

    const outstanding = round2(selectedLoan.remainingBalance);
    if (outstanding > 0.004 && parsed.value > outstanding + 0.004) {
      Alert.alert(
        'Amount Exceeds Balance',
        `Only ${formatCurrency(outstanding, currencySymbol)} is still outstanding on this loan. Enter that amount or less.`
      );
      return;
    }

    // Show the parsed figure so a mistyped separator can never be recorded silently.
    Alert.alert(
      'Confirm Payment',
      `Record ${formatCurrency(parsed.value, currencySymbol)} received from ${borrower.fullName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Record',
          onPress: () => {
            void submitPayment(parsed.value);
          },
        },
      ]
    );
  };

  const disburseLoan = async (amount: number) => {
    try {
      setLoanLoading(true);
      await loanRepo.createLoan({
        borrowerId: borrower.id,
        principalAmount: amount,
        interestRate,
        interestType,
        frequency,
        termCount,
        startDate: format(new Date(), 'yyyy-MM-dd'),
      });

      await loadBorrowerData();
      onDataChanged();
      setViewMode('DETAILS');
      Alert.alert(
        'Loan Disbursed',
        `Successfully issued a loan of ${formatCurrency(amount, currencySymbol)} to ${borrower.fullName}. A cash outflow was recorded in the ledger.`
      );
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to disburse loan.');
    } finally {
      setLoanLoading(false);
    }
  };

  const handleCreateLoan = () => {
    if (!principalResult.ok) {
      Alert.alert('Invalid Amount', principalResult.error);
      return;
    }
    if (!interestResult.ok) {
      Alert.alert('Invalid Interest Rate', interestResult.error);
      return;
    }
    if (!termResult.ok) {
      Alert.alert('Invalid Terms', termResult.error);
      return;
    }

    // Echo the parsed figures before money leaves the fund.
    const scheduleSummary = calculation
      ? `\n\nTotal payable: ${formatCurrency(calculation.totalPayable, currencySymbol)}\n` +
        `Installments: ${calculation.termCount} × ≈${formatCurrency(calculation.installmentAmount, currencySymbol)}`
      : '';

    Alert.alert(
      'Confirm Loan Disbursement',
      `Disburse ${formatCurrency(principalResult.value, currencySymbol)} to ${borrower.fullName}?${scheduleSummary}\n\nThis records a cash outflow in the ledger.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disburse',
          onPress: () => {
            void disburseLoan(principalResult.value);
          },
        },
      ]
    );
  };

  const handleShareReceipt = async () => {
    if (!currentReceipt) return;
    try {
      await shareReceipt(currentReceipt, currencySymbol);
    } catch (err) {
      console.error('Error sharing receipt:', err);
    }
  };

  const activeLoan = loans.find((l) => l.status === 'ACTIVE' || l.status === 'OVERDUE');

  // Overdue is derived from the schedule dates (statuses are never written as 'OVERDUE' by design).
  const activeLoanSchedules = activeLoan ? schedulesMap[activeLoan.id] ?? [] : [];
  const overdueSchedules = activeLoanSchedules.filter((s) => isScheduleOverdue(s));
  const activeLoanOverdue = overdueSchedules.length > 0;
  const activeLoanDaysLate = activeLoanOverdue
    ? Math.max(...overdueSchedules.map((s) => getDaysLate(s.dueDate)))
    : 0;

  const recentPayments = activeLoan ? (paymentsMap[activeLoan.id] ?? []).slice(0, 4) : [];

  const paymentMethods: { label: string; value: PaymentMethod }[] = [
    { label: 'Cash', value: 'CASH' },
    { label: 'GCash / Maya', value: 'GCASH' },
    { label: 'Bank Transfer', value: 'BANK_TRANSFER' },
    { label: 'Cheque', value: 'CHEQUE' },
  ];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheetContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              {viewMode !== 'DETAILS' ? (
                <TouchableOpacity
                  onPress={() => setViewMode('DETAILS')}
                  style={styles.backBtn}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <ArrowLeft size={20} color="#0c4a6e" />
                </TouchableOpacity>
              ) : null}

              <View style={styles.headerTextGroup}>
                <Text style={styles.headerName} numberOfLines={1}>
                  {viewMode === 'PAYMENT'
                    ? 'Record Payment'
                    : viewMode === 'ISSUE_LOAN'
                    ? 'Issue New Loan'
                    : viewMode === 'RECEIPT'
                    ? 'Payment Receipt'
                    : borrower.fullName}
                </Text>
                {viewMode === 'DETAILS' ? (
                  <View style={styles.tagBadge}>
                    <Tag size={10} color="#0284c7" />
                    <Text style={styles.tagText}>{borrower.categoryTag}</Text>
                  </View>
                ) : (
                  <Text style={styles.headerSubtext} numberOfLines={1}>
                    {borrower.fullName}
                  </Text>
                )}
              </View>
            </View>

            <View style={styles.headerRight}>
              {viewMode === 'DETAILS' ? (
                <TouchableOpacity
                  onPress={handleDeleteBorrower}
                  style={styles.iconBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Trash2 size={18} color="#dc2626" />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={onClose}
                style={styles.iconBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <X size={20} color="#64748b" />
              </TouchableOpacity>
            </View>
          </View>

          {/* View Mode 1: Borrower Profile & Loans */}
          {viewMode === 'DETAILS' && (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
              {loading && (
                <View style={styles.infoHint}>
                  <Text style={styles.infoHintText}>Loading borrower records…</Text>
                </View>
              )}
              {/* Quick Communication Bar */}
              <View style={styles.contactBar}>
                <View style={styles.contactInfo}>
                  <Phone size={14} color="#0284c7" />
                  <Text style={styles.phoneText} numberOfLines={1}>
                    {borrower.phoneNumber}
                  </Text>
                </View>
                <View style={styles.contactActions}>
                  <TouchableOpacity style={styles.contactBtn} onPress={handleCall}>
                    <Phone size={13} color="#0284c7" />
                    <Text style={styles.contactBtnText}>Call</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.contactBtn} onPress={handleSMS}>
                    <MessageCircle size={13} color="#0369a1" />
                    <Text style={[styles.contactBtnText, { color: '#0369a1' }]}>SMS</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Address / Notes info if present */}
              {(borrower.address || borrower.notes) && (
                <View style={styles.notesCard}>
                  {borrower.address ? (
                    <View style={styles.metaRow}>
                      <MapPin size={12} color="#0369a1" />
                      <Text style={styles.metaText}>{borrower.address}</Text>
                    </View>
                  ) : null}
                  {borrower.notes ? (
                    <Text style={styles.notesText}>Note: {borrower.notes}</Text>
                  ) : null}
                </View>
              )}

              {/* Penalties — rules and what has actually been assessed */}
              <View style={styles.penaltyCard}>
                <View style={styles.penaltyHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.penaltyTitle}>Penalties</Text>
                    <Text style={styles.penaltySubtitle}>
                      {activePenaltyRules.length === 0
                        ? 'No rules — this borrower cannot be penalised'
                        : `${activePenaltyRules.length} active rule${activePenaltyRules.length === 1 ? '' : 's'}`}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.penaltyAmountLabel}>Outstanding</Text>
                    <Text
                      style={[styles.penaltyAmount, openPenaltyTotal > 0 && styles.penaltyAmountDue]}
                    >
                      {formatCurrency(openPenaltyTotal, currencySymbol)}
                    </Text>
                  </View>
                </View>

                {activePenaltyRules.slice(0, 3).map((rule) => (
                  <Text key={rule.id} style={styles.penaltyRuleLine}>
                    • {describePenaltyRule(rule, currencySymbol)}
                    {rule.scope === 'LOAN' ? ' (one loan)' : ' (whole account)'}
                  </Text>
                ))}
                {activePenaltyRules.length > 3 ? (
                  <Text style={styles.penaltyRuleLine}>
                    …and {activePenaltyRules.length - 3} more rule(s).
                  </Text>
                ) : null}

                {openPenaltyCharges.slice(0, 5).map((charge) => (
                  <View key={charge.id} style={styles.penaltyChargeRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.penaltyChargeText}>
                        Installment #{charge.installmentNumber ?? '—'} •{' '}
                        {formatCurrency(canonicalMoney(charge.amount - charge.paidAmount), currencySymbol)}
                        {charge.paidAmount > 0
                          ? ` (partly paid: ${formatCurrency(charge.paidAmount, currencySymbol)})`
                          : ''}
                      </Text>
                      <Text style={styles.penaltyChargeMeta}>
                        {charge.daysLate} day{charge.daysLate === 1 ? '' : 's'} late
                        {charge.assessedAt
                          ? ` • assessed ${formatDatePretty(charge.assessedAt.slice(0, 10))}`
                          : ''}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleWaiveCharge(charge)}
                      style={styles.penaltyWaiveBtn}
                      accessibilityLabel="Waive this penalty"
                    >
                      <Text style={styles.penaltyWaiveText}>Waive</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                {openPenaltyCharges.length > 5 ? (
                  <Text style={styles.penaltyChargeMeta}>
                    …and {openPenaltyCharges.length - 5} more assessed penalty(ies).
                  </Text>
                ) : null}

                <View style={styles.penaltyActions}>
                  <TouchableOpacity
                    style={[styles.penaltyActionBtn, assessing && { opacity: 0.6 }]}
                    onPress={() => void handleAssessPenalties()}
                    disabled={assessing}
                  >
                    {assessing ? (
                      <ActivityIndicator size="small" color="#ffffff" />
                    ) : (
                      <AlertCircle size={14} color="#ffffff" />
                    )}
                    <Text style={styles.penaltyActionBtnText}>Assess now</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.penaltySecondaryBtn}
                    onPress={() => setRulesModalVisible(true)}
                  >
                    <Tag size={14} color="#0369a1" />
                    <Text style={styles.penaltySecondaryBtnText}>Manage rules</Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.penaltyFootnote}>
                  Assessing adds penalties for installments that are late under your rules. Nothing is
                  ever charged automatically.
                </Text>
              </View>

              {/* Active Loan Status Card */}
              {activeLoan ? (
                <View style={styles.loanCard}>
                  <View style={styles.loanCardHeader}>
                    <View style={styles.loanHeaderLeft}>
                      <Text style={styles.loanTitle}>Active Loan Agreement</Text>
                      <Text style={styles.loanSubtitle}>
                        Issued {formatDatePretty(activeLoan.startDate)} • {activeLoan.frequency}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.statusPill,
                        activeLoanOverdue ? styles.pillOverdue : styles.pillActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusPillText,
                          activeLoanOverdue ? styles.pillTextOverdue : styles.pillTextActive,
                        ]}
                      >
                        {activeLoanOverdue
                          ? `OVERDUE${activeLoanDaysLate > 0 ? ` ${activeLoanDaysLate}d` : ''}`
                          : activeLoan.status}
                      </Text>
                    </View>
                  </View>

                  {/* Financial Grid */}
                  <View style={styles.finGrid}>
                    <View style={styles.finCol}>
                      <Text style={styles.finLabel}>Principal</Text>
                      <Text style={styles.finVal} numberOfLines={1} adjustsFontSizeToFit>
                        {formatCurrency(activeLoan.principalAmount, currencySymbol)}
                      </Text>
                    </View>
                    <View style={styles.finCol}>
                      <Text style={styles.finLabel}>Interest</Text>
                      <Text style={styles.finVal} numberOfLines={1}>
                        {activeLoan.interestRate}%
                      </Text>
                    </View>
                    <View style={styles.finCol}>
                      <Text style={styles.finLabel}>Balance</Text>
                      <Text style={[styles.finVal, styles.balanceVal]} numberOfLines={1} adjustsFontSizeToFit>
                        {formatCurrency(activeLoan.remainingBalance, currencySymbol)}
                      </Text>
                    </View>
                  </View>

                  {/* Installments Table */}
                  <Text style={styles.sectionHeading}>Repayment Schedule</Text>
                  <View style={styles.schedulesList}>
                    {(schedulesMap[activeLoan.id] || []).map((sch) => {
                      const isPaid = sch.status === 'PAID';
                      const isPartial = sch.status === 'PARTIAL';
                      const isOverdue = isScheduleOverdue(sch);

                      return (
                        <View key={sch.id} style={styles.scheduleRow}>
                          <View style={styles.schLeft}>
                            <View
                              style={[
                                styles.schBadge,
                                isPaid
                                  ? styles.schBadgePaid
                                  : isOverdue
                                  ? styles.schBadgeOverdue
                                  : styles.schBadgePending,
                              ]}
                            >
                              {isPaid ? (
                                <CheckCircle2 size={12} color="#0284c7" />
                              ) : isOverdue ? (
                                <AlertCircle size={12} color="#dc2626" />
                              ) : (
                                <Clock size={12} color="#64748b" />
                              )}
                              <Text style={styles.schNumber}>#{sch.installmentNumber}</Text>
                            </View>

                            <View style={styles.schTextCol}>
                              <Text style={styles.schDate}>
                                Due: {formatDatePretty(sch.dueDate)}
                              </Text>
                              {isPartial ? (
                                <Text style={styles.schPartialText} numberOfLines={1}>
                                  Paid {formatCurrency(sch.paidAmount, currencySymbol)} of {formatCurrency(sch.expectedAmount, currencySymbol)}
                                </Text>
                              ) : (
                                <Text style={styles.schExpected} numberOfLines={1}>
                                  {formatCurrency(sch.expectedAmount, currencySymbol)}
                                </Text>
                              )}
                              {isOverdue && (
                                <Text style={styles.schOverdueText} numberOfLines={1}>
                                  {getDaysLate(sch.dueDate)} day
                                  {getDaysLate(sch.dueDate) === 1 ? '' : 's'} late •{' '}
                                  {formatCurrency(getScheduleRemaining(sch), currencySymbol)} still due
                                </Text>
                              )}
                            </View>
                          </View>

                          {/* Quick Pay Button */}
                          {!isPaid ? (
                            <TouchableOpacity
                              style={styles.payBtn}
                              onPress={() => openPayForSchedule(activeLoan, sch)}
                              activeOpacity={0.8}
                            >
                              <DollarSign size={13} color="#ffffff" />
                              <Text style={styles.payBtnText}>Pay</Text>
                            </TouchableOpacity>
                          ) : (
                            <View style={styles.clearedBadge}>
                              <Text style={styles.clearedBadgeText}>Paid</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>

                  {/* General Payment Button */}
                  <TouchableOpacity
                    style={styles.generalPayBtn}
                    onPress={() => openPayForLoanGeneral(activeLoan)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.generalPayBtnText}>Record Custom Amount</Text>
                  </TouchableOpacity>

                  {/* Printable statement of account for this loan */}
                  <TouchableOpacity
                    style={[styles.statementBtn, pdfBusy && styles.statementBtnBusy]}
                    onPress={() => void handleShareStatement(activeLoan.id)}
                    disabled={pdfBusy}
                    activeOpacity={0.8}
                  >
                    {pdfBusy ? (
                      <ActivityIndicator size="small" color="#0284c7" />
                    ) : (
                      <FileText size={16} color="#0284c7" />
                    )}
                    <Text style={styles.statementBtnText}>
                      {pdfBusy ? 'Building PDF…' : 'Statement of Account (PDF)'}
                    </Text>
                  </TouchableOpacity>

                  {/* Recent payments recorded against this loan */}
                  {recentPayments.length > 0 && (
                    <View style={styles.paymentHistory}>
                      <Text style={styles.sectionHeading}>Recent Payments</Text>
                      {recentPayments.map((pastPayment) => (
                        <View key={pastPayment.id} style={styles.paymentHistoryRow}>
                          <Text style={styles.paymentHistoryDate}>
                            {formatDbDate(pastPayment.paidAt)}
                          </Text>
                          <Text
                            style={[
                              styles.paymentHistoryMethod,
                              pastPayment.voidedAt ? styles.paymentHistoryVoided : null,
                            ]}
                            numberOfLines={1}
                          >
                            {pastPayment.voidedAt
                              ? 'VOIDED'
                              : pastPayment.paymentMethod.replace('_', ' ')}
                          </Text>
                          <Text
                            style={[
                              styles.paymentHistoryAmount,
                              pastPayment.voidedAt ? styles.paymentHistoryAmountVoided : null,
                            ]}
                          >
                            {formatCurrency(pastPayment.amountPaid, currencySymbol)}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              ) : (
                <View style={styles.noLoanCard}>
                  <Text style={styles.noLoanTitle}>No Active Loan</Text>
                  <Text style={styles.noLoanDesc}>
                    This borrower currently has zero outstanding balance.
                  </Text>
                  <TouchableOpacity
                    style={styles.issueLoanBtn}
                    onPress={() => setViewMode('ISSUE_LOAN')}
                    activeOpacity={0.8}
                  >
                    <PlusCircle size={18} color="#ffffff" style={{ marginRight: 6 }} />
                    <Text style={styles.issueLoanBtnText}>Issue New Loan</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Historical Loans if any */}
              {loans.filter((l) => l.status === 'SETTLED').length > 0 && (
                <View style={styles.pastLoansSection}>
                  <Text style={styles.sectionHeading}>Completed Loans</Text>
                  {loans
                    .filter((l) => l.status === 'SETTLED')
                    .map((past) => (
                      <View key={past.id} style={styles.pastLoanItem}>
                        <View style={{ flex: 1, marginRight: 8 }}>
                          <Text style={styles.pastLoanAmt}>
                            {formatCurrency(past.principalAmount, currencySymbol)}
                          </Text>
                          <Text style={styles.pastLoanDates}>
                            {formatDatePretty(past.startDate)} – {formatDatePretty(past.endDate)}
                          </Text>
                        </View>
                        <View style={styles.settledBadge}>
                          <Text style={styles.settledBadgeText}>Fully Settled</Text>
                        </View>
                      </View>
                    ))}
                </View>
              )}
            </ScrollView>
          )}

          {/* View Mode 2: Integrated Payment Screen */}
          {viewMode === 'PAYMENT' && (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Amount Received ({currencySymbol})</Text>
                <TextInput
                  style={[styles.input, styles.largeInput]}
                  keyboardType="numeric"
                  value={payAmountStr}
                  onChangeText={setPayAmountStr}
                  autoFocus
                />
                {selectedSchedule && (
                  <View style={styles.infoHint}>
                    <Text style={styles.infoHintText}>
                      Expected installment:{' '}
                      <Text style={{ fontWeight: '800', color: '#0c4a6e' }}>
                        {formatCurrency(selectedSchedule.expectedAmount - selectedSchedule.paidAmount, currencySymbol)}
                      </Text>
                    </Text>
                  </View>
                )}
              </View>

              {/* Payment Method */}
              <View style={styles.fieldGroup}>
                <View style={styles.labelWithIcon}>
                  <CreditCard size={14} color="#0369a1" />
                  <Text style={styles.label}>Payment Method</Text>
                </View>
                <View style={styles.methodGrid}>
                  {paymentMethods.map((m) => (
                    <TouchableOpacity
                      key={m.value}
                      style={[styles.methodBtn, payMethod === m.value && styles.methodBtnActive]}
                      onPress={() => setPayMethod(m.value)}
                    >
                      <Text
                        style={[
                          styles.methodBtnText,
                          payMethod === m.value && styles.methodBtnTextActive,
                        ]}
                      >
                        {m.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Reference Number */}
              {payMethod !== 'CASH' && (
                <View style={styles.fieldGroup}>
                  <View style={styles.labelWithIcon}>
                    <Tag size={14} color="#0369a1" />
                    <Text style={styles.label}>Transaction / Reference # (Optional)</Text>
                  </View>
                  <TextInput
                    style={styles.input}
                    placeholder="e.g. GCash Ref 1029384756"
                    placeholderTextColor="#94a3b8"
                    value={payReference}
                    onChangeText={setPayReference}
                  />
                </View>
              )}

              {/* Remarks */}
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Remarks / Note (Optional)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Paid in cash at committee meeting"
                  placeholderTextColor="#94a3b8"
                  value={payNotes}
                  onChangeText={setPayNotes}
                />
              </View>

              {/* Action Buttons */}
              <View style={styles.formActionRow}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => setViewMode('DETAILS')}
                  disabled={payLoading}
                >
                  <Text style={styles.cancelBtnText}>Back</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.saveBtn, payLoading && styles.saveBtnDisabled]}
                  onPress={handleRecordPayment}
                  disabled={payLoading}
                >
                  <Text style={styles.saveBtnText}>
                    {payLoading ? 'Recording...' : 'Confirm & Save'}
                  </Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}

          {/* View Mode 3: Integrated Loan Origination Form */}
          {viewMode === 'ISSUE_LOAN' && (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Principal Amount ({currencySymbol})</Text>
                <TextInput
                  style={[styles.input, styles.largeInput]}
                  keyboardType="numeric"
                  value={principalStr}
                  onChangeText={setPrincipalStr}
                  placeholder="10000"
                  placeholderTextColor="#94a3b8"
                />
                <View style={styles.quickAmountRow}>
                  {[2000, 5000, 10000, 20000].map((amt) => (
                    <TouchableOpacity
                      key={amt}
                      style={styles.quickAmountBtn}
                      onPress={() => setPrincipalStr(amt.toString())}
                    >
                      <Text style={styles.quickAmountText}>
                        +{formatCurrency(amt, currencySymbol).replace('.00', '')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Interest Rate & Type */}
              <View style={styles.twoColRow}>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <View style={styles.labelWithIcon}>
                    <Percent size={13} color="#0369a1" />
                    <Text style={styles.label}>Interest (%)</Text>
                  </View>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={interestRateStr}
                    onChangeText={setInterestRateStr}
                    placeholder="5"
                    placeholderTextColor="#94a3b8"
                  />
                </View>

                <View style={[styles.fieldGroup, { flex: 1.2 }]}>
                  <Text style={styles.label}>Method</Text>
                  <View style={styles.typeSelector}>
                    <TouchableOpacity
                      style={[styles.typeBtn, interestType === 'FLAT' && styles.typeBtnActive]}
                      onPress={() => setInterestType('FLAT')}
                    >
                      <Text
                        style={[
                          styles.typeBtnText,
                          interestType === 'FLAT' && styles.typeBtnTextActive,
                        ]}
                      >
                        Flat %
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.typeBtn, interestType === 'NONE' && styles.typeBtnActive]}
                      onPress={() => setInterestType('NONE')}
                    >
                      <Text
                        style={[
                          styles.typeBtnText,
                          interestType === 'NONE' && styles.typeBtnTextActive,
                        ]}
                      >
                        0% (Dues)
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>

              {/* Repayment Frequency */}
              <View style={styles.fieldGroup}>
                <View style={styles.labelWithIcon}>
                  <Calendar size={13} color="#0369a1" />
                  <Text style={styles.label}>Repayment Frequency</Text>
                </View>
                <View style={styles.freqRow}>
                  {(['WEEKLY', 'BI_WEEKLY', 'MONTHLY', 'DAILY'] as RepaymentFrequency[]).map(
                    (freq) => (
                      <TouchableOpacity
                        key={freq}
                        style={[styles.freqBtn, frequency === freq && styles.freqBtnActive]}
                        onPress={() => setFrequency(freq)}
                      >
                        <Text
                          style={[
                            styles.freqBtnText,
                            frequency === freq && styles.freqBtnTextActive,
                          ]}
                          numberOfLines={1}
                        >
                          {freq === 'BI_WEEKLY'
                            ? 'Bi-Weekly'
                            : freq.charAt(0) + freq.slice(1).toLowerCase()}
                        </Text>
                      </TouchableOpacity>
                    )
                  )}
                </View>
              </View>

              {/* Term Count */}
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>
                  Number of Installments ({frequency.toLowerCase().replace('_', ' ')})
                </Text>
                <View style={styles.termCounterRow}>
                  <TouchableOpacity
                    style={styles.counterBtn}
                    onPress={() => setTermCountStr(Math.max(1, termCount - 1).toString())}
                  >
                    <Text style={styles.counterBtnText}>-</Text>
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.input, styles.counterInput]}
                    keyboardType="numeric"
                    value={termCountStr}
                    onChangeText={setTermCountStr}
                  />
                  <TouchableOpacity
                    style={styles.counterBtn}
                    onPress={() => setTermCountStr((termCount + 1).toString())}
                  >
                    <Text style={styles.counterBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Live Calculation Card */}
              {calculation && (
                <View style={styles.calcCard}>
                  <Text style={styles.calcCardTitle}>Repayment Summary</Text>
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>Principal Amount:</Text>
                    <Text style={styles.calcValue}>
                      {formatCurrency(calculation.principal, currencySymbol)}
                    </Text>
                  </View>
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>Total Interest ({interestRate}%):</Text>
                    <Text style={[styles.calcValue, { color: '#0284c7' }]}>
                      +{formatCurrency(calculation.interestAmount, currencySymbol)}
                    </Text>
                  </View>
                  <View style={[styles.calcRow, styles.calcRowTotal]}>
                    <Text style={styles.calcLabelTotal}>Total Payable:</Text>
                    <Text style={styles.calcValueTotal}>
                      {formatCurrency(calculation.totalPayable, currencySymbol)}
                    </Text>
                  </View>
                  <View style={styles.divider} />
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>Per Installment ({termCount}x):</Text>
                    <Text style={styles.installmentHighlight}>
                      {formatCurrency(calculation.installmentAmount, currencySymbol)}
                    </Text>
                  </View>
                </View>
              )}

              {/* Action Buttons */}
              <View style={styles.formActionRow}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => setViewMode('DETAILS')}
                  disabled={loanLoading}
                >
                  <Text style={styles.cancelBtnText}>Back</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.saveBtn, loanLoading && styles.saveBtnDisabled]}
                  onPress={handleCreateLoan}
                  disabled={loanLoading}
                >
                  <Text style={styles.saveBtnText}>
                    {loanLoading ? 'Disbursing...' : 'Disburse & Record'}
                  </Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}

          {/* View Mode 4: Integrated Receipt Screen */}
          {viewMode === 'RECEIPT' && currentReceipt && (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <View style={styles.receiptContainer}>
                <View style={styles.successIconBadge}>
                  <CheckCircle2 size={36} color="#0284c7" />
                </View>
                <Text style={styles.receiptTitle}>Payment Successful!</Text>
                <Text style={styles.receiptSubtitle}>{currentReceipt.orgName || orgName}</Text>
                <Text style={styles.receiptSubtitle}>Official Treasury Receipt</Text>

                <View style={styles.receiptDivider} />

                <View style={styles.amountBox}>
                  <Text style={styles.amountBoxLabel}>AMOUNT PAID</Text>
                  <Text style={styles.amountBoxVal}>
                    {formatCurrency(currentReceipt.amountPaid, currencySymbol)}
                  </Text>
                  <Text style={styles.receiptMethod}>
                    Paid via {currentReceipt.paymentMethod}
                    {currentReceipt.referenceNo ? ` • Ref: ${currentReceipt.referenceNo}` : ''}
                  </Text>
                </View>

                <View style={styles.receiptDivider} />

                <View style={styles.receiptDetails}>
                  <View style={styles.receiptDetailRow}>
                    <Text style={styles.receiptLabel}>Borrower:</Text>
                    <Text style={styles.receiptVal}>{currentReceipt.borrowerName}</Text>
                  </View>
                  <View style={styles.receiptDetailRow}>
                    <Text style={styles.receiptLabel}>Date & Time:</Text>
                    <Text style={styles.receiptVal}>
                      {formatDbDateTime(currentReceipt.paidAt)}
                    </Text>
                  </View>
                  {currentReceipt.allocations && currentReceipt.allocations.length > 0 && (
                    <View style={styles.receiptDetailRow}>
                      <Text style={styles.receiptLabel}>Applied To:</Text>
                      <Text style={[styles.receiptVal, { flexShrink: 1, textAlign: 'right' }]}>
                        {currentReceipt.allocations
                          .map(
                            (a) => `#${a.installmentNumber} ${formatCurrency(a.amount, currencySymbol)}`
                          )
                          .join(' • ')}
                      </Text>
                    </View>
                  )}
                  <View style={styles.receiptDetailRow}>
                    <Text style={styles.receiptLabel}>Remaining Balance:</Text>
                    <Text style={[styles.receiptVal, { fontWeight: '800', color: '#0c4a6e' }]}>
                      {formatCurrency(currentReceipt.remainingBalance, currencySymbol)}
                    </Text>
                  </View>
                  <View style={styles.receiptDetailRow}>
                    <Text style={styles.receiptLabel}>
                      {isReceiptSettled(currentReceipt) ? 'Status:' : 'Next Due:'}
                    </Text>
                    <Text style={[styles.receiptVal, { fontWeight: '800', color: '#0c4a6e' }]}>
                      {isReceiptSettled(currentReceipt)
                        ? 'FULLY SETTLED'
                        : currentReceipt.nextDueDate
                        ? `${formatDatePretty(currentReceipt.nextDueDate)}${
                            currentReceipt.nextDueAmount
                              ? ` • ${formatCurrency(currentReceipt.nextDueAmount, currencySymbol)}`
                              : ''
                          }`
                        : 'To be scheduled'}
                    </Text>
                  </View>
                </View>

                <View style={styles.badgeFooter}>
                  <ShieldCheck size={14} color="#0284c7" />
                  <Text style={styles.badgeFooterText}>Recorded in Offline Treasury Ledger</Text>
                </View>

                <View style={styles.receiptActions}>
                  <TouchableOpacity
                    style={styles.receiptDoneBtn}
                    onPress={() => setViewMode('DETAILS')}
                  >
                    <Text style={styles.receiptDoneBtnText}>Done</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.receiptShareBtn} onPress={handleShareReceipt}>
                    <Share2 size={16} color="#ffffff" style={{ marginRight: 6 }} />
                    <Text style={styles.receiptShareBtnText}>Share Proof</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          )}
        </View>
      </View>

      <PenaltyRulesModal
        visible={rulesModalVisible}
        borrowerId={borrower.id}
        borrowerName={borrower.fullName}
        loans={loans}
        currencySymbol={currencySymbol}
        onClose={() => setRulesModalVisible(false)}
        onChanged={() => {
          void loadBorrowerData();
          onDataChanged();
        }}
      />

      <ConfirmReasonModal
        visible={waiveChargeTarget !== null}
        title="Waive this penalty?"
        message={
          waiveChargeTarget
            ? `${formatCurrency(canonicalMoney(waiveChargeTarget.amount - waiveChargeTarget.paidAmount), currencySymbol)} will be forgiven. The waiver is permanent and stays in the audit log.`
            : ''
        }
        confirmLabel="Waive penalty"
        destructive
        reasonLabel="Reason for waiving (required)"
        onCancel={() => setWaiveChargeTarget(null)}
        onConfirm={async (why) => {
          if (!waiveChargeTarget) return;
          await waiveCharge(waiveChargeTarget, why);
          setWaiveChargeTarget(null);
          await loadBorrowerData();
          onDataChanged();
        }}
      />
    </Modal>
  );
};

const styles = StyleSheet.create({
  penaltyCard: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  penaltyHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  penaltyTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#78350f',
  },
  penaltySubtitle: {
    fontSize: 11,
    color: '#92400e',
    marginTop: 2,
  },
  penaltyAmountLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#92400e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  penaltyAmount: {
    fontSize: 15,
    fontWeight: '800',
    color: '#78350f',
  },
  penaltyAmountDue: {
    color: '#b91c1c',
  },
  penaltyRuleLine: {
    fontSize: 12,
    color: '#78350f',
    marginTop: 6,
  },
  penaltyChargeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#fde68a',
  },
  penaltyChargeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#7c2d12',
  },
  penaltyChargeMeta: {
    fontSize: 10,
    color: '#92400e',
    marginTop: 2,
  },
  penaltyWaiveBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  penaltyWaiveText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#b91c1c',
  },
  penaltyActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  penaltyActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#b45309',
    borderRadius: 10,
    paddingVertical: 11,
  },
  penaltyActionBtnText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
  },
  penaltySecondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 10,
    paddingVertical: 11,
  },
  penaltySecondaryBtnText: {
    color: '#0369a1',
    fontWeight: '800',
    fontSize: 13,
  },
  penaltyFootnote: {
    fontSize: 10,
    color: '#92400e',
    lineHeight: 14,
    marginTop: 10,
  },

  overlay: {
    flex: 1,
    backgroundColor: 'rgba(12, 74, 110, 0.65)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '94%',
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f9ff',
  },
  headerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  headerTextGroup: {
    flex: 1,
  },
  headerName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  headerSubtext: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  tagBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  tagText: {
    fontSize: 11,
    color: '#0284c7',
    fontWeight: '700',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  contactBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#f0f9ff',
    padding: 12,
    borderRadius: 14,
    marginBottom: 14,
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
  },
  contactInfo: {
    flex: 1,
    marginRight: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  phoneText: {
    fontSize: 13,
    color: '#0c4a6e',
    fontWeight: '600',
    flexShrink: 1,
  },
  contactActions: {
    flexDirection: 'row',
    gap: 6,
    flexShrink: 0,
  },
  contactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#ffffff',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    minHeight: 36,
  },
  contactBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0284c7',
  },
  notesCard: {
    backgroundColor: '#f0f9ff',
    padding: 12,
    borderRadius: 10,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  metaText: {
    fontSize: 12,
    color: '#0369a1',
    fontWeight: '500',
  },
  notesText: {
    fontSize: 12,
    color: '#075985',
    fontStyle: 'italic',
  },
  loanCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    marginBottom: 16,
    shadowColor: '#0c4a6e',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  loanCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  loanHeaderLeft: {
    flex: 1,
    marginRight: 8,
  },
  loanTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  loanSubtitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    flexShrink: 0,
  },
  pillActive: {
    backgroundColor: '#e0f2fe',
  },
  pillOverdue: {
    backgroundColor: '#fee2e2',
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: '800',
  },
  pillTextActive: {
    color: '#0284c7',
  },
  pillTextOverdue: {
    color: '#dc2626',
  },
  finGrid: {
    flexDirection: 'row',
    backgroundColor: '#f0f9ff',
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  finCol: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  finLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
  },
  finVal: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 2,
  },
  balanceVal: {
    color: '#0284c7',
  },
  sectionHeading: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  schedulesList: {
    gap: 8,
  },
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  schLeft: {
    flex: 1,
    marginRight: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  schBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    flexShrink: 0,
  },
  schBadgePaid: {
    backgroundColor: '#e0f2fe',
  },
  schBadgeOverdue: {
    backgroundColor: '#fee2e2',
  },
  schBadgePending: {
    backgroundColor: '#f1f5f9',
  },
  schNumber: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },
  schTextCol: {
    flex: 1,
  },
  schDate: {
    fontSize: 12,
    color: '#334155',
    fontWeight: '500',
  },
  schExpected: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  schPartialText: {
    fontSize: 11,
    color: '#d97706',
    fontWeight: '700',
  },
  schOverdueText: {
    fontSize: 11,
    color: '#dc2626',
    fontWeight: '700',
    marginTop: 2,
  },
  paymentHistory: {
    marginTop: 14,
  },
  paymentHistoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  paymentHistoryDate: {
    fontSize: 11,
    color: '#64748b',
    flexShrink: 0,
  },
  paymentHistoryMethod: {
    fontSize: 11,
    color: '#0369a1',
    fontWeight: '600',
    flex: 1,
    marginHorizontal: 8,
    textAlign: 'center',
  },
  paymentHistoryAmount: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
    flexShrink: 0,
  },
  paymentHistoryAmountVoided: {
    textDecorationLine: 'line-through',
    color: '#94a3b8',
  },
  paymentHistoryVoided: {
    color: '#b91c1c',
  },
  payBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    minHeight: 40,
    minWidth: 64,
    flexShrink: 0,
  },
  payBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#ffffff',
  },
  clearedBadge: {
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    flexShrink: 0,
  },
  clearedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0284c7',
  },
  generalPayBtn: {
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    minHeight: 48,
    justifyContent: 'center',
  },
  generalPayBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0284c7',
  },
  statementBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    minHeight: 48,
  },
  statementBtnBusy: {
    opacity: 0.7,
  },
  statementBtnText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0284c7',
  },
  noLoanCard: {
    alignItems: 'center',
    padding: 26,
    backgroundColor: '#f0f9ff',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    marginVertical: 10,
  },
  noLoanTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0c4a6e',
    marginBottom: 4,
  },
  noLoanDesc: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 16,
  },
  issueLoanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0284c7',
    paddingHorizontal: 18,
    minHeight: 48,
    borderRadius: 12,
    justifyContent: 'center',
  },
  issueLoanBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
  },
  pastLoansSection: {
    marginTop: 10,
  },
  pastLoanItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    marginBottom: 6,
  },
  pastLoanAmt: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
  },
  pastLoanDates: {
    fontSize: 11,
    color: '#94a3b8',
  },
  settledBadge: {
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  settledBadgeText: {
    fontSize: 11,
    color: '#0284c7',
    fontWeight: '600',
  },

  // Form Styles (Shared between Payment & Loan Origination)
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0c4a6e',
    marginBottom: 6,
  },
  labelWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 15,
    color: '#0f172a',
    minHeight: 48,
  },
  largeInput: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0284c7',
  },
  infoHint: {
    marginTop: 6,
    paddingHorizontal: 4,
  },
  infoHintText: {
    fontSize: 12,
    color: '#64748b',
  },
  methodGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  methodBtn: {
    flex: 1,
    minWidth: '45%',
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minHeight: 44,
  },
  methodBtnActive: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  methodBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
  },
  methodBtnTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  quickAmountRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  quickAmountBtn: {
    flex: 1,
    minWidth: 68,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickAmountText: {
    fontSize: 11,
    color: '#0369a1',
    fontWeight: '700',
  },
  twoColRow: {
    flexDirection: 'row',
    gap: 10,
  },
  typeSelector: {
    flexDirection: 'row',
    gap: 6,
  },
  typeBtn: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
    minHeight: 48,
  },
  typeBtnActive: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  typeBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0369a1',
  },
  typeBtnTextActive: {
    color: '#ffffff',
  },
  freqRow: {
    flexDirection: 'row',
    gap: 6,
  },
  freqBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
    minHeight: 44,
  },
  freqBtnActive: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  freqBtnText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#0369a1',
    textAlign: 'center',
  },
  freqBtnTextActive: {
    color: '#ffffff',
  },
  termCounterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  counterBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#f0f9ff',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#bae6fd',
  },
  counterBtnText: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0284c7',
  },
  counterInput: {
    flex: 1,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
  },
  calcCard: {
    backgroundColor: '#f0f9ff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1.5,
    borderColor: '#bae6fd',
  },
  calcCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0c4a6e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  calcRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  calcRowTotal: {
    marginTop: 4,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#bae6fd',
  },
  calcLabel: {
    fontSize: 12,
    color: '#475569',
  },
  calcValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  calcLabelTotal: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  calcValueTotal: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  divider: {
    height: 1,
    backgroundColor: '#e0f2fe',
    marginVertical: 6,
  },
  installmentHighlight: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0284c7',
  },
  formActionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
    marginBottom: 20,
  },
  cancelBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
  },
  saveBtn: {
    flex: 2,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0284c7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
  },

  // Receipt Styles
  receiptContainer: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  successIconBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#e0f2fe',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  receiptTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  receiptSubtitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  receiptDivider: {
    width: '100%',
    height: 1,
    backgroundColor: '#e0f2fe',
    marginVertical: 14,
  },
  amountBox: {
    alignItems: 'center',
  },
  amountBoxLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 0.5,
  },
  amountBoxVal: {
    fontSize: 28,
    fontWeight: '900',
    color: '#0284c7',
    marginVertical: 4,
  },
  receiptMethod: {
    fontSize: 12,
    color: '#0369a1',
    backgroundColor: '#f0f9ff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0f2fe',
    fontWeight: '600',
  },
  receiptDetails: {
    width: '100%',
    gap: 8,
  },
  receiptDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  receiptLabel: {
    fontSize: 13,
    color: '#64748b',
  },
  receiptVal: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '600',
  },
  badgeFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    backgroundColor: '#f0f9ff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  badgeFooterText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0369a1',
  },
  receiptActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
    width: '100%',
  },
  receiptDoneBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  receiptDoneBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
  },
  receiptShareBtn: {
    flex: 2,
    flexDirection: 'row',
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0284c7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  receiptShareBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
  },
});
