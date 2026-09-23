import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Activity, CalendarClock, TrendingUp } from 'lucide-react-native';
import type { AgingRow, ForecastRow, PortfolioRisk } from '../db/repositories/reportsRepo';
import { formatCurrency } from '../utils/financial';

interface PortfolioHealthCardProps {
  aging: AgingRow[];
  risk: PortfolioRisk;
  forecast: ForecastRow[];
  currencySymbol: string;
}

const BUCKET_LABEL: Record<string, string> = {
  DUE_SOON: 'Due within 7 days',
  CURRENT: 'Due later',
  '1-30': '1–30 days late',
  '31-60': '31–60 days late',
  '61-90': '61–90 days late',
  '90+': 'Over 90 days late',
};

/** Buckets that represent money already behind — everything else is pipeline, not arrears. */
const ARREARS_BUCKETS = ['1-30', '31-60', '61-90', '90+'];

function severityColor(bucket: string): string {
  switch (bucket) {
    case '1-30':
      return '#f59e0b';
    case '31-60':
      return '#ea580c';
    case '61-90':
      return '#dc2626';
    case '90+':
      return '#991b1b';
    default:
      return '#0284c7';
  }
}

function formatPeriod(period: string): string {
  const [year, month] = period.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(date.getTime())) return period;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/**
 * Aging schedule, portfolio at risk and expected collections.
 *
 * The aging bars are scaled against the largest bucket rather than the total, so a young
 * arrears book still shows its shape instead of one full-width bar and five slivers.
 */
export const PortfolioHealthCard: React.FC<PortfolioHealthCardProps> = React.memo(
  ({ aging, risk, forecast, currencySymbol }) => {
    const arrears = aging.filter((a) => ARREARS_BUCKETS.includes(a.bucket));
    const arrearsTotal = arrears.reduce((sum, a) => sum + a.amount, 0);
    const maxAmount = Math.max(1, ...aging.map((a) => a.amount));
    const parIsHealthy = risk.parPercent < 5;

    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <View style={styles.headerIcon}>
            <Activity size={18} color="#0284c7" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Portfolio health</Text>
            <Text style={styles.subtitle}>
              {risk.activeLoanCount} active {risk.activeLoanCount === 1 ? 'loan' : 'loans'} ·{' '}
              {formatCurrency(risk.totalOutstanding, currencySymbol)} outstanding
            </Text>
          </View>
        </View>

        <View style={[styles.parBox, parIsHealthy ? styles.parBoxHealthy : styles.parBoxRisk]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.parLabel}>Portfolio at risk</Text>
            <Text
              style={[styles.parValue, parIsHealthy ? styles.parValueHealthy : styles.parValueRisk]}
            >
              {risk.parPercent.toFixed(1)}%
            </Text>
            <Text style={styles.parHint}>
              {risk.atRiskLoanCount === 0
                ? 'Nothing is behind schedule.'
                : `${formatCurrency(risk.atRiskAmount, currencySymbol)} across ${risk.atRiskLoanCount} ${risk.atRiskLoanCount === 1 ? 'loan' : 'loans'} behind schedule.`}
            </Text>
          </View>
        </View>

        <Text style={styles.blockTitle}>Aging of unpaid installments</Text>
        {aging.map((row) => (
          <View key={row.bucket} style={styles.agingRow}>
            <Text style={styles.agingLabel} numberOfLines={1}>
              {BUCKET_LABEL[row.bucket] ?? row.bucket}
            </Text>
            <View style={styles.agingBarTrack}>
              <View
                style={[
                  styles.agingBarFill,
                  {
                    width: `${Math.max(row.amount > 0 ? 4 : 0, (row.amount / maxAmount) * 100)}%`,
                    backgroundColor: severityColor(row.bucket),
                  },
                ]}
              />
            </View>
            <View style={styles.agingAmounts}>
              <Text style={styles.agingAmount}>{formatCurrency(row.amount, currencySymbol)}</Text>
              <Text style={styles.agingCount}>{row.installmentCount} inst.</Text>
            </View>
          </View>
        ))}

        <View style={styles.arrearsTotalRow}>
          <Text style={styles.arrearsTotalLabel}>Total arrears</Text>
          <Text
            style={[styles.arrearsTotalValue, { color: arrearsTotal > 0 ? '#dc2626' : '#047857' }]}
          >
            {formatCurrency(arrearsTotal, currencySymbol)}
          </Text>
        </View>

        <View style={styles.forecastHeader}>
          <TrendingUp size={14} color="#0c4a6e" />
          <Text style={styles.blockTitle}>Expected collections</Text>
        </View>
        {forecast.length === 0 ? (
          <Text style={styles.emptyText}>No scheduled collections yet.</Text>
        ) : (
          forecast.map((row) => (
            <View key={row.period} style={styles.forecastRow}>
              <CalendarClock size={15} color="#94a3b8" />
              <Text style={styles.forecastPeriod}>{formatPeriod(row.period)}</Text>
              <Text style={styles.forecastCount}>{row.installmentCount} inst.</Text>
              <Text style={styles.forecastAmount}>
                {formatCurrency(row.expected, currencySymbol)}
              </Text>
            </View>
          ))
        )}
        <Text style={styles.footnote}>
          Scheduled amounts only. Overdue balances are not added to these months.
        </Text>
      </View>
    );
  }
);

PortfolioHealthCard.displayName = 'PortfolioHealthCard';

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
    marginBottom: 12,
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
  parBox: {
    borderRadius: 12,
    borderWidth: 1.5,
    padding: 12,
    marginBottom: 14,
  },
  parBoxHealthy: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
  },
  parBoxRisk: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  parLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  parValue: {
    fontSize: 24,
    fontWeight: '900',
    marginTop: 2,
  },
  parValueHealthy: {
    color: '#047857',
  },
  parValueRisk: {
    color: '#dc2626',
  },
  parHint: {
    fontSize: 11,
    color: '#475569',
    marginTop: 4,
  },
  blockTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0c4a6e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  agingRow: {
    marginBottom: 8,
  },
  agingBarTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#f1f5f9',
    marginTop: 4,
    overflow: 'hidden',
  },
  agingBarFill: {
    height: 8,
    borderRadius: 4,
  },
  agingLabel: {
    fontSize: 12,
    color: '#334155',
    fontWeight: '600',
  },
  agingAmounts: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 3,
  },
  agingAmount: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
  },
  agingCount: {
    fontSize: 11,
    color: '#94a3b8',
  },
  arrearsTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1.5,
    borderTopColor: '#e2e8f0',
    paddingTop: 10,
    marginTop: 4,
  },
  arrearsTotalLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  arrearsTotalValue: {
    fontSize: 16,
    fontWeight: '900',
  },
  forecastHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 18,
  },
  forecastRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  forecastPeriod: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
  },
  forecastCount: {
    fontSize: 11,
    color: '#94a3b8',
    marginRight: 8,
  },
  forecastAmount: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0284c7',
  },
  emptyText: {
    fontSize: 12,
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  footnote: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 10,
    lineHeight: 14,
  },
});

