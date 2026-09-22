import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface MetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  subtitle,
  icon,
  variant = 'default',
}) => {
  const getBadgeStyle = () => {
    switch (variant) {
      case 'success':
        return { bg: '#f0f9ff', border: '#bae6fd', text: '#0284c7', valColor: '#0284c7' };
      case 'warning':
        return { bg: '#fffbeb', border: '#fde68a', text: '#d97706', valColor: '#b45309' };
      case 'danger':
        return { bg: '#fef2f2', border: '#fecaca', text: '#dc2626', valColor: '#dc2626' };
      default:
        return { bg: '#f0f9ff', border: '#e0f2fe', text: '#0c4a6e', valColor: '#0c4a6e' };
    }
  };

  const style = getBadgeStyle();

  return (
    <View style={[styles.card, { borderColor: style.border }]}>
      <View style={styles.topRow}>
        <View style={styles.titleWrapper}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
        </View>
        <View style={[styles.iconContainer, { backgroundColor: style.bg }]}>
          {icon}
        </View>
      </View>
      <View style={styles.bottomContent}>
        <Text style={[styles.value, { color: style.valColor }]} numberOfLines={1}>
          {value}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1.5,
    shadowColor: '#0c4a6e',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
    flex: 1,
    minHeight: 118,
    justifyContent: 'space-between',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  titleWrapper: {
    flex: 1,
    marginRight: 8,
    height: 32,
    justifyContent: 'center',
  },
  title: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    lineHeight: 15,
  },
  iconContainer: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bottomContent: {
    marginTop: 'auto',
  },
  value: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
    fontWeight: '500',
  },
});
