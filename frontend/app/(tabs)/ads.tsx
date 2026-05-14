import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../../src/components/Header';
import CountrySelectorModal from '../../src/components/CountrySelectorModal';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useDebouncedValue } from '../../src/hooks/useDebouncedValue';
import { api } from '../../src/convexApi';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

type ViewMode = 'browse' | 'mine';

export default function AdsScreen() {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<ViewMode>('browse');
  const [search, setSearch] = useState('');
  const [filterCountries, setFilterCountries] = useState<string[]>([]);
  const [showCountryModal, setShowCountryModal] = useState(false);
  const debouncedSearch = useDebouncedValue(search.trim(), 350);

  const { data: me } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null);
  const { data: approvedPage, loading: approvedLoading } = useSafeConvexQuery<any>(
    api.ads.listApproved,
    { paginationOpts: { numItems: 50, cursor: null } },
    { page: [] }
  );
  const { data: searchResults, loading: searchLoading } = useSafeConvexQuery<any[]>(
    api.ads.searchAds,
    { query: debouncedSearch },
    [],
    debouncedSearch.length > 0
  );
  const { data: myAds, loading: myAdsLoading } = useSafeConvexQuery<any[]>(api.ads.listMyAds, {}, []);
  const recordClick = useMutation(api.ads.recordClick);

  const browseAds = useMemo(() => {
    const base = debouncedSearch.length > 0 ? searchResults : approvedPage?.page || [];
    if (!filterCountries.length) return base;
    return (Array.isArray(base) ? base : []).filter((ad: any) => {
      const targets = Array.isArray(ad.targetCountries) ? ad.targetCountries : [];
      if (!targets.length) return true;
      return targets.some((country: string) => filterCountries.includes(country));
    });
  }, [approvedPage?.page, debouncedSearch.length, filterCountries, searchResults]);

  const onVisitAd = async (ad: any) => {
    try {
      const url = await recordClick({ adId: ad._id });
      await Linking.openURL(url || ad.externalLink);
    } catch (errorValue: any) {
      if (ad.externalLink) {
        await Linking.openURL(ad.externalLink).catch(() => {});
      } else {
        Alert.alert('Could not open link', errorValue?.message || 'Unknown error');
      }
    }
  };

  const loading = viewMode === 'browse' ? approvedLoading || searchLoading : myAdsLoading;
  const listData = viewMode === 'browse' ? browseAds : myAds;
  const isAdmin = me?.role === 'admin';

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="ads-screen">
      <Header
        title="Ads"
        variant="light"
        right={
          <>
            <MaterialCommunityIcons name="bullhorn-outline" size={22} color={Colors.textPrimary} />
            {isAdmin ? (
              <TouchableOpacity onPress={() => router.push('/ads/review' as any)} testID="ads-review-button">
                <Feather name="shield" size={22} color={Colors.textPrimary} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={() => router.push('/ads/create' as any)} testID="ads-post-button">
              <Feather name="plus-circle" size={22} color={Colors.primary} />
            </TouchableOpacity>
          </>
        }
      />

      <View style={styles.segmentWrap} testID="ads-segmented-tabs">
        <SegmentButton label="Browse Ads" active={viewMode === 'browse'} onPress={() => setViewMode('browse')} testID="ads-browse-tab" />
        <SegmentButton label="My Ads" active={viewMode === 'mine'} onPress={() => setViewMode('mine')} testID="ads-my-tab" />
      </View>

      {viewMode === 'browse' ? (
        <>
          <View style={styles.searchWrap}>
            <Feather name="search" size={18} color={Colors.textMuted} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search ads by product"
              placeholderTextColor={Colors.textMuted}
              style={styles.searchInput}
              testID="ads-search-input"
            />
            <TouchableOpacity onPress={() => setShowCountryModal(true)} style={styles.filterBtn} testID="ads-country-filter-button">
              <Ionicons name="filter-outline" size={18} color={Colors.primary} />
              <Text style={styles.filterText}>{filterCountries.length ? `${filterCountries.length}` : 'All'}</Text>
            </TouchableOpacity>
          </View>
          {filterCountries.length ? (
            <Text style={styles.helperText} testID="ads-filter-summary">
              Filtering {filterCountries.length} countr{filterCountries.length === 1 ? 'y' : 'ies'}
            </Text>
          ) : null}
        </>
      ) : null}

      <FlatList
        data={Array.isArray(listData) ? listData : []}
        keyExtractor={(item: any) => item._id}
        contentContainerStyle={styles.listContent}
        testID="ads-list"
        renderItem={({ item, index }) =>
          viewMode === 'browse' ? (
            <BrowseAdCard ad={item} index={index} onPress={() => onVisitAd(item)} />
          ) : (
            <MyAdCard ad={item} index={index} />
          )
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty} testID="ads-empty-state">
              <MaterialCommunityIcons name="bullhorn-outline" size={42} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>{viewMode === 'browse' ? 'No ads found' : 'No ads posted yet'}</Text>
              <Text style={styles.emptySub}>
                {viewMode === 'browse'
                  ? debouncedSearch || filterCountries.length
                    ? 'Try a different search or country filter.'
                    : 'Approved ads will appear here.'
                  : 'Create your first ad to reach more customers.'}
              </Text>
            </View>
          ) : null
        }
      />

      <CountrySelectorModal
        selected={filterCountries}
        title="Filter by countries"
        visible={showCountryModal}
        onApply={setFilterCountries}
        onClose={() => setShowCountryModal(false)}
      />
    </SafeAreaView>
  );
}

function SegmentButton({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.segmentButton, active ? styles.segmentButtonActive : null]}
      onPress={onPress}
      activeOpacity={0.8}
      testID={testID}
    >
      <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

function BrowseAdCard({ ad, index, onPress }: { ad: any; index: number; onPress: () => void }) {
  const countries = Array.isArray(ad.targetCountries) ? ad.targetCountries : [];
  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.86} onPress={onPress} testID={`browse-ad-card-${index}`}>
      {ad.imageUrl ? <Image source={{ uri: ad.imageUrl }} style={styles.cardImage} resizeMode="cover" /> : null}
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} testID={`browse-ad-title-${index}`}>{ad.productName}</Text>
        <Text style={styles.cardBusiness}>{ad.businessName}</Text>
        <Text style={styles.cardDescription} numberOfLines={2}>{ad.description}</Text>
        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Ionicons name="location-outline" size={14} color={Colors.textMuted} />
            <Text style={styles.metaText}>{ad.location || 'Location not set'}</Text>
          </View>
          <View style={styles.countryBadge}>
            <Text style={styles.countryBadgeText}>{countries.length ? `${countries.length} countries` : 'Worldwide'}</Text>
          </View>
        </View>
        <Text style={styles.visitLink}>Visit advertiser</Text>
      </View>
    </TouchableOpacity>
  );
}

function MyAdCard({ ad, index }: { ad: any; index: number }) {
  const countries = Array.isArray(ad.targetCountries) ? ad.targetCountries : [];
  const visibleCountries = countries.slice(0, 3);
  const hiddenCount = Math.max(countries.length - visibleCountries.length, 0);
  const statusColor = ad.status === 'approved' ? '#16a34a' : ad.status === 'rejected' ? '#dc2626' : '#d97706';

  return (
    <View style={styles.card} testID={`my-ad-card-${index}`}>
      {ad.imageUrl ? <Image source={{ uri: ad.imageUrl }} style={styles.cardImage} resizeMode="cover" /> : null}
      <View style={styles.cardBody}>
        <View style={styles.myCardHeader}>
          <Text style={styles.cardTitle}>{ad.productName}</Text>
          <View style={[styles.statusBadge, { backgroundColor: `${statusColor}20` }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>{ad.status}</Text>
          </View>
        </View>
        <Text style={styles.cardBusiness}>{ad.businessName}</Text>
        {ad.status === 'rejected' && ad.rejectedReason ? (
          <Text style={styles.rejectionText}>Reason: {ad.rejectedReason}</Text>
        ) : null}
        <View style={styles.statsRow}>
          <Text style={styles.statsText}>{ad.clickCount || 0} clicks</Text>
          <Text style={styles.statsText}>€{Number(ad.totalCostEur || 0).toFixed(2)}</Text>
        </View>
        <Text style={styles.countryListText}>
          {countries.length ? `${visibleCountries.join(', ')}${hiddenCount ? ` +${hiddenCount} more` : ''}` : 'Worldwide'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  segmentWrap: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.base, marginTop: Spacing.md },
  segmentButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  segmentButtonActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  segmentText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textPrimary },
  segmentTextActive: { color: Colors.white, fontWeight: FontWeight.bold },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  filterText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  helperText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm, marginHorizontal: Spacing.base },
  listContent: { padding: Spacing.base, paddingBottom: 120, gap: Spacing.base },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.borderLight,
    ...Shadow.sm,
  },
  cardImage: { width: '100%', height: 176, backgroundColor: Colors.borderLight },
  cardBody: { padding: Spacing.base },
  cardTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  cardBusiness: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  cardDescription: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: 8, lineHeight: 20 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.base, gap: Spacing.sm },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  metaText: { fontSize: FontSize.xs, color: Colors.textMuted },
  countryBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: Radius.pill, backgroundColor: Colors.primaryLight },
  countryBadgeText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: FontWeight.bold },
  visitLink: { marginTop: Spacing.base, fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.bold },
  myCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: Radius.pill },
  statusText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, textTransform: 'uppercase' },
  rejectionText: { fontSize: FontSize.sm, color: Colors.danger, marginTop: 8 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.base },
  statsText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  countryListText: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: Spacing.sm },
  empty: { alignItems: 'center', paddingTop: Spacing.xxl * 2, paddingHorizontal: Spacing.lg, gap: Spacing.md },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
});