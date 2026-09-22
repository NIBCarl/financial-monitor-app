import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { X, ArrowDownLeft, ArrowUpRight } from 'lucide-react-native';
import { TransactionType, TransactionCategory } from '../db/types';
import { ledgerRepo } from '../db/repositories/ledgerRepo';
import { parsePositiveMoney, clampText } from '../utils/validation';

interface AddLedgerModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  currencySymbol?: string;
}

export const AddLedgerModal: React.FC<AddLedgerModalProps> = ({
  visible,
  onClose,
  onSuccess,
  currencySymbol = '₱',
}) => {
  const [type, setType] = useState<TransactionType>('INFLOW');
  const [category, setCategory] = useState<TransactionCategory>('MEMBERSHIP_DUES');
  const [amountStr, setAmountStr] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const inflowCategories: Array<{ label: string; value: TransactionCategory }> = [
    { label: 'Member Dues', value: 'MEMBERSHIP_DUES' },
    { label: 'Donation', value: 'DONATION' },
    { label: 'Other Inflow', value: 'OTHER' },
  ];

  const outflowCategories: Array<{ label: string; value: TransactionCategory }> = [
    { label: 'Supplies & Expenses', value: 'EXPENSE' },
    { label: 'Other Outflow', value: 'OTHER' },
  ];

  const categories = type === 'INFLOW' ? inflowCategories : outflowCategories;

  const handleSave = async () => {
    const parsed = parsePositiveMoney(amountStr);
    if (!parsed.ok) {
      Alert.alert('Invalid Amount', parsed.error);
      return;
    }

    try {
      setLoading(true);
      await ledgerRepo.addTransaction({
        type,
        category,
        amount: parsed.value,
        description: clampText(description),
      });

      setAmountStr('');
      setDescription('');
      onSuccess();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to record transaction.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheetContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <View
                style={[
                  styles.iconBg,
                  { backgroundColor: type === 'INFLOW' ? '#e0f2fe' : '#fef2f2' },
                ]}
              >
                {type === 'INFLOW' ? (
                  <ArrowDownLeft size={20} color="#0284c7" />
                ) : (
                  <ArrowUpRight size={20} color="#dc2626" />
                )}
              </View>
              <View>
                <Text style={styles.headerTitle}>Record Treasury Entry</Text>
                <Text style={styles.headerSubtitle}>Cash Inflow & Outflow</Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <View style={styles.content}>
            {/* Type Selector Tabs */}
            <View style={styles.typeTabs}>
              <TouchableOpacity
                style={[styles.typeTab, type === 'INFLOW' && styles.typeTabInflow]}
                onPress={() => {
                  setType('INFLOW');
                  setCategory('MEMBERSHIP_DUES');
                }}
              >
                <ArrowDownLeft size={16} color={type === 'INFLOW' ? '#ffffff' : '#0284c7'} />
                <Text
                  style={[
                    styles.typeTabText,
                    type === 'INFLOW' && styles.typeTabTextActive,
                  ]}
                >
                  Cash In (Inflow)
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.typeTab, type === 'OUTFLOW' && styles.typeTabOutflow]}
                onPress={() => {
                  setType('OUTFLOW');
                  setCategory('EXPENSE');
                }}
              >
                <ArrowUpRight size={16} color={type === 'OUTFLOW' ? '#ffffff' : '#dc2626'} />
                <Text
                  style={[
                    styles.typeTabText,
                    type === 'OUTFLOW' && styles.typeTabTextActive,
                  ]}
                >
                  Cash Out (Expense)
                </Text>
              </TouchableOpacity>
            </View>

            {/* Amount */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Amount ({currencySymbol})</Text>
              <TextInput
                style={[
                  styles.input,
                  styles.amountInput,
                  { color: type === 'INFLOW' ? '#0284c7' : '#dc2626' },
                ]}
                keyboardType="numeric"
                placeholder="0.00"
                placeholderTextColor="#94a3b8"
                value={amountStr}
                onChangeText={setAmountStr}
                autoFocus
              />
            </View>

            {/* Category */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Category</Text>
              <View style={styles.categoryRow}>
                {categories.map((c) => (
                  <TouchableOpacity
                    key={c.value}
                    style={[
                      styles.categoryBtn,
                      category === c.value &&
                        (type === 'INFLOW' ? styles.catBtnActiveIn : styles.catBtnActiveOut),
                    ]}
                    onPress={() => setCategory(c.value)}
                  >
                    <Text
                      style={[
                        styles.categoryBtnText,
                        category === c.value && styles.catBtnTextActive,
                      ]}
                    >
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Description */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Description / Purpose</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Monthly committee dues or meeting refreshments"
                placeholderTextColor="#94a3b8"
                value={description}
                onChangeText={setDescription}
              />
            </View>
          </View>

          {/* Footer */}
          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={loading}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.saveBtn,
                { backgroundColor: type === 'INFLOW' ? '#0284c7' : '#dc2626' },
                loading && styles.saveBtnDisabled,
              ]}
              onPress={handleSave}
              disabled={loading}
            >
              <Text style={styles.saveBtnText}>
                {loading ? 'Saving...' : 'Save Entry'}
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
    backgroundColor: 'rgba(12, 74, 110, 0.4)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBg: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0c4a6e',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748b',
  },
  closeBtn: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  typeTabs: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderRadius: 14,
    padding: 4,
    marginBottom: 16,
    gap: 4,
  },
  typeTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderRadius: 10,
    gap: 6,
  },
  typeTabInflow: {
    backgroundColor: '#0284c7',
  },
  typeTabOutflow: {
    backgroundColor: '#dc2626',
  },
  typeTabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
  },
  typeTabTextActive: {
    color: '#ffffff',
  },
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0c4a6e',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 48,
    fontSize: 15,
    color: '#0f172a',
  },
  amountInput: {
    fontSize: 24,
    fontWeight: '700',
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  categoryBtn: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  catBtnActiveIn: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  catBtnActiveOut: {
    backgroundColor: '#dc2626',
    borderColor: '#dc2626',
  },
  categoryBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
  },
  catBtnTextActive: {
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
    fontWeight: '600',
    color: '#475569',
  },
  saveBtn: {
    flex: 2,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
  },
});
