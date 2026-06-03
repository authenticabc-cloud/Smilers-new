/**
 * Devotional Broadcasts — Feed
 *
 * Lists devotional broadcasts (text / voice / video) from the user's
 * network, automatically translated to the user's preferred language
 * UNLESS the source language is in their "don't translate" list.
 *
 * Backend endpoints used (per /app spec):
 *   - api.devotionals.getFeed({paginationOpts})         → paginated feed
 *   - api.devotionals.getPreferences()                  → feed filter
 *   - api.devotionals.getViewerLanguage()               → preferred lang
 *   - api.devotionals.remove({devotionalId})            → delete own
 *   - api.files.getUrl({storageId})                     → resolve media
 *
 * Local-only preference (AsyncStorage):
 *   - noTranslateLangs[]                                → per-device list
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';

import { api } from '../../src/convexApi';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';
import { chooseDisplayText, readNoTranslateLangs } from '../../src/lib/devotionalsLocalPrefs';
import { getLanguageByCode } from '../../src/lib/languages';
import { getDisplayInitials } from '../../src/lib/displayName';
import DevotionalMediaPlayer from '../../src/components/DevotionalMediaPlayer';

type DevotionalItem = {
  _id: string;
  authorId: string;
  authorName?: string;
  authorAvatar?: string;
  type: 'text' | 'voice' | 'video';
  text?: string;
  title?: string;
  storageId?: string;
  duration?: number;
  mimeType?: string;
  fileSize?: number;
  detectedLanguage?: string;
  translations?: Record<string, string>;
  _creationTime?: number;
};

// Fetch all visible devotionals in one call. Convex paginated queries
// vary deployment-to-deployment, but `getFeed` typically accepts a
// `{paginationOpts: { numItems, cursor }}` shape. For an MVP feed we
// just ask for the first 50 — enough for a daily devotional cadence.
const FEED_PAGE_SIZE = 50;

export default function DevotionalsFeedScreen() {
  const router = useRouter();

  const feedResult = useQuery((api as any).devotionals?.getFeed, {
    paginationOpts: { numItems: FEED_PAGE_SIZE, cursor: null },
  });
  const viewerLanguage = useQuery((api as any).devotionals?.getViewerLanguage, {});
  const me = useQuery(api.users.getCurrentUser);
  const removeDevotional = useMutation((api as any).devotionals?.remove);

  // Local-only "no translate these source languages" preference.
  const [noTranslateLangs, setNoTranslateLangs] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const langs = await readNoTranslateLangs();
      if (!cancelled) setNoTranslateLangs(langs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever the user comes BACK from the preferences screen, refresh.
  // Router.canGoBack focus isn't a built-in expo-router hook, so we
  // rely on an interval safe-guard — cheap, no UI cost.
  useEffect(() => {
    const id = setInterval(async () => {
      const next = await readNoTranslateLangs();
      setNoTranslateLangs((prev) => {
        const same = prev.length === next.length && prev.every((p, i) => p === next[i]);
        return same ? prev : next;
      });
    }, 4000);
    return () => clearInterval(id);
  }, []);

  const preferredLanguage = useMemo(() => {
    if (viewerLanguage && typeof (viewerLanguage as any).preferredLanguage === 'string') {
      return (viewerLanguage as any).preferredLanguage;
    }
    if (me && typeof (me as any).preferredLanguage === 'string') {
      return (me as any).preferredLanguage;
    }
    return 'en';
  }, [viewerLanguage, me]);

  const items: DevotionalItem[] = useMemo(() => {
    if (!feedResult) return [];
    // Convex paginated queries return { page, isDone, continueCursor }.
    if (Array.isArray((feedResult as any).page)) return (feedResult as any).page as DevotionalItem[];
    if (Array.isArray(feedResult as any)) return (feedResult as any) as DevotionalItem[];
    return [];
  }, [feedResult]);

  const isLoading = feedResult === undefined;

  const onCompose = useCallback(() => {
    router.push('/devotionals/compose' as any);
  }, [router]);

  const onPreferences = useCallback(() => {
    router.push('/devotionals/preferences' as any);
  }, [router]);

  const onDelete = useCallback(
    async (devotional: DevotionalItem) => {
      Alert.alert(
        'Delete devotional?',
        'This will remove your broadcast from everyone\u2019s feed.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await (removeDevotional as any)({ devotionalId: devotional._id });
              } catch (errorValue: any) {
                Alert.alert('Failed to delete', errorValue?.message || 'Unknown error');
              }
            },
          },
        ],
      );
    },
    [removeDevotional],
  );

  const renderItem = useCallback(
    ({ item }: { item: DevotionalItem }) => {
      const isMine = me?._id && item.authorId === me._id;
      const { text: displayText, translatedFrom } = chooseDisplayText({
        originalText: item.text || '',
        detectedLanguage: item.detectedLanguage,
        preferredLanguage,
        translations: item.translations,
        noTranslateLangs,
      });
      const authorInitials = getDisplayInitials(item.authorName || 'User', 1);
      const sentAt = item._creationTime
        ? new Date(item._creationTime).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';

      return (
        <View style={styles.card} testID={`devotional-card-${item._id}`}>
          <View style={styles.cardHeader}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{authorInitials}</Text>
            </View>
            <View style={styles.flexOne}>
              <Text style={styles.authorName} numberOfLines={1}>
                {item.authorName || 'User'}
              </Text>
              <Text style={styles.sentAt}>{sentAt}</Text>
            </View>
            <View style={styles.typeBadge}>
              <MaterialCommunityIcons
                name={
                  item.type === 'voice'
                    ? 'microphone-outline'
                    : item.type === 'video'
                      ? 'video-outline'
                      : 'text-box-outline'
                }
                size={14}
                color={Colors.primary}
              />
              <Text style={styles.typeBadgeText}>{item.type}</Text>
            </View>
            {isMine ? (
              <TouchableOpacity
                onPress={() => onDelete(item)}
                hitSlop={12}
                style={styles.deleteBtn}
                testID={`devotional-delete-${item._id}`}
              >
                <Feather name="trash-2" size={16} color={Colors.danger} />
              </TouchableOpacity>
            ) : null}
          </View>

          {item.title ? <Text style={styles.cardTitle}>{item.title}</Text> : null}

          {(item.type === 'voice' || item.type === 'video') && item.storageId ? (
            <DevotionalMediaPlayer
              key={`${item._id}-media`}
              storageId={item.storageId}
              type={item.type}
              durationSec={item.duration}
              mimeType={item.mimeType}
            />
          ) : null}

          {displayText ? <Text style={styles.cardBody}>{displayText}</Text> : null}

          {translatedFrom ? (
            <View style={styles.translatedPill}>
              <Feather name="globe" size={11} color={Colors.textSecondary} />
              <Text style={styles.translatedText}>
                Translated from {getLanguageByCode(translatedFrom)?.name || translatedFrom}
              </Text>
            </View>
          ) : null}
        </View>
      );
    },
    [me?._id, noTranslateLangs, onDelete, preferredLanguage],
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={12}
          testID="devotionals-back"
        >
          <Feather name="arrow-left" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Devotionals</Text>
        <TouchableOpacity
          onPress={onPreferences}
          hitSlop={12}
          testID="devotionals-preferences"
        >
          <Feather name="sliders" size={20} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item._id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.emptyWrap} testID="devotionals-loading">
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : (
            <View style={styles.emptyWrap} testID="devotionals-empty">
              <MaterialCommunityIcons name="hands-pray" size={40} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No devotionals yet</Text>
              <Text style={styles.emptyHint}>
                Tap the + button to broadcast a devotion in text, voice, or video.
              </Text>
            </View>
          )
        }
      />

      <TouchableOpacity
        onPress={onCompose}
        style={styles.fab}
        testID="devotionals-compose-fab"
      >
        <Feather name="plus" size={26} color={Colors.white} />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  listContent: { padding: Spacing.base, paddingBottom: 80 },
  card: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    marginBottom: 12,
    ...Shadow.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.white, fontWeight: FontWeight.bold },
  authorName: { fontSize: FontSize.base, fontWeight: FontWeight.semiBold, color: Colors.textPrimary },
  sentAt: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: '#E6F8EC',
  },
  typeBadgeText: { fontSize: FontSize.xs, color: Colors.primary, textTransform: 'capitalize' },
  deleteBtn: { marginLeft: 4, padding: 4 },
  cardTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semiBold, color: Colors.textPrimary, marginBottom: 6 },
  cardBody: { fontSize: FontSize.base, color: Colors.textPrimary, lineHeight: 22, marginTop: 8 },
  translatedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: Colors.background,
  },
  translatedText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontStyle: 'italic' },
  emptyWrap: {
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: Spacing.base,
    gap: 10,
  },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semiBold, color: Colors.textPrimary },
  emptyHint: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  flexOne: { flex: 1 },
});
