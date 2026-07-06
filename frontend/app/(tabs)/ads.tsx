import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
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
import { useMutation, useAction } from 'convex/react';
import * as WebBrowser from 'expo-web-browser';
import * as ExpoLinking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CountrySelectorModal from '../../src/components/CountrySelectorModal';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useDebouncedValue } from '../../src/hooks/useDebouncedValue';
import { api } from '../../src/convexApi';
import { estimateClicks, formatCreditCode } from '../../src/lib/adCreditCodes';
import { formatLocalAmount } from '../../src/lib/mobileMoney';
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
  const [redeemModalVisible, setRedeemModalVisible] = useState(false);
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
  const { data: myMoneyRequests } = useSafeConvexQuery<any[]>(
    (api as any).adClickRequests?.getMyRequests,
    {},
    [],
  );
  const recordClick = useMutation(api.ads.recordClick);
  const redeemCode = useMutation(api.adCreditCodes.redeemCode);
  const checkoutAdClicks = useAction(api.adCommerceAction.checkoutAdClicks);
  const confirmAdClickPurchase = useAction(api.adCommerceAction.confirmAdClickPurchase);

  // Buy-clicks (Hercules Commerce) state
  const [purchaseAd, setPurchaseAd] = useState<any | null>(null);
  const [purchaseQty, setPurchaseQty] = useState<number>(50);
  const [purchasing, setPurchasing] = useState(false);

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
      setRedeemModalVisible(false);
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

  // --- Buy clicks via Hercules Commerce hosted checkout (external browser) ---
  const PENDING_KEY = 'pendingAdClickPurchase';

  const runConfirm = useCallback(
    async (sessionId: string, silent: boolean) => {
      try {
        const res: any = await confirmAdClickPurchase({ checkoutSessionId: sessionId });
        await AsyncStorage.removeItem(PENDING_KEY);
        if (res?.credited) {
          Alert.alert('Payment successful', `${res.clicks} click${res.clicks === 1 ? '' : 's'} added to your ad.`);
        } else if (!silent) {
          Alert.alert('Already processed', 'This purchase was already confirmed.');
        }
      } catch (errorValue: any) {
        // Keep the pending session so we can retry later (idempotent confirm).
        if (!silent) {
          Alert.alert('Could not confirm payment', errorValue?.message || 'Please reopen the app to retry.');
        }
      }
    },
    [confirmAdClickPurchase],
  );

  // If the app was closed mid-checkout, retry confirming on next mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pending = await AsyncStorage.getItem(PENDING_KEY);
      if (pending && !cancelled) {
        await runConfirm(pending, true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runConfirm]);

  const onConfirmPurchase = async () => {
    if (!purchaseAd || purchaseQty <= 0) return;
    setPurchasing(true);
    try {
      const redirectUrl = ExpoLinking.createURL('ads/purchase-return');
      const successUrl = `${redirectUrl}?status=success`;
      const cancelUrl = `${redirectUrl}?status=cancel`;
      const result: any = await checkoutAdClicks({
        adId: purchaseAd._id,
        quantity: purchaseQty,
        successUrl,
        cancelUrl,
      });
      const sessionId = result?.sessionId;
      const url = result?.url;
      if (!url || !sessionId) {
        Alert.alert('Checkout unavailable', 'Could not start the payment session. Please try again.');
        return;
      }
      // Persist the session so we can confirm even if the app is killed.
      await AsyncStorage.setItem(PENDING_KEY, sessionId);
      setPurchaseAd(null);

      const browserResult = await WebBrowser.openAuthSessionAsync(url, redirectUrl);
      if (browserResult.type === 'success' && browserResult.url) {
        const { queryParams } = ExpoLinking.parse(browserResult.url);
        if (queryParams?.status === 'cancel') {
          await AsyncStorage.removeItem(PENDING_KEY);
          Alert.alert('Payment cancelled', 'No clicks were purchased.');
        } else {
          await runConfirm(sessionId, false);
        }
      }
      // Dismissed (type !== 'success'): leave pending session for the resume-on-mount retry.
    } catch (errorValue: any) {
      Alert.alert('Could not start checkout', errorValue?.message || 'Unknown error');
    } finally {
      setPurchasing(false);
    }
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
            <View style={styles.myAdsHeader}>
              <LifetimeLicenseCard credits={myCredits} />
              <RedeemAdCodeButton onPress={() => setRedeemModalVisible(true)} />
              <MobileMoneyRequestsCard requests={myMoneyRequests} />
            </View>
          ) : null
        }
        renderItem={({ item, index }) =>
          viewMode === 'browse' ? (
            <BrowseAdCard ad={item} index={index} onPress={() => onVisitAd(item)} />
          ) : (
            <MyAdCard ad={item} index={index} onBuyClicks={() => { setPurchaseQty(50); setPurchaseAd(item); }} />
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

      <RedeemCodeModal
        visible={redeemModalVisible}
        value={redeemCodeInput}
        onChange={onChangeRedeemCode}
        onSubmit={onRedeemCode}
        onClose={() => setRedeemModalVisible(false)}
        submitting={redeeming}
      />

      <BuyClicksModal
        ad={purchaseAd}
        quantity={purchaseQty}
        onChangeQuantity={setPurchaseQty}
        onConfirm={onConfirmPurchase}
        onMobileMoney={() => {
          const ad = purchaseAd;
          if (!ad) return;
          setPurchaseAd(null);
          router.push({
            pathname: '/ad-clicks-payment',
            params: {
              adId: ad._id,
              adTitle: ad.productName || ad.businessName || 'your ad',
              clicks: String(purchaseQty),
            },
          } as any);
        }}
        onClose={() => (!purchasing ? setPurchaseAd(null) : undefined)}
        submitting={purchasing}
      />
    </SafeAreaView>
  );
}

const CLICK_PRICE_EUR = 0.04;
const QTY_PRESETS = [25, 50, 100, 250, 500];

function BuyClicksModal({
  ad,
  quantity,
  onChangeQuantity,
  onConfirm,
  onMobileMoney,
  onClose,
  submitting,
}: {
  ad: any | null;
  quantity: number;
  onChangeQuantity: (q: number) => void;
  onConfirm: () => void;
  onMobileMoney: () => void;
  onClose: () => void;
  submitting: boolean;
}) {
  const total = (quantity * CLICK_PRICE_EUR).toFixed(2);
  return (
    <Modal visible={!!ad} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined} testID="buy-clicks-modal">
          <View style={styles.modalHeaderRow}>
            <MaterialCommunityIcons name="cursor-default-click-outline" size={22} color={Colors.primary} />
            <Text style={styles.modalTitle}>Buy clicks</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={onClose} hitSlop={10} disabled={submitting} testID="buy-clicks-close">
              <Ionicons name="close" size={24} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {ad ? (
            <Text style={styles.modalSubtitle} numberOfLines={1}>
              {ad.productName}
            </Text>
          ) : null}

          <Text style={styles.modalHelper}>€{CLICK_PRICE_EUR.toFixed(2)} per click. Choose how many to buy.</Text>

          <View style={styles.qtyPresetRow}>
            {QTY_PRESETS.map((q) => {
              const active = q === quantity;
              return (
                <TouchableOpacity
                  key={q}
                  style={[styles.qtyChip, active ? styles.qtyChipActive : null]}
                  onPress={() => onChangeQuantity(q)}
                  disabled={submitting}
                  testID={`buy-clicks-qty-${q}`}
                >
                  <Text style={[styles.qtyChipText, active ? styles.qtyChipTextActive : null]}>{q}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.qtyStepperRow}>
            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => onChangeQuantity(Math.max(1, quantity - 25))}
              disabled={submitting}
              testID="buy-clicks-minus"
            >
              <Feather name="minus" size={18} color={Colors.textPrimary} />
            </TouchableOpacity>
            <Text style={styles.qtyValue}>{quantity}</Text>
            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => onChangeQuantity(quantity + 25)}
              disabled={submitting}
              testID="buy-clicks-plus"
            >
              <Feather name="plus" size={18} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>€{total}</Text>
          </View>

          <TouchableOpacity
            style={[styles.payBtn, submitting ? styles.payBtnDisabled : null]}
            onPress={onConfirm}
            disabled={submitting}
            activeOpacity={0.85}
            testID="buy-clicks-pay"
          >
            <Text style={styles.payBtnText}>{submitting ? 'Opening checkout…' : `Pay €${total}`}</Text>
          </TouchableOpacity>

          {/* Manual Mobile Money alternative to card checkout. */}
          <TouchableOpacity
            style={styles.mobileMoneyBtn}
            onPress={onMobileMoney}
            disabled={submitting}
            activeOpacity={0.85}
            testID="buy-clicks-mobile-money"
          >
            <MaterialCommunityIcons name="cellphone" size={19} color={Colors.primary} />
            <Text style={styles.mobileMoneyBtnText}>Pay with Mobile Money</Text>
          </TouchableOpacity>

          <Text style={styles.payDisclaimer}>
            You&apos;ll complete payment securely in your browser, then return to the app.
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function LifetimeLicenseCard({ credits }: { credits: any }) {
  const hasLifetime = !!credits?.hasLifetime;
  const totalRemaining = Number(credits?.totalRemainingEur || 0);
  const clickEstimate = estimateClicks(totalRemaining);

  // Always show a top-level status banner (web mirrors this even when no
  // lifetime license is active — it just toggles content).
  return (
    <View style={[styles.lifetimeCard, hasLifetime ? styles.lifetimeCardActive : null]} testID="ad-credits-card">
      <View style={[styles.lifetimeIconWrap, hasLifetime ? styles.lifetimeIconActive : null]}>
        <MaterialCommunityIcons
          name={hasLifetime ? 'infinity' : 'wallet-outline'}
          size={22}
          color={hasLifetime ? '#92400e' : Colors.primary}
        />
      </View>
      <View style={styles.flexOne}>
        <Text style={[styles.lifetimeTitle, hasLifetime ? styles.lifetimeTitleActive : null]} testID="ad-credits-title">
          {hasLifetime ? 'Lifetime License' : totalRemaining > 0 ? 'Ad Credits Available' : 'No Active Credits'}
        </Text>
        <Text style={styles.lifetimeSub} testID="ad-credits-subtitle">
          {hasLifetime
            ? 'Unlimited ad clicks at no cost'
            : totalRemaining > 0
              ? `€${totalRemaining.toFixed(2)} remaining · about ${clickEstimate} clicks`
              : 'Redeem a code to cover future ad clicks.'}
        </Text>
      </View>
    </View>
  );
}

function RedeemAdCodeButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      style={styles.redeemAdCodeBtn}
      onPress={onPress}
      activeOpacity={0.7}
      testID="ad-redeem-code-button"
    >
      <Feather name="tag" size={18} color={Colors.textPrimary} />
      <Text style={styles.redeemAdCodeText}>Redeem Ad Code</Text>
    </TouchableOpacity>
  );
}

const MM_STATUS_META: Record<string, { bg: string; fg: string; label: string }> = {
  pending: { bg: '#FFF4E5', fg: '#B26A00', label: 'Pending' },
  completed: { bg: '#E7F6EC', fg: '#1B7F3B', label: 'Credited' },
  declined: { bg: '#FDECEC', fg: Colors.danger, label: 'Declined' },
  cancelled: { bg: '#EEE', fg: Colors.textSecondary, label: 'Cancelled' },
};

// Advertiser-facing summary of their Mobile Money click top-ups, so approved
// purchases are visible at a glance without opening the payment screen.
function MobileMoneyRequestsCard({ requests }: { requests: any[] | undefined }) {
  if (!Array.isArray(requests) || requests.length === 0) return null;
  const recent = requests.slice(0, 3);
  const pendingCount = requests.filter((r) => r?.status === 'pending').length;
  return (
    <View style={styles.mmCard} testID="ad-mobile-money-requests">
      <View style={styles.mmHeaderRow}>
        <MaterialCommunityIcons name="cellphone-check" size={18} color={Colors.primary} />
        <Text style={styles.mmTitle}>Mobile Money top-ups</Text>
        {pendingCount ? (
          <View style={styles.mmPendingBadge}>
            <Text style={styles.mmPendingBadgeText}>{pendingCount} pending</Text>
          </View>
        ) : null}
      </View>
      {recent.map((r: any) => {
        const meta = MM_STATUS_META[r?.status] || MM_STATUS_META.cancelled;
        const title = r?.adTitle || r?.ad?.productName || 'Ad';
        const clicks = r?.clicks ?? r?.quantity ?? 0;
        return (
          <View key={String(r._id)} style={styles.mmRow} testID={`ad-mm-req-${String(r._id).slice(-6)}`}>
            <View style={styles.flexOne}>
              <Text style={styles.mmRowTitle} numberOfLines={1}>{title}</Text>
              <Text style={styles.mmRowMeta} numberOfLines={1}>
                {clicks} clicks · {formatLocalAmount(r?.amount ?? 0, r?.currency || '')}
              </Text>
            </View>
            <View style={[styles.mmPill, { backgroundColor: meta.bg }]}>
              <Text style={[styles.mmPillText, { color: meta.fg }]}>{meta.label}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function RedeemCodeModal({
  visible,
  value,
  onChange,
  onSubmit,
  onClose,
  submitting,
}: {
  visible: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  submitting: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalBackdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} testID="redeem-modal-backdrop" />
        <View style={styles.modalCard} testID="redeem-modal">
          <View style={styles.modalHeaderRow}>
            <Feather name="tag" size={20} color={Colors.primary} />
            <Text style={styles.modalTitle}>Redeem Ad Code</Text>
            <View style={styles.flexOne} />
            <TouchableOpacity onPress={onClose} hitSlop={10} testID="redeem-modal-close">
              <Feather name="x" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.modalSubtitle}>
            Enter the 9-character code you received. Lifetime codes unlock unlimited clicks; credit codes top up your balance.
          </Text>
          <TextInput
            value={value}
            onChangeText={onChange}
            placeholder="XXX-XXX-XXX"
            placeholderTextColor={Colors.textMuted}
            style={styles.modalInput}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={11}
            autoFocus
            testID="ad-redeem-code-input"
          />
          <TouchableOpacity
            style={[styles.modalSubmitBtn, (!value || submitting) && styles.modalSubmitBtnDisabled]}
            onPress={onSubmit}
            disabled={!value || submitting}
            testID="ad-redeem-modal-submit"
          >
            <Text style={styles.modalSubmitText}>{submitting ? 'Redeeming…' : 'Redeem Code'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
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

function MyAdCard({ ad, index, onBuyClicks }: { ad: any; index: number; onBuyClicks: () => void }) {
  const countries = Array.isArray(ad.targetCountries) ? ad.targetCountries : [];
  const visibleCountries = countries.slice(0, 3);
  const hiddenCount = Math.max(countries.length - visibleCountries.length, 0);

  const statusColor =
    ad.status === 'approved' ? '#16a34a' : ad.status === 'rejected' ? '#dc2626' : '#d97706';
  const statusBg =
    ad.status === 'approved' ? '#dcfce7' : ad.status === 'rejected' ? '#fee2e2' : '#fef3c7';
  const statusLabel =
    ad.status === 'approved'
      ? 'Approved'
      : ad.status === 'rejected'
        ? 'Rejected'
        : 'Pending';

  // Support the same gallery shape as BrowseAdCard for visual parity.
  const galleryRaw: any[] = Array.isArray(ad.images) && ad.images.length > 0
    ? ad.images
    : ad.imageUrl
      ? [ad.imageUrl]
      : [];
  const gallery: string[] = galleryRaw
    .map((g: any) => (typeof g === 'string' ? g : g?.url || g?.uri || ''))
    .filter(Boolean);
  const isGallery = gallery.length > 1;

  const clickCount = Number(ad.clickCount || 0);
  const totalCost = Number(ad.totalCostEur || 0);
  const remainingPaid = Number(ad.remainingPaidClicks || 0);

  return (
    <View style={styles.card} testID={`my-ad-card-${index}`}>
      <View style={styles.cardInner}>
        {ad.category ? (
          <View style={styles.categoryChipWrap}>
            <View style={styles.categoryChip}>
              <Text style={styles.categoryChipText}>{ad.category}</Text>
            </View>
          </View>
        ) : null}

        {gallery.length > 0 ? (
          isGallery ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.galleryRow}
            >
              {gallery.map((uri, idx) => (
                <Image key={idx} source={{ uri }} style={styles.galleryImage} resizeMode="cover" />
              ))}
            </ScrollView>
          ) : (
            <Image source={{ uri: gallery[0] }} style={styles.cardImageSolo} resizeMode="cover" />
          )
        ) : null}

        <View style={styles.myCardHeader}>
          <Text style={styles.cardTitle} numberOfLines={2}>{ad.productName}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusBg }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>

        {ad.businessName ? (
          <Text style={styles.myCardBusiness}>{ad.businessName}</Text>
        ) : null}

        {ad.status === 'rejected' && ad.rejectedReason ? (
          <Text style={styles.rejectionText}>Reason: {ad.rejectedReason}</Text>
        ) : null}

        <View style={styles.statsRow}>
          <Text style={styles.statsText}>{clickCount} clicks</Text>
          <Text style={styles.statsTextRight}>€{totalCost.toFixed(2)} charged</Text>
        </View>

        <View style={styles.paidClicksRow}>
          <MaterialCommunityIcons name="wallet-outline" size={15} color={Colors.textSecondary} />
          <Text style={styles.paidClicksText}>
            {remainingPaid > 0 ? `${remainingPaid} paid clicks remaining` : 'No paid clicks left'}
          </Text>
        </View>

        {countries.length ? (
          <Text style={styles.countryListText}>
            {visibleCountries.join(', ')}{hiddenCount ? ` +${hiddenCount} more` : ''}
          </Text>
        ) : null}

        <TouchableOpacity
          style={styles.buyClicksBtn}
          onPress={onBuyClicks}
          activeOpacity={0.7}
          testID={`my-ad-buy-clicks-${index}`}
        >
          <MaterialCommunityIcons name="cursor-default-click-outline" size={18} color={Colors.textPrimary} />
          <Text style={styles.buyClicksText}>Buy Clicks</Text>
        </TouchableOpacity>
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
  myAdsHeader: { gap: Spacing.sm, marginBottom: 4 },
  mmCard: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    padding: Spacing.base,
    gap: 8,
  },
  mmHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mmTitle: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  mmPendingBadge: { backgroundColor: '#FFF4E5', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  mmPendingBadgeText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: '#B26A00' },
  mmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  mmRowTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  mmRowMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  mmPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  mmPillText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  /* My Ads: Lifetime License banner card */
  lifetimeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.base,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fef3c7',
  },
  lifetimeCardActive: { backgroundColor: '#fef3c7', borderColor: '#fcd34d' },
  lifetimeIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fde68a',
  },
  lifetimeIconActive: { backgroundColor: '#fde68a' },
  lifetimeTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: '#92400e' },
  lifetimeTitleActive: { color: '#92400e' },
  lifetimeSub: { fontSize: FontSize.sm, color: '#92400e', marginTop: 2, opacity: 0.9 },

  /* My Ads: Redeem Ad Code button (separate from license card) */
  redeemAdCodeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  redeemAdCodeText: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },

  /* Redeem code modal */
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: Colors.background,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.md,
    ...Shadow.lg,
  },
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  modalInput: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    letterSpacing: 4,
    textAlign: 'center',
  },
  modalSubmitBtn: {
    minHeight: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSubmitBtnDisabled: { opacity: 0.55 },
  modalSubmitText: { fontSize: FontSize.base, color: Colors.headerBg, fontWeight: FontWeight.bold },

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
  myCardHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: Spacing.sm, marginTop: 4 },
  myCardBusiness: { fontSize: FontSize.base, color: Colors.textSecondary, marginTop: -4 },
  statusBadge: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: Radius.pill, alignSelf: 'flex-start' },
  statusText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  rejectionText: { fontSize: FontSize.sm, color: Colors.danger, marginTop: 4 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  statsText: { fontSize: FontSize.base, color: Colors.textSecondary },
  statsTextRight: { fontSize: FontSize.base, color: Colors.textSecondary },
  countryListText: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: 4 },
  buyClicksBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: Spacing.sm,
    paddingVertical: 12,
    borderRadius: Radius.md,
    backgroundColor: '#f5e9d3',
  },
  buyClicksText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },

  /* Flex helper used in modal/lifetime cards */
  flexOne: { flex: 1 },

  /* Empty */
  empty: { alignItems: 'center', paddingTop: Spacing.xxl * 2, paddingHorizontal: Spacing.lg, gap: Spacing.md },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  paidClicksRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  paidClicksText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.medium },
  modalHelper: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  qtyPresetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  qtyChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  qtyChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  qtyChipText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  qtyChipTextActive: { color: Colors.headerBg },
  qtyStepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24, marginTop: 16 },
  stepperBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  qtyValue: { fontSize: 24, fontWeight: FontWeight.bold, color: Colors.textPrimary, minWidth: 60, textAlign: 'center' },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  totalLabel: { fontSize: FontSize.base, color: Colors.textSecondary },
  totalValue: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  payBtn: {
    marginTop: 16,
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: 14,
    alignItems: 'center',
  },
  payBtnDisabled: { opacity: 0.6 },
  mobileMoneyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    marginTop: 10,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.primary,
  },
  mobileMoneyBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primary },
  payBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  payDisclaimer: { fontSize: FontSize.xs, color: Colors.textMuted, textAlign: 'center', marginTop: 10 },
});
