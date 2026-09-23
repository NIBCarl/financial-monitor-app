import React, { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  PanResponder,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Eraser, X, Check, PenLine } from 'lucide-react-native';
import { SignatureStrokes } from '../db/types';
import { isSignatureTooSmall, normaliseStrokes, strokesToSvgPath } from '../utils/signature';

interface SignaturePadModalProps {
  visible: boolean;
  title: string;
  /** What is being signed, in the treasurer's words (e.g. "Payment of ₱2,625.00"). */
  subject: string;
  signerName: string;
  /** Existing signature, so a re-sign starts from what is on file. */
  existing?: SignatureStrokes | null;
  onCancel: () => void;
  onSave: (strokes: SignatureStrokes) => Promise<void> | void;
}

/** Logical drawing surface; strokes are normalised to it, so the device size does not matter. */
const PAD_WIDTH = 300;
const PAD_HEIGHT = 170;

type PadPoint = { x: number; y: number };

/** The committed strokes plus the one still under the finger, in one state object. */
interface PadState {
  committed: PadPoint[][];
  live: PadPoint[];
}

/**
 * Finger signature capture (report §20.6).
 *
 * Uses the platform's own touch handling (`PanResponder`) and the SVG renderer already in the app,
 * so capturing a signature needs no new native module. What the borrower draws is stored as
 * normalised strokes, which is what lets the same mark appear on the receipt and in the PDF.
 */
export const SignaturePadModal: React.FC<SignaturePadModalProps> = ({
  visible,
  title,
  subject,
  signerName,
  existing,
  onCancel,
  onSave,
}) => {
  const [pad, setPad] = useState<PadState>({ committed: [], live: [] });
  const [busy, setBusy] = useState(false);

  const reset = (initial?: SignatureStrokes | null) => setPad({ committed: initial ?? [], live: [] });

  /** Normalises the stroke just drawn into the committed set, ready for display and storage. */
  function commitLiveStroke() {
    setPad((prev) => {
      const normalised = normaliseStrokes([prev.live], PAD_WIDTH, PAD_HEIGHT);
      return {
        committed: normalised.length > 0 ? [...prev.committed, ...normalised] : prev.committed,
        live: [],
      };
    });
  }

  // Every update below is a pure state transition — the stroke under the finger is part of the
  // state, not a ref, so drawing stays inside React's rules and the pad repaints as the finger moves.
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          setPad((prev) => ({ ...prev, live: [{ x: locationX, y: locationY }] }));
        },
        onPanResponderMove: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          setPad((prev) => ({ ...prev, live: [...prev.live, { x: locationX, y: locationY }] }));
        },
        onPanResponderRelease: () => commitLiveStroke(),
        onPanResponderTerminate: () => commitLiveStroke(),
      }),
    []
  );

  // The live stroke is drawn in raw pad coordinates; committed strokes are normalised. Both land in
  // the same 300x170 viewBox, so the mark does not jump when the finger lifts.
  const livePath = useMemo(() => strokesToSvgPath([pad.live], PAD_WIDTH, PAD_HEIGHT), [pad.live]);
  const savedPath = useMemo(() => strokesToSvgPath(pad.committed, PAD_WIDTH, PAD_HEIGHT), [
    pad.committed,
  ]);

  const handleSave = async () => {
    if (isSignatureTooSmall(pad.committed)) {
      Alert.alert(
        'Signature too short',
        'Ask the borrower to sign across the box — a dot or a short tap is not a signature.'
      );
      return;
    }

    try {
      setBusy(true);
      await onSave(pad.committed);
      reset(null);
    } catch (err) {
      Alert.alert(
        'Could not save',
        err instanceof Error ? err.message : 'The signature was not saved.'
      );
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>{subject}</Text>
            </View>
            <TouchableOpacity onPress={onCancel} style={styles.closeButton} accessibilityLabel="Close">
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <Text style={styles.instruction}>
            Hand the phone to {signerName} and ask them to sign in the box with a finger.
          </Text>

          <View style={styles.pad} collapsable={false} {...responder.panHandlers}>
            <Svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${PAD_WIDTH} ${PAD_HEIGHT}`}
              preserveAspectRatio="none"
              pointerEvents="none"
            >
              <Path
                d={savedPath}
                fill="none"
                stroke="#0f172a"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <Path
                d={livePath}
                fill="none"
                stroke="#0f172a"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>

            <View style={styles.baseline} pointerEvents="none" />

            {pad.committed.length === 0 && pad.live.length === 0 ? (
              <View style={styles.padHint} pointerEvents="none">
                <PenLine size={16} color="#94a3b8" />
                <Text style={styles.padHintText}>Sign here</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.clearButton} onPress={() => reset(null)} disabled={busy}>
              <Eraser size={15} color="#b91c1c" />
              <Text style={styles.clearButtonText}>Clear</Text>
            </TouchableOpacity>

            {existing && existing.length > 0 ? (
              <TouchableOpacity
                style={styles.restoreButton}
                onPress={() => reset(existing)}
                disabled={busy}
              >
                <Text style={styles.restoreButtonText}>Restore saved</Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity
              style={[styles.saveButton, busy && styles.saveButtonBusy]}
              onPress={() => void handleSave()}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <Check size={16} color="#ffffff" />
                  <Text style={styles.saveButtonText}>Save signature</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <Text style={styles.footnote}>
            The signature and the time it was taken are stored on this device and printed on the
            receipt and statement. Re-signing replaces it and the old version stays in the audit log.
          </Text>

        </View>
      </View>
    </Modal>
  );
};


const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 18,
    paddingBottom: Platform.OS === 'ios' ? 26 : 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  closeButton: {
    padding: 6,
  },
  instruction: {
    fontSize: 12,
    color: '#334155',
    marginTop: 12,
    lineHeight: 17,
  },
  pad: {
    height: 190,
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderStyle: 'dashed',
    backgroundColor: '#f8fafc',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  baseline: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 46,
    height: 1,
    backgroundColor: '#cbd5e1',
  },
  padHint: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  padHintText: {
    fontSize: 13,
    color: '#94a3b8',
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  clearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  clearButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#b91c1c',
  },
  restoreButton: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  restoreButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  saveButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0284c7',
    borderRadius: 10,
    paddingVertical: 12,
  },
  saveButtonBusy: {
    backgroundColor: '#7dd3fc',
  },
  saveButtonText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
  },
  footnote: {
    fontSize: 10,
    color: '#64748b',
    lineHeight: 14,
    marginTop: 12,
  },
});

export default SignaturePadModal;
