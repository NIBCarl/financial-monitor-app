import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { X, UserPlus, Phone, Tag, MapPin, UserCheck, FileText } from 'lucide-react-native';
import { borrowerRepo } from '../db/repositories/borrowerRepo';
import { isValidPhone, clampText } from '../utils/validation';

interface AddBorrowerModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: (newBorrowerId: string) => void;
}

export const AddBorrowerModal: React.FC<AddBorrowerModalProps> = ({
  visible,
  onClose,
  onSuccess,
}) => {
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [categoryTag, setCategoryTag] = useState('General');
  const [address, setAddress] = useState('');
  const [guarantorInfo, setGuarantorInfo] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  const defaultTags = ['General', 'Vendor', 'Member', 'Committee', 'Batch 2024', 'External'];

  const handleSave = async () => {
    if (!fullName.trim()) {
      Alert.alert('Required Field', 'Please enter the borrower full name.');
      return;
    }
    if (!phoneNumber.trim()) {
      Alert.alert('Required Field', 'Please enter a contact phone number.');
      return;
    }
    if (!isValidPhone(phoneNumber)) {
      Alert.alert('Invalid Phone Number', 'Enter a phone number containing 7 to 15 digits.');
      return;
    }

    try {
      setLoading(true);
      const newId = await borrowerRepo.create({
        fullName: clampText(fullName, 120) ?? fullName.trim(),
        phoneNumber: phoneNumber.trim(),
        categoryTag: clampText(categoryTag, 40) ?? 'General',
        address: clampText(address),
        guarantorInfo: clampText(guarantorInfo),
        notes: clampText(notes),
      });

      // Reset form
      setFullName('');
      setPhoneNumber('');
      setCategoryTag('General');
      setAddress('');
      setGuarantorInfo('');
      setNotes('');
      onSuccess(newId);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create borrower profile.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
      >
        <View style={styles.sheetContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <View style={styles.iconBg}>
                <UserPlus size={20} color="#0284c7" />
              </View>
              <View>
                <Text style={styles.headerTitle}>Add Borrower Profile</Text>
                <Text style={styles.headerSubtitle}>Zero-Auth • Managed by Treasurer</Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close modal">
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* Full Name */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>
                Full Name <Text style={styles.required}>*</Text>
              </Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Maria Elena Santos"
                placeholderTextColor="#94a3b8"
                value={fullName}
                onChangeText={setFullName}
                autoFocus
              />
            </View>

            {/* Phone Number */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelWithIcon}>
                <Phone size={14} color="#0369a1" />
                <Text style={styles.label}>
                  Phone Number <Text style={styles.required}>*</Text>
                </Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder="e.g. 0917-123-4567"
                placeholderTextColor="#94a3b8"
                keyboardType="phone-pad"
                value={phoneNumber}
                onChangeText={setPhoneNumber}
              />
            </View>

            {/* Category / Group Tag */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelWithIcon}>
                <Tag size={14} color="#0369a1" />
                <Text style={styles.label}>Category / Group Tag</Text>
              </View>
              <View style={styles.tagChips}>
                {defaultTags.map((tag) => (
                  <TouchableOpacity
                    key={tag}
                    style={[styles.tagChip, categoryTag === tag && styles.tagChipActive]}
                    onPress={() => setCategoryTag(tag)}
                  >
                    <Text
                      style={[
                        styles.tagChipText,
                        categoryTag === tag && styles.tagChipTextActive,
                      ]}
                    >
                      {tag}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Address */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelWithIcon}>
                <MapPin size={14} color="#0369a1" />
                <Text style={styles.label}>Address / Location (Optional)</Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder="e.g. Stall 12, Public Market"
                placeholderTextColor="#94a3b8"
                value={address}
                onChangeText={setAddress}
              />
            </View>

            {/* Guarantor Info */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelWithIcon}>
                <UserCheck size={14} color="#0369a1" />
                <Text style={styles.label}>Guarantor / Contact (Optional)</Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder="e.g. Juan Santos (Spouse) - 0918-000-1111"
                placeholderTextColor="#94a3b8"
                value={guarantorInfo}
                onChangeText={setGuarantorInfo}
              />
            </View>

            {/* Notes */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelWithIcon}>
                <FileText size={14} color="#0369a1" />
                <Text style={styles.label}>Treasurer Remarks (Optional)</Text>
              </View>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="e.g. Preferred collection schedule"
                placeholderTextColor="#94a3b8"
                multiline
                numberOfLines={3}
                value={notes}
                onChangeText={setNotes}
              />
            </View>
          </ScrollView>

          {/* Action Buttons with HCI Touch Compliance */}
          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={loading}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveBtn, loading && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={loading}
            >
              <Text style={styles.saveBtnText}>
                {loading ? 'Saving...' : 'Save Borrower'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
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
    marginBottom: 6,
  },
  required: {
    color: '#dc2626',
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
    minHeight: 74,
    textAlignVertical: 'top',
  },
  tagChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  tagChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f0f9ff',
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
    minHeight: 36,
    justifyContent: 'center',
  },
  tagChipActive: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  tagChipText: {
    fontSize: 12,
    color: '#0369a1',
    fontWeight: '600',
  },
  tagChipTextActive: {
    color: '#ffffff',
    fontWeight: '700',
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
    backgroundColor: '#0284c7', // Sky Blue 600
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
