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
  Image,
  Modal,
  StyleSheet,
  Text,
  TextInput,
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
import { getDisplayInitials, findSavedContactDisplayName, getDisplayNameFromUser } from '../../src/lib/displayName';
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
  // The backend's getFeed query server-side resolves storage IDs into
  // playable URLs and surfaces them as one of these fields (varies by
  // deployment version). The native UI just reads whichever is present.
  mediaUrl?: string;
  fileUrl?: string;
  url?: string;
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
  // iter-135: pull the user's saved contacts so we can map an
  // `authorId` to the human-readable name the user has saved
  // (e.g., "ABC INVESTOR") instead of falling back to the raw
  // `authorName` (which is often empty for users who never set a
  // display name in their profile, yielding "User" everywhere).
  // Mirrors the same lookup pattern used by chat/conversations.
  const devotionalContacts = useQuery(api.contacts.getContacts, me ? {} : 'skip') as any[] | undefined;
  const removeDevotional = useMutation((api as any).devotionals?.remove);
  const reportDevotional = useMutation((api as any).devotionals?.reportDevotional);
  // iter-292: admins can delete ANY devotion directly from the feed (no report
  // needed), with an OPTIONAL reason — mirroring the web app's moderation.
  const adminDeleteDevotional = useMutation((api as any).devotionals?.adminDelete);
  const [reportTarget, setReportTarget] = useState<DevotionalItem | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  // iter-292: admin-delete-any-devotion modal state.
  const [adminTarget, setAdminTarget] = useState<DevotionalItem | null>(null);
  const [adminReason, setAdminReason] = useState('');
  const [adminSubmitting, setAdminSubmitting] = useState(false);
  const isAdmin = !!(me && ((me as any).role === 'admin' || (me as any).isAdmin === true));

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

  const submitReport = useCallback(async () => {
    if (!reportTarget) return;
    const reason = reportReason.trim();
    if (!reason) {
      Alert.alert('Reason required', 'Please describe why you are reporting this devotion.');
      return;
    }
    setReportSubmitting(true);
    try {
      await (reportDevotional as any)({ devotionalId: reportTarget._id, reason });
      setReportTarget(null);
      setReportReason('');
      Alert.alert('Report submitted', 'Thanks — our admins will review this devotion.');
    } catch (errorValue: any) {
      const msg = String(errorValue?.data?.message || errorValue?.message || '');
      const code = String(errorValue?.data?.code || '');
      if (code === 'CONFLICT' || /already report/i.test(msg)) {
        Alert.alert('Already reported', 'You have already reported this devotion. It is pending review.');
        setReportTarget(null);
      } else if (code === 'BAD_REQUEST' || /reason|own/i.test(msg)) {
        Alert.alert('Could not report', msg || 'Reason is required, and you cannot report your own devotion.');
      } else {
        Alert.alert('Could not submit report', msg || 'Please try again.');
      }
    } finally {
      setReportSubmitting(false);
    }
  }, [reportTarget, reportReason, reportDevotional]);

  // iter-292: admin deletes ANY devotion (reason optional). Backend
  // `devotionals.adminDelete` is trustee/admin-gated server-side, so this is
  // safe even though we also hide the UI behind `isAdmin`.
  const submitAdminDelete = useCallback(async () => {
    if (!adminTarget) return;
    setAdminSubmitting(true);
    try {
      const reason = adminReason.trim();
      await (adminDeleteDevotional as any)({
        devotionalId: adminTarget._id,
        ...(reason ? { reason } : {}),
      });
      setAdminTarget(null);
      setAdminReason('');
      Alert.alert('Devotion deleted', 'The devotion has been removed for everyone.');
    } catch (errorValue: any) {
      const msg = String(errorValue?.data?.message || errorValue?.message || '');
      Alert.alert('Could not delete', msg || 'Please try again.');
    } finally {
      setAdminSubmitting(false);
    }
  }, [adminTarget, adminReason, adminDeleteDevotional]);

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
      // iter-135: resolve the author the same way the web app does —
      // saved-contact name takes precedence over the user's own
      // unset profile name. Falls back gracefully when there is no
      // saved contact for this author.
      const savedContactName = findSavedContactDisplayName(
        devotionalContacts,
        { _id: item.authorId, userId: item.authorId, name: item.authorName },
        me?._id || null,
      );
      const resolvedAuthorName =
        (isMine && me ? getDisplayNameFromUser(me, '') : '') ||
        savedContactName ||
        item.authorName ||
        'User';
      // Prefer a saved-contact photo, then the raw author's photo, before
      // falling back to the initials avatar (kept identical to the web).
      const contactRecord = (devotionalContacts || []).find((c: any) => {
        const ids = [c?.userId, c?.user?._id, c?._id, c?.contactUserId].filter(Boolean);
        return ids.includes(item.authorId);
      });
      const authorPhoto: string | undefined =
        (isMine ? (me as any)?.profilePicture || (me as any)?.avatarUrl : undefined) ||
        contactRecord?.profilePicture ||
        contactRecord?.user?.profilePicture ||
        contactRecord?.avatarUrl ||
        (item as any).authorPhoto ||
        (item as any).authorProfilePicture;
      const authorInitials = getDisplayInitials(resolvedAuthorName, 1);
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
            {authorPhoto ? (
              <Image source={{ uri: authorPhoto }} style={styles.avatarImg} />
            ) : (
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{authorInitials}</Text>
              </View>
            )}
            <View style={styles.flexOne}>
              <Text style={styles.authorName} numberOfLines={1}>
                {resolvedAuthorName}
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
            ) : (
              <TouchableOpacity
                onPress={() => {
                  if (isAdmin) {
                    // Admin: choose between reporting or deleting outright.
                    Alert.alert('Devotion options', undefined, [
                      { text: 'Report', onPress: () => { setReportReason(''); setReportTarget(item); } },
                      {
                        text: 'Delete (Admin)',
                        style: 'destructive',
                        onPress: () => { setAdminReason(''); setAdminTarget(item); },
                      },
                      { text: 'Cancel', style: 'cancel' },
                    ]);
                  } else {
                    setReportReason('');
                    setReportTarget(item);
                  }
                }}
                hitSlop={12}
                style={styles.menuBtn}
                testID={`devotional-report-${item._id}`}
              >
                <Feather name={isAdmin ? 'more-vertical' : 'flag'} size={isAdmin ? 18 : 16} color={Colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>

          {item.title ? <Text style={styles.cardTitle}>{item.title}</Text> : null}

          {(item.type === 'voice' || item.type === 'video') ? (
            <DevotionalMediaPlayer
              key={`${item._id}-media`}
              storageId={item.storageId}
              mediaUrl={item.mediaUrl || item.fileUrl || item.url || null}
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
    [me, noTranslateLangs, onDelete, preferredLanguage, devotionalContacts, isAdmin],
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

      <Modal
        visible={!!reportTarget}
        transparent
        animationType="fade"
        onRequestClose={() => (!reportSubmitting ? setReportTarget(null) : undefined)}
      >
        <View style={styles.reportBackdrop}>
          <View style={styles.reportCard} testID="devotional-report-modal">
            <View style={styles.reportHeaderRow}>
              <Feather name="flag" size={20} color={Colors.danger} />
              <Text style={styles.reportTitle}>Report devotion</Text>
            </View>
            <Text style={styles.reportHelp}>
              Tell our admins why you&apos;re reporting this. A reason is required.
            </Text>
            <TextInput
              style={styles.reportInput}
              value={reportReason}
              onChangeText={setReportReason}
              placeholder="Reason (e.g. inappropriate, spam, offensive)…"
              placeholderTextColor={Colors.textMuted}
              multiline
              maxLength={500}
              editable={!reportSubmitting}
              testID="devotional-report-input"
            />
            <View style={styles.reportBtnRow}>
              <TouchableOpacity
                style={[styles.reportBtn, styles.reportCancelBtn]}
                onPress={() => setReportTarget(null)}
                disabled={reportSubmitting}
                testID="devotional-report-cancel"
              >
                <Text style={styles.reportCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.reportBtn, styles.reportSubmitBtn, (!reportReason.trim() || reportSubmitting) && styles.reportBtnDisabled]}
                onPress={submitReport}
                disabled={!reportReason.trim() || reportSubmitting}
                testID="devotional-report-submit"
              >
                <Text style={styles.reportSubmitText}>{reportSubmitting ? 'Submitting…' : 'Submit report'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* iter-292: admin delete-any-devotion modal (reason optional). */}
      <Modal
        visible={!!adminTarget}
        transparent
        animationType="fade"
        onRequestClose={() => (!adminSubmitting ? setAdminTarget(null) : undefined)}
      >
        <View style={styles.reportBackdrop}>
          <View style={styles.reportCard} testID="devotional-admin-delete-modal">
            <View style={styles.reportHeaderRow}>
              <Feather name="trash-2" size={20} color={Colors.danger} />
              <Text style={styles.reportTitle}>Delete devotion (Admin)</Text>
            </View>
            <Text style={styles.reportHelp}>
              This removes the devotion from everyone&apos;s feed. A reason is optional.
            </Text>
            <TextInput
              style={styles.reportInput}
              value={adminReason}
              onChangeText={setAdminReason}
              placeholder="Reason (optional)…"
              placeholderTextColor={Colors.textMuted}
              multiline
              maxLength={500}
              editable={!adminSubmitting}
              testID="devotional-admin-delete-input"
            />
            <View style={styles.reportBtnRow}>
              <TouchableOpacity
                style={[styles.reportBtn, styles.reportCancelBtn]}
                onPress={() => setAdminTarget(null)}
                disabled={adminSubmitting}
                testID="devotional-admin-delete-cancel"
              >
                <Text style={styles.reportCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.reportBtn, styles.reportSubmitBtn, adminSubmitting && styles.reportBtnDisabled]}
                onPress={submitAdminDelete}
                disabled={adminSubmitting}
                testID="devotional-admin-delete-submit"
              >
                <Text style={styles.reportSubmitText}>{adminSubmitting ? 'Deleting…' : 'Delete'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  avatarImg: { width: 40, height: 40, borderRadius: 20, backgroundColor: DEVOTION_ACCENT },
  authorName: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaIcon: { marginRight: 2 },
  sentAt: { fontSize: FontSize.xs, color: Colors.textMuted },
  menuBtn: { padding: 4, marginLeft: 4 },
  reportBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: Spacing.lg },
  reportCard: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.sm },
  reportHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reportTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  reportHelp: { fontSize: FontSize.sm, color: Colors.textSecondary },
  reportInput: {
    minHeight: 90,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    padding: Spacing.base,
    color: Colors.textPrimary,
    fontSize: FontSize.base,
    textAlignVertical: 'top',
    marginTop: 4,
  },
  reportBtnRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  reportBtn: { flex: 1, paddingVertical: 12, borderRadius: Radius.md, alignItems: 'center' },
  reportCancelBtn: { backgroundColor: Colors.borderLight },
  reportCancelText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  reportSubmitBtn: { backgroundColor: Colors.danger },
  reportSubmitText: { fontSize: FontSize.base, color: '#FFFFFF', fontWeight: FontWeight.bold },
  reportBtnDisabled: { opacity: 0.5 },
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
