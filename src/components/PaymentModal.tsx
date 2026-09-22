import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Platform,
} from 'react-native';
import { X, DollarSign, CreditCard, Tag } from 'lucide-react-native';
import { Loan, LoanSchedule, PaymentMethod, ReceiptData } from '../db/types';
import { paymentRepo } from '../db/repositories/paymentRepo';
import { formatCurrency, getScheduleRemaining } from '../utils/financial';
import { parsePositiveMoney, round2 } from '../utils/validation';
import { buildReceiptFromPayment } from '../services/receiptService';

/** Half-cent tolerance, matching paymentRepo's balance checks. */
const MONEY_EPSILON = 0.004;

interface PaymentModalProps {
  visible: boolean;
  loan: Loan | null;
  schedule: LoanSchedule | null;
  borrowerName: string;
  borrowerPhone: string;
  onClose: () => void;
  onSuccess: (receipt: ReceiptData) => void;
  currencySymbol?: string;
  orgName?: string;
}

export const PaymentModal: React.FC<PaymentModalProps> = ({
  visible,
  loan,
  schedule,
  borrowerName,
  borrowerPhone,
  onClose,
  onSuccess,
  currencySymbol = '₱',
  orgName = 'Community Treasury',
}) => {
  // The suggested amount is derived, never stored, so opening the modal always shows the
  // current outstanding figure (no setState-in-effect, no stale prefill). The parent
  // remounts this component per loan/installment via `key`.
  const [amountOverride, setAmountOverride] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  const outstandingBalance = round2(loan?.remainingBalance ?? 0);
  const installmentDue = schedule ? getScheduleRemaining(schedule) : outstandingBalance;
  const amountStr = amountOverride ?? (installmentDue > 0 ? installmentDue.toFixed(2) : '');

  const paymentMethods: Array<{ label: string; value: PaymentMethod }> = [
    { label: 'Cash', value: 'CASH' },
    { label: 'GCash / Maya', value: 'GCASH' },
    { label: 'Bank Transfer', value: 'BANK_TRANSFER' },
    { label: 'Cheque', value: 'CHEQUE' },
  ];

  const submitPayment = async (amount: number) => {
    if (!loan) return;

    try {
      setLoading(true);
      const result = await paymentRepo.recordPayment({
        loanId: loan.id,
        scheduleId: schedule?.id,
        amountPaid: amount,
        paymentMethod,
        referenceNo: referenceNo.trim() || undefined,
        notes: notes.trim() || undefined,
      });

      // The receipt is built from what the database actually stored, not from local state.
      onSuccess(
        buildReceiptFromPayment({
          payment: result.payment,
          remainingBalance: result.remainingBalance,
          nextDueDate: result.nextDueDate,
          nextDueAmount: result.nextDueAmount,
          allocations: result.allocations,
          unallocated: result.unallocated,
          borrowerName,
          borrowerPhone,
          orgName,
        })
      );
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to record payment.');
    } finally {
      setLoading(false);
    }
  };

  const handleRecord = () => {
    if (!loan) return;

    const parsed = parsePositiveMoney(amountStr);
    if (!parsed.ok) {
      Alert.alert('Invalid Amount', parsed.error);
      return;
    }

    if (outstandingBalance > MONEY_EPSILON && parsed.value > outstandingBalance + MONEY_EPSILON) {
      Alert.alert(
        'Amount Exceeds Balance',
        `Only ${formatCurrency(outstandingBalance, currencySymbol)} is still outstanding on this loan. Enter that amount or less.`
      );
      return;
    }

    // Echo the parsed figure so a mistyped separator ("10,000" parsed as 10) can never be saved silently.
    Alert.alert(
      'Confirm Payment',
      `Record ${formatCurrency(parsed.value, currencySymbol)} received from ${borrowerName}?`,
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

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheetContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <View style={styles.iconBg}>
                <DollarSign size={20} color="#0284c7" />
              </View>
              <View>
                <Text style={styles.headerTitle}>Record Payment</Text>
                <Text style={styles.headerSubtitle}>
                  {borrowerName}
                  {schedule ? ` • Installment #${schedule.installmentNumber}` : ''}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* Amount Received */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Amount Received ({currencySymbol})</Text>
              <TextInput
                style={[styles.input, styles.largeInput]}
                keyboardType="decimal-pad"
                value={amountStr}
                onChangeText={setAmountOverride}
                autoFocus
              />
              <View style={styles.infoHint}>
                <Text style={styles.infoHintText}>
                  {schedule ? `Installment #${schedule.installmentNumber} due: ` : 'Loan balance: '}
                  <Text style={{ fontWeight: '800', color: '#0c4a6e' }}>
                    {formatCurrency(installmentDue, currencySymbol)}
                  </Text>
                  {schedule ? (
                    <Text>
                      {'  •  Loan balance: '}
                      <Text style={{ fontWeight: '800', color: '#0c4a6e' }}>
                        {formatCurrency(outstandingBalance, currencySymbol)}
                      </Text>
                    </Text>
                  ) : null}
                </Text>
              </View>
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
                    style={[styles.methodBtn, paymentMethod === m.value && styles.methodBtnActive]}
                    onPress={() => setPaymentMethod(m.value)}
                  >
                    <Text
                      style={[
                        styles.methodBtnText,
                        paymentMethod === m.value && styles.methodBtnTextActive,
                      ]}
                    >
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Reference Number */}
            {paymentMethod !== 'CASH' && (
              <View style={styles.fieldGroup}>
                <View style={styles.labelWithIcon}>
                  <Tag size={14} color="#0369a1" />
                  <Text style={styles.label}>Transaction / Reference # (Optional)</Text>
                </View>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. 1029384756"
                  placeholderTextColor="#94a3b8"
                  value={referenceNo}
                  onChangeText={setReferenceNo}
                />
              </View>
            )}

            {/* Optional Notes */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Remarks / Note (Optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. In-person collection"
                placeholderTextColor="#94a3b8"
                value={notes}
                onChangeText={setNotes}
              />
            </View>
          </ScrollView>

          {/* Footer */}
          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={loading}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveBtn, loading && styles.saveBtnDisabled]}
              onPress={handleRecord}
              disabled={loading}
            >
              <Text style={styles.saveBtnText}>
                {loading ? 'Recording...' : 'Confirm & Save'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
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
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f9ff',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBg: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#e0f2fe',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748b',
  },
  closeBtn: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  labelWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#ffffff',
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#0f172a',
    minHeight: 48,
  },
  largeInput: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0284c7',
  },
  infoHint: {
    marginTop: 6,
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
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
    minHeight: 48,
    justifyContent: 'center',
  },
  methodBtnActive: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  methodBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0369a1',
  },
  methodBtnTextActive: {
    color: '#ffffff',
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
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
    fontSize: 15,
    fontWeight: '700',
    color: '#64748b',
  },
  saveBtn: {
    flex: 2,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0284c7',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0284c7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
  },
});
