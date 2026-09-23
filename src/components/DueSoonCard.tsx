import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Share } from 'react-native';
import { BellRing, CalendarClock, ChevronRight, MessageSquare } from 'lucide-react-native';
import type { DueItem } from '../db/repositories/reportsRepo';
import { formatCurrency, formatDbDate } from '../utils/financial';
import {
  buildBulkReminderMessage,
  buildReminderMessage,
  chooseReminderChannel,
} from '../utils/reminders';

interface DueSoonCardProps {
  items: DueItem[];
  orgName: string;
  currencySymbol: string;
  onOpenBorrower?: (borrowerId: string) => void;
}

/**
 * Who owes what, right now.
 *
 * Shows every unpaid installment that is due within the week *or already late* (oldest first),
 * with a one-tap reminder that opens the treasurer's own SMS/WhatsApp composer. Nothing is sent
 * without them pressing send, and no phone number leaves the device through a third party.
 */
export const DueSoonCard: React.FC<DueSoonCardProps> = React.memo(
  ({ items, orgName, currencySymbol, onOpenBorrower }) => {
    const overdue = items.filter((i) => i.daysLate > 0);
    const totalDue = items.reduce((sum, i) => sum + i.amountDue, 0);

    const remind = (item: DueItem) => {
      chooseReminderChannel(
        item.borrowerPhone,
        buildReminderMessage({
          borrowerName: item.borrowerName,
          orgName,
          amountDue: item.amountDue,
          dueDate: item.dueDate,
          daysLate: item.daysLate,
          currencySymbol,
        })
      );
    };

    const remindAll = () => {
      const message = buildBulkReminderMessage(
        items.map((i) => ({
          borrowerName: i.borrowerName,
          amountDue: i.amountDue,
          dueDate: i.dueDate,
          daysLate: i.daysLate,
        })),
        orgName,
        currencySymbol
      );
      void Share.share({ message });
    };

    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <View style={[styles.headerIcon, overdue.length > 0 && styles.headerIconAlert]}>
            <BellRing size={18} color={overdue.length > 0 ? '#b45309' : '#0284c7'} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Due &amp; overdue</Text>
            <Text style={styles.subtitle}>
              {items.length === 0
                ? 'Nothing due in the next 7 days.'
                : `${items.length} installment${items.length === 1 ? '' : 's'} · ${formatCurrency(totalDue, currencySymbol)}${overdue.length > 0 ? ` · ${overdue.length} late` : ''}`}
            </Text>
          </View>
          {items.length > 1 ? (
            <TouchableOpacity style={styles.allBtn} onPress={remindAll} activeOpacity={0.8}>
              <Text style={styles.allBtnText}>Remind all</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {items.length === 0 ? (
          <Text style={styles.emptyText}>Every scheduled payment is up to date.</Text>
        ) : (
          items.slice(0, 6).map((item) => (
            <View key={item.scheduleId} style={styles.row}>
              <TouchableOpacity
                style={styles.rowMain}
                onPress={() => onOpenBorrower?.(item.borrowerId)}
                activeOpacity={0.7}
                disabled={!onOpenBorrower}
              >
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.borrowerName}
                  </Text>
                  <View style={styles.metaRow}>
                    <CalendarClock size={12} color="#94a3b8" />
                    <Text style={styles.meta}>
                      {formatDbDate(item.dueDate)}
                      {item.daysLate > 0
                        ? ` · ${item.daysLate} day${item.daysLate === 1 ? '' : 's'} late`
                        : ' · due soon'}
                    </Text>
                  </View>
                </View>
                <Text
                  style={[styles.amount, item.daysLate > 0 ? styles.amountLate : styles.amountSoon]}
                >
                  {formatCurrency(item.amountDue, currencySymbol)}
                </Text>
                {onOpenBorrower ? <ChevronRight size={16} color="#cbd5e1" /> : null}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.remindBtn}
                onPress={() => remind(item)}
                activeOpacity={0.8}
                accessibilityLabel={`Send a payment reminder to ${item.borrowerName}`}
              >
                <MessageSquare size={15} color="#0284c7" />
              </TouchableOpacity>
            </View>
          ))
        )}

        {items.length > 6 ? (
          <Text style={styles.moreText}>+{items.length - 6} more not shown</Text>
        ) : null}
      </View>
    );
  }
);

DueSoonCard.displayName = 'DueSoonCard';

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
    marginBottom: 10,
  },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerIconAlert: {
    backgroundColor: '#fffbeb',
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
  allBtn: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  allBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0284c7',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 56,
    paddingRight: 8,
  },
  rowText: {
    flex: 1,
  },
  name: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
  },
  meta: {
    fontSize: 11,
    color: '#64748b',
  },
  amount: {
    fontSize: 13,
    fontWeight: '800',
  },
  amountLate: {
    color: '#dc2626',
  },
  amountSoon: {
    color: '#0284c7',
  },
  remindBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 12,
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  moreText: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 8,
  },
});

