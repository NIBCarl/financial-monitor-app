import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { AlertTriangle, X } from 'lucide-react-native';

interface ConfirmReasonModalProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders a required reason field — the value is what lands in the audit log. */
  withReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  destructive?: boolean;
  onCancel: () => void;
  /** May be async; the sheet stays busy until it settles, then closes. */
  onConfirm: (reason: string) => void | Promise<void>;
}

/**
 * Confirmation sheet that captures a written reason.
 *
 * Every destructive or money-affecting action in the app goes through here, so the audit
 * log always has a human explanation attached to it.
 */
export const ConfirmReasonModal: React.FC<ConfirmReasonModalProps> = ({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  withReason = true,
  reasonLabel = 'Reason (recorded in the audit log)',
  reasonPlaceholder = 'e.g. wrong amount encoded, duplicate entry…',
  destructive = false,
  onCancel,
  onConfirm,
}) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (!visible) return null;

  const accent = destructive ? '#dc2626' : '#0284c7';
  const canConfirm = !withReason || reason.trim().length > 0;

  const handleConfirm = async () => {
    if (!canConfirm || busy) return;
    try {
      setBusy(true);
      await onConfirm(reason.trim());
      setReason('');
      onCancel();
    } catch (err) {
      Alert.alert('Action Failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={[styles.iconBg, { backgroundColor: destructive ? '#fee2e2' : '#e0f2fe' }]}>
              <AlertTriangle size={20} color={accent} />
            </View>
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
            <TouchableOpacity
              onPress={onCancel}
              style={styles.closeBtn}
              accessibilityLabel="Close"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <X size={18} color="#64748b" />
            </TouchableOpacity>
          </View>

          <Text style={styles.message}>{message}</Text>

          {withReason ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{reasonLabel}</Text>
              <TextInput
                style={styles.input}
                placeholder={reasonPlaceholder}
                placeholderTextColor="#94a3b8"
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={240}
              />
              {!canConfirm ? <Text style={styles.hint}>A reason is required to continue.</Text> : null}
            </View>
          ) : null}

          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={onCancel}
              disabled={busy}
              activeOpacity={0.8}
            >
              <Text style={styles.cancelBtnText}>{cancelLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.confirmBtn,
                { backgroundColor: accent },
                (!canConfirm || busy) && styles.confirmBtnDisabled,
              ]}
              onPress={handleConfirm}
              disabled={!canConfirm || busy}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.confirmBtnText}>{confirmLabel}</Text>
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
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 18,
    paddingBottom: Platform.OS === 'ios' ? 24 : 18,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBg: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  closeBtn: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
  },
  message: {
    fontSize: 13,
    color: '#475569',
    lineHeight: 19,
    marginTop: 12,
  },
  fieldGroup: {
    marginTop: 14,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
    minHeight: 72,
    textAlignVertical: 'top',
  },
  hint: {
    fontSize: 11,
    color: '#dc2626',
    marginTop: 6,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
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
  confirmBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnDisabled: {
    opacity: 0.5,
  },
  confirmBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
  },
});

