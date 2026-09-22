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
import { X, ShieldCheck, ShieldAlert, ClipboardCheck } from 'lucide-react-native';
import { verifyReceiptText, type ReceiptVerificationFields } from '../services/receiptService';
import { formatCurrency, formatDbDateTime } from '../utils/financial';

interface VerifyReceiptModalProps {
  visible: boolean;
  onClose: () => void;
  currencySymbol?: string;
}

type VerifyState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'valid'; fields: ReceiptVerificationFields }
  | { status: 'invalid'; reason: string; fields?: ReceiptVerificationFields };

/**
 * Checks a receipt against the ledger's signing secret.
 *
 * The treasurer pastes the message a borrower received (or the `TV1~…` token on its own);
 * the app recomputes the code and confirms the amount, date and balance were not altered.
 */
export const VerifyReceiptModal: React.FC<VerifyReceiptModalProps> = ({
  visible,
  onClose,
  currencySymbol = '₱',
}) => {
  const [text, setText] = useState('');
  const [state, setState] = useState<VerifyState>({ status: 'idle' });

  const handleVerify = async () => {
    if (!text.trim()) {
      Alert.alert('Nothing to check', 'Paste the receipt message or its verification token first.');
      return;
    }
    try {
      setState({ status: 'checking' });
      const result = await verifyReceiptText(text);
      setState(
        result.ok && result.fields
          ? { status: 'valid', fields: result.fields }
          : {
              status: 'invalid',
              reason: result.reason ?? 'This receipt could not be verified.',
              fields: result.fields,
            }
      );
    } catch (err) {
      setState({
        status: 'invalid',
        reason: err instanceof Error ? err.message : 'Verification failed.',
      });
    }
  };

  const handleReset = () => {
    setText('');
    setState({ status: 'idle' });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheetContainer}>
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <View style={styles.iconBg}>
                <ClipboardCheck size={20} color="#0284c7" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerTitle}>Verify a Receipt</Text>
                <Text style={styles.headerSubtitle}>Confirm a shared receipt was not edited</Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close">
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <Text style={styles.label}>Paste the receipt message</Text>
            <TextInput
              style={styles.input}
              placeholder='Paste here… it contains a line starting with "Token: TV1~"'
              placeholderTextColor="#94a3b8"
              value={text}
              onChangeText={setText}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />

            {state.status === 'valid' ? (
              <View style={[styles.resultBox, styles.resultValid]}>
                <ShieldCheck size={18} color="#047857" />
                <View style={styles.resultBody}>
                  <Text style={[styles.resultTitle, { color: '#047857' }]}>GENUINE RECEIPT</Text>
                  <Text style={styles.resultLine}>
                    Amount: {formatCurrency(state.fields.amountPaid, currencySymbol)}
                  </Text>
                  <Text style={styles.resultLine}>Paid: {formatDbDateTime(state.fields.paidAt)}</Text>
                  <Text style={styles.resultLine}>
                    Balance after: {formatCurrency(state.fields.remainingBalance, currencySymbol)}
                  </Text>
                  <Text style={styles.resultLine}>Ref: {state.fields.paymentId}</Text>
                </View>
              </View>
            ) : null}

            {state.status === 'invalid' ? (
              <View style={[styles.resultBox, styles.resultInvalid]}>
                <ShieldAlert size={18} color="#b91c1c" />
                <View style={styles.resultBody}>
                  <Text style={[styles.resultTitle, { color: '#b91c1c' }]}>NOT VERIFIED</Text>
                  <Text style={styles.resultLine}>{state.reason}</Text>
                  {state.fields ? (
                    <Text style={styles.resultLine}>
                      Claimed amount: {formatCurrency(state.fields.amountPaid, currencySymbol)} •{' '}
                      {formatDbDateTime(state.fields.paidAt)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            <Text style={styles.helpText}>
              A receipt is signed with this device’s ledger secret when it is shared, so any edit
              to the amount, date or balance after it was sent makes the code stop matching.
            </Text>
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={handleReset} activeOpacity={0.8}>
              <Text style={styles.cancelBtnText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.verifyBtn, state.status === 'checking' && styles.verifyBtnDisabled]}
              onPress={handleVerify}
              disabled={state.status === 'checking'}
              activeOpacity={0.85}
            >
              {state.status === 'checking' ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.verifyBtnText}>Verify Receipt</Text>
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
  label: {
    fontSize: 13,
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
    fontSize: 13,
    color: '#0f172a',
    minHeight: 140,
    textAlignVertical: 'top',
  },
  resultBox: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 12,
    marginTop: 14,
  },
  resultValid: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  },
  resultInvalid: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  resultBody: {
    flex: 1,
  },
  resultTitle: {
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  resultLine: {
    fontSize: 12,
    color: '#334155',
    marginTop: 2,
  },
  helpText: {
    fontSize: 11,
    color: '#64748b',
    lineHeight: 16,
    marginTop: 16,
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 18,
    paddingTop: 12,
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
  verifyBtn: {
    flex: 2,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0284c7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  verifyBtnDisabled: {
    opacity: 0.6,
  },
  verifyBtnText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
  },
});


