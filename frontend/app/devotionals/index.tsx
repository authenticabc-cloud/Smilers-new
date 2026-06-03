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
import { LinearGradient } from 'expo-linear-gradient';

import { api } from '../../src/convexApi';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';
import { chooseDisplayText, readNoTranslateLangs } from '../../src/lib/devotionalsLocalPrefs';
import { getLanguageByCode } from '../../src/lib/languages';
import { getDisplayInitials } from '../../src/lib/displayName';
import DevotionalMediaPlayer from '../../src/components/DevotionalMediaPlayer';
import { recordDiagnostic } from '../../src/lib/diagnostics';
import { useReactiveSafeConvexQuery } from '../../src/hooks/useReactiveSafeConvexQuery';

// Module-evaluation marker: records the very first signal that this file
// was loaded by the JS bundle. If we see this in the backend diagnostics
// stream but DON'T see the matching MOUNT row, the crash is happening
// somewhere between module load and the first render — usually in a
// useQuery / useMutation hook initialization.
try {
  recordDiagnostic({
    tag: 'BOOT',
    source: 'devotionals/index',
    message: 'module evaluated',
  });
} catch {
  /* swallow — diagnostics is best-effort */
}

// Yellow accent matching the web app's devotional CTA + play button colour
// (iter-102). Used for FAB, play button, active filter highlight, and the
// "Save Preferences" button. Kept local because it's specific to this
// feature\u2019s brand palette \u2014 doesn't pollute the global theme.
const DEVOTION_ACCENT = '#FACC15';
const DEVOTION_ACCENT_DARK = '#EAB308';

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

  // Mount marker — if we see BOOT but not MOUNT in the diagnostics stream,
  // the crash is in a top-level hook call (useQuery / useMutation) before
  // the component returns its first JSX. If we see MOUNT but not RENDER,
  // it's in renderItem or a child component.
  React.useEffect(() => {
    try {
      recordDiagnostic({
        tag: 'BOOT',
        source: 'devotionals/index',
        message: 'screen mounted',
      });
    } catch {}
  }, []);

  const { data: feedResult, error: feedError } = useReactiveSafeConvexQuery<{ page?: DevotionalItem[] } | DevotionalItem[] | null>(
    (api as any).devotionals?.getFeed,
    { paginationOpts: { numItems: FEED_PAGE_SIZE, cursor: null } },
    null,
  );
  const { data: viewerLanguage } = useReactiveSafeConvexQuery<any>(
    (api as any).devotionals?.getViewerLanguage,
    {},
    null,
  );
  const me = useQuery(api.users.getCurrentUser);
  const removeDevotional = useMutation((api as any).devotionals?.remove);

  // Log feed errors so we can see them server-side without crashing the UI.
  useEffect(() => {
    if (feedError) {
      try {
        recordDiagnostic({
          tag: 'ERR',
          source: 'devotionals/index',
          message: `getFeed failed: ${feedError.message?.slice(0, 240) || 'unknown'}`,
        });
      } catch {}
    }
  }, [feedError]);

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
      // Relative time ("3 hours ago") to match the web app's caption.
      const sentAt = item._creationTime ? formatRelativeTime(item._creationTime) : '';
      const typeIconName: any =
        item.type === 'voice'
          ? 'microphone'
          : item.type === 'video'
            ? 'video'
            : 'text-box-outline';

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
              <View style={styles.metaRow}>
                <MaterialCommunityIcons
                  name={typeIconName}
                  size={13}
                  color={Colors.textMuted}
                  style={styles.metaIcon}
                />
                <Text style={styles.sentAt}>{sentAt}</Text>
              </View>
            </View>
            {isMine ? (
              <TouchableOpacity
                onPress={() => onDelete(item)}
                hitSlop={12}
                style={styles.menuBtn}
                testID={`devotional-menu-${item._id}`}
              >
                <Feather name="more-vertical" size={18} color={Colors.textMuted} />
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
              accentColor={DEVOTION_ACCENT}
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
      {/* Dark brown gradient header — matches the web app design exactly
          (iter-102 user screenshot). Includes back arrow + title +
          subtitle on left, and the filter funnel icon on the right. */}
      <LinearGradient
        colors={[Colors.devotionHeaderTop, Colors.devotionHeaderBottom]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.header}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={12}
          testID="devotionals-back"
        >
          <Feather name="arrow-left" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>Devotionals</Text>
          <Text style={styles.headerSubtitle}>Share and receive daily inspiration</Text>
        </View>
        <TouchableOpacity
          onPress={onPreferences}
          hitSlop={12}
          testID="devotionals-preferences"
          style={styles.headerActionBtn}
        >
          <Feather name="filter" size={18} color="#FFFFFF" />
        </TouchableOpacity>
      </LinearGradient>

      <FlatList
        data={items}
        keyExtractor={(item) => item._id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.emptyWrap} testID="devotionals-loading">
              <ActivityIndicator color={DEVOTION_ACCENT} />
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

      {/* Yellow FAB to match web design (replaces the green primary FAB
          we shipped in iter-100). */}
      <TouchableOpacity
        onPress={onCompose}
        style={styles.fab}
        testID="devotionals-compose-fab"
      >
        <Feather name="plus" size={26} color="#1F1208" />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

/**
 * Format a timestamp into a "X minutes/hours/days ago" string that
 * matches the web app's caption ("about 3 hours ago"). Falls back to
 * a localised date/time when older than 7 days so it doesn't say
 * "about 47 days ago".
 */
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) {
    const m = Math.round(diff / minute);
    return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  }
  if (diff < day) {
    const h = Math.round(diff / hour);
    return `about ${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  if (diff < 7 * day) {
    const d = Math.round(diff / day);
    return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  }
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  // Dark brown gradient header — matches web app exactly. White text +
  // white icons. The headerTextWrap consumes the middle space so the
  // filter button sits flush against the right edge.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingTop: 14,
    paddingBottom: 18,
    gap: 14,
  },
  headerTextWrap: { flex: 1 },
  headerTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: '#FFFFFF',
  },
  headerSubtitle: {
    marginTop: 2,
    fontSize: FontSize.xs,
    color: 'rgba(255, 255, 255, 0.78)',
  },
  headerActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
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
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: DEVOTION_ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#1F1208', fontWeight: FontWeight.bold, fontSize: FontSize.base },
  authorName: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaIcon: { marginRight: 2 },
  sentAt: { fontSize: FontSize.xs, color: Colors.textMuted },
  menuBtn: { padding: 4, marginLeft: 4 },
  cardTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginTop: 4,
    marginBottom: 6,
  },
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
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  emptyHint: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: DEVOTION_ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  flexOne: { flex: 1 },
});
