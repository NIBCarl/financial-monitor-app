import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { CheckCircle2, Share2, X, ShieldCheck, Download, Lock } from 'lucide-react-native';
import { formatCurrency, formatDatePretty, formatDbDateTime } from '../utils/financial';
import { ReceiptData } from '../db/types';
import { buildReceiptVerification, isReceiptSettled, shareReceipt } from '../services/receiptService';

interface ShareableReceiptModalProps {
  visible: boolean;
  receipt: ReceiptData | null;
  onClose: () => void;
  currencySymbol?: string;
}

export const ShareableReceiptModal: React.FC<ShareableReceiptModalProps> = ({
  visible,
  receipt,
  onClose,
  currencySymbol = '₱',
}) => {
  const cardRef = useRef<View>(null);
  const [verification, setVerification] = useState<{ code: string; token: string } | null>(null);
  const [sharingImage, setSharingImage] = useState(false);

  // Sign the receipt once it is shown, so the card and the shared text carry the same code.
  useEffect(() => {
    if (!visible || !receipt) return;

    let active = true;
    const sign = async () => {
      try {
        const signed = await buildReceiptVerification(receipt);
        if (active) setVerification(signed);
      } catch (err) {
        console.error('Failed to sign receipt:', err);
        if (active) setVerification(null);
      }
    };

    void sign();
    return () => {
      active = false;
    };
  }, [visible, receipt]);

  const handleShare = useCallback(async () => {
    if (!receipt) return;
    try {
      await shareReceipt(receipt, currencySymbol, verification);
    } catch (err) {
      console.error('Error sharing receipt:', err);
    }
  }, [receipt, currencySymbol, verification]);

  /** Renders the receipt card to a PNG and opens the share sheet (WhatsApp/Drive/email). */
  const handleShareImage = useCallback(async () => {
    if (!receipt || sharingImage) return;
    try {
      setSharingImage(true);
      const uri = await captureRef(cardRef, { format: 'png', quality: 1, result: 'tmpfile' });

      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', `The receipt image was saved to ${uri}`);
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: 'image/png',
        dialogTitle: `Receipt for ${receipt.borrowerName}`,
      });
    } catch (err) {
      Alert.alert(
        'Could not create image',
        err instanceof Error ? err.message : 'The receipt image could not be generated.'
      );
    } finally {
      setSharingImage(false);
    }
  }, [receipt, sharingImage]);

  if (!receipt) return null;

  const settled = isReceiptSettled(receipt);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Close button */}
          <TouchableOpacity style={styles.closeBtn} onPress={onClose} accessibilityLabel="Close">
            <X size={18} color="#64748b" />
          </TouchableOpacity>

          {/* Receipt Card (this exact view is what gets captured as the image receipt) */}
          <View ref={cardRef} collapsable={false} style={styles.receiptCard}>
            <View style={styles.successIconBadge}>
              <CheckCircle2 size={32} color="#0284c7" />
            </View>

            <Text style={styles.orgTitle}>{receipt.orgName || 'Community Treasury'}</Text>
            <Text style={styles.receiptSubtitle}>Official Payment Confirmation</Text>

            <View style={styles.divider} />

            {/* Amount Paid Callout */}
            <View style={styles.amountContainer}>
              <Text style={styles.amountLabel}>AMOUNT RECEIVED</Text>
              <Text style={styles.amountValue}>
                {formatCurrency(receipt.amountPaid, currencySymbol)}
              </Text>
              <Text style={styles.methodTag}>
                Paid via {receipt.paymentMethod}
                {receipt.referenceNo ? ` • Ref: ${receipt.referenceNo}` : ''}
              </Text>
            </View>

            <View style={styles.divider} />

            {/* Receipt Details */}
            <View style={styles.detailsList}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Borrower:</Text>
                <Text style={styles.detailValue}>{receipt.borrowerName}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Contact:</Text>
                <Text style={styles.detailValue}>{receipt.borrowerPhone}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Date & Time:</Text>
                <Text style={styles.detailValue}>
                  {formatDbDateTime(receipt.paidAt)}
                </Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Remaining Balance:</Text>
                <Text style={[styles.detailValue, { fontWeight: '800', color: '#0c4a6e' }]}>
                  {formatCurrency(receipt.remainingBalance, currencySymbol)}
                </Text>
              </View>

              {receipt.allocations && receipt.allocations.length > 0 && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Applied To:</Text>
                  <Text style={[styles.detailValue, { flexShrink: 1, textAlign: 'right' }]}>
                    {receipt.allocations
                      .map((a) => `#${a.installmentNumber} ${formatCurrency(a.amount, currencySymbol)}`)
                      .join(' • ')}
                  </Text>
                </View>
              )}

              {settled ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Status:</Text>
                  <Text style={[styles.detailValue, { color: '#0284c7', fontWeight: '800' }]}>
                    FULLY SETTLED
                  </Text>
                </View>
              ) : receipt.nextDueDate ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Next Due Date:</Text>
                  <Text style={[styles.detailValue, { color: '#0284c7', fontWeight: '700' }]}>
                    {formatDatePretty(receipt.nextDueDate)}
                    {receipt.nextDueAmount
                      ? ` • ${formatCurrency(receipt.nextDueAmount, currencySymbol)}`
                      : ''}
                  </Text>
                </View>
              ) : (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Balance Outstanding:</Text>
                  <Text style={[styles.detailValue, { color: '#0284c7', fontWeight: '700' }]}>
                    {formatCurrency(receipt.remainingBalance, currencySymbol)}
                  </Text>
                </View>
              )}
            </View>

              {/* Official Stamp */}
              <View style={styles.stampContainer}>
                <Image
                  source={require('../../assets/images/official-stamp.png')}
                  style={styles.stampImage}
                  resizeMode="contain"
                />
              </View>

              {/* Treasurer Badge */}
              <View style={styles.badgeFooter}>
                <ShieldCheck size={15} color="#0284c7" />
                <Text style={styles.badgeText}>Recorded in Offline Treasury Ledger</Text>
              </View>

              {/* Tamper-evident verification code */}
              {verification ? (
                <View style={styles.verifyBox}>
                  <Lock size={13} color="#0369a1" />
                  <View style={styles.verifyTextCol}>
                    <Text style={styles.verifyLabel}>VERIFICATION CODE</Text>
                    <Text style={styles.verifyCode}>{verification.code}</Text>
                    <Text style={styles.verifyHint}>
                      Anyone with the app can confirm this receipt was not edited.
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>

          {/* Action Buttons with HCI touch size */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.doneBtn} onPress={onClose}>
              <Text style={styles.doneBtnText}>Done</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.shareBtn} onPress={handleShare}>
              <Share2 size={18} color="#ffffff" style={{ marginRight: 6 }} />
              <Text style={styles.shareBtnText}>Share Text</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.imageBtn, sharingImage && styles.imageBtnDisabled]}
            onPress={handleShareImage}
            disabled={sharingImage}
            activeOpacity={0.85}
          >
            {sharingImage ? (
              <ActivityIndicator color="#0284c7" />
            ) : (
              <>
                <Download size={16} color="#0284c7" style={{ marginRight: 6 }} />
                <Text style={styles.imageBtnText}>Save as Image (PNG)</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(12, 74, 110, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  container: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 22,
    shadowColor: '#0c4a6e',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  closeBtn: {
    position: 'absolute',
    top: 14,
    right: 14,
    padding: 8,
    zIndex: 10,
  },
  receiptCard: {
    alignItems: 'center',
  },
  successIconBadge: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#e0f2fe',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  orgTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0c4a6e',
    textAlign: 'center',
  },
  receiptSubtitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
    fontWeight: '500',
  },
  divider: {
    width: '100%',
    height: 1.5,
    backgroundColor: '#f0f9ff',
    marginVertical: 14,
  },
  amountContainer: {
    alignItems: 'center',
  },
  amountLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 0.5,
  },
  amountValue: {
    fontSize: 28,
    fontWeight: '900',
    color: '#0284c7',
    marginVertical: 4,
  },
  methodTag: {
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
  detailsList: {
    width: '100%',
    gap: 8,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  detailLabel: {
    fontSize: 13,
    color: '#64748b',
  },
  detailValue: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '600',
  },
  stampContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  stampImage: {
    width: 86,
    height: 86,
  },
  badgeFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: '#f0f9ff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0369a1',
  },
  verifyBox: {
    flexDirection: 'row',
    gap: 8,
    width: '100%',
    marginTop: 12,
    backgroundColor: '#f0f9ff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bae6fd',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  verifyTextCol: {
    flex: 1,
  },
  verifyLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#0369a1',
    letterSpacing: 0.5,
  },
  verifyCode: {
    fontSize: 20,
    fontWeight: '900',
    color: '#0c4a6e',
    letterSpacing: 1.5,
    marginTop: 2,
  },
  verifyHint: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 2,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 22,
  },
  doneBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
  },
  shareBtn: {
    flex: 2,
    flexDirection: 'row',
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
  shareBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
  },
  imageBtn: {
    flexDirection: 'row',
    minHeight: 48,
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: '#f0f9ff',
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageBtnDisabled: {
    opacity: 0.6,
  },
  imageBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0284c7',
  },
});
