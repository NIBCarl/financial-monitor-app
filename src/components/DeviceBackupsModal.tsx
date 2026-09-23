import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Platform,
} from 'react-native';
import { Archive, HardDriveDownload, RotateCcw, X } from 'lucide-react-native';
import {
  describeBackup,
  restoreBackup,
  restoreFromStoredBackup,
  type StoredBackup,
} from '../services/backupService';
import { formatDbDateTime } from '../utils/financial';

interface DeviceBackupsModalProps {
  visible: boolean;
  /** The automatic copies on this device, newest first (loaded by the screen that owns the data). */
  backups: StoredBackup[];
  onClose: () => void;
  /** Called after a restore so the screen can reload every figure from the restored book. */
  onRestored: () => void;
}

/** Bytes as something a treasurer can read at a glance. */
function formatSize(bytes: number): string {
  if (!bytes) return 'size unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The app's own rotating backups (report §20.9).
 *
 * These are the copies the app takes by itself, so this list is what turns "I lost my phone" into
 * "restore yesterday's copy". Restoring still shows exactly what is inside the file first — the
 * same preview-before-confirm rule as the manual restore, because it replaces everything.
 */
export const DeviceBackupsModal: React.FC<DeviceBackupsModalProps> = ({
  visible,
  backups,
  onClose,
  onRestored,
}) => {
  const [restoring, setRestoring] = useState<string | null>(null);
  const handleRestore = async (backup: StoredBackup) => {
    const proceed = (payload: Awaited<ReturnType<typeof restoreFromStoredBackup>>) => {
      Alert.alert(
        'Replace All Data?',
        `Device backup from ${formatDbDateTime(payload.generatedAt)} contains:\n\n${describeBackup(
          payload
        )}\n\nRestoring replaces every current record and cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Restore',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await restoreBackup(payload);
                  onRestored();
                  onClose();
                  Alert.alert('Restore Complete', 'The book has been replaced with that backup.');
                } catch (err) {
                  Alert.alert(
                    'Restore Failed',
                    err instanceof Error ? err.message : 'The backup could not be restored.'
                  );
                }
              })();
            },
          },
        ]
      );
    };

    try {
      setRestoring(backup.fileName);
      proceed(await restoreFromStoredBackup(backup.uri));
    } catch (err) {
      Alert.alert(
        'Cannot Use That Backup',
        err instanceof Error ? err.message : 'That backup could not be read.'
      );
    } finally {
      setRestoring(null);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Archive size={18} color="#0c4a6e" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Device Backups</Text>
              <Text style={styles.subtitle}>
                The automatic copies kept on this phone, newest first.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityLabel="Close">
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>
          {backups.length === 0 ? (
            <View style={styles.center}>
              <HardDriveDownload size={22} color="#94a3b8" />
              <Text style={styles.emptyText}>
                No automatic backup yet. The app writes one shortly after it is opened on a new day,
                or tap Back Up Now in Backup &amp; Restore.
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 8 }}>
              {backups.map((backup) => (
                <View key={backup.fileName} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowDate}>{formatDbDateTime(backup.generatedAt)}</Text>
                    <Text style={styles.rowMeta}>{formatSize(backup.sizeBytes)}</Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.restoreButton, restoring !== null && styles.busyButton]}
                    onPress={() => void handleRestore(backup)}
                    disabled={restoring !== null}
                  >
                    <RotateCcw size={13} color="#ffffff" />
                    <Text style={styles.restoreButtonText}>Restore</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          )}

          <TouchableOpacity style={styles.doneButton} onPress={onClose}>
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>

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
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  closeButton: {
    padding: 6,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 26,
    gap: 8,
  },
  emptyText: {
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 17,
    paddingHorizontal: 12,
  },
  list: {
    marginTop: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    marginBottom: 8,
  },
  rowDate: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  rowMeta: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 2,
  },
  restoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 9,
    backgroundColor: '#0284c7',
  },
  busyButton: {
    backgroundColor: '#7dd3fc',
  },
  restoreButtonText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#ffffff',
  },
  doneButton: {
    marginTop: 12,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: '#0c4a6e',
    alignItems: 'center',
  },
  doneButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
  },
});

export default DeviceBackupsModal;
