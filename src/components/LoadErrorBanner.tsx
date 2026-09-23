import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { AlertTriangle, RefreshCw } from 'lucide-react-native';

interface LoadErrorBannerProps {
  /** What failed, in the treasurer's words (e.g. "the dashboard figures"). */
  what: string;
  /** The underlying message, when there is one worth showing. */
  detail?: string | null;
  onRetry: () => void;
  retrying?: boolean;
}

/**
 * Shown when a screen's data load fails.
 *
 * The screens used to swallow load failures into `console.error`, which left every figure rendered
 * from its initial state — an all-zero dashboard. In a money app that reads as "the records are
 * gone", which is a far worse experience than an honest error. Every screen that loads data now
 * says what failed and offers a retry.
 */
export const LoadErrorBanner: React.FC<LoadErrorBannerProps> = ({
  what,
  detail,
  onRetry,
  retrying = false,
}) => (
  <View style={styles.banner}>
    <AlertTriangle size={16} color="#b91c1c" />
    <View style={styles.textColumn}>
      <Text style={styles.title}>Could not load {what}</Text>
      <Text style={styles.detail}>
        {detail || 'The figures below are not up to date. Nothing has been changed or lost.'}
      </Text>
    </View>
    <TouchableOpacity
      style={[styles.retryButton, retrying && styles.retryButtonBusy]}
      onPress={onRetry}
      disabled={retrying}
    >
      <RefreshCw size={13} color="#ffffff" />
      <Text style={styles.retryText}>{retrying ? 'Trying…' : 'Retry'}</Text>
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    marginBottom: 14,
    borderRadius: 12,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  textColumn: {
    flex: 1,
  },
  title: {
    fontSize: 12,
    fontWeight: '800',
    color: '#b91c1c',
  },
  detail: {
    fontSize: 10,
    lineHeight: 14,
    color: '#991b1b',
    marginTop: 2,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: '#dc2626',
  },
  retryButtonBusy: {
    backgroundColor: '#fca5a5',
  },
  retryText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#ffffff',
  },
});

export default LoadErrorBanner;
