import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Phone, ChevronRight, AlertCircle, CheckCircle2 } from 'lucide-react-native';
import { Borrower } from '../db/types';
import { formatCurrency } from '../utils/financial';

interface BorrowerCardProps {
  borrower: Borrower;
  /** Receives the borrower so the parent can pass one stable callback (memo-friendly). */
  onPress: (borrower: Borrower) => void;
  currencySymbol?: string;
}

const BorrowerCardBase: React.FC<BorrowerCardProps> = ({
  borrower,
  onPress,
  currencySymbol = '₱',
}) => {
  const getInitials = (name: string) => {
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  const hasDebt = (borrower.totalOutstanding || 0) > 0;
  const isOverdue = borrower.hasOverdue;

  return (
    <TouchableOpacity
      style={[
        styles.card,
        isOverdue ? styles.cardOverdue : hasDebt ? styles.cardActive : styles.cardSettled,
      ]}
      onPress={() => onPress(borrower)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Borrower ${borrower.fullName}, balance ${borrower.totalOutstanding || 0}`}
    >
      <View style={styles.contentRow}>
        {/* Avatar */}
        <View
          style={[
            styles.avatar,
            isOverdue
              ? styles.avatarOverdue
              : hasDebt
              ? styles.avatarActive
              : styles.avatarSettled,
          ]}
        >
          <Text
            style={[
              styles.avatarText,
              isOverdue
                ? styles.textOverdue
                : hasDebt
                ? styles.textActive
                : styles.textSettled,
            ]}
          >
            {getInitials(borrower.fullName)}
          </Text>
        </View>

        {/* Info */}
        <View style={styles.infoCol}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
              {borrower.fullName}
            </Text>
            <View style={styles.categoryBadge}>
              <Text style={styles.categoryText} numberOfLines={1}>
                {borrower.categoryTag}
              </Text>
            </View>
          </View>

          <View style={styles.phoneRow}>
            <Phone size={12} color="#64748b" style={styles.phoneIcon} />
            <Text style={styles.phoneText} numberOfLines={1}>
              {borrower.phoneNumber}
            </Text>
          </View>
        </View>

        {/* Financial Status */}
        <View style={styles.rightCol}>
          {hasDebt ? (
            <>
              <Text style={styles.balanceLabel}>Balance</Text>
              <Text
                style={[
                  styles.balanceAmount,
                  isOverdue ? styles.balanceOverdue : styles.balanceActive,
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {formatCurrency(borrower.totalOutstanding || 0, currencySymbol)}
              </Text>
              {isOverdue && (
                <View style={styles.overdueTag}>
                  <AlertCircle size={10} color="#dc2626" />
                  <Text style={styles.overdueText}>Overdue</Text>
                </View>
              )}
            </>
          ) : (
            <View style={styles.settledTag}>
              <CheckCircle2 size={12} color="#0284c7" />
              <Text style={styles.settledText}>Cleared</Text>
            </View>
          )}
        </View>

        <ChevronRight size={18} color="#94a3b8" style={{ marginLeft: 4 }} />
      </View>
    </TouchableOpacity>
  );
};

/**
 * Memoized so scrolling/typing does not re-render every card in the directory —
 * the parent passes a stable `onPress` and a memoized borrower object.
 */
export const BorrowerCard = React.memo(BorrowerCardBase);
BorrowerCard.displayName = 'BorrowerCard';

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1.5,
    borderColor: '#e0f2fe',
    shadowColor: '#0c4a6e',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    minHeight: 72,
    justifyContent: 'center',
  },
  cardOverdue: {
    borderColor: '#fca5a5',
    backgroundColor: '#fffcfc',
  },
  cardActive: {
    borderColor: '#bae6fd',
    backgroundColor: '#ffffff',
  },
  cardSettled: {
    borderColor: '#f1f5f9',
    backgroundColor: '#fafbfc',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarActive: {
    backgroundColor: '#e0f2fe',
  },
  avatarOverdue: {
    backgroundColor: '#fee2e2',
  },
  avatarSettled: {
    backgroundColor: '#f1f5f9',
  },
  avatarText: {
    fontSize: 15,
    fontWeight: '800',
  },
  textActive: {
    color: '#0284c7',
  },
  textOverdue: {
    color: '#dc2626',
  },
  textSettled: {
    color: '#64748b',
  },
  infoCol: {
    flex: 1,
    marginRight: 8,
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    flexShrink: 1,
  },
  categoryBadge: {
    backgroundColor: '#f0f9ff',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e0f2fe',
    flexShrink: 0,
  },
  categoryText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0369a1',
  },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  phoneIcon: {
    marginRight: 4,
  },
  phoneText: {
    fontSize: 12,
    color: '#64748b',
    flexShrink: 1,
  },
  rightCol: {
    alignItems: 'flex-end',
    minWidth: 70,
    maxWidth: 95,
    flexShrink: 0,
  },
  balanceLabel: {
    fontSize: 10,
    color: '#94a3b8',
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  balanceAmount: {
    fontSize: 14,
    fontWeight: '800',
  },
  balanceActive: {
    color: '#0c4a6e',
  },
  balanceOverdue: {
    color: '#dc2626',
  },
  overdueTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fee2e2',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    gap: 3,
    marginTop: 2,
  },
  overdueText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#b91c1c',
  },
  settledTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    gap: 4,
  },
  settledText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0284c7',
  },
});
