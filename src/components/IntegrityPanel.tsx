import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import {
  ShieldCheck,
  ShieldAlert,
  Link2,
  ClipboardCheck,
  Stamp,
  Share2,
  FileText,
  AlertTriangle,
} from 'lucide-react-native';
import { auditRepo, type ChainVerification } from '../db/repositories/auditRepo';
import {
  listSeals,
  publishSeal,
  runBooksCheck,
  shareSeal,
  verifySeal,
  type BooksCheckResult,
  type SealVerification,
} from '../services/integrityService';
import type { LedgerSeal } from '../db/repositories/sealRepo';
import { exportMonthlyReportPdf } from '../services/pdfService';
import { formatDbDateTime } from '../utils/financial';
import { useScopedReload } from '../hooks/use-scoped-reload';

interface IntegrityPanelProps {
  orgName: string;
  currencySymbol: string;
  /** Lets the host screen refresh totals after any change. */
  onChanged?: () => void;
}

type Busy = 'chain' | 'books' | 'seal' | 'pdf' | null;

/**
 * Trust panel: proves what can be proven about a single-device ledger.
 *
 *  - **Audit chain** — every recorded change is hash-linked; a rewrite breaks it.
 *  - **Books check** — balances are recomputed from raw payments and compared with what is stored.
 *  - **Seals** — publish the chain head monthly so later tampering is detectable even if the
 *    whole database were regenerated.
 */
export const IntegrityPanel: React.FC<IntegrityPanelProps> = ({
  orgName,
  currencySymbol,
  onChanged,
}) => {
  const [busy, setBusy] = useState<Busy>(null);
  const [chain, setChain] = useState<ChainVerification | null>(null);
  const [books, setBooks] = useState<BooksCheckResult | null>(null);
  const [seals, setSeals] = useState<LedgerSeal[]>([]);
  const [sealChecks, setSealChecks] = useState<Record<string, SealVerification>>({});

  const loadSeals = useCallback(async () => {
    const rows = await listSeals();
    setSeals(rows);

    // Re-check the three newest seals only — older ones are history, not a live signal.
    const checks: Record<string, SealVerification> = {};
    for (const seal of rows.slice(0, 3)) {
      checks[seal.id] = await verifySeal(seal);
    }
    setSealChecks(checks);
  }, []);

  // Seals only change when one is published, or when the book is restored/wiped — both of which
  // bump the evidence/settings scopes. It no longer re-reads itself on every payment.
  useScopedReload(['evidence', 'settings'], loadSeals);

  const handleVerifyChain = async () => {
    try {
      setBusy('chain');
      setChain(await auditRepo.verifyChain());
    } catch (err) {
      Alert.alert(
        'Check failed',
        err instanceof Error ? err.message : 'Could not verify the trail.'
      );
    } finally {
      setBusy(null);
    }
  };

  const handleBooksCheck = async () => {
    try {
      setBusy('books');
      setBooks(await runBooksCheck());
    } catch (err) {
      Alert.alert(
        'Check failed',
        err instanceof Error ? err.message : 'Could not check the books.'
      );
    } finally {
      setBusy(null);
    }
  };

  const handlePublishSeal = async () => {
    try {
      setBusy('seal');
      const seal = await publishSeal();
      await loadSeals();
      onChanged?.();
      Alert.alert(
        'Seal created',
        `Seal code ${seal.sealCode} for ${seal.period}.\n\nShare it to your group chat, print it, or paste it into the minutes. Keeping it is what makes later changes detectable.`,
        [
          { text: 'Later', style: 'cancel' },
          { text: 'Share now', onPress: () => void shareSeal(seal, orgName, currencySymbol) },
        ]
      );
    } catch (err) {
      Alert.alert(
        'Cannot seal yet',
        err instanceof Error ? err.message : 'Could not create a seal.'
      );
    } finally {
      setBusy(null);
    }
  };

  const handleMonthlyPdf = async () => {
    try {
      setBusy('pdf');
      const monthLabel = new Date().toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      });
      await exportMonthlyReportPdf({ orgName, currencySymbol, monthLabel });
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Could not build the PDF.');
    } finally {
      setBusy(null);
    }
  };

  const latestSeal = seals[0];
  const latestCheck = latestSeal ? sealChecks[latestSeal.id] : undefined;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerIcon}>
          <ShieldCheck size={18} color="#0284c7" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Integrity &amp; seals</Text>
          <Text style={styles.subtitle}>
            {seals.length === 0
              ? 'No seal published yet'
              : `${seals.length} seal${seals.length === 1 ? '' : 's'} recorded`}
          </Text>
        </View>
      </View>

      <TouchableOpacity
        style={styles.actionRow}
        onPress={handleVerifyChain}
        disabled={busy !== null}
        activeOpacity={0.7}
      >
        <Link2 size={18} color="#0c4a6e" />
        <View style={styles.actionText}>
          <Text style={styles.actionTitle}>Verify audit chain</Text>
          <Text style={styles.actionDesc}>Recompute every recorded change hash.</Text>
        </View>
        {busy === 'chain' ? <ActivityIndicator color="#0284c7" /> : null}
      </TouchableOpacity>

      {chain ? (
        <View style={[styles.resultBox, chain.ok ? styles.resultOk : styles.resultBad]}>
          {chain.ok ? (
            <ShieldCheck size={16} color="#047857" />
          ) : (
            <ShieldAlert size={16} color="#b91c1c" />
          )}
          <View style={styles.resultBody}>
            <Text style={[styles.resultTitle, { color: chain.ok ? '#047857' : '#b91c1c' }]}>
              {chain.ok ? 'TRAIL INTACT' : 'TRAIL BROKEN'}
            </Text>
            <Text style={styles.resultLine}>
              {chain.checked} linked {chain.checked === 1 ? 'entry' : 'entries'} checked
              {chain.unsigned > 0 ? ` · ${chain.unsigned} pre-chain (unsigned)` : ''}
            </Text>
            {!chain.ok && chain.reason ? <Text style={styles.resultLine}>{chain.reason}</Text> : null}
          </View>
        </View>
      ) : null}

      <TouchableOpacity
        style={styles.actionRow}
        onPress={handleBooksCheck}
        disabled={busy !== null}
        activeOpacity={0.7}
      >
        <ClipboardCheck size={18} color="#0c4a6e" />
        <View style={styles.actionText}>
          <Text style={styles.actionTitle}>Run books check</Text>
          <Text style={styles.actionDesc}>Recompute balances from raw payments and compare.</Text>
        </View>
        {busy === 'books' ? <ActivityIndicator color="#0284c7" /> : null}
      </TouchableOpacity>

      {books ? (
        <View style={[styles.resultBox, books.ok ? styles.resultOk : styles.resultBad]}>
          {books.ok ? (
            <ShieldCheck size={16} color="#047857" />
          ) : (
            <AlertTriangle size={16} color="#b91c1c" />
          )}
          <View style={styles.resultBody}>
            <Text style={[styles.resultTitle, { color: books.ok ? '#047857' : '#b91c1c' }]}>
              {books.ok ? 'BOOKS BALANCE' : `${books.issues.length} DISCREPANCY(IES)`}
            </Text>
            <Text style={styles.resultLine}>
              {books.checkedLoans} loans · {books.checkedPayments} payments ·{' '}
              {books.checkedLedgerRows} ledger entries
            </Text>
            {books.issues.slice(0, 4).map((issue, index) => (
              <Text key={index} style={styles.resultLine}>
                • {issue.reference}: {issue.detail}
              </Text>
            ))}
            {books.issues.length > 4 ? (
              <Text style={styles.resultLine}>…and {books.issues.length - 4} more.</Text>
            ) : null}
          </View>
        </View>
      ) : null}

      <TouchableOpacity
        style={styles.actionRow}
        onPress={handlePublishSeal}
        disabled={busy !== null}
        activeOpacity={0.7}
      >
        <Stamp size={18} color="#0c4a6e" />
        <View style={styles.actionText}>
          <Text style={styles.actionTitle}>Publish monthly seal</Text>
          <Text style={styles.actionDesc}>Capture the chain head and totals, then share it.</Text>
        </View>
        {busy === 'seal' ? <ActivityIndicator color="#0284c7" /> : null}
      </TouchableOpacity>

      {latestSeal && latestCheck ? (
        <View style={[styles.resultBox, latestCheck.headFound ? styles.resultOk : styles.resultBad]}>
          {latestCheck.headFound ? (
            <ShieldCheck size={16} color="#047857" />
          ) : (
            <ShieldAlert size={16} color="#b91c1c" />
          )}
          <View style={styles.resultBody}>
            <Text
              style={[styles.resultTitle, { color: latestCheck.headFound ? '#047857' : '#b91c1c' }]}
            >
              {latestCheck.headFound
                ? `SEAL ${latestSeal.period} STILL VALID`
                : `SEAL ${latestSeal.period} NO LONGER MATCHES`}
            </Text>
            <Text style={styles.resultLine}>
              Code {latestSeal.sealCode} · head {latestSeal.chainHead.slice(0, 12)}…
            </Text>
            <Text style={styles.resultLine}>
              {latestCheck.headFound
                ? `Found at position ${latestCheck.position} of the trail — nothing recorded before it has been changed.`
                : 'The published chain head is not in the trail, so the recorded history was rewritten.'}
            </Text>
            <Text style={styles.resultLine}>Sealed {formatDbDateTime(latestSeal.createdAt)}</Text>
          </View>
        </View>
      ) : null}

      <TouchableOpacity
        style={styles.shareSealBtn}
        onPress={() => latestSeal && void shareSeal(latestSeal, orgName, currencySymbol)}
        disabled={!latestSeal}
        activeOpacity={0.8}
      >
        <Share2 size={15} color={latestSeal ? '#0284c7' : '#94a3b8'} />
        <Text style={[styles.shareSealText, !latestSeal && styles.disabledText]}>
          Share latest seal
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.actionRow}
        onPress={handleMonthlyPdf}
        disabled={busy !== null}
        activeOpacity={0.7}
      >
        <FileText size={18} color="#0c4a6e" />
        <View style={styles.actionText}>
          <Text style={styles.actionTitle}>Export monthly report (PDF)</Text>
          <Text style={styles.actionDesc}>
            Cash, portfolio, aging, forecast, expenses and activity.
          </Text>
        </View>
        {busy === 'pdf' ? <ActivityIndicator color="#0284c7" /> : null}
      </TouchableOpacity>

      <Text style={styles.footnote}>
        A seal is only evidence once it leaves the device. Share it to your group chat or print it —
        that copy is what a later rewrite would contradict.
      </Text>
    </View>
  );
};



const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
    shadowColor: '#0c4a6e',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  subtitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 8,
  },
  actionText: {
    flex: 1,
  },
  actionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  actionDesc: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  resultBox: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    padding: 12,
    marginBottom: 10,
  },
  resultOk: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  },
  resultBad: {
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
    fontSize: 11,
    color: '#334155',
    marginTop: 2,
    lineHeight: 15,
  },
  shareSealBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#f0f9ff',
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    marginBottom: 8,
  },
  shareSealText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0284c7',
  },
  disabledText: {
    color: '#94a3b8',
  },
  footnote: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 6,
    lineHeight: 14,
  },
});
