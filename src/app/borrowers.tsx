import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  StatusBar,
  RefreshControl,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, UserPlus, X } from 'lucide-react-native';
import { BorrowerCard } from '../components/BorrowerCard';
import { AddBorrowerModal } from '../components/AddBorrowerModal';
import { BorrowerDetailModal } from '../components/BorrowerDetailModal';
import { borrowerRepo } from '../db/repositories/borrowerRepo';
import { Borrower } from '../db/types';
import { useAppStore } from '../stores/useAppStore';
import { useDebouncedValue } from '../hooks/use-debounced-value';

export default function BorrowersScreen() {
  const { currencySymbol, organizationName, refreshKey, triggerRefresh } = useAppStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [borrowers, setBorrowers] = useState<Borrower[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // Debounced so typing does not run a SQLite query + full list re-render per keystroke.
  const debouncedQuery = useDebouncedValue(searchQuery);

  // Modals
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [selectedBorrower, setSelectedBorrower] = useState<Borrower | null>(null);

  const loadBorrowers = useCallback(async () => {
    try {
      const data = await borrowerRepo.getAll(debouncedQuery, filterStatus);
      setBorrowers(data);
    } catch (err) {
      console.error('Failed to load borrowers:', err);
    }
  }, [debouncedQuery, filterStatus]);

  useEffect(() => {
    loadBorrowers();
  }, [loadBorrowers, refreshKey]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadBorrowers();
    setRefreshing(false);
  };

  // Stable callback keeps every memoized BorrowerCard from re-rendering on scroll.
  const handleBorrowerPress = useCallback((borrower: Borrower) => {
    setSelectedBorrower(borrower);
    setDetailModalVisible(true);
  }, []);

  const keyExtractor = useCallback((item: Borrower) => item.id, []);

  const renderBorrower = useCallback(
    ({ item }: { item: Borrower }) => (
      <BorrowerCard borrower={item} onPress={handleBorrowerPress} currencySymbol={currencySymbol} />
    ),
    [handleBorrowerPress, currencySymbol]
  );

  const handleNewBorrowerSuccess = async (newId: string) => {
    setAddModalVisible(false);
    triggerRefresh();
    const created = await borrowerRepo.getById(newId);
    if (created) {
      setSelectedBorrower(created);
      setDetailModalVisible(true);
    }
  };

  const filterTabs = [
    { label: 'All', value: 'ALL' },
    { label: 'Active Loans', value: 'ACTIVE' },
    { label: 'Overdue', value: 'OVERDUE' },
    { label: 'Cleared', value: 'CLEARED' },
  ];

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
              Borrower Directory
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {borrowers.length} registered {borrowers.length === 1 ? 'borrower' : 'borrowers'}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => setAddModalVisible(true)}
            activeOpacity={0.8}
          >
            <UserPlus size={16} color="#ffffff" style={{ marginRight: 6 }} />
            <Text style={styles.addBtnText}>Add Profile</Text>
          </TouchableOpacity>
        </View>

        {/* Search Bar */}
        <View style={styles.searchContainer}>
          <Search size={16} color="#94a3b8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name, phone, or tag..."
            placeholderTextColor="#94a3b8"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery !== '' && (
            <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearBtn}>
              <X size={14} color="#64748b" />
            </TouchableOpacity>
          )}
        </View>

        {/* Filter Chips */}
        <View style={styles.filterChipsRow}>
          {filterTabs.map((t) => (
            <TouchableOpacity
              key={t.value}
              style={[styles.filterChip, filterStatus === t.value && styles.filterChipActive]}
              onPress={() => setFilterStatus(t.value)}
            >
              <Text
                style={[
                  styles.filterChipText,
                  filterStatus === t.value && styles.filterChipTextActive,
                ]}
              >
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Borrower List */}
        <FlatList
          data={borrowers}
          keyExtractor={keyExtractor}
          renderItem={renderBorrower}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#0284c7']} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Image
                source={require('../../assets/images/empty-ledger.png')}
                style={styles.emptyImage}
                resizeMode="contain"
              />
              <Text style={styles.emptyTitle}>
                {searchQuery ? 'No Results Found' : 'Clean & Ready Ledger'}
              </Text>
              <Text style={styles.emptyDesc}>
                {searchQuery
                  ? 'No borrower matches your search filter.'
                  : 'All records are in order. Tap below to register your first borrower.'}
              </Text>
              <TouchableOpacity
                style={styles.emptyAddBtn}
                onPress={() => setAddModalVisible(true)}
              >
                <Text style={styles.emptyAddBtnText}>+ Add Borrower Profile</Text>
              </TouchableOpacity>
            </View>
          }
        />
      </View>

      {/* Add Borrower Modal */}
      <AddBorrowerModal
        visible={addModalVisible}
        onClose={() => setAddModalVisible(false)}
        onSuccess={handleNewBorrowerSuccess}
      />

      {/* Borrower Detail Modal */}
      <BorrowerDetailModal
        visible={detailModalVisible}
        borrower={selectedBorrower}
        onClose={() => setDetailModalVisible(false)}
        onDataChanged={triggerRefresh}
        currencySymbol={currencySymbol}
        orgName={organizationName}
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    backgroundColor: '#ffffff',
  },
  headerLeft: {
    flex: 1,
    marginRight: 10,
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
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0284c7',
    paddingHorizontal: 14,
    minHeight: 44,
    borderRadius: 12,
    flexShrink: 0,
    shadowColor: '#0284c7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  addBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 8,
    paddingHorizontal: 14,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e0f2fe',
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#0f172a',
  },
  clearBtn: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterChipsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 10,
  },
  filterChip: {
    paddingHorizontal: 14,
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 20,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  filterChipActive: {
    backgroundColor: '#0c4a6e',
    borderColor: '#0c4a6e',
  },
  filterChipText: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 36,
    paddingHorizontal: 20,
  },
  emptyImage: {
    width: 190,
    height: 129,
    marginBottom: 10,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  emptyDesc: {
    fontSize: 14,
    color: '#334155',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 18,
    maxWidth: 270,
    lineHeight: 20,
  },
  emptyAddBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 18,
    minHeight: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyAddBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
});
