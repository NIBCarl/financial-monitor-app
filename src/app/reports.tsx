import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  StatusBar,
  Share,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  FileSpreadsheet,
  Share2,
  Building2,
  Check,
  ShieldCheck,
  Trash2,
  Download,
  UploadCloud,
  ClipboardCheck,
} from 'lucide-react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { ledgerRepo } from '../db/repositories/ledgerRepo';
import { borrowerRepo } from '../db/repositories/borrowerRepo';
import { settingsRepo } from '../db/repositories/settingsRepo';
import { resetEntireDatabase } from '../db/client';
import { DashboardMetrics } from '../db/types';
import { useAppStore } from '../stores/useAppStore';
import { VerifyReceiptModal } from '../components/VerifyReceiptModal';
import { PortfolioHealthCard } from '../components/PortfolioHealthCard';
import { IntegrityPanel } from '../components/IntegrityPanel';
import { reportsRepo, type AgingRow, type ForecastRow, type PortfolioRisk } from '../db/repositories/reportsRepo';
import { formatCurrency, formatDbDate } from '../utils/financial';
import {
  createBackup,
  describeBackup,
  pickBackupFile,
  readAndValidateBackup,
  restoreBackup,
  shareBackup,
  type BackupPayload,
} from '../services/backupService';
import { format } from 'date-fns';

export default function ReportsScreen() {
  const {
    currencySymbol,
    setCurrencySymbol,
    organizationName,
    setOrganizationName,
    refreshKey,
    triggerRefresh,
  } = useAppStore();

  const [metrics, setMetrics] = useState<DashboardMetrics>({
    liquidCash: 0,
    totalInflows: 0,
    totalOutflows: 0,
    outstandingPrincipal: 0,
    expectedInterest: 0,
    overdueAmount: 0,
    activeBorrowersCount: 0,
    overdueBorrowersCount: 0,
    totalCollectedThisMonth: 0,
  });

  const [orgInput, setOrgInput] = useState(organizationName);
  const [currInput, setCurrInput] = useState(currencySymbol);
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [verifyVisible, setVerifyVisible] = useState(false);
  const [aging, setAging] = useState<AgingRow[]>([]);
  const [risk, setRisk] = useState<PortfolioRisk>({
    atRiskAmount: 0,
    totalOutstanding: 0,
    parPercent: 0,
    atRiskLoanCount: 0,
    activeLoanCount: 0,
  });
  const [forecast, setForecast] = useState<ForecastRow[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [metrics, lastBackup, agingRows, riskRow, forecastRows] = await Promise.all([
        ledgerRepo.getMetrics(),
        settingsRepo.get('last_backup_at'),
        reportsRepo.getAgingSchedule(),
        reportsRepo.getPortfolioRisk(),
        reportsRepo.getForecast(3),
      ]);
      setMetrics(metrics);
      setLastBackupAt(lastBackup);
      setAging(agingRows);
      setRisk(riskRow);
      setForecast(forecastRows);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData, refreshKey]);

  const handleSaveSettings = async () => {
    const nextOrg = orgInput.trim() || organizationName;
    const nextCurrency = currInput.trim() || currencySymbol;

    try {
      // Persisted to app_settings, so preferences now survive a cold start.
      await settingsRepo.setMany({ org_name: nextOrg, currency_symbol: nextCurrency });
      setOrganizationName(nextOrg);
      setCurrencySymbol(nextCurrency);
      setIsEditingSettings(false);
      triggerRefresh();
      Alert.alert('Settings Saved', 'Organization name and currency symbol are stored on this device.');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to save settings.');
    }
  };

  const handleCreateBackup = async () => {
    try {
      setBackupBusy(true);
      const summary = await createBackup();
      await settingsRepo.set('last_backup_at', summary.generatedAt);
      setLastBackupAt(summary.generatedAt);

      Alert.alert(
        'Backup Created',
        `${summary.fileName}\n\nBorrowers: ${summary.counts.borrowers}\nLoans: ${summary.counts.loans}\nPayments: ${summary.counts.loan_payments}\n\nShare it to Drive or email so the records survive a lost phone.`,
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Share Now',
            onPress: () => {
              void shareBackup(summary).catch((err) =>
                Alert.alert('Share Failed', err instanceof Error ? err.message : 'Could not share the backup.')
              );
            },
          },
        ]
      );
    } catch (err) {
      Alert.alert('Backup Failed', err instanceof Error ? err.message : 'Could not create the backup.');
    } finally {
      setBackupBusy(false);
    }
  };

  const applyRestore = async (payload: BackupPayload) => {
    try {
      setBackupBusy(true);
      const inserted = await restoreBackup(payload);
      triggerRefresh();
      Alert.alert(
        'Restore Complete',
        `Restored ${inserted.borrowers} borrowers, ${inserted.loans} loans, ${inserted.loan_schedules} installments, ${inserted.loan_payments} payments and ${inserted.ledger_transactions} ledger entries.`
      );
    } catch (err) {
      Alert.alert('Restore Failed', err instanceof Error ? err.message : 'Could not restore the backup.');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreBackup = async () => {
    try {
      setBackupBusy(true);
      const picked = await pickBackupFile();
      if (!picked) return;

      const validation = await readAndValidateBackup(picked.uri);
      if (!validation.valid || !validation.payload) {
        Alert.alert('Invalid Backup', validation.error ?? 'That file could not be used.');
        return;
      }

      const payload = validation.payload;
      Alert.alert(
        'Replace All Data?',
        `Backup from ${formatDbDate(payload.generatedAt)} contains:\n\n${describeBackup(payload)}\n\nRestoring replaces every current record and cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Restore',
            style: 'destructive',
            onPress: () => {
              void applyRestore(payload);
            },
          },
        ]
      );
    } catch (err) {
      Alert.alert('Restore Failed', err instanceof Error ? err.message : 'Could not read the backup.');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleResetData = () => {
    Alert.alert(
      'Reset Entire Database?',
      'This will permanently clear all borrower profiles, loans, payments, and ledger entries for a clean slate. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Erase All Data',
          style: 'destructive',
          onPress: async () => {
            try {
              await resetEntireDatabase();
              triggerRefresh();
              Alert.alert('Database Cleaned', 'All sample and user data have been reset to a fresh clean slate.');
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Failed to reset database.');
            }
          },
        },
      ]
    );
  };

  const handleShareSummary = async () => {
    try {
      const summaryText = `
📊 *FINANCIAL HEALTH REPORT*
🏛 *${organizationName}*
📅 As of ${format(new Date(), 'PPpp')}
────────────────────────
💰 *Total Liquid Cash:* ${formatCurrency(metrics.liquidCash, currencySymbol)}
🤝 *Total Outstanding Lent:* ${formatCurrency(metrics.outstandingPrincipal, currencySymbol)}
📈 *Expected Interest/Profit:* ${formatCurrency(metrics.expectedInterest, currencySymbol)}
⚠️ *Total Overdue Balances:* ${formatCurrency(metrics.overdueAmount, currencySymbol)}
────────────────────────
👥 *Active Borrowers:* ${metrics.activeBorrowersCount}
🔴 *Delinquent Accounts:* ${metrics.overdueBorrowersCount}
💵 *Collected This Month:* ${formatCurrency(metrics.totalCollectedThisMonth, currencySymbol)}
────────────────────────
Generated from Treasurer Mobile Ledger
      `.trim();

      await Share.share({
        message: summaryText,
        title: `${organizationName} - Financial Report`,
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleExportCSV = async () => {
    try {
      const borrowers = await borrowerRepo.getAll();
      let csvContent = 'Full Name,Phone,Tag,Active Loans,Outstanding Balance,Has Overdue\n';

      for (const b of borrowers) {
        csvContent += `"${b.fullName}","${b.phoneNumber}","${b.categoryTag}",${b.activeLoansCount || 0},${b.totalOutstanding || 0},${b.hasOverdue ? 'YES' : 'NO'}\n`;
      }

      const fileName = `Borrowers_Report_${format(new Date(), 'yyyyMMdd_HHmm')}.csv`;
      const file = new File(Paths.document, fileName);
      file.write(csvContent);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'text/csv',
          dialogTitle: 'Export Borrowers CSV',
        });
      } else {
        Alert.alert('File Saved', `Saved CSV to ${file.uri}`);
      }
    } catch (err: any) {
      Alert.alert('Export Error', err?.message || 'Failed to export CSV.');
    }
  };

  // Recovery health calculation
  const totalReceivable = metrics.outstandingPrincipal + metrics.overdueAmount;
  const healthRate =
    totalReceivable > 0
      ? Math.max(0, Math.min(100, Math.round(((totalReceivable - metrics.overdueAmount) / totalReceivable) * 100)))
      : 100;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Reports & Settings</Text>
          <Text style={styles.headerSubtitle}>Organization overview & data export</Text>
        </View>

        {/* Portfolio Health Card */}
        <View style={styles.healthCard}>
          <View style={styles.healthHeader}>
            <View>
              <Text style={styles.healthLabel}>LOAN PORTFOLIO HEALTH</Text>
              <Text style={styles.healthRate}>{healthRate}%</Text>
            </View>
            <View style={styles.healthBadge}>
              <ShieldCheck size={20} color="#0284c7" />
              <Text style={styles.healthBadgeText}>
                {healthRate >= 80 ? 'Good Standing' : 'Attention Needed'}
              </Text>
            </View>
          </View>
          <View style={styles.progressBarBg}>
            <View
              style={[
                styles.progressBarFill,
                {
                  width: `${healthRate}%`,
                  backgroundColor: healthRate >= 80 ? '#0284c7' : '#f59e0b',
                },
              ]}
            />
          </View>
          <Text style={styles.healthSubtext}>
            {metrics.overdueBorrowersCount === 0
              ? 'Zero delinquent loans currently. All borrowers are on schedule!'
              : `${metrics.overdueBorrowersCount} borrower(s) currently overdue.`}
          </Text>
        </View>

        {/* Portfolio health — aging, portfolio-at-risk and expected collections */}
        <Text style={styles.sectionTitle}>Portfolio Health</Text>
        <PortfolioHealthCard
          aging={aging}
          risk={risk}
          forecast={forecast}
          currencySymbol={currencySymbol}
        />

        {/* Trust: audit chain, books check, seals, PDF */}
        <Text style={styles.sectionTitle}>Trust &amp; Evidence</Text>
        <IntegrityPanel
          orgName={organizationName}
          currencySymbol={currencySymbol}
          onChanged={triggerRefresh}
        />

        {/* Export & Sharing Options */}
        <Text style={styles.sectionTitle}>Reports & Sharing</Text>
        <View style={styles.actionCards}>
          <TouchableOpacity style={styles.actionCard} onPress={handleShareSummary} activeOpacity={0.7}>
            <View style={[styles.actionIconBg, { backgroundColor: '#e0f2fe' }]}>
              <Share2 size={20} color="#0284c7" />
            </View>
            <View style={styles.actionCardInfo}>
              <Text style={styles.actionCardTitle}>Share Meeting Summary</Text>
              <Text style={styles.actionCardDesc}>
                Format and send a financial update via WhatsApp, Telegram, or SMS.
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionCard} onPress={handleExportCSV} activeOpacity={0.7}>
            <View style={[styles.actionIconBg, { backgroundColor: '#e0f2fe' }]}>
              <FileSpreadsheet size={20} color="#0c4a6e" />
            </View>
            <View style={styles.actionCardInfo}>
              <Text style={styles.actionCardTitle}>Export Borrowers to CSV</Text>
              <Text style={styles.actionCardDesc}>
                Generate a spreadsheet of all borrowers and balances.
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Organization Settings */}
        <Text style={styles.sectionTitle}>Treasurer Preferences</Text>
        <View style={styles.settingsCard}>
          <View style={styles.settingsRow}>
            <View style={styles.settingsIcon}>
              <Building2 size={18} color="#0c4a6e" />
            </View>
            <View style={styles.settingsInputGroup}>
              <Text style={styles.settingsLabel}>Organization Name</Text>
              {isEditingSettings ? (
                <TextInput
                  style={styles.settingsInput}
                  value={orgInput}
                  onChangeText={setOrgInput}
                />
              ) : (
                <Text style={styles.settingsValue}>{organizationName}</Text>
              )}
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.settingsRow}>
            <View style={styles.settingsIcon}>
              <Text style={styles.currencyIconText}>{currencySymbol}</Text>
            </View>
            <View style={styles.settingsInputGroup}>
              <Text style={styles.settingsLabel}>Currency Symbol</Text>
              {isEditingSettings ? (
                <TextInput
                  style={[styles.settingsInput, { width: 80 }]}
                  value={currInput}
                  onChangeText={setCurrInput}
                />
              ) : (
                <Text style={styles.settingsValue}>{currencySymbol}</Text>
              )}
            </View>
          </View>

          <View style={styles.divider} />

          {isEditingSettings ? (
            <TouchableOpacity style={styles.saveSettingsBtn} onPress={handleSaveSettings}>
              <Check size={16} color="#ffffff" style={{ marginRight: 6 }} />
              <Text style={styles.saveSettingsBtnText}>Save Changes</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.editSettingsBtn}
              onPress={() => setIsEditingSettings(true)}
            >
              <Text style={styles.editSettingsBtnText}>Edit Preferences</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Local Backup & Restore */}
        <Text style={styles.sectionTitle}>Backup & Restore</Text>
        <View style={styles.settingsCard}>
          <View style={styles.settingsRow}>
            <View style={styles.settingsIcon}>
              <ShieldCheck size={18} color="#0c4a6e" />
            </View>
            <View style={styles.settingsInputGroup}>
              <Text style={styles.settingsLabel}>Last Backup</Text>
              <Text style={styles.settingsValue}>
                {lastBackupAt ? formatDbDate(lastBackupAt) : 'Never — create one today'}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <TouchableOpacity
            style={[styles.actionCard, { marginBottom: 10 }, backupBusy && styles.busyCard]}
            onPress={handleCreateBackup}
            disabled={backupBusy}
            activeOpacity={0.7}
          >
            <View style={[styles.actionIconBg, { backgroundColor: '#e0f2fe' }]}>
              <UploadCloud size={20} color="#0c4a6e" />
            </View>
            <View style={styles.actionCardInfo}>
              <Text style={styles.actionCardTitle}>
                {backupBusy ? 'Working…' : 'Create Backup File'}
              </Text>
              <Text style={styles.actionCardDesc}>
                Save every borrower, loan, payment and ledger entry as a JSON file you can keep
                off-device (Drive, email, SD card).
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionCard, backupBusy && styles.busyCard]}
            onPress={handleRestoreBackup}
            disabled={backupBusy}
            activeOpacity={0.7}
          >
            <View style={[styles.actionIconBg, { backgroundColor: '#fee2e2' }]}>
              <Download size={20} color="#b91c1c" />
            </View>
            <View style={styles.actionCardInfo}>
              <Text style={styles.actionCardTitle}>Restore From Backup</Text>
              <Text style={styles.actionCardDesc}>
                Replace current records with a previously exported backup file.
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionCard, { marginTop: 10 }]}
            onPress={() => setVerifyVisible(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.actionIconBg, { backgroundColor: '#e0f2fe' }]}>
              <ClipboardCheck size={20} color="#0c4a6e" />
            </View>
            <View style={styles.actionCardInfo}>
              <Text style={styles.actionCardTitle}>Verify a Receipt</Text>
              <Text style={styles.actionCardDesc}>
                Paste a receipt a borrower received and confirm it was not edited.
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Database Management / Reset Data */}
        <Text style={[styles.sectionTitle, { marginTop: 24, color: '#dc2626' }]}>Data Management</Text>
        <View style={styles.dangerCard}>
          <View style={styles.dangerRow}>
            <View style={styles.dangerIconBg}>
              <Trash2 size={20} color="#dc2626" />
            </View>
            <View style={styles.dangerInfo}>
              <Text style={styles.dangerTitle}>Clear All Data & Reset</Text>
              <Text style={styles.dangerDesc}>
                Permanently erase all loans, borrowers, and entries for a pristine clean slate.
              </Text>
            </View>
          </View>
          <TouchableOpacity style={styles.resetDataBtn} onPress={handleResetData} activeOpacity={0.8}>
            <Trash2 size={16} color="#ffffff" style={{ marginRight: 6 }} />
            <Text style={styles.resetDataBtnText}>Reset Entire Database</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <VerifyReceiptModal
        visible={verifyVisible}
        onClose={() => setVerifyVisible(false)}
        currencySymbol={currencySymbol}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 36,
  },
  header: {
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0c4a6e',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  healthCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  healthHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  healthLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 0.5,
  },
  healthRate: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0284c7',
  },
  healthBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  healthBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0c4a6e',
  },
  progressBarBg: {
    height: 8,
    backgroundColor: '#f1f5f9',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  healthSubtext: {
    fontSize: 12,
    color: '#64748b',
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0c4a6e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  actionCards: {
    gap: 10,
    marginBottom: 24,
  },
  actionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 14,
    minHeight: 64,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  actionIconBg: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  actionCardInfo: {
    flex: 1,
  },
  actionCardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0c4a6e',
  },
  actionCardDesc: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  settingsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  settingsIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#e0f2fe',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  currencyIconText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0284c7',
  },
  settingsInputGroup: {
    flex: 1,
  },
  settingsLabel: {
    fontSize: 11,
    color: '#94a3b8',
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  settingsValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0f172a',
    marginTop: 2,
  },
  settingsInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#0f172a',
    marginTop: 4,
    minHeight: 40,
  },
  divider: {
    height: 1,
    backgroundColor: '#f1f5f9',
    marginVertical: 12,
  },
  editSettingsBtn: {
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
  },
  editSettingsBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0c4a6e',
  },
  saveSettingsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#0284c7',
  },
  saveSettingsBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
  busyCard: {
    opacity: 0.6,
  },
  dangerCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  dangerIconBg: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fee2e2',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  dangerInfo: {
    flex: 1,
  },
  dangerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#991b1b',
  },
  dangerDesc: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  resetDataBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#dc2626',
  },
  resetDataBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
});
