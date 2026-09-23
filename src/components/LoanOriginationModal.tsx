import React, { useState, useMemo } from 'react';
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
import { X, Calculator, Calendar, CheckCircle, Percent } from 'lucide-react-native';
import { Borrower, InterestType, RepaymentFrequency } from '../db/types';
import { loanRepo } from '../db/repositories/loanRepo';
import { signatureRepo } from '../db/repositories/signatureRepo';
import { SignaturePadModal } from './SignaturePadModal';
import type { SignatureStrokes } from '../db/types';
import { calculateAmortization, formatCurrency, formatDatePretty } from '../utils/financial';
import { parseMoney, parseInterestRate, parseTermCount } from '../utils/validation';
import { format } from 'date-fns';

interface LoanOriginationModalProps {
  visible: boolean;
  borrower: Borrower | null;
  onClose: () => void;
  onSuccess: (loanId: string) => void;
  currencySymbol?: string;
}

export const LoanOriginationModal: React.FC<LoanOriginationModalProps> = ({
  visible,
  borrower,
  onClose,
  onSuccess,
  currencySymbol = '₱',
}) => {
  const [principalStr, setPrincipalStr] = useState('10000');
  const [interestRateStr, setInterestRateStr] = useState('5');
  const [interestType, setInterestType] = useState<InterestType>('FLAT');
  const [frequency, setFrequency] = useState<RepaymentFrequency>('WEEKLY');
  const [termCountStr, setTermCountStr] = useState('4');
  const [startDateStr] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [loading, setLoading] = useState(false);

  // A disbursement is the moment the borrower takes the money, so it is the natural moment to sign
  // for it. The loan exists by this point; the signature is the last step before the modal closes.
  const [pendingSignature, setPendingSignature] = useState<{ loanId: string; amount: number } | null>(
    null
  );

  const principalResult = parseMoney(principalStr);
  const principal = principalResult.ok ? principalResult.value : 0;
  const interestResult = parseInterestRate(interestRateStr);
  const interestRate = interestResult.ok ? interestResult.value : 0;
  const termResult = parseTermCount(termCountStr);
  const termCount = termResult.ok ? termResult.value : 1;

  // Real-time calculation preview
  const calculation = useMemo(() => {
    if (principal <= 0 || termCount <= 0) return null;
    return calculateAmortization({
      principal,
      interestRate,
      interestType,
      frequency,
      termCount,
      startDate: startDateStr,
    });
  }, [principal, interestRate, interestType, frequency, termCount, startDateStr]);

  const disburseLoan = async (amount: number) => {
    if (!borrower) {
      Alert.alert('Error', 'No borrower selected.');
      return;
    }

    try {
      setLoading(true);
      const loanId = await loanRepo.createLoan({
        borrowerId: borrower.id,
        principalAmount: amount,
        interestRate,
        interestType,
        frequency,
        termCount,
        startDate: startDateStr,
      });

      // The loan is on the books; ask for the borrower's signature before letting the modal close.
      setPendingSignature({ loanId, amount });
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to disburse loan.');
    } finally {
      setLoading(false);
    }
  };

  /** Closes out the disbursement flow and hands the caller the new loan. */
  const finishDisbursement = () => {
    const loanId = pendingSignature?.loanId;
    setPendingSignature(null);
    if (loanId) onSuccess(loanId);
  };

  const handleSaveSignature = async (strokes: SignatureStrokes) => {
    if (!pendingSignature || !borrower) return;

    await signatureRepo.save({
      entity: 'LOAN',
      entityId: pendingSignature.loanId,
      borrowerId: borrower.id,
      signerName: borrower.fullName,
      strokes,
    });

    finishDisbursement();
  };

  const handleSkipSignature = () => {
    Alert.alert(
      'Disburse without a signature?',
      'The loan is already recorded. You can still capture the signature later from the borrower profile.',
      [
        { text: 'Keep signing', style: 'cancel' },
        { text: 'Continue', style: 'destructive', onPress: finishDisbursement },
      ]
    );
  };

  const handleDisburse = () => {
    if (!borrower) {
      Alert.alert('Error', 'No borrower selected.');
      return;
    }
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

    const scheduleSummary = calculation
      ? `\n\nTotal payable: ${formatCurrency(calculation.totalPayable, currencySymbol)}\n` +
        `Installments: ${calculation.termCount} × ≈${formatCurrency(calculation.installmentAmount, currencySymbol)}`
      : '';

    // Echo the parsed amount so a mistyped separator cannot silently disburse the wrong figure.
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

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheetContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <View style={styles.iconBg}>
                <Calculator size={20} color="#0284c7" />
              </View>
              <View>
                <Text style={styles.headerTitle}>Issue New Loan</Text>
                <Text style={styles.headerSubtitle}>
                  Borrower: {borrower?.fullName || 'Selected'}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close">
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* Principal Input */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Principal Amount ({currencySymbol})</Text>
              <TextInput
                style={[styles.input, styles.largeNumberInput]}
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
                  <Text style={styles.label}>Interest Rate (%)</Text>
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
                <Text style={styles.label}>Interest Method</Text>
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
                        {freq === 'BI_WEEKLY' ? 'Bi-Weekly' : freq.charAt(0) + freq.slice(1).toLowerCase()}
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
                  <Text style={styles.calcTotalLabel}>Total Payable:</Text>
                  <Text style={styles.calcTotalValue}>
                    {formatCurrency(calculation.totalPayable, currencySymbol)}
                  </Text>
                </View>
                <View style={styles.installmentPill}>
                  <Text style={styles.installmentPillText}>
                    {termCount} installments of{' '}
                    <Text style={{ fontWeight: '800', color: '#0c4a6e' }}>
                      {formatCurrency(calculation.installmentAmount, currencySymbol)}
                    </Text>
                  </Text>
                </View>

                {/* Timeline Preview */}
                <Text style={styles.timelineHeader}>Payment Schedule Preview</Text>
                <View style={styles.timelineList}>
                  {calculation.installments.map((inst) => (
                    <View key={inst.installmentNumber} style={styles.timelineItem}>
                      <View style={styles.timelineNumberBadge}>
                        <Text style={styles.timelineNumberText}>#{inst.installmentNumber}</Text>
                      </View>
                      <Text style={styles.timelineDate}>
                        {formatDatePretty(inst.dueDate)}
                      </Text>
                      <Text style={styles.timelineAmount}>
                        {formatCurrency(inst.expectedAmount, currencySymbol)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>

          {/* Footer */}
          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={loading}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveBtn, loading && styles.saveBtnDisabled]}
              onPress={handleDisburse}
              disabled={loading}
            >
              <CheckCircle size={18} color="#ffffff" style={{ marginRight: 6 }} />
              <Text style={styles.saveBtnText}>
                {loading ? 'Disbursing...' : 'Confirm & Disburse'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Signature capture is a modal of its own, stacked over the form, so the pad gets the full
          screen width and the borrower can sign without the form's fields behind it. */}
      <SignaturePadModal
        visible={pendingSignature !== null}
        title="Loan acknowledgment"
        subject={
          pendingSignature
            ? `${formatCurrency(pendingSignature.amount, currencySymbol)} disbursed to ${borrower?.fullName ?? 'borrower'}`
            : ''
        }
        signerName={borrower?.fullName ?? 'the borrower'}
        onCancel={handleSkipSignature}
        onSave={handleSaveSignature}
      />
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
    maxHeight: '92%',
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
    fontWeight: '500',
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
  twoColRow: {
    flexDirection: 'row',
    gap: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 6,
  },
  labelWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
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
  largeNumberInput: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0284c7',
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
  typeSelector: {
    flexDirection: 'row',
    gap: 6,
  },
  typeBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
    minHeight: 46,
    justifyContent: 'center',
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
    gap: 5,
  },
  freqBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
    minHeight: 44,
    justifyContent: 'center',
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
    fontWeight: '800',
  },
  calcCard: {
    backgroundColor: '#f0f9ff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    marginTop: 6,
    marginBottom: 16,
  },
  calcCardTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0c4a6e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  calcRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  calcRowTotal: {
    borderTopWidth: 1,
    borderTopColor: '#bae6fd',
    paddingTop: 8,
    marginTop: 4,
    marginBottom: 10,
  },
  calcLabel: {
    fontSize: 13,
    color: '#475569',
  },
  calcValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  calcTotalLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  calcTotalValue: {
    fontSize: 19,
    fontWeight: '900',
    color: '#0284c7',
  },
  installmentPill: {
    backgroundColor: '#ffffff',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  installmentPillText: {
    fontSize: 13,
    color: '#0369a1',
  },
  timelineHeader: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0c4a6e',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  timelineList: {
    gap: 6,
  },
  timelineItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  timelineNumberBadge: {
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  timelineNumberText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0284c7',
  },
  timelineDate: {
    fontSize: 12,
    color: '#334155',
    flex: 1,
    marginLeft: 10,
  },
  timelineAmount: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
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
    flexDirection: 'row',
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0284c7', // Sky Blue
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
