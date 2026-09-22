import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { X, CreditCard, Tag, FileText, Lock } from 'lucide-react-native';
import { LoanPayment, PaymentMethod } from '../db/types';
import { paymentRepo } from '../db/repositories/paymentRepo';
import { formatCurrency, formatDbDateTime } from '../utils/financial';
import { getPaymentMethodLabel } from '../utils/labels';
import { clampText } from '../utils/validation';

interface EditPaymentModalProps {
  visible: boolean;
  /** Required: the parent mounts this with `key={payment.id}` so state never goes stale. */
  payment: LoanPayment;
  onClose: () => void;
  onSaved: () => void;
  currencySymbol?: string;
}

const METHODS: PaymentMethod[] = ['CASH', 'GCASH', 'BANK_TRANSFER', 'CHEQUE'];

/**
 * Edits a payment's descriptive fields only (method, reference, remarks).
 *
 * The amount and date are intentionally immutable: correcting money means voiding this
 * payment and recording the right one, so the audit trail explains exactly what happened.
 */
export const EditPaymentModal: React.FC<EditPaymentModalProps> = ({
  visible,
  payment,
  onClose,
  onSaved,
  currencySymbol = '₱',
}) => {
  const [method, setMethod] = useState<PaymentMethod>(payment.paymentMethod);
  const [reference, setReference] = useState(payment.referenceNo ?? '');
  const [notes, setNotes] = useState(payment.notes ?? '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = reason.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    try {
      setSaving(true);
      await paymentRepo.updatePaymentMeta({
        paymentId: payment.id,
        paymentMethod: method,
        referenceNo: clampText(reference, 60) ?? null,
        notes: clampText(notes) ?? null,
        reason: reason.trim(),
      });
      onSaved();
      setReason('');
      onClose();
      Alert.alert('Payment Updated', 'The change was saved and recorded in the audit log.');
    } catch (err) {
      Alert.alert(
        'Update Failed',
        err instanceof Error ? err.message : 'Could not save the changes.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheetContainer}>
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <View style={styles.iconBg}>
                <CreditCard size={20} color="#0284c7" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerTitle}>Edit Payment Details</Text>
                <Text style={styles.headerSubtitle} numberOfLines={1}>
                  {formatCurrency(payment.amountPaid, currencySymbol)} •{' '}
                  {formatDbDateTime(payment.paidAt)}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close">
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.lockNotice}>
              <Lock size={14} color="#0369a1" />
              <Text style={styles.lockNoticeText}>
                Amount and date cannot be edited. To correct the amount, void this payment and
                record a new one — that keeps the audit trail truthful.
              </Text>
            </View>

            <View style={styles.fieldGroup}>
              <View style={styles.labelWithIcon}>
                <CreditCard size={14} color="#0369a1" />
                <Text style={styles.label}>Payment Method</Text>
              </View>
              <View style={styles.methodGrid}>
                {METHODS.map((value) => (
                  <TouchableOpacity
                    key={value}
                    style={[styles.methodBtn, method === value && styles.methodBtnActive]}
                    onPress={() => setMethod(value)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[styles.methodBtnText, method === value && styles.methodBtnTextActive]}
                    >
                      {getPaymentMethodLabel(value)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {method !== 'CASH' ? (
              <View style={styles.fieldGroup}>
                <View style={styles.labelWithIcon}>
                  <Tag size={14} color="#0369a1" />
                  <Text style={styles.label}>Transaction / Reference #</Text>
                </View>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. GCash Ref 1029384756"
                  placeholderTextColor="#94a3b8"
                  value={reference}
                  onChangeText={setReference}
                />
              </View>
            ) : null}

            <View style={styles.fieldGroup}>
              <View style={styles.labelWithIcon}>
                <FileText size={14} color="#0369a1" />
                <Text style={styles.label}>Remarks</Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder="e.g. Paid in cash at the committee meeting"
                placeholderTextColor="#94a3b8"
                value={notes}
                onChangeText={setNotes}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>
                Reason for change <Text style={styles.required}>*</Text>
              </Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="e.g. wrong reference number encoded"
                placeholderTextColor="#94a3b8"
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={240}
              />
              {!canSave && !saving ? (
                <Text style={styles.requiredHint}>
                  A reason is required so the audit log stays useful.
                </Text>
              ) : null}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={saving}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={!canSave}
              activeOpacity={0.85}
            >
              {saving ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.saveBtnText}>Save Changes</Text>
              )}
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
    maxHeight: '92%',
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
  headerTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginRight: 8,
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
  scrollContent: {
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  lockNotice: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#f0f9ff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bae6fd',
    padding: 12,
    marginBottom: 16,
  },
  lockNoticeText: {
    flex: 1,
    fontSize: 11,
    color: '#0369a1',
    lineHeight: 16,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  labelWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  required: {
    color: '#dc2626',
  },
  requiredHint: {
    fontSize: 11,
    color: '#dc2626',
    marginTop: 6,
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
  textArea: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  methodGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  methodBtn: {
    flex: 1,
    minWidth: '45%',
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
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
    paddingHorizontal: 18,
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
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
  },
});


