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
  KeyboardAvoidingView,
  Platform,
  Alert,
  FlatList,
  Modal,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { setAudioModeAsync as setExpoAudioModeAsync } from 'expo-audio';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';
import { recordDiagnostic } from '../../src/lib/diagnostics';
import ScreenErrorBoundary from '../../src/components/ScreenErrorBoundary';

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
  const otherStoriesC = useSafeConvexQuery<any>(
    (api as any).statuses?.getUserStatuses,
    targetUserId ? { userId: targetUserId } : {},
    null,
    !!targetUserId &&
      !otherStoriesA.data &&
      !otherStoriesA.loading &&
      !otherStoriesB.data &&
      !otherStoriesB.loading,
  );
  const otherStoriesD = useSafeConvexQuery<any>(
    (api as any).statuses?.listForOther,
    targetUserId ? { userId: targetUserId } : {},
    null,
    !!targetUserId &&
      !otherStoriesA.data &&
      !otherStoriesA.loading &&
      !otherStoriesB.data &&
      !otherStoriesB.loading &&
      !otherStoriesC.data &&
      !otherStoriesC.loading,
  );
  const otherStories =
    otherStoriesA.data || otherStoriesB.data || otherStoriesC.data || otherStoriesD.data || null;
  const me = useQuery(api.users.getCurrentUser);

  const stories: any[] = useMemo(() => {
    const source: any = userId === 'me' ? myStories : otherStories;
    if (!source) return [];
    if (Array.isArray(source)) return source;
    if (Array.isArray(source.stories)) return source.stories;
    return [];
  }, [userId, myStories, otherStories]);

  const isMine = userId === 'me';
  const author: any = useMemo(() => {
    if (isMine) return { name: 'You', _id: me?._id };
    const source: any = otherStories;
    if (source && !Array.isArray(source)) {
      return { name: source.name || source.userName || 'User', _id: targetUserId, avatarUrl: source.avatarUrl };
    }
    return { name: 'User', _id: targetUserId };
  }, [isMine, otherStories, me, targetUserId]);

  const markViewed = useMutation(api.statuses.markViewed);
  const sendMessage = useMutation(api.messages.send);
  const getOrCreateDM = useMutation(api.conversations.getOrCreateDirectConversation);

  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reply, setReply] = useState('');
  const [showViewers, setShowViewers] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const videoPlayerRef = useRef<VideoPlayer | null>(null);

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
    markViewed({ statusId: current._id }).catch(() => {});
  }, [current, isMine, markViewed]);

  useEffect(() => {
    if (!current) return;

    progress.setValue(0);
    if (paused) return;

    let duration = DEFAULT_DURATION_MS;
    if (current.type === 'video') {
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
  }, [idx, paused, current, goNext, progress]);

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

  const onSendReply = useCallback(async () => {
    const text = reply.trim();
    if (!text || isMine || !targetUserId) return;

    setReply('');
    try {
      const conversation: any = await getOrCreateDM({ otherUserId: targetUserId });
      const conversationId = typeof conversation === 'string' ? conversation : conversation?._id || conversation?.conversationId;
      if (!conversationId) throw new Error('No conversation');

      await sendMessage({
        conversationId,
        type: 'text',
        text,
        replyToStatusId: current?._id,
      } as any);
      Alert.alert('Reply sent', 'Your reply was sent as a direct message.');
    } catch (errorValue: any) {
      Alert.alert('Failed to reply', errorValue?.message || 'Unknown error');
    }
  }, [reply, isMine, targetUserId, getOrCreateDM, sendMessage, current]);

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

  const bg = current.type === 'text' ? current.backgroundColor || '#3A2608' : '#000';
  const fg = current.type === 'text' ? current.textColor || '#FFFFFF' : '#FFFFFF';
  const viewsCount = current.views?.length || current.viewCount || 0;

  return (
    <View style={[styles.container, { backgroundColor: bg }]} testID="status-view-screen">
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
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="status-close">
          <Feather name="x" size={26} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.body}>
        <StoryContent story={current} fg={fg} videoPlayerRef={videoPlayerRef} onVideoEnd={goNext} />
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
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
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
        </KeyboardAvoidingView>
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
              data={current.views || []}
              keyExtractor={(viewer: any, viewerIndex: number) => viewer?.userId || String(viewerIndex)}
              contentContainerStyle={styles.viewersList}
              renderItem={({ item }: any) => (
                <View style={styles.viewerRow}>
                  <View style={styles.viewerAvatar}>
                    <Text style={styles.viewerAvatarText}>{(item?.name || '?').charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={styles.flexOne}>
                    <Text style={styles.viewerName}>{item?.name || 'User'}</Text>
                    <Text style={styles.viewerTime}>{timeAgo(item?.viewedAt || Date.now())}</Text>
                  </View>
                </View>
              )}
              ListEmptyComponent={<Text style={styles.viewerEmpty}>No one has viewed this yet.</Text>}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function StoryContent({
  story,
  fg,
  videoPlayerRef,
  onVideoEnd,
}: {
  story: any;
  fg: string;
  videoPlayerRef: React.MutableRefObject<VideoPlayer | null>;
  onVideoEnd: () => void;
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

  const retryResolve = useCallback(() => {
    viaMessages.refetch();
    viaStorage.refetch();
    viaFiles.refetch();
  }, [viaMessages, viaStorage, viaFiles]);

  if (story.type === 'text') {
    return (
      <View style={styles.textBody}>
        <Text style={[styles.textContent, { color: fg }]}>{story.text || ''}</Text>
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

function timeAgo(ms: number): string {
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
});