import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

const GIPHY_API_KEY = process.env.EXPO_PUBLIC_GIPHY_API_KEY || '';
const TRENDING_URL = `https://api.giphy.com/v1/gifs/trending`;
const SEARCH_URL = `https://api.giphy.com/v1/gifs/search`;
const STICKERS_TRENDING_URL = `https://api.giphy.com/v1/stickers/trending`;
const STICKERS_SEARCH_URL = `https://api.giphy.com/v1/stickers/search`;
const RATING = 'g';
const PAGE_SIZE = 24;

interface GiphyAsset {
  id: string;
  title: string;
  /** Best small URL to render in grid */
  previewUrl: string;
  /** Full-quality GIF URL we will actually upload */
  gifUrl: string;
  /** Pixel width/height of preview */
  width: number;
  height: number;
}

interface ApiImage {
  url: string;
  width: string;
  height: string;
}

interface ApiResultEntry {
  id: string;
  title?: string;
  images: {
    fixed_width_small?: ApiImage;
    fixed_width?: ApiImage;
    downsized_medium?: ApiImage;
    downsized?: ApiImage;
    original?: ApiImage;
  };
}

const TAB_GIFS: 'gifs' = 'gifs';
const TAB_STICKERS: 'stickers' = 'stickers';
type TabId = typeof TAB_GIFS | typeof TAB_STICKERS;

function normalizeEntry(entry: ApiResultEntry): GiphyAsset | null {
  const images = entry.images || ({} as any);
  const preview =
    images.fixed_width_small ||
    images.fixed_width ||
    images.downsized ||
    images.downsized_medium ||
    images.original;
  const fullSized =
    images.downsized_medium ||
    images.downsized ||
    images.original ||
    images.fixed_width;
  if (!preview?.url || !fullSized?.url) return null;
  return {
    id: entry.id,
    title: entry.title || 'GIF',
    previewUrl: preview.url,
    gifUrl: fullSized.url,
    width: Number(preview.width) || 200,
    height: Number(preview.height) || 200,
  };
}

interface GiphyPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (asset: GiphyAsset) => void | Promise<void>;
}

const SCREEN_HEIGHT = Dimensions.get('window').height;
const SHEET_HEIGHT = Math.min(SCREEN_HEIGHT * 0.85, 720);
const COLUMNS = 2;
const GRID_HORIZONTAL_PADDING = Spacing.base;
const GRID_GAP = Spacing.sm;
const TILE_WIDTH =
  (Dimensions.get('window').width - GRID_HORIZONTAL_PADDING * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS;

const POPULAR_TAGS = ['Funny', 'Love', 'Happy', 'Sad', 'Reaction', 'Hello', 'Thank you', 'Wow', 'Sorry', 'Yes'];

export default function GiphyPicker({ visible, onClose, onSelect }: GiphyPickerProps) {
  const [tab, setTab] = useState<TabId>(TAB_GIFS);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<GiphyAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const slideAnimation = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const dragYRef = useRef(0);
  const requestSeqRef = useRef(0);

  // Pan responder for swipe-down-to-dismiss
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gestureState) =>
          Math.abs(gestureState.dy) > 8 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onPanResponderMove: (_evt, gestureState) => {
          if (gestureState.dy > 0) {
            slideAnimation.setValue(gestureState.dy);
            dragYRef.current = gestureState.dy;
          }
        },
        onPanResponderRelease: (_evt, gestureState) => {
          if (gestureState.dy > 140) {
            onClose();
          } else {
            Animated.spring(slideAnimation, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 4,
            }).start();
          }
          dragYRef.current = 0;
        },
      }),
    [onClose, slideAnimation]
  );

  // Open/close slide animation
  useEffect(() => {
    if (visible) {
      slideAnimation.setValue(SHEET_HEIGHT);
      Animated.timing(slideAnimation, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      // Reset search state when closed so reopening starts fresh on trending
      setQuery('');
      setDebounced('');
      setTab(TAB_GIFS);
      setItems([]);
      setErrorMessage(null);
      Keyboard.dismiss();
    }
  }, [visible, slideAnimation]);

  // Debounce search query
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebounced(query.trim());
    }, 350);
    return () => clearTimeout(handle);
  }, [query]);

  const fetchAssets = useCallback(
    async (currentQuery: string, currentTab: TabId, isRefresh = false) => {
      if (!GIPHY_API_KEY) {
        setErrorMessage('Giphy API key is missing.');
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const seq = ++requestSeqRef.current;
      try {
        if (isRefresh) setRefreshing(true);
        else setLoading(true);
        setErrorMessage(null);

        const params = new URLSearchParams({
          api_key: GIPHY_API_KEY,
          limit: String(PAGE_SIZE),
          rating: RATING,
          bundle: 'messaging_non_clips',
        });
        const trimmedQuery = currentQuery.trim();
        let endpoint: string;
        if (trimmedQuery.length > 0) {
          endpoint = currentTab === TAB_STICKERS ? STICKERS_SEARCH_URL : SEARCH_URL;
          params.set('q', trimmedQuery);
          params.set('lang', 'en');
        } else {
          endpoint = currentTab === TAB_STICKERS ? STICKERS_TRENDING_URL : TRENDING_URL;
        }

        const response = await fetch(`${endpoint}?${params.toString()}`);
        if (!response.ok) {
          throw new Error(`Giphy responded ${response.status}`);
        }
        const json = await response.json();
        if (seq !== requestSeqRef.current) {
          // newer request started; ignore this result
          return;
        }
        const entries = Array.isArray(json?.data) ? json.data : [];
        const next = entries
          .map((entry: ApiResultEntry) => normalizeEntry(entry))
          .filter(Boolean) as GiphyAsset[];
        setItems(next);
      } catch (errorValue: any) {
        if (seq !== requestSeqRef.current) return;
        setItems([]);
        setErrorMessage(errorValue?.message || 'Could not load GIFs. Check your internet connection.');
      } finally {
        if (seq !== requestSeqRef.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  // Trigger fetch when the sheet is visible OR the debounced query / tab changes
  useEffect(() => {
    if (!visible) return;
    fetchAssets(debounced, tab);
  }, [debounced, tab, visible, fetchAssets]);

  const handleSelect = useCallback(
    async (asset: GiphyAsset) => {
      if (submittingId) return;
      setSubmittingId(asset.id);
      try {
        await onSelect(asset);
      } finally {
        setSubmittingId(null);
      }
    },
    [onSelect, submittingId]
  );

  const handleRefresh = useCallback(() => {
    fetchAssets(debounced, tab, true);
  }, [debounced, tab, fetchAssets]);

  const renderItem = useCallback(
    ({ item }: { item: GiphyAsset }) => {
      const aspect = item.width > 0 && item.height > 0 ? item.width / item.height : 1;
      const tileHeight = Math.max(120, Math.min(220, TILE_WIDTH / aspect));
      const isSubmitting = submittingId === item.id;
      return (
        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.tile, { width: TILE_WIDTH, height: tileHeight }]}
          onPress={() => handleSelect(item)}
          disabled={!!submittingId}
          testID={`giphy-tile-${item.id}`}
        >
          <Image source={{ uri: item.previewUrl }} style={styles.tileImage} resizeMode="cover" />
          {isSubmitting ? (
            <View style={styles.tileOverlay}>
              <ActivityIndicator color={Colors.white} />
            </View>
          ) : null}
        </TouchableOpacity>
      );
    },
    [handleSelect, submittingId]
  );

  const renderEmpty = useMemo(() => {
    if (loading || refreshing) return null;
    if (errorMessage) {
      return (
        <View style={styles.emptyState} testID="giphy-error-state">
          <Feather name="alert-circle" size={28} color={Colors.danger} />
          <Text style={styles.emptyTitle}>Couldn't load GIFs</Text>
          <Text style={styles.emptySubtitle}>{errorMessage}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => fetchAssets(debounced, tab)}>
            <Text style={styles.retryButtonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.emptyState} testID="giphy-empty-state">
        <Feather name="image" size={28} color={Colors.textMuted} />
        <Text style={styles.emptyTitle}>No GIFs found</Text>
        <Text style={styles.emptySubtitle}>Try a different search.</Text>
      </View>
    );
  }, [debounced, errorMessage, fetchAssets, loading, refreshing, tab]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} testID="giphy-backdrop" />
        <Animated.View
          style={[styles.sheet, { transform: [{ translateY: slideAnimation }] }]}
          testID="giphy-sheet"
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.flexOne}
          >
            <View style={styles.handle} {...panResponder.panHandlers} />

            <View style={styles.headerRow}>
              <Text style={styles.title}>GIPHY</Text>
              <TouchableOpacity onPress={onClose} hitSlop={12} testID="giphy-close-button">
                <Ionicons name="close" size={26} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={styles.searchRow}>
              <Feather name="search" size={18} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search Giphy"
                placeholderTextColor={Colors.textMuted}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
                testID="giphy-search-input"
              />
              {query.length > 0 ? (
                <TouchableOpacity onPress={() => setQuery('')} hitSlop={12} testID="giphy-clear-search">
                  <Feather name="x-circle" size={18} color={Colors.textMuted} />
                </TouchableOpacity>
              ) : null}
            </View>

            <View style={styles.tabsRow}>
              <TabButton label="GIFs" active={tab === TAB_GIFS} onPress={() => setTab(TAB_GIFS)} testID="giphy-tab-gifs" />
              <TabButton label="Stickers" active={tab === TAB_STICKERS} onPress={() => setTab(TAB_STICKERS)} testID="giphy-tab-stickers" />
            </View>

            {!debounced ? (
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.tagsContent}
                data={POPULAR_TAGS}
                keyExtractor={(tag) => tag}
                renderItem={({ item: tagLabel }) => (
                  <TouchableOpacity
                    style={styles.tagPill}
                    onPress={() => setQuery(tagLabel)}
                    testID={`giphy-tag-${tagLabel}`}
                  >
                    <Text style={styles.tagPillText}>{tagLabel}</Text>
                  </TouchableOpacity>
                )}
              />
            ) : null}

            {loading && items.length === 0 ? (
              <View style={styles.loadingState} testID="giphy-loading-state">
                <ActivityIndicator color={Colors.primary} size="large" />
              </View>
            ) : (
              <FlatList
                data={items}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                numColumns={COLUMNS}
                columnWrapperStyle={styles.gridRow}
                contentContainerStyle={styles.gridContent}
                ListEmptyComponent={renderEmpty}
                onRefresh={handleRefresh}
                refreshing={refreshing}
                keyboardShouldPersistTaps="handled"
                testID="giphy-grid"
              />
            )}

            <View style={styles.attribution}>
              <Text style={styles.attributionText}>Powered by GIPHY</Text>
            </View>
          </KeyboardAvoidingView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function TabButton({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.tabButton, active ? styles.tabButtonActive : null]}
      testID={testID}
    >
      <Text style={[styles.tabButtonText, active ? styles.tabButtonTextActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdropWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    height: SHEET_HEIGHT,
    paddingBottom: Spacing.sm,
    overflow: 'hidden',
  },
  flexOne: { flex: 1 },
  handle: {
    alignSelf: 'center',
    width: 48,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.18)',
    marginTop: 8,
    marginBottom: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.sm,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
    letterSpacing: 0.5,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    paddingHorizontal: Spacing.base,
    paddingVertical: 10,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  tabsRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
  },
  tabButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tabButtonActive: {
    backgroundColor: Colors.headerBg,
    borderColor: Colors.headerBg,
  },
  tabButtonText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  tabButtonTextActive: {
    color: Colors.primary,
  },
  tagsContent: {
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.sm,
    gap: Spacing.sm,
  },
  tagPill: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primaryLight,
    marginRight: Spacing.sm,
  },
  tagPillText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    color: Colors.headerBg,
  },
  gridContent: {
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
    paddingBottom: Spacing.lg,
  },
  gridRow: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP,
  },
  tile: {
    backgroundColor: Colors.borderLight,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  tileOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xl,
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    gap: 6,
  },
  emptyTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginTop: 6,
  },
  emptySubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: Spacing.base,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  retryButtonText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
  attribution: {
    alignItems: 'center',
    paddingTop: 4,
  },
  attributionText: {
    fontSize: 10,
    color: Colors.textMuted,
    letterSpacing: 0.5,
  },
});

export type { GiphyAsset };
