import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Linking,
  ScrollView,
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
import CountrySelectorModal from '../../src/components/CountrySelectorModal';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useDebouncedValue } from '../../src/hooks/useDebouncedValue';
import { api } from '../../src/convexApi';
import { estimateClicks, formatCreditCode } from '../../src/lib/adCreditCodes';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

type ViewMode = 'browse' | 'mine';

export default function AdsScreen() {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<ViewMode>('browse');
  const [search, setSearch] = useState('');
  const [filterCountries, setFilterCountries] = useState<string[]>([]);
  const [showCountryModal, setShowCountryModal] = useState(false);
  const [redeemCodeInput, setRedeemCodeInput] = useState('');
  const [redeeming, setRedeeming] = useState(false);
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
  const { data: myCredits } = useSafeConvexQuery<any>(
    api.adCreditCodes.getMyAdCredits,
    {},
    { hasLifetime: false, totalRemainingEur: 0, codes: [] }
  );
  const recordClick = useMutation(api.ads.recordClick);
  const redeemCode = useMutation(api.adCreditCodes.redeemCode);

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

  const onRedeemCode = async () => {
    const code = formatCreditCode(redeemCodeInput);
    if (!code || code.length < 11) {
      Alert.alert('Enter a valid code', 'Please enter a code in the format XXX-XXX-XXX.');
      return;
    }

    setRedeeming(true);
    try {
      const result: any = await redeemCode({ code });
      setRedeemCodeInput('');
      if (result?.type === 'lifetime') {
        Alert.alert('Code redeemed', 'Lifetime license activated successfully.');
      } else {
        Alert.alert('Code redeemed', `€${Number(result?.amountEur || 0).toFixed(2)} ad credits added.`);
      }
    } catch (errorValue: any) {
      Alert.alert('Could not redeem code', errorValue?.message || 'Unknown error');
    } finally {
      setRedeeming(false);
    }
  };

  const onChangeRedeemCode = (value: string) => {
    setRedeemCodeInput(formatCreditCode(value));
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="ads-screen">
      {/* Header — back arrow + megaphone + "Ads" title + "+ Post Ad" pill */}
      <View style={styles.adsHeader}>
        <TouchableOpacity hitSlop={10} onPress={() => router.back()} style={styles.adsHeaderBack} testID="ads-back-btn">
          <Feather name="arrow-left" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <MaterialCommunityIcons name="bullhorn-outline" size={22} color={Colors.primary} />
        <Text style={styles.adsHeaderTitle}>Ads</Text>
        <View style={{ flex: 1 }} />
        {isAdmin ? (
          <TouchableOpacity
            onPress={() => router.push('/ads/review' as any)}
            style={styles.adsAdminBtn}
            testID="ads-review-button"
          >
            <Feather name="shield" size={20} color={Colors.textPrimary} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={() => router.push('/ads/create' as any)}
          style={styles.postAdBtn}
          testID="ads-post-button"
          activeOpacity={0.85}
        >
          <Feather name="plus" size={18} color={Colors.headerBg} />
          <Text style={styles.postAdText}>Post Ad</Text>
        </TouchableOpacity>
      </View>

      {/* Tabs — Browse Ads | My Ads (with icons + underline indicator) */}
      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setViewMode('browse')}
          activeOpacity={0.7}
          testID="ads-browse-tab"
        >
          <View style={styles.tabLabelRow}>
            <Ionicons
              name="eye-outline"
              size={18}
              color={viewMode === 'browse' ? Colors.primary : Colors.textSecondary}
            />
            <Text style={[styles.tabText, viewMode === 'browse' ? styles.tabTextActive : null]}>Browse Ads</Text>
          </View>
          {viewMode === 'browse' ? <View style={styles.tabIndicator} /> : null}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setViewMode('mine')}
          activeOpacity={0.7}
          testID="ads-my-tab"
        >
          <View style={styles.tabLabelRow}>
            <Ionicons
              name="clipboard-outline"
              size={18}
              color={viewMode === 'mine' ? Colors.primary : Colors.textSecondary}
            />
            <Text style={[styles.tabText, viewMode === 'mine' ? styles.tabTextActive : null]}>My Ads</Text>
          </View>
          {viewMode === 'mine' ? <View style={styles.tabIndicator} /> : null}
        </TouchableOpacity>
      </View>

      {viewMode === 'browse' ? (
        <>
          <View style={styles.searchWrap}>
            <Feather name="search" size={18} color={Colors.textMuted} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search products, brands, locations"
              placeholderTextColor={Colors.textMuted}
              style={styles.searchInput}
              testID="ads-search-input"
            />
            <TouchableOpacity onPress={() => setShowCountryModal(true)} style={styles.filterBtn} testID="ads-country-filter-button">
              <Ionicons name="options-outline" size={20} color={Colors.textPrimary} />
              {filterCountries.length ? <Text style={styles.filterText}>{filterCountries.length}</Text> : null}
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
        ListHeaderComponent={
          viewMode === 'mine' ? (
            <MyCreditsCard
              credits={myCredits}
              redeemCodeInput={redeemCodeInput}
              onChangeRedeemCode={onChangeRedeemCode}
              onRedeemCode={onRedeemCode}
              redeeming={redeeming}
            />
          ) : null
        }
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

function MyCreditsCard({
  credits,
  redeemCodeInput,
  onChangeRedeemCode,
  onRedeemCode,
  redeeming,
}: {
  credits: any;
  redeemCodeInput: string;
  onChangeRedeemCode: (value: string) => void;
  onRedeemCode: () => void;
  redeeming: boolean;
}) {
  const hasLifetime = !!credits?.hasLifetime;
  const totalRemaining = Number(credits?.totalRemainingEur || 0);
  const codeCount = Array.isArray(credits?.codes) ? credits.codes.length : 0;
  const clickEstimate = estimateClicks(totalRemaining);

  return (
    <View style={styles.creditsWrap} testID="ad-credits-card">
      <View style={[styles.creditsCard, hasLifetime ? styles.creditsCardLifetime : null]}>
        <View style={styles.creditsCardRow}>
          <View style={[styles.creditsIconWrap, hasLifetime ? styles.creditsIconLifetime : null]}>
            <MaterialCommunityIcons
              name={hasLifetime ? 'infinity' : 'wallet-outline'}
              size={22}
              color={hasLifetime ? '#92400e' : Colors.primary}
            />
          </View>
          <View style={styles.flexOne}>
            <Text style={styles.creditsTitle} testID="ad-credits-title">
              {hasLifetime ? 'Lifetime License' : totalRemaining > 0 ? 'Ad Credits Available' : 'No Active Credits'}
            </Text>
            <Text style={styles.creditsSub} testID="ad-credits-subtitle">
              {hasLifetime
                ? 'Your ads can receive unlimited clicks.'
                : totalRemaining > 0
                  ? `€${totalRemaining.toFixed(2)} remaining · about ${clickEstimate} clicks`
                  : 'Redeem a code to cover future ad clicks.'}
            </Text>
          </View>
        </View>

        <View style={styles.redeemWrap}>
          <Text style={styles.redeemLabel}>Redeem Code</Text>
          <TextInput
            value={redeemCodeInput}
            onChangeText={onChangeRedeemCode}
            placeholder="XXX-XXX-XXX"
            placeholderTextColor={Colors.textMuted}
            style={styles.redeemInput}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={11}
            testID="ad-redeem-code-input"
          />
          <TouchableOpacity
            style={[styles.redeemBtn, (!redeemCodeInput || redeeming) && styles.redeemBtnDisabled]}
            onPress={onRedeemCode}
            disabled={!redeemCodeInput || redeeming}
            testID="ad-redeem-code-button"
          >
            <Text style={styles.redeemBtnText}>{redeeming ? 'Redeeming…' : 'Redeem Code'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.creditsFootnote} testID="ad-credits-footnote">
          {codeCount > 0 ? `${codeCount} redeemed code${codeCount === 1 ? '' : 's'} on this account` : 'No redeemed codes yet'}
        </Text>
      </View>
    </View>
  );
}

function BrowseAdCard({ ad, index, onPress }: { ad: any; index: number; onPress: () => void }) {
  const countries = Array.isArray(ad.targetCountries) ? ad.targetCountries : [];
  const isWorldwide = countries.length === 0;

  // Support an `images` gallery if backend returns it; fallback to single imageUrl
  const galleryRaw: any[] = Array.isArray(ad.images) && ad.images.length > 0
    ? ad.images
    : ad.imageUrl
      ? [ad.imageUrl]
      : [];
  const gallery: string[] = galleryRaw
    .map((g: any) => (typeof g === 'string' ? g : g?.url || g?.uri || ''))
    .filter(Boolean);
  const isGallery = gallery.length > 1;

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.86}
      onPress={onPress}
      testID={`browse-ad-card-${index}`}
    >
      <View style={styles.cardInner}>
        {/* Category chip */}
        {ad.category ? (
          <View style={styles.categoryChipWrap}>
            <View style={styles.categoryChip}>
              <Text style={styles.categoryChipText}>{ad.category}</Text>
            </View>
          </View>
        ) : null}

        {/* Gallery (horizontal scroll) or single image */}
        {gallery.length > 0 ? (
          isGallery ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.galleryRow}
              testID={`browse-ad-gallery-${index}`}
            >
              {gallery.map((uri, idx) => (
                <Image
                  key={idx}
                  source={{ uri }}
                  style={styles.galleryImage}
                  resizeMode="cover"
                />
              ))}
            </ScrollView>
          ) : (
            <Image source={{ uri: gallery[0] }} style={styles.cardImageSolo} resizeMode="cover" />
          )
        ) : null}

        {/* Title */}
        <Text style={styles.cardTitle} testID={`browse-ad-title-${index}`}>
          {ad.productName}
        </Text>

        {/* Business with megaphone icon */}
        {ad.businessName ? (
          <View style={styles.cardMetaInline}>
            <MaterialCommunityIcons name="bullhorn-outline" size={15} color={Colors.textSecondary} />
            <Text style={styles.cardBusiness} numberOfLines={1}>{ad.businessName}</Text>
          </View>
        ) : null}

        {/* Description */}
        {ad.description ? (
          <Text style={styles.cardDescription} numberOfLines={3}>{ad.description}</Text>
        ) : null}

        {/* Location row */}
        <View style={styles.cardLocationRow}>
          <View style={styles.cardMetaInline}>
            <Ionicons name="location-outline" size={15} color={Colors.textSecondary} />
            <Text style={styles.cardLocationText} numberOfLines={1}>{ad.location || 'Location not set'}</Text>
          </View>
          <View style={styles.worldwidePill}>
            <Feather name="globe" size={13} color={Colors.primary} />
            <Text style={styles.worldwidePillText}>
              {isWorldwide ? 'Worldwide' : `${countries.length} ${countries.length === 1 ? 'country' : 'countries'}`}
            </Text>
          </View>
        </View>

        {/* Visit advertiser link */}
        <View style={styles.visitRow}>
          <Feather name="external-link" size={15} color={Colors.primary} />
          <Text style={styles.visitLink}>Visit advertiser</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function MyAdCard({ ad, index }: { ad: any; index: number }) {
  const countries = Array.isArray(ad.targetCountries) ? ad.targetCountries : [];
  const visibleCountries = countries.slice(0, 3);
  const hiddenCount = Math.max(countries.length - visibleCountries.length, 0);
  const statusColor =
    ad.status === 'approved' ? '#16a34a' : ad.status === 'rejected' ? '#dc2626' : '#d97706';
  const imageUri =
    typeof ad.imageUrl === 'string'
      ? ad.imageUrl
      : Array.isArray(ad.images) && ad.images[0]
        ? typeof ad.images[0] === 'string'
          ? ad.images[0]
          : ad.images[0]?.url
        : '';

  return (
    <View style={styles.card} testID={`my-ad-card-${index}`}>
      {imageUri ? <Image source={{ uri: imageUri }} style={styles.cardImage} resizeMode="cover" /> : null}
      <View style={styles.cardInner}>
        <View style={styles.myCardHeader}>
          <Text style={styles.cardTitle}>{ad.productName}</Text>
          <View style={[styles.statusBadge, { backgroundColor: `${statusColor}20` }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>{ad.status}</Text>
          </View>
        </View>
        {ad.businessName ? (
          <View style={styles.cardMetaInline}>
            <MaterialCommunityIcons name="bullhorn-outline" size={15} color={Colors.textSecondary} />
            <Text style={styles.cardBusiness}>{ad.businessName}</Text>
          </View>
        ) : null}
        {ad.status === 'rejected' && ad.rejectedReason ? (
          <Text style={styles.rejectionText}>Reason: {ad.rejectedReason}</Text>
        ) : null}
        <View style={styles.statsRow}>
          <Text style={styles.statsText}>{ad.clickCount || 0} clicks</Text>
          <Text style={styles.statsText}>€{Number(ad.totalCostEur || 0).toFixed(2)}</Text>
        </View>
        <Text style={styles.countryListText}>
          {countries.length
            ? `${visibleCountries.join(', ')}${hiddenCount ? ` +${hiddenCount} more` : ''}`
            : 'Worldwide'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  /* Header */
  adsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
  },
  adsHeaderBack: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adsHeaderTitle: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginLeft: 2,
  },
  adsAdminBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  postAdBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
  },
  postAdText: {
    color: Colors.headerBg,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },

  /* Tabs row (with underline indicator) */
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tabText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  tabTextActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 3,
    width: 90,
    borderRadius: 2,
    backgroundColor: Colors.primary,
  },

  /* Search */
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, paddingVertical: 0 },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  filterText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  helperText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm, marginHorizontal: Spacing.base },

  /* List */
  listContent: { padding: Spacing.base, paddingBottom: 140, gap: Spacing.base },

  /* Credits / Redeem */
  creditsWrap: { marginBottom: Spacing.base },
  creditsCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.base,
    ...Shadow.sm,
  },
  creditsCardLifetime: { backgroundColor: '#fef3c7', borderColor: '#fcd34d' },
  creditsCardRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  creditsIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  creditsIconLifetime: { backgroundColor: '#fde68a' },
  flexOne: { flex: 1 },
  creditsTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  creditsSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, lineHeight: 20 },
  redeemWrap: { marginTop: Spacing.base },
  redeemLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginBottom: 8 },
  redeemInput: {
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    letterSpacing: 2,
  },
  redeemBtn: {
    minHeight: 44,
    marginTop: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  redeemBtnDisabled: { opacity: 0.6 },
  redeemBtnText: { fontSize: FontSize.sm, color: Colors.headerBg, fontWeight: FontWeight.bold },
  creditsFootnote: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: Spacing.sm },

  /* Ad Card */
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.borderLight,
    ...Shadow.sm,
  },
  cardInner: { padding: Spacing.base, gap: 10 },
  categoryChipWrap: { flexDirection: 'row' },
  categoryChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  categoryChipText: {
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
  },
  galleryRow: { gap: 8, paddingVertical: 2, paddingRight: 8 },
  galleryImage: {
    width: 140,
    height: 160,
    borderRadius: Radius.md,
    backgroundColor: Colors.borderLight,
  },
  cardImageSolo: {
    width: '100%',
    height: 200,
    borderRadius: Radius.md,
    backgroundColor: Colors.borderLight,
  },
  cardImage: { width: '100%', height: 180, backgroundColor: Colors.borderLight },
  cardTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: 2 },
  cardMetaInline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardBusiness: { fontSize: FontSize.sm, color: Colors.textSecondary, flexShrink: 1 },
  cardDescription: { fontSize: FontSize.base, color: Colors.textPrimary, lineHeight: 22 },
  cardLocationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    gap: Spacing.sm,
  },
  cardLocationText: { fontSize: FontSize.sm, color: Colors.textSecondary, flexShrink: 1 },
  worldwidePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryLight,
  },
  worldwidePillText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.bold },
  visitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  visitLink: { fontSize: FontSize.base, color: Colors.primary, fontWeight: FontWeight.bold },

  /* My Ads */
  myCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: Radius.pill },
  statusText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, textTransform: 'uppercase' },
  rejectionText: { fontSize: FontSize.sm, color: Colors.danger, marginTop: 4 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  statsText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  countryListText: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: 4 },

  /* Empty */
  empty: { alignItems: 'center', paddingTop: Spacing.xxl * 2, paddingHorizontal: Spacing.lg, gap: Spacing.md },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
});
