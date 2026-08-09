import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  Pressable,
  Animated,
  ActivityIndicator,
  TextInput,
  Keyboard,
  Platform,
  Alert,
  FlatList,
  Modal,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { setAudioModeAsync as setExpoAudioModeAsync } from 'expo-audio';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../src/lib/deviceContactIndex';
import { getResolvedDisplayName, getSavedContactRecord } from '../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';
import { recordDiagnostic } from '../../src/lib/diagnostics';
import ScreenErrorBoundary from '../../src/components/ScreenErrorBoundary';
import ZoomableImage from '../../src/components/ZoomableImage';


// Background palette for editing a text status (mirrors the composer).
const STATUS_BG_PRESETS = [
  { id: 'amber', bg: '#F4A93B', fg: '#FFFFFF' },
  { id: 'brown', bg: '#3A2608', fg: '#FBC871' },
  { id: 'rose', bg: '#E11D48', fg: '#FFFFFF' },
  { id: 'violet', bg: '#7C3AED', fg: '#FFFFFF' },
  { id: 'emerald', bg: '#059669', fg: '#FFFFFF' },
  { id: 'ocean', bg: '#0EA5E9', fg: '#FFFFFF' },
  { id: 'slate', bg: '#1F2937', fg: '#FBC871' },
  { id: 'cream', bg: '#F5EFE0', fg: '#3A2608' },
];

// iter-135: module-evaluation marker so we can correlate a crash on
// "Smilers has stopped" with whichever screen the user opened last.
try {
  recordDiagnostic({
    tag: 'BOOT',
    source: 'status-view/[userId]',
    message: 'module evaluated',
  });
} catch {
  /* swallow */
}

const DEFAULT_DURATION_MS = 5000;
const MAX_VIDEO_DURATION_MS = 30000;
// iter-317: WhatsApp-style quick status reactions (sent as a status-reply DM).
const STATUS_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// iter-267: the web status contract exposes type under `type` OR `kind`, text
// under `content` OR `text`, and colors under `backgroundColor`/`textColor` OR
// `palette.{background,text}`. The native viewer previously only read `type`/
// `text`, so text statuses (e.g. "Only God is our helper") fell through to the
// media branch and showed "Couldn't load this media". These tolerant readers
// fix that regardless of which alias the backend sends.
function readStoryType(s: any): string {
  const raw = s?.type || s?.kind;
  if (raw) return String(raw).toLowerCase();
  const hasMedia =
    s?.mediaUrl || s?.url || s?.uri || s?.src || s?.media ||
    s?.imageUrl || s?.videoUrl || s?.fileUrl || s?.storageId;
  return hasMedia ? 'image' : 'text';
}
function readStoryText(s: any): string {
  return String(s?.text ?? s?.content ?? '');
}
function readStoryBg(s: any): string {
  return s?.backgroundColor || s?.palette?.background || '#3A2608';
}
function readStoryFg(s: any): string {
  return s?.textColor || s?.palette?.text || '#FFFFFF';
}


export default function StatusViewScreen() {
  // iter-149: wrap the inner screen in an ErrorBoundary so a render
  // crash (e.g. an unexpected story shape from the server, a broken
  // hook order under React 19, etc.) shows a friendly fallback INSTEAD
  // of taking down the whole app with "Smilers has stopped".
  // The inner component is below — same code path as before.
  const router = useRouter();
  return (
    <ScreenErrorBoundary screenName="status-view" onClose={() => router.back()}>
      <StatusViewScreenInner />
    </ScreenErrorBoundary>
  );
}

function StatusViewScreenInner() {
  const router = useRouter();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const targetUserId = userId === 'me' ? undefined : userId;

  const myStories = useQuery(api.statuses.getMyStatuses, userId === 'me' ? {} : 'skip');
  // iter-150: `statuses.listForUser` returns "Server Error - Called by
  // client" on this Convex deployment. Probe canonical aliases in
  // priority order and stop at the first one that returns data.
  const otherStoriesA = useSafeConvexQuery<any>(
    (api as any).statuses?.listForUser,
    targetUserId ? { userId: targetUserId } : {},
    null,
    !!targetUserId,
  );
  const otherStoriesB = useSafeConvexQuery<any>(
    (api as any).statuses?.listByUser,
    targetUserId ? { userId: targetUserId } : {},
    null,
    !!targetUserId && !otherStoriesA.data && !otherStoriesA.loading,
  );
  // iter-267: web contract confirmed — `listForUser`/`listByUser` are the real
  // per-user queries and both return an ARRAY OF GROUPS (read the matching
  // group's `stories`). `getUserStatuses`/`listForOther` don't exist; replaced
  // the last probe with `listStatusGroups` (the same query the working list tab
  // uses) as a bulletproof fallback. All return media URLs ALREADY resolved
  // server-side under `mediaUrl`/`url`/… aliases — no storageId resolution.
  const otherStoriesC = useSafeConvexQuery<any>(
    (api as any).statuses?.listStatusGroups,
    {},
    null,
    !!targetUserId &&
      !otherStoriesA.data &&
      !otherStoriesA.loading &&
      !otherStoriesB.data &&
      !otherStoriesB.loading,
  );
  const otherStories =
    otherStoriesA.data || otherStoriesB.data || otherStoriesC.data || null;
  const me = useQuery(api.users.getCurrentUser);
  // iter-239: resolve status author / viewer names from the device address
  // book (e.g. "ABC Albania") instead of the Smilers/Google account name —
  // mirrors the chats list behaviour. Falls back to the Smilers name when no
  // device contact matches.
  const myContacts = useQuery(api.contacts.getContacts, {}) as any[] | undefined;
  const deviceIndex = useDeviceContactIndex();
  const resolveContactName = useCallback(
    (entityUserId: string | null | undefined, fallbackName: string, extra?: any): string => {
      const fallback = fallbackName && fallbackName.trim() ? fallbackName : 'User';
      const saved = entityUserId
        ? getSavedContactRecord(myContacts, { userId: entityUserId }, me?._id)
        : null;
      const record = saved || { _id: entityUserId, name: fallback, ...(extra || {}) };
      return getResolvedDisplayName(record, deviceIndex, lookupDeviceContactName, fallback);
    },
    [myContacts, me, deviceIndex],
  );

  const stories: any[] = useMemo(() => {
    const source: any = userId === 'me' ? myStories : otherStories;
    if (!source) return [];
    const pickStories = (g: any): any[] =>
      g?.stories || g?.statuses || g?.items || [];
    if (Array.isArray(source)) {
      // `getMyStatuses` → flat array of stories. `listForUser`/`listByUser`/
      // `listStatusGroups` → array of GROUPS. Detect groups by a nested
      // stories array and pick the one matching this user (else the first).
      const looksGrouped =
        source.length > 0 &&
        (Array.isArray(source[0]?.stories) ||
          Array.isArray(source[0]?.statuses) ||
          Array.isArray(source[0]?.items));
      if (looksGrouped) {
        const grp =
          source.find((g: any) => String(g?.userId) === String(targetUserId)) || source[0];
        return pickStories(grp);
      }
      return source; // flat stories
    }
    return pickStories(source);
  }, [userId, myStories, otherStories, targetUserId]);

  const isMine = userId === 'me';
  const author: any = useMemo(() => {
    if (isMine) return { name: 'You', _id: me?._id };
    const src: any = otherStories;
    const grp = Array.isArray(src)
      ? src.find((g: any) => String(g?.userId) === String(targetUserId)) || src[0]
      : src;
    const smilersName = (grp && (grp.name || grp.userName)) || 'User';
    const extra = grp ? { phoneE164: grp.phoneE164, phone: grp.phone } : undefined;
    const resolved = resolveContactName(targetUserId, String(smilersName), extra);
    const avatarUrl = grp ? grp.avatarUrl : undefined;
    return { name: resolved, _id: targetUserId, avatarUrl };
  }, [isMine, otherStories, me, targetUserId, resolveContactName]);

  const markViewed = useMutation(api.statuses.markViewed);
  const sendMessage = useMutation(api.messages.send);
  const getOrCreateDM = useMutation(api.conversations.getOrCreateDirect);
  // Backend mutations shipped by the web team: `statuses.deleteStatus` and
  // `statuses.editStatus` (author-only; edit does not reset the 24h expiry).
  const deleteStatus = useMutation((api as any).statuses.deleteStatus);
  const editStatus = useMutation((api as any).statuses.editStatus);
  const onDeleteStatus = useCallback(() => {
    if (!isMine || !current?._id) return;
    Alert.alert('Delete status?', 'This status will be removed for everyone who can see it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await (deleteStatus as any)({ statusId: current._id });
            router.back();
          } catch (errorValue: any) {
            const msg = String(errorValue?.message || '');
            if (msg.includes('CouldNotFindFunction') || msg.toLowerCase().includes('not found')) {
              Alert.alert(
                'Not available yet',
                'Deleting a status needs a backend update that hasn\u2019t shipped yet.',
              );
            } else {
              Alert.alert('Could not delete', msg || 'Please try again.');
            }
          }
        },
      },
    ]);
  }, [isMine, current, deleteStatus, router]);

  // --- Edit my status ---
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editBgIdx, setEditBgIdx] = useState(0);
  const [savingEdit, setSavingEdit] = useState(false);
  const openEdit = useCallback(() => {
    if (!isMine || !current?._id) return;
    setEditText(String(current?.content || current?.caption || ''));
    const bg = String(current?.backgroundColor || '').toLowerCase();
    const foundIdx = STATUS_BG_PRESETS.findIndex((p) => p.bg.toLowerCase() === bg);
    setEditBgIdx(foundIdx >= 0 ? foundIdx : 0);
    setEditing(true);
  }, [isMine, current]);
  const saveEdit = useCallback(async () => {
    if (!current?._id) return;
    const value = editText.trim();
    const isText = String(current?.type) === 'text';
    if (isText && !value) return;
    setSavingEdit(true);
    try {
      const palette = STATUS_BG_PRESETS[editBgIdx];
      const args: any = isText
        ? { statusId: current._id, content: value, backgroundColor: palette.bg, textColor: palette.fg }
        : { statusId: current._id, caption: value };
      await (editStatus as any)(args);
      setEditing(false);
    } catch (errorValue: any) {
      const msg = String(errorValue?.message || '');
      if (msg.includes('CouldNotFindFunction') || msg.toLowerCase().includes('not found')) {
        Alert.alert('Not available yet', 'Editing a status needs a backend update that hasn\u2019t shipped yet.');
      } else {
        Alert.alert('Could not save', msg || 'Please try again.');
      }
    } finally {
      setSavingEdit(false);
    }
  }, [current, editText, editBgIdx, editStatus]);

  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [currentImageUri, setCurrentImageUri] = useState<string | null>(null);
  const [showZoom, setShowZoom] = useState(false);
  const closeZoom = useCallback(() => {
    setShowZoom(false);
    setPaused(false);
  }, []);
  const [reply, setReply] = useState('');
  const [showViewers, setShowViewers] = useState(false);
  // iter-315: KeyboardAvoidingView is unreliable on Android edge-to-edge (the
  // window doesn't resize) and breaks with the Modals rendered here, so the
  // reply box stayed hidden behind the keyboard. Track the keyboard height via
  // the Keyboard API and lift the reply bar deterministically instead.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e: any) => {
      setKeyboardHeight(e?.endCoordinates?.height || 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  const progress = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const videoPlayerRef = useRef<VideoPlayer | null>(null);
  // iter-268: guard so markViewed fires AT MOST once per status id. Marking
  // a status viewed mutates the Convex data, which hands back a NEW `current`
  // object reference; the old effect keyed on `current` then re-fired
  // markViewed AND reset the progress bar to 0 on every data echo — so the
  // bar never filled and the story never auto-advanced/closed.
  const viewedRef = useRef<Set<string>>(new Set());

  const current = stories[idx];
  const total = stories.length;

  useEffect(() => {
    // iter-149: setAudioModeAsync is iOS-only — `playsInSilentMode`
    // doesn't exist on Android and has been reported to fault under
    // certain expo-audio versions. Skip the call entirely on Android.
    if (Platform.OS !== 'ios') return;
    try {
      setExpoAudioModeAsync({ playsInSilentMode: true } as any).catch((errorValue: any) => {
        try {
          recordDiagnostic({
            tag: 'WARN',
            source: 'status-view/[userId]',
            message: `setAudioModeAsync failed: ${errorValue?.message?.slice(0, 160) || 'unknown'}`,
          });
        } catch {}
      });
    } catch (errorValue: any) {
      try {
        recordDiagnostic({
          tag: 'WARN',
          source: 'status-view/[userId]',
          message: `setAudioModeAsync threw: ${errorValue?.message?.slice(0, 160) || 'unknown'}`,
        });
      } catch {}
    }
    // iter-135: MOUNT diagnostic so we can correlate a crash to the
    // exact userId the user tapped.
    try {
      recordDiagnostic({
        tag: 'MOUNT',
        source: 'status-view/[userId]',
        message: `userId=${String(userId).slice(0, 32)}`,
      });
    } catch {}
  }, [userId]);

  const goNext = useCallback(() => {
    if (idx < total - 1) setIdx((currentIndex) => currentIndex + 1);
    else router.back();
  }, [idx, total, router]);

  const goPrev = useCallback(() => {
    if (idx > 0) setIdx((currentIndex) => currentIndex - 1);
    else router.back();
  }, [idx, router]);

  useEffect(() => {
    if (!current || isMine) return;
    const key = String(current._id || current.id || current.statusId || '');
    if (!key || viewedRef.current.has(key)) return;
    viewedRef.current.add(key);
    markViewed({ statusId: current._id || current.id || current.statusId }).catch(() => {});
    // iter-339: key on the CURRENT status id (not just `idx`) so the mark fires
    // once the stories array finishes loading AFTER mount — previously the
    // effect only depended on [idx, isMine], so if `current` was still
    // undefined on the first render (async Convex fetch) it exited early and
    // never re-ran, leaving the first/only status never marked viewed ("views
    // not counting"). The `viewedRef` per-id guard still prevents a data echo
    // from the mutation re-firing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, isMine, current?._id, current?.id, current?.statusId]);

  useEffect(() => {
    if (!current) return;

    progress.setValue(0);
    if (paused) return;

    let duration = DEFAULT_DURATION_MS;
    if (readStoryType(current) === 'video') {
      const seconds = current.duration && current.duration > 1000 ? current.duration / 1000 : current.duration || 5;
      duration = Math.min(MAX_VIDEO_DURATION_MS, seconds * 1000);
    }

    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      useNativeDriver: false,
    });
    animRef.current = animation;
    animation.start(({ finished }) => {
      if (finished) goNext();
    });

    return () => {
      if (animRef.current) {
        animRef.current.stop();
      }
    };
    // iter-268: depend on `idx`/`paused`/`total` — NOT the `current` object.
    // markViewed (and other Convex echoes) hand back a fresh `current`
    // reference on every render; keying on it reset the progress bar to 0
    // continuously so it never filled and never fired goNext (no
    // auto-advance / auto-close). `idx` uniquely identifies the active slide;
    // `total` re-arms the timer once stories finish loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, paused, total]);

  useEffect(() => {
    const video = videoPlayerRef.current;
    if (!video) return;
    try {
      if (paused) {
        video.pause();
      } else {
        video.play();
      }
    } catch {}
  }, [paused]);

  const onPressIn = () => setPaused(true);
  const onPressOut = () => setPaused(false);

  const sendReplyText = useCallback(
    async (text: string) => {
      const trimmed = (text || '').trim();
      if (!trimmed || isMine || !targetUserId) return;
      try {
        const conversation: any = await getOrCreateDM({ otherUserId: targetUserId });
        const conversationId = typeof conversation === 'string' ? conversation : conversation?._id || conversation?.conversationId;
        if (!conversationId) throw new Error('No conversation');

        // iter-317: the poster receives status replies as a plain DM and could
        // not tell WHICH status (or that it was a status reply at all). Prepend
        // a human-readable reference line so the context is ALWAYS visible, even
        // on deployments where the structured `replyToStatusId` link isn't shown.
        const rawRef =
          (typeof current?.caption === 'string' && current.caption.trim()) ||
          (current?.type === 'text' && typeof current?.text === 'string' && current.text.trim()) ||
          '';
        const refLabel = rawRef ? `“${rawRef.slice(0, 60)}${rawRef.length > 60 ? '…' : ''}”` : 'your status update';
        const composed = `↩️ Reply to ${refLabel}:\n${trimmed}`;

        try {
          await sendMessage({
            conversationId,
            type: 'text',
            text: composed,
            replyToStatusId: current?._id,
          } as any);
        } catch {
          await sendMessage({
            conversationId,
            type: 'text',
            text: composed,
          } as any);
        }
        Alert.alert('Reply sent', 'Your reply was sent as a direct message.');
      } catch (errorValue: any) {
        Alert.alert('Failed to reply', errorValue?.message || 'Unknown error');
      }
    },
    [isMine, targetUserId, getOrCreateDM, sendMessage, current],
  );

  const onSendReply = useCallback(() => {
    const text = reply.trim();
    if (!text) return;
    setReply('');
    void sendReplyText(text);
  }, [reply, sendReplyText]);

  // iter-317: one-tap emoji reactions for statuses (WhatsApp-style). Sent as a
  // status reply DM so it works via the existing message path and the poster
  // still gets the "↩️ Reply to your status" context line.
  const onStatusReaction = useCallback(
    (emoji: string) => {
      void sendReplyText(emoji);
    },
    [sendReplyText],
  );

  if (!stories.length && (myStories !== undefined || otherStories !== undefined)) {
    return (
      <View style={[styles.container, styles.blackBg]} testID="status-view-empty">
        <View style={styles.emptyWrap}>
          <Ionicons name="disc-outline" size={48} color="rgba(255,255,255,0.4)" />
          <Text style={styles.emptyText}>No stories to show</Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.emptyBtn} testID="status-view-empty-close">
            <Text style={styles.emptyBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (!current) {
    return (
      <View style={[styles.container, styles.blackBg]} testID="status-view-loading">
        <ActivityIndicator color={Colors.white} size="large" />
      </View>
    );
  }

  const isTextStory = readStoryType(current) === 'text';
  const bg = isTextStory ? readStoryBg(current) : '#000';
  const fg = isTextStory ? readStoryFg(current) : '#FFFFFF';
  // iter-330: the backend returns the viewer list + count under SEVERAL aliases
  // (views / viewers / viewedBy / seenBy, and viewCount / viewsCount / seenCount).
  // Reading only `views` made the owner see "0 viewers" whenever the backend
  // used a different field name. Resolve all of them.
  const viewerList: any[] = Array.isArray(current.views)
    ? current.views
    : Array.isArray(current.viewers)
      ? current.viewers
      : Array.isArray(current.viewedBy)
        ? current.viewedBy
        : Array.isArray(current.seenBy)
          ? current.seenBy
          : [];
  const viewsCount =
    Number(
      current.viewCount ??
        current.viewsCount ??
        current.seenCount ??
        current.viewsTotal ??
        (Array.isArray(current.views) ? current.views.length : undefined),
    ) || viewerList.length || 0;

  return (
    <View
      style={[styles.container, { backgroundColor: bg }]}
      testID="status-view-screen"
    >
      <View style={styles.progressWrap}>
        {stories.map((_, progressIndex) => (
          <View key={progressIndex} style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width:
                    progressIndex < idx
                      ? '100%'
                      : progressIndex === idx
                        ? progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
                        : '0%',
                },
              ]}
            />
          </View>
        ))}
      </View>

      <View style={styles.authorRow}>
        <View style={styles.authorAvatar}>
          <Text style={styles.authorAvatarText}>{(author.name || '?').charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.flexOne}>
          <Text style={styles.authorName}>{author.name}</Text>
          <Text style={styles.authorTime}>{timeAgo(current._creationTime || Date.now())}</Text>
        </View>
        {isMine ? (
          <TouchableOpacity
            onPress={openEdit}
            hitSlop={12}
            style={{ marginRight: 18 }}
            testID="status-edit"
          >
            <Feather name="edit-2" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        ) : null}
        {isMine ? (
          <TouchableOpacity
            onPress={onDeleteStatus}
            hitSlop={12}
            style={{ marginRight: 18 }}
            testID="status-delete"
          >
            <Feather name="trash-2" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        ) : null}
        {currentImageUri ? (
          <TouchableOpacity
            onPress={() => {
              setPaused(true);
              setShowZoom(true);
            }}
            hitSlop={12}
            style={{ marginRight: 18 }}
            testID="status-zoom"
          >
            <Feather name="maximize-2" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="status-close">
          <Feather name="x" size={26} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.body}>
        <StoryContent story={current} fg={fg} videoPlayerRef={videoPlayerRef} onVideoEnd={goNext} onImageReady={setCurrentImageUri} />
      </View>

      <View style={styles.tapZones}>
        <Pressable
          style={[styles.tapZone, styles.tapZonePrev]}
          onPress={goPrev}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          testID="story-prev"
        />
        <Pressable
          style={[styles.tapZone, styles.tapZoneNext]}
          onPress={goNext}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          testID="story-next"
        />
      </View>

      {!isMine ? (
        <View style={[styles.replyContainer, { marginBottom: keyboardHeight }]}>
          <View style={styles.reactionRow}>
            {STATUS_REACTIONS.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                style={styles.reactionBtn}
                onPress={() => onStatusReaction(emoji)}
                testID={`story-react-${emoji}`}
              >
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.replyBar}>
            <TextInput
              value={reply}
              onChangeText={(value) => {
                setReply(value);
                setPaused(true);
              }}
              onBlur={() => setPaused(false)}
              placeholder={`Reply to ${author.name || 'user'}…`}
              placeholderTextColor="rgba(255,255,255,0.65)"
              style={styles.replyInput}
              testID="story-reply-input"
            />
            <TouchableOpacity style={styles.replySend} onPress={onSendReply} disabled={!reply.trim()} testID="story-reply-send">
              <Feather name="send" size={20} color={reply.trim() ? Colors.primary : 'rgba(255,255,255,0.5)'} />
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.viewersBar}
          onPress={() => {
            setPaused(true);
            setShowViewers(true);
          }}
          testID="story-viewers-btn"
        >
          <Feather name="eye" size={16} color={Colors.white} />
          <Text style={styles.viewersText}>
            {viewsCount} viewer{viewsCount === 1 ? '' : 's'}
          </Text>
          <Feather name="chevron-up" size={16} color={Colors.white} />
        </TouchableOpacity>
      )}

      <Modal visible={showZoom && !!currentImageUri} transparent animationType="fade" onRequestClose={closeZoom}>
        <View style={styles.zoomBackdrop}>
          {currentImageUri ? <ZoomableImage uri={currentImageUri} onClose={closeZoom} /> : null}
          <TouchableOpacity style={styles.zoomClose} onPress={closeZoom} hitSlop={12} testID="story-zoom-close">
            <Feather name="x" size={26} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </Modal>

      <Modal
        visible={showViewers}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setShowViewers(false);
          setPaused(false);
        }}
      >
        <Pressable
          style={styles.viewersBackdrop}
          onPress={() => {
            setShowViewers(false);
            setPaused(false);
          }}
        >
          <Pressable style={styles.viewersSheet} onPress={() => {}} testID="story-viewers-sheet">
            <View style={styles.grabber} />
            <Text style={styles.viewersSheetTitle}>Seen by {viewsCount}</Text>
            <FlatList
              data={viewerList}
              keyExtractor={(viewer: any, viewerIndex: number) =>
                (typeof viewer === 'string'
                  ? viewer
                  : viewer?.userId || viewer?._id || viewer?.viewer || viewer?.viewerId) ||
                String(viewerIndex)
              }
              contentContainerStyle={styles.viewersList}
              renderItem={({ item }: any) => (
                <StatusViewerRow
                  item={item}
                  resolveContactName={resolveContactName}
                />
              )}
              ListEmptyComponent={<Text style={styles.viewerEmpty}>No one has viewed this yet.</Text>}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Edit my status */}
      <Modal visible={editing} transparent animationType="slide" onRequestClose={() => setEditing(false)}>
        <KeyboardAvoidingView
          behavior="padding"
          style={styles.editBackdrop}
        >
          <View style={styles.editSheet}>
            <View style={styles.editHeader}>
              <TouchableOpacity onPress={() => setEditing(false)} hitSlop={10} testID="status-edit-cancel">
                <Text style={styles.editCancel}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.editTitle}>Edit status</Text>
              <TouchableOpacity onPress={saveEdit} hitSlop={10} disabled={savingEdit} testID="status-edit-save">
                {savingEdit ? (
                  <ActivityIndicator color={Colors.primary} />
                ) : (
                  <Text style={styles.editSave}>Save</Text>
                )}
              </TouchableOpacity>
            </View>

            {String(current?.type) === 'text' ? (
              <>
                <View style={[styles.editPreview, { backgroundColor: STATUS_BG_PRESETS[editBgIdx].bg }]}>
                  <TextInput
                    value={editText}
                    onChangeText={setEditText}
                    multiline
                    placeholder="Type a status"
                    placeholderTextColor={`${STATUS_BG_PRESETS[editBgIdx].fg}99`}
                    style={[styles.editInput, { color: STATUS_BG_PRESETS[editBgIdx].fg }]}
                    autoFocus
                    testID="status-edit-input"
                  />
                </View>
                <View style={styles.editSwatches}>
                  {STATUS_BG_PRESETS.map((p, idx) => (
                    <TouchableOpacity
                      key={p.id}
                      onPress={() => setEditBgIdx(idx)}
                      style={[
                        styles.editSwatch,
                        { backgroundColor: p.bg },
                        idx === editBgIdx ? styles.editSwatchActive : null,
                      ]}
                      testID={`status-edit-color-${p.id}`}
                    />
                  ))}
                </View>
              </>
            ) : (
              <View style={styles.editCaptionWrap}>
                <Text style={styles.editCaptionLabel}>Caption</Text>
                <TextInput
                  value={editText}
                  onChangeText={setEditText}
                  multiline
                  placeholder="Add a caption"
                  placeholderTextColor={Colors.textMuted}
                  style={styles.editCaptionInput}
                  autoFocus
                  testID="status-edit-caption"
                />
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function StoryContent({
  story,
  fg,
  videoPlayerRef,
  onVideoEnd,
  onImageReady,
}: {
  story: any;
  fg: string;
  videoPlayerRef: React.MutableRefObject<VideoPlayer | null>;
  onVideoEnd: () => void;
  onImageReady?: (uri: string | null) => void;
}) {
  // iter-235: the status kept "loading" forever for photo/video. Root cause:
  // unlike `messages.list` (which resolves a message's storageId → signed
  // `mediaUrl` server-side), the status read queries return only the raw
  // `storageId`. The viewer then fell back to `api.files.getUrl`, which is
  // BROKEN on this Convex deployment ("Server Error") → the query never
  // resolves → infinite spinner.
  //
  // Fix: (1) read any server-resolved URL field directly first; (2) if only a
  // storageId is present, resolve it via the SAME resolvers the voice /
  // transcription pipeline uses successfully here — `messages.getStorageUrl`
  // then `storage.getUrl` — and only use the unreliable `files.getUrl` as a
  // last resort; (3) never spin forever — once every resolver has settled
  // without a URL, show a retry state instead of an endless spinner.
  const directUrl =
    (typeof story?.mediaUrl === 'string' && story.mediaUrl.length > 0 && story.mediaUrl) ||
    (typeof story?.fileUrl === 'string' && story.fileUrl.length > 0 && story.fileUrl) ||
    (typeof story?.url === 'string' && story.url.length > 0 && story.url) ||
    (typeof story?.imageUrl === 'string' && story.imageUrl.length > 0 && story.imageUrl) ||
    (typeof story?.videoUrl === 'string' && story.videoUrl.length > 0 && story.videoUrl) ||
    (typeof story?.uri === 'string' && story.uri.length > 0 && story.uri) ||
    (typeof story?.src === 'string' && story.src.length > 0 && story.src) ||
    (typeof story?.media === 'string' && story.media.length > 0 && story.media) ||
    (typeof story?.downloadUrl === 'string' && story.downloadUrl.length > 0 && story.downloadUrl) ||
    null;
  const safeStorageId =
    !directUrl && typeof story?.storageId === 'string' && story.storageId.length > 0
      ? story.storageId
      : null;

  const viaMessages = useSafeConvexQuery<string | null>(
    (api as any).messages?.getStorageUrl,
    safeStorageId ? { storageId: safeStorageId } : {},
    null,
    !!safeStorageId,
  );
  const viaStorage = useSafeConvexQuery<string | null>(
    (api as any).storage?.getUrl,
    safeStorageId ? { storageId: safeStorageId } : {},
    null,
    !!safeStorageId && !viaMessages.data && !viaMessages.loading,
  );
  const viaFiles = useSafeConvexQuery<string | null>(
    (api as any).files?.getUrl,
    safeStorageId ? { storageId: safeStorageId } : {},
    null,
    !!safeStorageId &&
      !viaMessages.data &&
      !viaMessages.loading &&
      !viaStorage.data &&
      !viaStorage.loading,
  );
  const resolvedStorageUrl = viaMessages.data || viaStorage.data || viaFiles.data || null;
  const stillResolving =
    !!safeStorageId &&
    !resolvedStorageUrl &&
    (viaMessages.loading || viaStorage.loading || viaFiles.loading);
  const src = directUrl || resolvedStorageUrl;

  // Report the resolved image URI (or null on text/video/unresolved) up to the
  // viewer so it can offer a fullscreen pinch-zoom preview of image stories.
  useEffect(() => {
    if (!onImageReady) return;
    onImageReady(readStoryType(story) === 'image' && src ? String(src) : null);
  }, [src, story, onImageReady]);

  const retryResolve = useCallback(() => {
    viaMessages.refetch();
    viaStorage.refetch();
    viaFiles.refetch();
  }, [viaMessages, viaStorage, viaFiles]);

  if (readStoryType(story) === 'text') {
    return (
      <View style={[styles.textBody, { backgroundColor: readStoryBg(story) }]}>
        <Text style={[styles.textContent, { color: readStoryFg(story) }]}>{readStoryText(story)}</Text>
      </View>
    );
  }

  if (!src) {
    if (stillResolving) {
      return (
        <View style={styles.mediaBody}>
          <ActivityIndicator color="#FFFFFF" size="large" />
        </View>
      );
    }
    return (
      <View style={styles.mediaBody}>
        <Ionicons name="cloud-offline-outline" size={44} color="rgba(255,255,255,0.6)" />
        <Text style={styles.mediaErrorText}>Couldn&apos;t load this media</Text>
        <TouchableOpacity onPress={retryResolve} style={styles.mediaRetryBtn} testID="story-media-retry">
          <Feather name="refresh-cw" size={16} color="#FFFFFF" />
          <Text style={styles.mediaRetryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (story.type === 'video') {
    // iter-135: render the video player in a dedicated sub-component so
    // useVideoPlayer is ONLY created when this is actually a video story.
    // Previously the hook ran unconditionally with a null source for
    // text / image stories which caused an Android native crash inside
    // expo-video when the screen rapidly transitioned between media
    // types (the user's report: tapping any status crashes the app).
    return (
      <StoryVideo
        src={src as string}
        videoPlayerRef={videoPlayerRef}
        onVideoEnd={onVideoEnd}
      />
    );
  }

  return (
    <View style={styles.mediaBody}>
      <Image source={{ uri: src }} style={styles.mediaImage} resizeMode="contain" />
    </View>
  );
}

function StoryVideo({
  src,
  videoPlayerRef,
  onVideoEnd,
}: {
  src: string;
  videoPlayerRef: React.MutableRefObject<VideoPlayer | null>;
  onVideoEnd: () => void;
}) {
  // iter-138/149: only mount the actual expo-video hook subtree when we
  // have a well-formed URL. Passing a null / data: / weird-scheme source
  // to useVideoPlayer crashes natively on Android Hermes ("Smilers has
  // stopped"). By splitting this into two components we guarantee
  // useVideoPlayer is *never* called with an invalid value.
  const safeSrc =
    typeof src === 'string' && (src.startsWith('http') || src.startsWith('file://') || src.startsWith('content://'))
      ? src
      : null;
  if (!safeSrc) {
    return (
      <View style={styles.mediaBody}>
        <ActivityIndicator color="#FFFFFF" size="large" />
      </View>
    );
  }
  return (
    <StoryVideoPlayer
      safeSrc={safeSrc}
      videoPlayerRef={videoPlayerRef}
      onVideoEnd={onVideoEnd}
    />
  );
}

function StoryVideoPlayer({
  safeSrc,
  videoPlayerRef,
  onVideoEnd,
}: {
  safeSrc: string;
  videoPlayerRef: React.MutableRefObject<VideoPlayer | null>;
  onVideoEnd: () => void;
}) {
  const player = useVideoPlayer({ uri: safeSrc }, (p) => {
    try {
      p.loop = false;
      p.play();
    } catch {
      /* native player setup may fail with malformed source — swallow */
    }
  });

  // Publish the latest player to the parent so it can pause/play on
  // long-press (held-to-pause).
  useEffect(() => {
    videoPlayerRef.current = player;
    return () => {
      if (videoPlayerRef.current === player) {
        videoPlayerRef.current = null;
      }
    };
  }, [player, videoPlayerRef]);

  // Listen for end-of-playback so the story advances to the next slide.
  useEffect(() => {
    if (!player) return;
    let subscription: { remove?: () => void } | null = null;
    try {
      subscription = player.addListener('playToEnd', () => {
        try {
          onVideoEnd();
        } catch {}
      });
    } catch {
      /* older expo-video versions may not expose this event */
    }
    return () => {
      try {
        subscription?.remove?.();
      } catch {}
    };
  }, [player, onVideoEnd]);

  return (
    <VideoView
      style={styles.mediaBody}
      player={player}
      contentFit="contain"
      nativeControls={false}
    />
  );
}

/**
 * StatusViewerRow — one row in the owner's "Seen by" sheet.
 *
 * A viewer entry from the backend may be a raw userId string OR an object
 * `{ userId, viewedAt?, name? }`. Names/avatars are NOT reliably embedded in
 * `getMyStatuses`, so we resolve them the way the web app does: fetch the
 * viewer's user doc via `api.users.getUserById` and prefer the device-contact
 * name (via `resolveContactName`) → their Smilers/Google account name. The
 * timestamp is only shown when the entry carries a real `viewedAt` value.
 */
function StatusViewerRow({
  item,
  resolveContactName,
}: {
  item: any;
  resolveContactName: (id: string | null | undefined, fallback: string, extra?: any) => string;
}) {
  const entry = typeof item === 'string' ? { userId: item } : (item || {});
  const viewerId = String(
    entry.userId || entry._id || entry.viewer || entry.viewerId || entry.user?._id || '',
  );
  const { data: fetchedUser } = useSafeConvexQuery<any | null>(
    api.users.getUserById,
    viewerId ? { userId: viewerId } : {},
    null,
    !!viewerId,
  );

  const accountName =
    entry.name ||
    entry.displayName ||
    entry.userName ||
    entry.viewerName ||
    entry.user?.name ||
    entry.user?.displayName ||
    fetchedUser?.name ||
    fetchedUser?.displayName ||
    fetchedUser?.fullName ||
    'User';
  const viewerName = resolveContactName(viewerId, accountName, {
    phoneE164: entry.phoneE164 || entry.phone || fetchedUser?.phoneE164 || fetchedUser?.phone,
    phone: entry.phone || fetchedUser?.phone,
  });
  const avatarUrl =
    entry.avatarUrl || entry.user?.avatarUrl || fetchedUser?.avatarUrl || fetchedUser?.photoUrl || '';

  // Show the view time when the entry carries one. The backend spec stores it
  // as `viewedAt` (ms); we also accept common aliases. When none is present we
  // render nothing rather than a misleading "just now".
  const rawTs =
    entry.viewedAt ??
    entry.viewedAtMs ??
    entry.at ??
    entry.seenAt ??
    entry.seenAtMs ??
    entry.timestamp ??
    entry.time ??
    entry.createdAt ??
    entry._creationTime ??
    entry.user?.viewedAt;
  const hasTs =
    (typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0) ||
    (typeof rawTs === 'string' && Number.isFinite(Date.parse(rawTs)));

  return (
    <View style={styles.viewerRow}>
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} style={styles.viewerAvatar} />
      ) : (
        <View style={styles.viewerAvatar}>
          <Text style={styles.viewerAvatarText}>{(viewerName || '?').charAt(0).toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.flexOne}>
        <Text style={styles.viewerName}>{viewerName}</Text>
        {hasTs ? <Text style={styles.viewerTime}>{timeAgo(rawTs)}</Text> : null}
      </View>
    </View>
  );
}

function timeAgo(value: number | string | null | undefined): string {
  // Accept ms-epoch numbers (Convex `_creationTime`), ISO strings, or
  // seconds-epoch numbers. Anything unparseable → "just now" (never "NaN").
  let ms: number;
  if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms)) return 'just now';
  // Coerce seconds-epoch (10-digit) to ms.
  if (ms > 0 && ms < 1e12) ms = ms * 1000;
  const diff = Math.max(0, Date.now() - ms);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  blackBg: { backgroundColor: '#000' },
  progressWrap: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: Spacing.base,
    paddingTop: 50,
    paddingBottom: Spacing.sm,
  },
  progressTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#FFFFFF' },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.sm,
    zIndex: 2,
  },
  authorAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  authorAvatarText: { color: '#FFFFFF', fontWeight: FontWeight.bold, fontSize: FontSize.base },
  authorName: { color: '#FFFFFF', fontWeight: FontWeight.semibold, fontSize: FontSize.base },
  authorTime: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.xs, marginTop: 2 },
  flexOne: { flex: 1 },
  body: { flex: 1 },
  textBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg },
  textContent: { fontSize: 32, fontWeight: FontWeight.bold, textAlign: 'center', lineHeight: 40 },
  mediaBody: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mediaImage: { width: '100%', height: '100%' },
  mediaErrorText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: FontSize.base,
    marginTop: 12,
  },
  mediaRetryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: Radius.pill,
  },
  mediaRetryText: { color: '#FFFFFF', fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
  tapZones: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 100,
    bottom: 80,
    flexDirection: 'row',
    zIndex: 1,
  },
  tapZone: {},
  tapZonePrev: { flex: 1 },
  tapZoneNext: { flex: 2 },
  replyContainer: {
    zIndex: 2,
  },
  reactionRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: 2,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  reactionBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  reactionEmoji: {
    fontSize: 28,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.4)',
    zIndex: 2,
  },
  replyInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: FontSize.base,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  replySend: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  viewersBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    zIndex: 2,
  },
  viewersText: { color: '#FFFFFF', fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  viewersBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  zoomBackdrop: { flex: 1, backgroundColor: '#000' },
  zoomClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  viewersSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
    maxHeight: '70%',
    ...Shadow.lg,
  },
  grabber: {
    width: 40,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginVertical: Spacing.sm,
  },
  viewersSheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    paddingVertical: Spacing.sm,
    textAlign: 'center',
  },
  viewersList: { paddingBottom: Spacing.lg },
  viewerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  viewerAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold },
  viewerName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  viewerTime: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  viewerEmpty: { textAlign: 'center', color: Colors.textMuted, paddingVertical: Spacing.lg },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.base, marginTop: 8 },
  emptyBtn: {
    marginTop: Spacing.lg,
    paddingHorizontal: 22,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: Radius.pill,
  },
  emptyBtnText: { color: '#FFFFFF', fontWeight: FontWeight.bold },
  editBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  editSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: Spacing.lg,
    paddingBottom: Spacing.xl,
  },
  editHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md },
  editTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  editCancel: { fontSize: FontSize.base, color: Colors.textSecondary },
  editSave: { fontSize: FontSize.base, color: Colors.primary, fontWeight: FontWeight.bold },
  editPreview: {
    borderRadius: 16,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  editInput: {
    fontSize: 24,
    fontWeight: FontWeight.bold,
    textAlign: 'center',
    minWidth: '100%',
    maxHeight: 220,
  },
  editSwatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: Spacing.md, justifyContent: 'center' },
  editSwatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: 'transparent' },
  editSwatchActive: { borderColor: Colors.textPrimary, transform: [{ scale: 1.12 }] },
  editCaptionWrap: { gap: 8 },
  editCaptionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  editCaptionInput: {
    minHeight: 90,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    textAlignVertical: 'top',
  },
});