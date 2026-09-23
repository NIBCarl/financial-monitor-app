import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { X, Plus, Trash2, Percent, Banknote, ShieldCheck } from 'lucide-react-native';
import { Loan, PenaltyBasis, PenaltyPeriod, PenaltyRule, PenaltyScope } from '../db/types';
import { penaltyRepo } from '../db/repositories/penaltyRepo';
import { describePenaltyRule } from '../utils/penalties';
import { formatCurrency, formatDatePretty } from '../utils/financial';
import { parsePositiveMoney, round2 } from '../utils/validation';
import { ConfirmReasonModal } from './ConfirmReasonModal';

interface PenaltyRulesModalProps {
  visible: boolean;
  borrowerId: string;
  borrowerName: string;
  loans: Loan[];
  onClose: () => void;
  /** Fired after any rule is created or waived so the profile can refresh its figures. */
  onChanged: () => void;
  currencySymbol?: string;
}

const PERIOD_OPTIONS: { label: string; value: PenaltyPeriod }[] = [
  { label: 'Per day late', value: 'DAY' },
  { label: 'Per week late', value: 'WEEK' },
  { label: 'Per month late', value: 'MONTH' },
];

/**
 * Where penalty rules are configured.
 *
 * One rule shape covers both arrangements the treasurer asked for: a rule can apply to a borrower's
 * whole account ("2% per month on anything overdue") or to a single loan. Rules are never applied
 * silently — the profile previews the amount and asks for confirmation before anything is recorded.
 */
export const PenaltyRulesModal: React.FC<PenaltyRulesModalProps> = ({
  visible,
  borrowerId,
  borrowerName,
  loans,
  onClose,
  onChanged,
  currencySymbol = '₱',
}) => {
  const [rules, setRules] = useState<PenaltyRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [scope, setScope] = useState<PenaltyScope>('BORROWER');
  const [loanId, setLoanId] = useState<string | null>(null);
  const [basis, setBasis] = useState<PenaltyBasis>('PERCENT');
  const [amountStr, setAmountStr] = useState('2');
  const [period, setPeriod] = useState<PenaltyPeriod>('MONTH');
  const [graceStr, setGraceStr] = useState('0');
  const [capStr, setCapStr] = useState('');
  const [reason, setReason] = useState('');

  const [waiveTarget, setWaiveTarget] = useState<PenaltyRule | null>(null);

  const loadRules = useCallback(async () => {
    try {
      setLoading(true);
      setRules(await penaltyRepo.getAllRulesForBorrower(borrowerId));
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not load penalty rules.');
    } finally {
      setLoading(false);
    }
  }, [borrowerId]);

  useEffect(() => {
    if (!visible) return;

    // Deferred one microtask so the spinner state is never set synchronously inside the effect.
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      try {
        setLoading(true);
        const rows = await penaltyRepo.getAllRulesForBorrower(borrowerId);
        if (active) setRules(rows);
      } catch (err) {
        if (active) {
          Alert.alert('Error', err instanceof Error ? err.message : 'Could not load penalty rules.');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [visible, borrowerId]);

  const resetForm = () => {
    setScope('BORROWER');
    setLoanId(null);
    setBasis('PERCENT');
    setAmountStr('2');
    setPeriod('MONTH');
    setGraceStr('0');
    setCapStr('');
    setReason('');
  };

  /** Resolves the entered figure, reporting the problem itself so callers stay flat. */
  const resolveAmount = (): number | null => {
    if (basis === 'PERCENT') {
      const percent = Number(amountStr.replace(/[,%\s]/g, ''));
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        Alert.alert('Invalid Rate', 'Enter a percentage greater than 0 and no more than 100.');
        return null;
      }
      return round2(percent);
    }

    const parsed = parsePositiveMoney(amountStr);
    if (!parsed.ok) {
      Alert.alert('Invalid Amount', parsed.error);
      return null;
    }
    return parsed.value;
  };

  const handleAdd = async () => {
    if (scope === 'LOAN' && !loanId) {
      Alert.alert('Select a Loan', 'Choose which loan this rule applies to.');
      return;
    }

    const ruleAmount = resolveAmount();
    if (ruleAmount === null) return;

    const graceDays = Number(graceStr.replace(/[^\d]/g, '') || '0');
    if (!Number.isFinite(graceDays) || graceDays < 0) {
      Alert.alert('Invalid Grace Period', 'Grace days must be zero or more.');
      return;
    }

    let capAmount: number | null = null;
    if (capStr.trim().length > 0) {
      const parsedCap = parsePositiveMoney(capStr);
      if (!parsedCap.ok) {
        Alert.alert('Invalid Cap', parsedCap.error);
        return;
      }
      capAmount = parsedCap.value;
    }

    try {
      setSaving(true);
      await penaltyRepo.createRule({
        scope,
        borrowerId,
        loanId: scope === 'LOAN' ? loanId : null,
        basis,
        amount: ruleAmount,
        period,
        graceDays,
        capAmount,
        reason: reason.trim() || undefined,
      });

      resetForm();
      await loadRules();
      onChanged();
      Alert.alert('Rule Saved', 'The penalty rule now applies to future assessments.');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not save the rule.');
    } finally {
      setSaving(false);
    }
  };

  const activeRules = rules.filter((r) => !r.waivedAt);
  const waivedRules = rules.filter((r) => r.waivedAt);

  /** Rules are labelled by what the treasurer recognises — the amount — not by an internal id. */
  const loanLabel = (rule: PenaltyRule): string => {
    if (rule.scope !== 'LOAN') return 'Whole account';
    const loan = loans.find((l) => l.id === rule.loanId);
    return loan
      ? `Loan of ${formatCurrency(Number(loan.principalAmount ?? 0), currencySymbol)}`
      : 'One loan';
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Penalty Rules</Text>
              <Text style={styles.subtitle}>{borrowerName}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityLabel="Close">
              <X size={20} color="#64748b" />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 24 }}>
            <Text style={styles.sectionTitle}>Active rules</Text>
            {loading ? (
              <ActivityIndicator color="#0284c7" style={{ marginVertical: 16 }} />
            ) : activeRules.length === 0 ? (
              <View style={styles.emptyBox}>
                <ShieldCheck size={18} color="#0f766e" />
                <Text style={styles.emptyText}>
                  No penalty rules yet — {borrowerName} is never charged a penalty until you add one.
                </Text>
              </View>
            ) : (
              activeRules.map((rule) => (
                <View key={rule.id} style={styles.ruleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.ruleText}>{describePenaltyRule(rule, currencySymbol)}</Text>
                    <Text style={styles.ruleMeta}>
                      {loanLabel(rule)} • added {formatDatePretty(rule.createdAt.slice(0, 10))}
                    </Text>
                    {rule.reason ? <Text style={styles.ruleReason}>“{rule.reason}”</Text> : null}
                  </View>
                  <TouchableOpacity
                    onPress={() => setWaiveTarget(rule)}
                    style={styles.waiveButton}
                    accessibilityLabel="Waive this rule"
                  >
                    <Trash2 size={15} color="#b91c1c" />
                    <Text style={styles.waiveText}>Waive</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}

            {waivedRules.length > 0 ? (
              <>
                <Text style={styles.sectionTitle}>Waived rules</Text>
                {waivedRules.map((rule) => (
                  <View key={rule.id} style={styles.waivedRow}>
                    <Text style={styles.waivedText}>
                      {describePenaltyRule(rule, currencySymbol)} — {loanLabel(rule)}
                    </Text>
                    <Text style={styles.ruleMeta}>
                      {rule.waivedAt ? `Waived ${formatDatePretty(rule.waivedAt.slice(0, 10))}` : ''}
                      {rule.waivedReason ? ` • ${rule.waivedReason}` : ''}
                    </Text>
                  </View>
                ))}
              </>
            ) : null}

            <Text style={styles.sectionTitle}>Add a rule</Text>
            <Text style={styles.label}>Applies to</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity
                onPress={() => setScope('BORROWER')}
                style={[styles.chip, scope === 'BORROWER' && styles.chipActive]}
              >
                <Text style={[styles.chipText, scope === 'BORROWER' && styles.chipTextActive]}>
                  Whole account
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setScope('LOAN')}
                style={[styles.chip, scope === 'LOAN' && styles.chipActive]}
              >
                <Text style={[styles.chipText, scope === 'LOAN' && styles.chipTextActive]}>
                  One loan
                </Text>
              </TouchableOpacity>
            </View>

            {scope === 'LOAN' ? (
              loans.length === 0 ? (
                <Text style={styles.hintText}>This borrower has no loans to attach a rule to.</Text>
              ) : (
                <View style={styles.loanList}>
                  {loans.map((loan) => (
                    <TouchableOpacity
                      key={loan.id}
                      onPress={() => setLoanId(loan.id)}
                      style={[styles.loanOption, loanId === loan.id && styles.loanOptionActive]}
                    >
                      <Text
                        style={[
                          styles.loanOptionText,
                          loanId === loan.id && styles.loanOptionTextActive,
                        ]}
                      >
                        {formatCurrency(Number(loan.principalAmount ?? 0), currencySymbol)} •{' '}
                        {loan.status === 'SETTLED' ? 'settled' : 'active'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )
            ) : null}

            <Text style={styles.label}>Charge type</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity
                onPress={() => {
                  setBasis('PERCENT');
                  setAmountStr('2');
                }}
                style={[styles.chip, basis === 'PERCENT' && styles.chipActive]}
              >
                <Percent size={13} color={basis === 'PERCENT' ? '#ffffff' : '#0369a1'} />
                <Text style={[styles.chipText, basis === 'PERCENT' && styles.chipTextActive]}>
                  Percent
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setBasis('FLAT');
                  setAmountStr('50');
                }}
                style={[styles.chip, basis === 'FLAT' && styles.chipActive]}
              >
                <Banknote size={13} color={basis === 'FLAT' ? '#ffffff' : '#0369a1'} />
                <Text style={[styles.chipText, basis === 'FLAT' && styles.chipTextActive]}>
                  Fixed amount
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>
              {basis === 'PERCENT'
                ? 'Rate (% of the overdue installment)'
                : `Amount (${currencySymbol})`}
            </Text>
            <TextInput
              value={amountStr}
              onChangeText={setAmountStr}
              keyboardType="numeric"
              placeholder={basis === 'PERCENT' ? '2' : '50.00'}
              placeholderTextColor="#94a3b8"
              style={styles.input}
            />

            <Text style={styles.label}>Charged</Text>
            <View style={styles.chipRow}>
              {PERIOD_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.value}
                  onPress={() => setPeriod(option.value)}
                  style={[styles.chip, period === option.value && styles.chipActive]}
                >
                  <Text style={[styles.chipText, period === option.value && styles.chipTextActive]}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.twoColumn}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Grace days</Text>
                <TextInput
                  value={graceStr}
                  onChangeText={setGraceStr}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor="#94a3b8"
                  style={styles.input}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Cap ({currencySymbol}, optional)</Text>
                <TextInput
                  value={capStr}
                  onChangeText={setCapStr}
                  keyboardType="numeric"
                  placeholder="No cap"
                  placeholderTextColor="#94a3b8"
                  style={styles.input}
                />
              </View>
            </View>

            <Text style={styles.label}>Note (recorded in the audit log)</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. agreed with the borrower on 12 Jan"
              placeholderTextColor="#94a3b8"
              style={styles.input}
            />

            <TouchableOpacity
              onPress={() => void handleAdd()}
              disabled={saving}
              style={[styles.addButton, saving && styles.addButtonDisabled]}
            >
              {saving ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <>
                  <Plus size={16} color="#ffffff" />
                  <Text style={styles.addButtonText}>Save rule</Text>
                </>
              )}
            </TouchableOpacity>

            <Text style={styles.footnote}>
              Rules only describe the arrangement. Nothing is charged to {borrowerName} until you
              assess penalties on their profile and confirm the amount shown.
            </Text>



          </ScrollView>
        </View>
      </View>

      <ConfirmReasonModal
        visible={waiveTarget !== null}
        title="Waive this rule?"
        message={
          waiveTarget
            ? `“${describePenaltyRule(waiveTarget, currencySymbol)}” will stop applying. Penalties already assessed stay on the account until you waive them individually.`
            : ''
        }
        confirmLabel="Waive rule"
        destructive
        reasonLabel="Reason for waiving (required)"
        onCancel={() => setWaiveTarget(null)}
        onConfirm={async (why) => {
          if (!waiveTarget) return;
          await penaltyRepo.waiveRule(waiveTarget.id, why);
          setWaiveTarget(null);
          await loadRules();
          onChanged();
        }}
      />
    </Modal>
  );
};


const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '92%',
    paddingBottom: Platform.OS === 'ios' ? 20 : 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
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
  body: {
    paddingHorizontal: 18,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0369a1',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 18,
    marginBottom: 8,
  },
  emptyBox: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    backgroundColor: '#f0fdfa',
    borderWidth: 1,
    borderColor: '#99f6e4',
    borderRadius: 10,
    padding: 12,
  },
  emptyText: {
    flex: 1,
    fontSize: 12,
    color: '#0f766e',
    lineHeight: 17,
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  ruleText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  ruleMeta: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  ruleReason: {
    fontSize: 11,
    color: '#475569',
    fontStyle: 'italic',
    marginTop: 2,
  },
  waiveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  waiveText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#b91c1c',
  },
  waivedRow: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    opacity: 0.7,
  },
  waivedText: {
    fontSize: 12,
    color: '#64748b',
    textDecorationLine: 'line-through',
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginTop: 14,
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  chipActive: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0369a1',
  },
  chipTextActive: {
    color: '#ffffff',
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
    backgroundColor: '#ffffff',
  },
  twoColumn: {
    flexDirection: 'row',
    gap: 12,
  },
  loanList: {
    gap: 6,
    marginTop: 8,
  },
  loanOption: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  loanOptionActive: {
    borderColor: '#0284c7',
    backgroundColor: '#e0f2fe',
  },
  loanOptionText: {
    fontSize: 13,
    color: '#334155',
  },
  loanOptionTextActive: {
    fontWeight: '700',
    color: '#0c4a6e',
  },
  hintText: {
    fontSize: 12,
    color: '#b45309',
    marginTop: 8,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0284c7',
    borderRadius: 12,
    paddingVertical: 13,
    marginTop: 20,
  },
  addButtonDisabled: {
    backgroundColor: '#7dd3fc',
  },
  addButtonText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
  },
  footnote: {
    fontSize: 11,
    color: '#64748b',
    lineHeight: 16,
    marginTop: 12,
  },
});

export default PenaltyRulesModal;

