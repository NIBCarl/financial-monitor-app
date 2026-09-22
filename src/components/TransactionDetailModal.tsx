import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  ActivityIndicator,
  Alert,
  Image,
} from 'react-native';
import {
  X,
  ArrowDownLeft,
  ArrowUpRight,
  Share2,
  User,
  Phone,
  Calendar,
  CreditCard,
  Percent,
  Clock,
  FileText,
  Landmark,
  Repeat,
  AlertTriangle,
  History,
  PencilLine,
  Ban,
} from 'lucide-react-native';
import { TransactionDetail } from '../db/types';
import { ledgerRepo } from '../db/repositories/ledgerRepo';
import { paymentRepo } from '../db/repositories/paymentRepo';
import { formatCurrency, formatDatePretty, formatDbDateTime } from '../utils/financial';
import {
  getCategoryHeadline,
  getCategoryLabel,
  getFrequencyLabel,
  getPaymentMethodLabel,
} from '../utils/labels';
import { buildReceiptFromPayment, shareReceipt } from '../services/receiptService';
import { ConfirmReasonModal } from './ConfirmReasonModal';
import { EditPaymentModal } from './EditPaymentModal';

interface TransactionDetailModalProps {
  visible: boolean;
  transactionId: string | null;
  onClose: () => void;
  currencySymbol?: string;
  orgName?: string;
  /** Opens the borrower profile for the linked loan (the parent screen owns that modal). */
  onOpenBorrower?: (borrowerId: string) => void;
  /** Called after a void/edit so the host screen can refresh its lists and totals. */
  onChanged?: () => void;
}

interface DetailRowProps {
  icon?: React.ReactNode;
  label: string;
  value: string;
  emphasis?: boolean;
}

const DetailRow: React.FC<DetailRowProps> = ({ icon, label, value, emphasis }) => (
  <View style={styles.detailRow}>
    <View style={styles.detailLabelWrap}>
      {icon}
      <Text style={styles.detailLabel}>{label}</Text>
    </View>
    <Text style={[styles.detailValue, emphasis && styles.detailValueEmphasis]} numberOfLines={2}>
      {value}
    </Text>
  </View>
);

export const TransactionDetailModal: React.FC<TransactionDetailModalProps> = ({
  visible,
  transactionId,
  onClose,
  currencySymbol = '₱',
  orgName = 'Community Treasury',
  onOpenBorrower,
  onChanged,
}) => {
  const [detail, setDetail] = useState<TransactionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [voidVisible, setVoidVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);

  const loadDetail = useCallback(async () => {
    if (!transactionId) return;
    try {
      setLoading(true);
      const result = await ledgerRepo.getTransactionDetail(transactionId);
      setDetail(result);
    } catch (err) {
      console.error('Failed to load transaction detail:', err);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [transactionId]);

  useEffect(() => {
    if (!visible || !transactionId) return;

    let active = true;
    const load = async () => {
      if (!active) return;
      await loadDetail();
    };

    void load();
    return () => {
      active = false;
    };
  }, [visible, transactionId, loadDetail]);

  const handleVoid = useCallback(
    async (reason: string) => {
      if (!detail?.payment) return;
      await paymentRepo.voidPayment({
        paymentId: detail.payment.id,
        reason,
        loanId: detail.loan?.id,
      });
      await loadDetail();
      onChanged?.();
      Alert.alert(
        'Payment Voided',
        `${formatCurrency(detail.payment.amountPaid, currencySymbol)} was reversed, the installment plan was rebuilt and the reason was written to the audit log.`
      );
    },
    [detail, currencySymbol, loadDetail, onChanged]
  );

  const handleShareReceipt = useCallback(async () => {
    if (!detail?.payment || !detail.loan) return;

    try {
      await shareReceipt(
        buildReceiptFromPayment({
          payment: detail.payment,
          remainingBalance: detail.balanceAfter ?? detail.loan.remainingBalance,
          // Historical payment: this is the balance as it stood right after it was taken.
          nextDueDate: null,
          nextDueAmount: null,
          borrowerName: detail.loan.borrowerName ?? 'Borrower',
          borrowerPhone: detail.loan.borrowerPhone ?? '',
          orgName,
        }),
        currencySymbol
      );
    } catch (err) {
      Alert.alert('Share Failed', err instanceof Error ? err.message : 'Could not share the receipt.');
    }
  }, [detail, orgName, currencySymbol]);

  const handleOpenBorrower = useCallback(() => {
    const borrowerId = detail?.loan?.borrowerId;
    if (!borrowerId || !onOpenBorrower) return;
    onClose();
    onOpenBorrower(borrowerId);
  }, [detail, onOpenBorrower, onClose]);

  if (!visible) return null;

  const transaction = detail?.transaction;
  const isInflow = transaction?.type === 'INFLOW';
  const category = transaction?.category ?? 'OTHER';
  const amountColor = isInflow ? '#0284c7' : '#dc2626';
  const amountPrefix = isInflow ? '+' : '-';

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheetContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={[styles.iconBg, { backgroundColor: isInflow ? '#e0f2fe' : '#fef2f2' }]}>
                {isInflow ? (
                  <ArrowDownLeft size={20} color="#0284c7" />
                ) : (
                  <ArrowUpRight size={20} color="#dc2626" />
                )}
              </View>
              <View style={styles.headerTextGroup}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {getCategoryHeadline(category)}
                </Text>
                <Text style={styles.headerSubtitle} numberOfLines={1}>
                  {getCategoryLabel(category)}
                </Text>
              </View>
            </View>

            <TouchableOpacity
              onPress={onClose}
              style={styles.closeBtn}
              accessibilityLabel="Close transaction details"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          {loading && !detail ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color="#0284c7" />
              <Text style={styles.loadingText}>Loading transaction…</Text>
            </View>
          ) : !transaction ? (
            <View style={styles.loadingBox}>
              <Text style={styles.loadingText}>
                This transaction could not be found. Refresh the ledger and try again.
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
              {/* Amount banner */}
              <View style={styles.amountBox}>
                <Text style={styles.amountLabel}>
                  {isInflow ? 'AMOUNT RECEIVED' : 'AMOUNT RELEASED'}
                </Text>
                <Text style={[styles.amountValue, { color: amountColor }]}>
                  {amountPrefix}
                  {formatCurrency(transaction.amount, currencySymbol)}
                </Text>
                {detail.payment ? (
                  <Text style={styles.methodTag}>
                    Paid via {getPaymentMethodLabel(detail.payment.paymentMethod)}
                    {detail.payment.referenceNo ? ` • Ref: ${detail.payment.referenceNo}` : ''}
                  </Text>
                ) : (
                  <Text style={styles.methodTag}>
                    Recorded {isInflow ? 'as treasury inflow' : 'as treasury outflow'}
                  </Text>
                )}
              </View>

              {(transaction.voidedAt || detail.payment?.voidedAt) && (
                <View style={styles.voidBanner}>
                  <AlertTriangle size={16} color="#b91c1c" />
                  <View style={styles.voidBannerText}>
                    <Text style={styles.voidTitle}>VOIDED TRANSACTION</Text>
                    <Text style={styles.voidReason}>
                      {transaction.voidReason || detail.payment?.voidReason || 'No reason recorded'}
                    </Text>
                    <Text style={styles.voidMeta}>
                      Reversed{' '}
                      {formatDbDateTime(transaction.voidedAt || detail.payment?.voidedAt || '')} •
                      excluded from all totals
                    </Text>
                  </View>
                </View>
              )}

              <View style={styles.divider} />

              {/* Loan repayment */}
              {category === 'LOAN_REPAYMENT' && (
                <View style={styles.section}>
                  {detail.loan ? (
                    <>
                      <DetailRow
                        icon={<User size={13} color="#0369a1" />}
                        label="Borrower"
                        value={detail.loan.borrowerName ?? 'Unknown borrower'}
                        emphasis
                      />
                      <DetailRow
                        icon={<Phone size={13} color="#0369a1" />}
                        label="Contact"
                        value={detail.loan.borrowerPhone ?? '—'}
                      />
                    </>
                  ) : null}
                  <DetailRow
                    icon={<Clock size={13} color="#0369a1" />}
                    label="Date & Time"
                    value={
                      detail.payment
                        ? formatDbDateTime(detail.payment.paidAt)
                        : formatDbDateTime(transaction.transactionDate)
                    }
                  />
                  <DetailRow
                    icon={<CreditCard size={13} color="#0369a1" />}
                    label="Payment Method"
                    value={detail.payment ? getPaymentMethodLabel(detail.payment.paymentMethod) : '—'}
                  />
                  <DetailRow
                    icon={<FileText size={13} color="#0369a1" />}
                    label="Installment"
                    value={
                      detail.schedule
                        ? `#${detail.schedule.installmentNumber} • due ${formatDatePretty(detail.schedule.dueDate)}`
                        : 'Applied as a custom amount'
                    }
                  />
                  <DetailRow
                    icon={<Landmark size={13} color="#0369a1" />}
                    label="Balance After Payment"
                    value={formatCurrency(
                      detail.balanceAfter ?? detail.loan?.remainingBalance ?? 0,
                      currencySymbol
                    )}
                    emphasis
                  />
                  {detail.payment?.notes ? (
                    <DetailRow
                      icon={<FileText size={13} color="#0369a1" />}
                      label="Remarks"
                      value={detail.payment.notes}
                    />
                  ) : null}
                </View>
              )}

              {/* Loan disbursement */}
              {category === 'LOAN_DISBURSEMENT' && (
                <View style={styles.section}>
                  {detail.loan ? (
                    <>
                      <DetailRow
                        icon={<User size={13} color="#0369a1" />}
                        label="Borrower"
                        value={detail.loan.borrowerName ?? 'Unknown borrower'}
                        emphasis
                      />
                      <DetailRow
                        icon={<Phone size={13} color="#0369a1" />}
                        label="Contact"
                        value={detail.loan.borrowerPhone ?? '—'}
                      />
                      <DetailRow
                        icon={<Landmark size={13} color="#0369a1" />}
                        label="Disbursed Principal"
                        value={formatCurrency(detail.loan.principalAmount, currencySymbol)}
                        emphasis
                      />
                      <DetailRow
                        icon={<Percent size={13} color="#0369a1" />}
                        label="Interest Rate"
                        value={`${detail.loan.interestRate}% (${detail.loan.interestType})`}
                      />
                      <DetailRow
                        icon={<Repeat size={13} color="#0369a1" />}
                        label="Frequency"
                        value={`${getFrequencyLabel(detail.loan.frequency)} • ${detail.loan.termCount} installment(s)`}
                      />
                      <DetailRow
                        icon={<Landmark size={13} color="#0369a1" />}
                        label="Total Payable"
                        value={formatCurrency(detail.loan.totalPayable, currencySymbol)}
                      />
                      <DetailRow
                        icon={<Calendar size={13} color="#0369a1" />}
                        label="Release Date"
                        value={formatDatePretty(detail.loan.startDate)}
                      />
                      <DetailRow
                        icon={<Calendar size={13} color="#0369a1" />}
                        label="Maturity Date"
                        value={formatDatePretty(detail.loan.endDate)}
                      />
                    </>
                  ) : (
                    <DetailRow
                      icon={<FileText size={13} color="#0369a1" />}
                      label="Details"
                      value={transaction.description ?? 'Loan disbursement'}
                    />
                  )}
                </View>
              )}

              {/* Operating expense */}
              {category === 'EXPENSE' && (
                <View style={styles.section}>
                  <DetailRow
                    icon={<FileText size={13} color="#0369a1" />}
                    label="Expense Category"
                    value={getCategoryLabel(category)}
                    emphasis
                  />
                  <DetailRow
                    icon={<FileText size={13} color="#0369a1" />}
                    label="Title / Purpose"
                    value={transaction.description ?? 'No description recorded'}
                  />
                  <DetailRow
                    icon={<Clock size={13} color="#0369a1" />}
                    label="Date & Time"
                    value={formatDbDateTime(transaction.transactionDate)}
                  />
                </View>
              )}

              {/* Capital, dues, donations and other manual entries */}
              {(category === 'DONATION' ||
                category === 'MEMBERSHIP_DUES' ||
                category === 'OTHER') && (
                <View style={styles.section}>
                  <DetailRow
                    icon={<Landmark size={13} color="#0369a1" />}
                    label="Source"
                    value={getCategoryLabel(category)}
                    emphasis
                  />
                  <DetailRow
                    icon={<FileText size={13} color="#0369a1" />}
                    label="Note / Contributor"
                    value={transaction.description ?? 'No note recorded'}
                  />
                  <DetailRow
                    icon={<Clock size={13} color="#0369a1" />}
                    label="Date & Time"
                    value={formatDbDateTime(transaction.transactionDate)}
                  />
                </View>
              )}

              {category === 'LOAN_REPAYMENT' && (
                <View style={styles.stampWrapper}>
                  <Image
                    source={require('../../assets/images/official-stamp.png')}
                    style={styles.officialStampImage}
                    resizeMode="contain"
                  />
                </View>
              )}

              <DetailRow
                icon={<FileText size={13} color="#94a3b8" />}
                label="Reference ID"
                value={transaction.id}
              />
              <Text style={styles.footerNote}>{orgName} • offline treasury ledger record</Text>

              {/* Audit trail — append-only history of this record */}
              {detail.auditTrail && detail.auditTrail.length > 0 && (
                <View style={styles.auditBlock}>
                  <View style={styles.auditHeader}>
                    <History size={13} color="#0369a1" />
                    <Text style={styles.auditTitle}>Audit Trail</Text>
                  </View>
                  {detail.auditTrail.map((entry) => (
                    <View key={entry.id} style={styles.auditRow}>
                      <Text
                        style={[
                          styles.auditAction,
                          entry.action === 'VOID' && styles.auditActionVoid,
                        ]}
                      >
                        {entry.action}
                      </Text>
                      <View style={styles.auditBody}>
                        <Text style={styles.auditMeta}>{formatDbDateTime(entry.createdAt)}</Text>
                        {entry.reason ? (
                          <Text style={styles.auditReason} numberOfLines={2}>
                            {entry.reason}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          )}

          {/* Actions */}
          {transaction ? (
            <View style={styles.footer}>
              <View style={styles.footerRow}>
                {category === 'LOAN_REPAYMENT' && detail?.payment ? (
                  <>
                    <TouchableOpacity
                      style={styles.secondaryBtn}
                      onPress={handleOpenBorrower}
                      disabled={!onOpenBorrower || !detail.loan}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.secondaryBtnText}>Borrower Profile</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.primaryBtn}
                      onPress={handleShareReceipt}
                      activeOpacity={0.85}
                    >
                      <Share2 size={16} color="#ffffff" style={{ marginRight: 6 }} />
                      <Text style={styles.primaryBtnText}>Share Receipt</Text>
                    </TouchableOpacity>
                  </>
                ) : category === 'LOAN_DISBURSEMENT' && detail?.loan ? (
                  <TouchableOpacity
                    style={styles.primaryBtn}
                    onPress={handleOpenBorrower}
                    disabled={!onOpenBorrower}
                    activeOpacity={0.85}
                  >
                    <User size={16} color="#ffffff" style={{ marginRight: 6 }} />
                    <Text style={styles.primaryBtnText}>View Loan in Borrower Profile</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={styles.secondaryBtn}
                    onPress={onClose}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.secondaryBtnText}>Done</Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Corrections: edit descriptive fields, or void the whole payment */}
              {category === 'LOAN_REPAYMENT' &&
              detail?.payment &&
              !detail.payment.voidedAt &&
              !transaction.voidedAt ? (
                <View style={styles.footerRow}>
                  <TouchableOpacity
                    style={styles.tertiaryBtn}
                    onPress={() => setEditVisible(true)}
                    activeOpacity={0.8}
                  >
                    <PencilLine size={14} color="#0369a1" />
                    <Text style={styles.tertiaryBtnText}>Edit details</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.tertiaryBtn, styles.dangerBtn]}
                    onPress={() => setVoidVisible(true)}
                    activeOpacity={0.8}
                  >
                    <Ban size={14} color="#b91c1c" />
                    <Text style={[styles.tertiaryBtnText, styles.dangerBtnText]}>Void payment</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      {/* Void confirmation with a mandatory reason (goes into the audit log) */}
      <ConfirmReasonModal
        visible={voidVisible}
        destructive
        title="Void this payment?"
        message={`${formatCurrency(detail?.payment?.amountPaid ?? 0, currencySymbol)} will be reversed: the ledger entry is marked void, the installment plan is rebuilt from the remaining payments, and the loan balance is recalculated. Nothing is deleted.`}
        confirmLabel="Void Payment"
        reasonLabel="Why are you voiding this payment? (required)"
        reasonPlaceholder="e.g. duplicate entry — the same payment was recorded twice"
        onCancel={() => setVoidVisible(false)}
        onConfirm={handleVoid}
      />

      {/* Metadata edit (amount and date stay immutable) */}
      {detail?.payment && !detail.payment.voidedAt ? (
        <EditPaymentModal
          key={detail.payment.id}
          visible={editVisible}
          payment={detail.payment}
          onClose={() => setEditVisible(false)}
          onSaved={() => {
            void loadDetail();
            onChanged?.();
          }}
          currencySymbol={currencySymbol}
        />
      ) : null}
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(12, 74, 110, 0.65)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
    paddingBottom: Platform.OS === 'ios' ? 30 : 18,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f9ff',
  },
  headerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  iconBg: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  headerTextGroup: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  closeBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#f8fafc',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingBox: {
    padding: 32,
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  amountBox: {
    backgroundColor: '#f0f9ff',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  amountLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0369a1',
    letterSpacing: 0.5,
  },
  amountValue: {
    fontSize: 28,
    fontWeight: '900',
    marginVertical: 4,
  },
  methodTag: {
    fontSize: 12,
    color: '#0369a1',
    backgroundColor: '#ffffff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0f2fe',
    fontWeight: '600',
    textAlign: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: '#f1f5f9',
    marginVertical: 14,
  },
  section: {
    gap: 2,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 7,
    gap: 12,
  },
  detailLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    maxWidth: '48%',
  },
  detailLabel: {
    fontSize: 13,
    color: '#64748b',
  },
  detailValue: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  detailValueEmphasis: {
    fontWeight: '800',
    color: '#0c4a6e',
  },
  stampWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
  },
  officialStampImage: {
    width: 90,
    height: 90,
  },
  footerNote: {
    fontSize: 11,
    color: '#475569',
    marginTop: 10,
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'column',
    gap: 8,
    paddingHorizontal: 18,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  footerRow: {
    flexDirection: 'row',
    gap: 10,
  },
  tertiaryBtn: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    gap: 6,
    borderRadius: 12,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e0f2fe',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tertiaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0369a1',
  },
  dangerBtn: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  dangerBtnText: {
    color: '#b91c1c',
  },
  voidBanner: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#fecaca',
    padding: 12,
    marginTop: 12,
  },
  voidBannerText: {
    flex: 1,
  },
  voidTitle: {
    fontSize: 12,
    fontWeight: '900',
    color: '#b91c1c',
    letterSpacing: 0.5,
  },
  voidReason: {
    fontSize: 13,
    fontWeight: '700',
    color: '#991b1b',
    marginTop: 3,
  },
  voidMeta: {
    fontSize: 11,
    color: '#b91c1c',
    marginTop: 3,
  },
  auditBlock: {
    marginTop: 14,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
  },
  auditHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  auditTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0369a1',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  auditRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  auditAction: {
    fontSize: 10,
    fontWeight: '900',
    color: '#0369a1',
    backgroundColor: '#e0f2fe',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    minWidth: 56,
    textAlign: 'center',
  },
  auditActionVoid: {
    color: '#b91c1c',
    backgroundColor: '#fee2e2',
  },
  auditBody: {
    flex: 1,
  },
  auditMeta: {
    fontSize: 11,
    color: '#64748b',
  },
  auditReason: {
    fontSize: 12,
    color: '#0f172a',
    fontWeight: '600',
    marginTop: 2,
  },
  secondaryBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
  },
  primaryBtn: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    borderRadius: 12,
    backgroundColor: '#0284c7',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
  },
});




