import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useConvex, useMutation, useQuery } from 'convex/react';
import { forceConvexReconnect } from '../../src/providers/useConvexAutoReconnect';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import AttachmentSheet from '../../src/components/AttachmentSheet';
import ShareContactsDialog from '../../src/components/ShareContactsDialog';
import { SharedContactBubble } from '../../src/components/chat/SharedContactBubble';
import EmojiPickerSheet from '../../src/components/EmojiPickerSheet';
import GiphyPicker, { GiphyAsset } from '../../src/components/GiphyPicker';
import MediaBubble from '../../src/components/MediaBubble';
import { LiveLocationRequestBanner } from '../../src/components/LiveLocationRequestBanner';
import { LiveLocationSharingPill } from '../../src/components/LiveLocationSharingPill';
import PollComposer from '../../src/components/PollComposer';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery, useSafeConvexSubscription } from '../../src/hooks/useSafeConvexQuery';
import { useScreenCaptureProtection } from '../../src/hooks/useScreenCaptureProtection';
import { useEngagementTracker } from '../../src/hooks/useEngagementTracker';
import { recordDiagnostic } from '../../src/lib/diagnostics';
import { errorToMessage } from '../../src/lib/safeString';
import { scanMessage as scanMessageDeep } from '../../src/lib/messageSecurityScanner';
import {
  IMAGE_PICKER_OPTIONS_CHAT,
  VIDEO_PICKER_OPTIONS_CHAT,
  assertUploadSize,
} from '../../src/lib/dataFriendlyDefaults';
import { readCache, writeCache } from '../../src/lib/offlineCache';
import NetInfo from '@react-native-community/netinfo';
import {
  loadOutbox,
  enqueueOutbox,
  removeFromOutbox,
  markOutboxFailed,
  type OutboxMessage,
} from '../../src/lib/outbox';
import { shareMessage } from '../../src/lib/messageMedia';
import { appendDiaryEntry, chatMessageToDiaryEntry } from '../../src/lib/diaryStore';
import { getWallpaperColor, normalizeChatAppearance } from '../../src/lib/chatAppearance';
import { notifyEventPush, previewForMessageType } from '../../src/lib/notifyPush';
import { reportConvexUserIdForPush } from '../../src/push/useEmergentPush';
import { findSavedContactDisplayName, getConversationDisplayName, getResolvedConversationDisplayName, getDisplayInitials, getSavedContactRecord } from '../../src/lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../src/lib/deviceContactIndex';
import { getLanguageByCode } from '../../src/lib/languages';
import {
  applyDraftFormatting,
  DRAFT_TEXT_COLORS,
  DraftTextColorKey,
  resolveDraftColor,
  stripRichTextTags,
} from '../../src/lib/chatRichText';
import {
  CHAT_APPEARANCE_KEY,
  DEFAULT_CHAT_APPEARANCE,
  DEFAULT_PRIVACY_SETTINGS,
  PRIVACY_SETTINGS_KEY,
  QUICK_TEMPLATES_KEY,
  readStoredJson,
  writeStoredJson,
} from '../../src/lib/settingsStorage';
import { formatLastSeenLabel } from '../../src/lib/presence';
import { translateIncomingMessageText } from '../../src/lib/translation';
import { uploadFile } from '../../src/lib/uploadFile';
import { useAuth } from '../../src/providers/AuthProvider';
import { useConversationOtherUser } from '../../src/hooks/useConversationOtherUser';
import { useConversationE2EE } from '../../src/hooks/useConversationE2EE';
import { useViewerSuspension } from '../../src/hooks/useViewerSuspension';
import { decryptText } from '../../src/lib/e2eeCrypto';
import { triggerTranscription } from '../../src/lib/triggerTranscription';
import ScheduleMessageSheet, { ScheduleSelection } from '../../src/components/ScheduleMessageSheet';
import CameraCapture from '../../src/components/CameraCapture';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';
import { formatChatDayChip, isSameCalendarDay } from '../../src/lib/chatFormat';
import { CallPill } from '../../src/components/chat/CallPill';
import { RecordingPlaybackModal } from '../../src/components/chat/RecordingPlayback';
import { ChatOptionsMenu } from '../../src/components/chat/ChatOptionsMenu';
import { SwipeToReply } from '../../src/components/chat/SwipeToReply';
import { MessageActionSheet } from '../../src/components/chat/MessageActionSheet';
import { DeleteMessageSheet } from '../../src/components/chat/DeleteMessageSheet';
import { DisappearingSheet, DISAPPEARING_OPTIONS } from '../../src/components/chat/DisappearingSheet';
import { ForwardPickerSheet } from '../../src/components/chat/ForwardPickerSheet';
import { TemplatePickerSheet } from '../../src/components/chat/TemplatePickerSheet';
import { startCall } from '../../src/lib/twilio/startCall';

const EMPTY_MESSAGES_PAGE = { page: [] as any[] };
const EMPTY_FORWARD_CONVERSATIONS: any[] = [];
const EMPTY_CALL_LOGS: any[] = [];

function formatPresenceSubtitle(conversation: any) {
  if (!conversation) return 'tap for info';
  if (conversation.type === 'group') {
    return `${conversation?.participants?.length || conversation?.memberCount || 0} members`;
  }
  const directStatus = [conversation?.status, conversation?.presence, conversation?.otherUser?.status]
    .find((value) => typeof value === 'string' && value.trim().length > 0);
  if (typeof directStatus === 'string' && directStatus.trim().length > 0) {
    return directStatus.trim();
  }
  return formatLastSeenLabel(conversation);
}

export default function ChatScreen() {
  const router = useRouter();
  const convex = useConvex();
  const insets = useSafeAreaInsets();
  const { conversationId, q: initialSearchQ, mid: initialSearchMid } = useLocalSearchParams<{
    conversationId: string;
    q?: string;
    mid?: string;
  }>();
  const { isAuthenticated } = useAuth();
  // iter-134 security hardening: chats contain end-to-end-encrypted
  // messages, voice notes, and media. Block screenshots/screen recording
  // while the user is reading a conversation. The hook is a no-op on
  // web (preview only) so it remains safe to call here unconditionally.
  // iter-140: screen-capture protection on chat conversations was
  // blocking the user from taking screenshots of errors for debugging.
  // iter 158 (reverted iter 159): screen-capture restriction is deliberately
  // NOT enabled here. Per product direction, users must retain full freedom
  // to screenshot their own chats. Anti-tampering measures live in the
  // messageSecurityScanner + (upcoming) auto-delete enforcement, NOT in
  // FLAG_SECURE which is a UX restriction, not a hacker defense.
  // useScreenCaptureProtection('chat-conversation');
  // iter-137 engagement tracking — fires `api.earnings.trackMessage`
  // after each qualifying outgoing text message (matches the web app's
  // earnings pipeline so the user's totalEngagements actually grows
  // when chatting from the native client).
  const engagement = useEngagementTracker();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [replyTo, setReplyTo] = useState<any | null>(null);
  // iter-109 → iter-111: in-chat message search overlay. Originally
  // introduced as part of the Diary feature, but kept here as a
  // benign general-purpose search since it doesn't depend on diary
  // mode and works for every conversation. When non-null the search
  // bar is visible and the message list gets client-side filtered.
  const [chatSearchQuery, setChatSearchQuery] = useState<string | null>(null);
  // iter-220 in-conversation search highlight + up/down navigation.
  // `searchActivePos` is the index into the matched-message list the ▲/▼
  // navigator is focused on. Unlike the old filter behaviour, the full
  // message list stays visible; matches are highlighted in place.
  const [searchActivePos, setSearchActivePos] = useState(0);
  const searchInitTermRef = useRef<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<any | null>(null);
  // Tri-state delete-mode sheet: when set, prompts WhatsApp-style "Delete for me /
  // for receiver / for everyone" (sent) or "Delete for me / ask sender" (received).
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  // Tracks whether the bottom emoji picker is opened to insert into the composer
  // (default) or to react to the currently-selected message ('react').
  const [emojiPickerMode, setEmojiPickerMode] = useState<'compose' | 'react'>('compose');
  const [reactionTargetMsg, setReactionTargetMsg] = useState<any | null>(null);
  const [showAttachSheet, setShowAttachSheet] = useState(false);
  // iter-212: staged photo awaiting an explicit Send tap (fixes "no send
  // button after attaching a photo"). Gallery picks land here so the user
  // can add a caption and send, instead of the photo firing immediately.
  // iter-215: multi-photo album send with per-image captions. Gallery
  // picks stage here; each image carries its own caption, and the
  // composer input edits the ACTIVE image's caption while any image is
  // staged. (Single-photo behaviour is unchanged — it's just length 1.)
  const [pendingImages, setPendingImages] = useState<{ uri: string; mimeType: string; caption: string }[]>([]);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const setActiveCaption = useCallback(
    (caption: string) =>
      setPendingImages((prev) => prev.map((im, i) => (i === activeImageIndex ? { ...im, caption } : im))),
    [activeImageIndex],
  );
  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
    setActiveImageIndex((cur) => (index < cur ? cur - 1 : cur === index ? Math.max(0, cur - 1) : cur));
  }, []);
  const [showShareContacts, setShowShareContacts] = useState(false);
  const [showScheduleSheet, setShowScheduleSheet] = useState(false);
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  const [showGiphyPicker, setShowGiphyPicker] = useState(false);
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  // Multi-select forward mode (iter-99): when non-null we're in
  // "selecting messages to bulk-forward" mode. null = not in mode,
  // [] = mode active with no selections, [id, ...] = active with
  // selections. The chat banner + bubble check-marks + forward sheet
  // all read from this state to drive their behaviour.
  const [multiSelectIds, setMultiSelectIds] = useState<string[] | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const [showDisappearingSheet, setShowDisappearingSheet] = useState(false);
  const [muted, setMuted] = useState(false);
  const [fallbackReady, setFallbackReady] = useState(false);
  const [quickTemplates, setQuickTemplates] = useState<any[]>([]);
  const [chatAppearance, setChatAppearance] = useState(DEFAULT_CHAT_APPEARANCE);
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const [disappearingMode, setDisappearingMode] = useState<(typeof DISAPPEARING_OPTIONS)[number]['key']>('off');
  const [composerFocused, setComposerFocused] = useState(false);
  const [showComposerFormattingPinned, setShowComposerFormattingPinned] = useState(false);
  const [draftBold, setDraftBold] = useState(false);
  const [draftColor, setDraftColor] = useState<DraftTextColorKey | null>(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [translatedMessageMap, setTranslatedMessageMap] = useState<Record<string, string>>({});
  const [recentEmojis, setRecentEmojis] = useState<string[]>(['😀', '😂', '😍', '🙏', '🔥', '🎉', '❤️', '👍']);
  const translatedIdsRef = useRef<Set<string>>(new Set());
  const translatingIdsRef = useRef<Set<string>>(new Set());
  const messageInputRef = useRef<TextInput | null>(null);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recCancelledRef = useRef(false);
  const recStartMsRef = useRef(0);
  const recDurationMsRef = useRef(0);
  const listRef = useRef<FlatList<any>>(null);
  // iter-231: track whether the user is near the bottom so we only auto-scroll
  // to the latest message when appropriate (not while they're reading history).
  const isNearBottomRef = useRef(true);
  // iter-274: true while the user is actively dragging/flinging the list.
  // The auto-snap-to-bottom in onContentSizeChange must NOT fire during an
  // active scroll — virtualization + media loading change contentSize on
  // every frame, and snapping back each time caused the rapid up/down
  // jitter the user reported while scrolling.
  const isUserScrollingRef = useRef(false);
  // iter-275: respect the user's "Typing indicators" privacy setting. When
  // OFF we suppress the typing broadcast so the other side never sees
  // "typing…". Loaded from on-device storage and refreshed on focus (so
  // toggling it in Privacy takes effect when they return to the chat).
  const typingIndicatorsEnabledRef = useRef(true);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder, 200);
  const hasValidConversationId =
    typeof conversationId === 'string' && /^[a-z0-9]+$/i.test(conversationId) && conversationId.length > 10;
  const canQueryConversation = !!conversationId && hasValidConversationId && isAuthenticated;

  // iter-202: prefer `listConversations` as the primary source for the
  // conversation object — it's the canonical query the web app uses,
  // it's already subscribed by the Chats tab so cache is usually warm,
  // AND (critically) it embeds `otherUser`. The previous reliance on
  // `getConversation` alone caused chats to hang on "Taking longer
  // than usual" whenever that single-shot query returned undefined
  // (e.g. when the conversation existed in the user's list but the
  // direct-fetch path had a stale cache / dropped subscription).
  //
  // Strategy:
  //   1. Query `listConversations` (the web canonical) and locate by id.
  //   2. Also keep `getConversation` as a fallback for conversations
  //      not surfaced in the user's list (e.g. archived, broadcasts).
  //   3. The effective `conversation` is whichever resolves first.
  //   4. `conversationLoading` is true only when BOTH are still pending.
  const conversationList = useQuery(
    api.conversations.listConversations,
    canQueryConversation ? ({} as any) : 'skip'
  ) as any[] | undefined;
  const conversationFromList = useMemo(() => {
    if (!Array.isArray(conversationList) || !conversationId) return null;
    const match = conversationList.find(
      (c: any) => String(c?._id || c?.id) === String(conversationId)
    );
    return match || null;
  }, [conversationList, conversationId]);
  const conversationDirect = useQuery(
    api.conversations.getConversation,
    canQueryConversation && !conversationFromList ? { conversationId } : 'skip'
  ) as any | null | undefined;
  // Effective conversation: list result wins (it has otherUser embedded).
  const conversation: any | null | undefined =
    conversationFromList ?? conversationDirect;
  // Loading = neither source has resolved AND the user is signed in.
  const conversationLoading =
    canQueryConversation &&
    conversationList === undefined &&
    conversationDirect === undefined;
  const messagesPage = useQuery(
    api.messages.list,
    canQueryConversation ? { conversationId, paginationOpts: { numItems: 50, cursor: null } } : 'skip'
  ) as any;
  const messagesLoading = canQueryConversation && messagesPage === undefined;
  // iter 156: call-log pills in chat timeline (per Smilers web parity).
  // Backed by canonical contract api.calls.listCallLogsForConversation.
  // iter-180: switched from one-shot useSafeConvexQuery to a LIVE
  // subscription — the one-shot fetch raced the Convex auth handshake on
  // cold launch (landed unauthenticated → cached [] forever) and never
  // refreshed after a call ended while the chat was open. Both made the
  // pills invisible in practice. Still degrades to [] on backend errors.
  const { data: callLogsForConvo } = useSafeConvexSubscription<any[]>(
    (api as any).calls.listCallLogsForConversation,
    { conversationId },
    EMPTY_CALL_LOGS,
    !!canQueryConversation,
  );
  // iter 157: recordings playback for "Recorded" pills.
  // listMyRecordings returns ALL of viewer's recordings — we build a Map
  // keyed by callId so each call-pill can look up its recording URL O(1).
  const { data: myRecordings } = useSafeConvexQuery<any[]>(
    (api as any).callRecording.listMyRecordings,
    {},
    EMPTY_CALL_LOGS,
    !!isAuthenticated,
  );
  const recordingByCallId = useMemo(() => {
    const map = new Map<string, any>();
    if (Array.isArray(myRecordings)) {
      myRecordings.forEach((r: any) => {
        if (r && r.callId) map.set(String(r.callId), r);
      });
    }
    return map;
  }, [myRecordings]);
  // null | { url, durationSeconds, callType, outcome }
  const [activeRecording, setActiveRecording] = useState<any>(null);
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip') as any | null | undefined;
  const contacts = useQuery(api.contacts.getContacts, me ? {} : 'skip') as any[] | undefined;
  // iter-176: device address-book name takes priority for the chat
  // header title (1:1 chats only — group titles are untouched).
  const deviceContactIndex = useDeviceContactIndex();
  const refetchMessages = useCallback(async () => {}, []);
  const { data: conversationsForForward } = useSafeConvexQuery<any[]>(
    api.conversations.listConversations,
    {},
    EMPTY_FORWARD_CONVERSATIONS,
    showForwardPicker
  );

  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      shouldRouteThroughEarpiece: false,
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isRecording) {
      return;
    }
    const nextDuration = recorderState.durationMillis || 0;
    recDurationMsRef.current = nextDuration;
    setRecDuration(Math.floor(nextDuration / 1000));
  }, [isRecording, recorderState.durationMillis]);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => setIsKeyboardVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setIsKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadPersonalization = async () => {
      const [storedTemplates, storedAppearance, storedPrivacy] = await Promise.all([
        readStoredJson(QUICK_TEMPLATES_KEY, []),
        readStoredJson(CHAT_APPEARANCE_KEY, DEFAULT_CHAT_APPEARANCE),
        readStoredJson(PRIVACY_SETTINGS_KEY, DEFAULT_PRIVACY_SETTINGS),
      ]);
      if (!mounted) {
        return;
      }
      setQuickTemplates(Array.isArray(storedTemplates) ? storedTemplates : []);
      setChatAppearance(normalizeChatAppearance(storedAppearance));
      typingIndicatorsEnabledRef.current = storedPrivacy?.typingIndicators !== false;
    };
    void loadPersonalization();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!showTemplatePicker) {
      return;
    }
    readStoredJson(QUICK_TEMPLATES_KEY, []).then((storedTemplates) => {
      setQuickTemplates(Array.isArray(storedTemplates) ? storedTemplates : []);
    });
  }, [showTemplatePicker]);

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    readStoredJson(`disappearing_mode_${conversationId}`, 'off').then((storedValue) => {
      if (!active) return;
      const nextValue = typeof storedValue === 'string' ? storedValue : 'off';
      setDisappearingMode(
        DISAPPEARING_OPTIONS.some((item) => item.key === nextValue)
          ? (nextValue as (typeof DISAPPEARING_OPTIONS)[number]['key'])
          : 'off'
      );
    });
    return () => {
      active = false;
    };
  }, [conversationId]);

  // iter-147: when the conversation document carries a canonical
  // `disappearAfter` value (set from another device or the web app),
  // align the local sheet selection so the UI reflects what the server
  // has — overrides the AsyncStorage fallback above.
  useEffect(() => {
    const raw: any = (conversation as any)?.disappearAfter;
    if (raw == null) return;
    let key: (typeof DISAPPEARING_OPTIONS)[number]['key'] = 'off';
    if (typeof raw === 'string') {
      const match = DISAPPEARING_OPTIONS.find((item) => item.key === raw);
      if (match) key = match.key;
    } else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      const ms = raw < 10_000 ? raw * 1000 : raw;
      const match = DISAPPEARING_OPTIONS.find((item) => item.ms === ms);
      if (match) key = match.key;
    }
    setDisappearingMode(key);
  }, [conversation]);

  // iter-151: canonical contract from backend = `setDisappearingMessages`
  // (NOT `setDisappearAfter`) and the unit is SECONDS (NOT ms or option-key
  // strings). 0 = off. Convert our local option keys → seconds at call time.
  const setDisappearingMessagesM = useMutation(
    (api as any).conversations?.setDisappearingMessages,
  );

  const sendMessageRaw = useMutation(api.messages.send);
  // iter-198 SENDER-SIDE MESSAGE PUSH: the Convex backend's push trigger was
  // proven absent during live diagnosis (2026-06-12) — no
  // /api/send-push-internal call ever arrived for real messages. So the
  // sender's device now fires the recipient's push itself right after a
  // successful send. The backend dedupes (message id + content hash), so
  // recipients get exactly ONE notification even if Convex triggers return.
  // Context (recipients + sender name) is kept in a ref because the
  // hydrated conversation is computed much later in this component.
  const pushNotifyCtxRef = useRef<{ recipients: string[]; senderName: string } | null>(null);
  const sendMessage = useCallback(
    async (args: any) => {
      const result = await sendMessageRaw(args);
      try {
        const ctx = pushNotifyCtxRef.current;
        if (ctx && ctx.recipients.length > 0) {
          notifyEventPush({
            recipients: ctx.recipients,
            event: 'message',
            title: ctx.senderName,
            message: previewForMessageType(args?.type, typeof args?.text === 'string' ? args.text : null),
            conversationId: String(args?.conversationId || conversationId || ''),
            idempotencyKey: result != null ? String(result) : null,
          });
        }
      } catch {}
      return result;
    },
    [sendMessageRaw, conversationId],
  );

  // ── Offline outbox (web-parity) ──────────────────────────────────────────
  // Plain-text messages that fail to reach the server (device offline /
  // Convex unreachable) are queued in AsyncStorage and shown immediately in
  // the timeline with a RED delivery dot. The queue auto-flushes when
  // connectivity returns (NetInfo) or the app returns to the foreground
  // (AppState 'active'). E2EE & media messages are NOT queued — they need
  // live keys / a live upload session.
  const [outboxMsgs, setOutboxMsgs] = useState<OutboxMessage[]>([]);
  const flushingRef = useRef(false);

  // Hydrate the queue for this conversation on mount / id change.
  useEffect(() => {
    if (!conversationId) {
      setOutboxMsgs([]);
      return;
    }
    let mounted = true;
    void loadOutbox(String(conversationId)).then((list) => {
      if (mounted) setOutboxMsgs(list);
    });
    return () => { mounted = false; };
  }, [conversationId]);

  // Attempt to send every queued message. On success the local entry is
  // removed (the real server message arrives via the reactive query); on
  // failure it is marked __failed and stays RED for the next flush.
  const flushOutbox = useCallback(async () => {
    if (!conversationId || flushingRef.current) return;
    flushingRef.current = true;
    try {
      const queue = await loadOutbox(String(conversationId));
      if (queue.length === 0) {
        setOutboxMsgs([]);
        return;
      }
      for (const item of queue) {
        try {
          await sendMessage({
            conversationId,
            type: 'text',
            text: item.text,
            ...(item.replyToId ? { replyToId: item.replyToId } : {}),
          });
          const next = await removeFromOutbox(String(conversationId), item._id);
          setOutboxMsgs(next);
        } catch (err) {
          // Still offline / failed — keep it RED and stop the run; we'll
          // retry on the next connectivity / foreground event.
          const next = await markOutboxFailed(String(conversationId), item._id);
          setOutboxMsgs(next);
          break;
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, [conversationId, sendMessage]);

  // Auto-flush triggers: connectivity returns + app foreground.
  useEffect(() => {
    if (!conversationId) return;
    const unsubNet = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        void flushOutbox();
      }
    });
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void flushOutbox();
    });
    // Kick a flush right away in case we mounted with a pending queue and are
    // already online.
    void flushOutbox();
    return () => {
      unsubNet();
      appStateSub.remove();
    };
  }, [conversationId, flushOutbox]);

  const setTyping = useMutation(api.typing.setTyping);
  const clearTyping = useMutation((api as any).typing.clearTyping);

  // "typing…" indicator (read side). Web contract: api.typing.getTypingUsers
  // returns an array of { name } for the OTHER participants currently typing.
  const { data: typingUsersRaw } = useSafeConvexQuery<any[]>(
    (api as any).typing.getTypingUsers,
    { conversationId },
    [],
    !!conversationId,
  );
  const markDelivered = useMutation((api as any).messages.markDelivered);
  const markRead = useMutation(api.messages.markRead);
  const toggleReaction = useMutation(api.messages.toggleReaction);
  const deleteMessage = useMutation(api.messages.deleteMessage);
  // Optional edit mutations — different Convex deployments expose this under
  // different names (`editMessage`, `updateMessage`, `editText`). We try them
  // in order at call-time. `api: any` keeps TS happy even if the function
  // doesn't exist server-side; the runtime catch handles missing endpoints.
  const editMessage = useMutation((api as any).messages.editMessage);
  const updateMessage = useMutation((api as any).messages.updateMessage);
  const editTextMutation = useMutation((api as any).messages.editText);
  // iter-147: canonical contract — toggleStar lives on `api.starred`,
  // NOT `api.messages`. Args require BOTH `messageId` AND
  // `conversationId` (server validates participant access).
  const toggleStarMutation = useMutation((api as any).starred?.toggleStar);
  const toggleStar = useCallback(
    async (args: { messageId: string }) => {
      if (typeof toggleStarMutation !== 'function') {
        throw new Error('Star/unstar is not available on this backend');
      }
      return await (toggleStarMutation as any)({
        messageId: args.messageId,
        conversationId,
      });
    },
    [toggleStarMutation, conversationId],
  );
  const createScheduledMessage = useMutation((api as any).scheduling.scheduleMessageMobile);
  // iter-113: alternative scheduling mutations. Some Convex deployments
  // expose `scheduledMessages.create` (legacy from the web app) instead of
  // `scheduling.scheduleMessageMobile` (newer mobile name). We try the
  // primary first, then fall back to the legacy on validator failure so a
  // schema-rename on the backend doesn't dead-end the user.
  const createScheduledLegacy = useMutation((api as any).scheduledMessages?.create);

  // When the user taps "Edit" on an existing message, we capture its id so
  // the composer's next "Send" becomes an edit instead of a brand-new
  // message. Clearing this id (Cancel or successful save) returns the
  // composer to normal send mode. See iter-97 fix.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const messages: any[] = useMemo(() => {
    const page = messagesPage as any;
    const arr = page?.page || page || [];
    return Array.isArray(arr) ? [...arr].reverse() : [];
  }, [messagesPage]);

  // iter-164 per-conversation offline message cache.
  //
  // We persist the most recent ~100 messages of this conversation to
  // AsyncStorage on every server refresh so that:
  //   - Cold opens render instantly (no Convex round-trip)
  //   - The user can scroll their last conversation while offline
  //
  // Caching uses the shared `offlineCache` namespace under the scope
  // `chat-messages` keyed by conversationId. Writes are silent on
  // failure (quota / locked) — they must never block UI.
  const [cachedMessages, setCachedMessages] = useState<any[] | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let mounted = true;
    void readCache<any[]>('chat-messages', String(conversationId)).then((cached) => {
      if (mounted && Array.isArray(cached) && cached.length) {
        setCachedMessages(cached);
      }
    });
    return () => { mounted = false; };
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    const page = messagesPage as any;
    const arr = page?.page || page;
    if (Array.isArray(arr) && arr.length) {
      // Server returns newest-first; keep the freshest 100 to bound storage.
      void writeCache('chat-messages', String(conversationId), arr.slice(0, 100));
    }
  }, [conversationId, messagesPage]);

  // iter-234 OFFLINE READ ACCESS: cache the conversation object + my own
  // user record so a cold/offline open can fully render the chat (header
  // name, "is mine" alignment, composer enabled) from cached messages —
  // not just a perpetual "Taking longer than usual" spinner.
  //   - `chat-conversation` scope is written here whenever the live
  //     conversation resolves (rich `listConversations` row preferred).
  //   - `me`/`self` scope is already written by the Chats tab; we only read.
  const [cachedConversation, setCachedConversation] = useState<any | null>(null);
  const [cachedMe, setCachedMe] = useState<any | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let mounted = true;
    void readCache<any>('chat-conversation', String(conversationId)).then((c) => {
      if (mounted && c) setCachedConversation(c);
    });
    void readCache<any>('me', 'self').then((m) => {
      if (mounted && m) setCachedMe(m);
    });
    return () => { mounted = false; };
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId || !conversation) return;
    void writeCache('chat-conversation', String(conversationId), conversation);
  }, [conversationId, conversation]);

  // Live value wins; cached value is the offline fallback.
  const effectiveConversation: any | null | undefined = conversation ?? cachedConversation;
  const effectiveMe: any = me ?? cachedMe;
  const hasCachedTimeline = Array.isArray(cachedMessages) && cachedMessages.length > 0;


  // When the server hasn't returned yet (cold start / offline) prefer
  // the cached array so the user sees something useful immediately.
  const messagesForRender: any[] = useMemo(() => {
    if (messages.length > 0) return messages;
    if (cachedMessages && cachedMessages.length) {
      return [...cachedMessages].reverse();
    }
    return messages;
  }, [messages, cachedMessages]);

  // E2EE decryption — text messages with `encrypted: true` carry base64
  // ciphertext in `text` and a base64 `iv` field. Derive the conversation's
  // key (PBKDF2-SHA256 ▶ AES-GCM-256) once, then decrypt each message text.
  const e2eeStatus = useConversationE2EE(conversationId || null);
  const decryptedMessages = useMemo(() => {
    if (!messagesForRender.length) return messagesForRender;
    if (!e2eeStatus.enabled || !e2eeStatus.passphrase || !e2eeStatus.salt) {
      // E2EE not active for this conversation OR key not yet fetched.
      // Returning the raw messages means encrypted ones will still show as
      // base64 until the key arrives (next render).
      return messagesForRender;
    }
    return messagesForRender.map((msg: any) => {
      if (!msg?.encrypted) return msg;
      try {
        // Only decrypt plain text fields. Media URLs are streamed as bytes
        // and decrypted separately at playback time (see MediaBubble).
        if (typeof msg.text === 'string' && msg.text.length > 0 && msg.iv) {
          const plain = decryptText(
            msg.text,
            msg.iv,
            e2eeStatus.passphrase as string,
            e2eeStatus.salt as string
          );
          return { ...msg, text: plain, _wasEncrypted: true };
        }
      } catch (errorValue: any) {
        // Decryption failed (wrong key, tampered ciphertext, missing iv).
        // Surface a readable indicator instead of base64 garbage.
        return { ...msg, text: '🔒 Could not decrypt', _wasEncrypted: true, _decryptError: true };
      }
      return msg;
    });
  }, [e2eeStatus.enabled, e2eeStatus.passphrase, e2eeStatus.salt, messagesForRender]);

  // iter-147: also honor the canonical conversation field
  // `conversation.disappearAfter` if the server has set one. It may be
  // delivered as milliseconds, seconds, OR one of our local option
  // keys ('24h' | '7d' | '90d'). Coerce to ms here.
  const serverDisappearMs = useMemo(() => {
    const raw: any = (conversation as any)?.disappearAfter;
    if (raw == null) return 0;
    if (typeof raw === 'string') {
      const match = DISAPPEARING_OPTIONS.find((item) => item.key === raw);
      return match?.ms || 0;
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      // Anything below 10_000 we treat as seconds, above as ms — this
      // covers both server conventions without a schema lookup.
      return raw < 10_000 ? raw * 1000 : raw;
    }
    return 0;
  }, [conversation]);

  const visibleMessages = useMemo(() => {
    const localTtl = DISAPPEARING_OPTIONS.find((item) => item.key === disappearingMode)?.ms || 0;
    const ttlMs = Math.max(localTtl, serverDisappearMs);
    if (!ttlMs) return decryptedMessages;
    const cutoff = Date.now() - ttlMs;
    return decryptedMessages.filter((message) => Number(message?._creationTime || 0) >= cutoff);
  }, [disappearingMode, serverDisappearMs, decryptedMessages]);

  // iter-109: in-chat search filter — applied AFTER the disappearing-mode
  // filter so the user only sees results that are still visible per the
  // conversation's TTL. Matches both the message text AND attachment
  // filenames (case-insensitive substring). When the query is empty
  // OR null we return visibleMessages unchanged — zero overhead.
  // iter-220: in-conversation search no longer FILTERS the list (old
  // iter-109 behaviour). The full timeline stays visible and matches are
  // highlighted in place with ▲/▼ navigation (see searchMatchPositions
  // below). This memo is now a passthrough kept to avoid renaming the
  // downstream displayMessages/timeline pipeline.
  const searchFilteredMessages = visibleMessages;

  const preferredLanguage = typeof me?.preferredLanguage === 'string' ? me.preferredLanguage : '';
  const preferredLanguageLabel = getLanguageByCode(preferredLanguage)?.name || preferredLanguage;
  const skipTranslationLanguages = useMemo(() => {
    const values = new Set<string>();
    const sourceList = Array.isArray(me?.skipTranslationLanguages)
      ? me.skipTranslationLanguages
      : Array.isArray(me?.spokenLanguages)
        ? me.spokenLanguages
        : Array.isArray(me?.languages)
          ? me.languages
          : [];

    sourceList.forEach((code) => {
      if (typeof code === 'string' && code.trim()) {
        values.add(getLanguageByCode(code.trim())?.name || code.trim());
      }
    });

    if (preferredLanguageLabel && values.has(preferredLanguageLabel)) {
      values.delete(preferredLanguageLabel);
    }
    return Array.from(values);
  }, [me?.languages, me?.skipTranslationLanguages, me?.spokenLanguages, preferredLanguageLabel]);

  useEffect(() => {
    if (!preferredLanguageLabel || visibleMessages.length === 0) {
      return;
    }

    const candidates = visibleMessages.filter((message) => {
      if (!message?._id || !message?.text || message?.senderId === me?._id) {
        return false;
      }
      return !translatedIdsRef.current.has(message._id) && !translatingIdsRef.current.has(message._id);
    }).slice(-8);

    if (candidates.length === 0) {
      return;
    }

    let cancelled = false;

    (async () => {
      const updates: Record<string, string> = {};
      candidates.forEach((message) => translatingIdsRef.current.add(message._id));
      const results = await Promise.all(
        candidates.map(async (message) => ({
          id: message._id,
          result: await translateIncomingMessageText({
            text: String(message.text || ''),
            targetLanguage: preferredLanguageLabel,
            skipLanguages: skipTranslationLanguages,
          }),
        })),
      );

      results.forEach(({ id, result }) => {
        translatingIdsRef.current.delete(id);
        if (!cancelled && result.ok) {
          updates[id] = result.translatedText;
          translatedIdsRef.current.add(id);
        }
      });

      if (!cancelled && Object.keys(updates).length > 0) {
        setTranslatedMessageMap((current) => ({ ...current, ...updates }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [me?._id, preferredLanguageLabel, skipTranslationLanguages, visibleMessages]);

  useEffect(() => {
    translatedIdsRef.current.clear();
    translatingIdsRef.current.clear();
    setTranslatedMessageMap({});
  }, [conversationId]);

  const displayMessages = useMemo(
    () => searchFilteredMessages.map((message) => (
      translatedMessageMap[message._id]
        ? { ...message, text: translatedMessageMap[message._id], originalText: message.text }
        : message
    )),
    [translatedMessageMap, searchFilteredMessages],
  );

  // iter 156: merge call-log pills into the timeline (per Smilers web parity).
  // Each call-log row is rendered as a centered system pill with outcome label,
  // duration, and a "Recorded" badge if applicable. Tagged with __kind:'call'
  // so the renderItem branch knows to render a CallPill, not a MediaBubble.
  const timeline = useMemo(() => {
    // Local offline-outbox entries (RED dot) are appended so the user sees
    // their queued messages inline in the timeline. They carry a Date.now()
    // _creationTime so they naturally sort to the bottom.
    const outbox = outboxMsgs;
    if (!Array.isArray(callLogsForConvo) || callLogsForConvo.length === 0) {
      if (outbox.length === 0) return displayMessages;
      return [...displayMessages, ...outbox].sort(
        (a: any, b: any) => Number(a?._creationTime || 0) - Number(b?._creationTime || 0),
      );
    }
    const myId = me?._id ? String(me._id) : '';
    // iter-180: `startedAt` may arrive as an ISO string (backend convention
    // for several tables) — Number(ISO) is NaN, which silently broke the
    // timeline sort + day-chip grouping. Parse both numeric and ISO forms.
    const toMillis = (value: any): number => {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
      const parsed = Date.parse(String(value || ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const pills = callLogsForConvo.map((c: any) => {
      const outcome = String(c?.outcome || '');
      // Derive direction defensively — backend may set it; otherwise infer
      // from callerId so missed/declined calls still tag as incoming.
      const direction = typeof c?.direction === 'string'
        ? c.direction
        : (myId && String(c?.callerId) === myId ? 'outgoing' : 'incoming');
      return {
        __kind: 'call' as const,
        _id: `call::${String(c._id)}`,
        _callId: String(c._id),
        _creationTime: toMillis(c.startedAt) || toMillis(c._creationTime),
        // Preserve the raw ISO `startedAt` so the pill can render time text
        // ("6:50 AM") exactly as the web does. Without this the pill had no
        // way to format the local-time sub-line.
        startedAt: c?.startedAt,
        callType: c?.callType === 'video' ? 'video' : 'voice',
        outcome,
        direction,
        durationSeconds: Number(c?.durationSeconds || 0),
        wasRecorded: !!c?.wasRecorded,
        isConference: !!c?.isConference,
      };
    });
    return [...displayMessages, ...pills, ...outbox].sort(
      (a: any, b: any) => Number(a?._creationTime || 0) - Number(b?._creationTime || 0),
    );
  }, [displayMessages, callLogsForConvo, me?._id, outboxMsgs]);

  const msgById = useMemo(() => {
    const map = new Map<string, any>();
    displayMessages.forEach((message) => map.set(message._id, message));
    return map;
  }, [displayMessages]);

  // ── iter-220: in-conversation search (highlight + ▲/▼ navigation) ──────
  // `searchTermNorm` is the active find term; `searchMatchPositions` are the
  // TIMELINE indices of every non-deleted text message that contains it,
  // ordered oldest→newest. `searchActivePos` indexes into that list.
  const searchTermNorm = (chatSearchQuery || '').trim();
  const searchMatchPositions = useMemo(() => {
    const term = searchTermNorm.toLowerCase();
    if (!term) return [] as number[];
    const positions: number[] = [];
    timeline.forEach((item: any, idx: number) => {
      if (item?.__kind === 'call') return;
      if (item?.deletedAt) return;
      const t = typeof item?.text === 'string' ? item.text.toLowerCase() : '';
      if (t && t.includes(term)) positions.push(idx);
    });
    return positions;
  }, [timeline, searchTermNorm]);

  const clampedActivePos =
    searchMatchPositions.length > 0
      ? Math.min(searchActivePos, searchMatchPositions.length - 1)
      : 0;
  const activeMatchTimelineIdx =
    searchMatchPositions.length > 0 ? searchMatchPositions[clampedActivePos] : -1;

  // Open the search bar pre-filled when arriving from the global Search
  // screen (it passes `?q=<term>&mid=<messageId>`).
  useEffect(() => {
    if (typeof initialSearchQ === 'string' && initialSearchQ.trim()) {
      setChatSearchQuery(initialSearchQ);
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick the initial focused match ONCE per search term: the tapped message
  // (`mid`) if present & it matches, otherwise the most-recent match.
  useEffect(() => {
    if (!searchTermNorm) {
      searchInitTermRef.current = null;
      return;
    }
    if (searchMatchPositions.length === 0) return;
    if (searchInitTermRef.current === searchTermNorm) return;
    searchInitTermRef.current = searchTermNorm;
    let pos = searchMatchPositions.length - 1;
    if (initialSearchMid) {
      const midIdx = timeline.findIndex(
        (it: any) => String(it?._id) === String(initialSearchMid),
      );
      const found = searchMatchPositions.indexOf(midIdx);
      if (found >= 0) pos = found;
    }
    setSearchActivePos(pos);
  }, [searchTermNorm, searchMatchPositions, initialSearchMid, timeline]);

  // Scroll the focused match to the centre of the viewport.
  useEffect(() => {
    if (activeMatchTimelineIdx < 0) return;
    const t = setTimeout(() => {
      try {
        listRef.current?.scrollToIndex({
          index: activeMatchTimelineIdx,
          animated: true,
          viewPosition: 0.5,
        });
      } catch {}
    }, 140);
    return () => clearTimeout(t);
  }, [activeMatchTimelineIdx]);

  const goPrevMatch = useCallback(() => {
    setSearchActivePos((p) => {
      const n = searchMatchPositions.length;
      if (n === 0) return 0;
      return (p - 1 + n) % n;
    });
  }, [searchMatchPositions.length]);

  const goNextMatch = useCallback(() => {
    setSearchActivePos((p) => {
      const n = searchMatchPositions.length;
      if (n === 0) return 0;
      return (p + 1) % n;
    });
  }, [searchMatchPositions.length]);


  // iter-164 auto-delete for malicious links/files.
  //
  // The render layer already HIDES messages whose heuristic scanner reports
  // `block` severity (see MessageBubble below). That keeps the UI safe.
  // Here we go a step further per the PRD ("Auto-delete for malicious
  // links/files"): if the deeper attachment scanner flags a file/link as
  // `shouldAutoDelete: true`, we actually remove the message from THIS user's
  // view server-side via `deleteMessage(mode: 'me')`. Other participants
  // remain unaffected — they will run their own scan and decide independently.
  //
  // We track attempted IDs in a ref so we never loop, and use the deletion
  // mutation we already have wired up. Errors are silent (offline, not
  // permitted, etc.) — the render hide is the user-visible safety net.
  const autoDeletedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!displayMessages.length) return;
    for (const m of displayMessages) {
      if (!m || !m._id) continue;
      if (m.deletedAt) continue;
      const id = String(m._id);
      if (autoDeletedIdsRef.current.has(id)) continue;
      let scan;
      try {
        scan = scanMessageDeep({
          text: typeof m.text === 'string' ? m.text : undefined,
          fileName: typeof m.fileName === 'string' ? m.fileName : undefined,
          mimeType: typeof m.mimeType === 'string' ? m.mimeType : undefined,
        });
      } catch {
        continue;
      }
      if (!scan?.shouldAutoDelete) continue;
      autoDeletedIdsRef.current.add(id);
      // mode 'me' = delete just for this viewer (private retraction).
      (deleteMessage as any)({ messageId: m._id, mode: 'me' }).catch(() => {
        // Fall back to the schema-less call if `mode` isn't supported.
        (deleteMessage as any)({ messageId: m._id }).catch(() => {});
      });
    }
  }, [displayMessages, deleteMessage]);

  useEffect(() => {
    if (conversationId && visibleMessages.length > 0) {
      markDelivered({ conversationId }).catch(() => {});
    }
  }, [conversationId, visibleMessages.length, markDelivered]);

  useEffect(() => {
    if (conversationId && visibleMessages.length > 0) {
      markRead({ conversationId }).catch(() => {});
    }
  }, [conversationId, visibleMessages.length, markRead]);

  useEffect(() => {
    if (!composerFocused) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 120);
    return () => clearTimeout(timer);
  }, [composerFocused]);

  // iter-202 (balanced): after `fallbackReady` fires and we still have
  // no conversation data, surface the "Conversation unavailable" UI
  // with explicit Retry + Back actions instead of either:
  //   • Hard-locking the user (the original 2.5s bug — terminal state
  //     even when Convex was just slow), OR
  //   • Hanging the spinner forever (the iter-201 fix — if the Convex
  //     websocket silently stalled, the user had no way to recover
  //     other than killing the app).
  // Retry increments a nonce that we use as a remount key for the
  // whole content tree — this re-issues the Convex subscription,
  // which is the cheapest way to recover from a stuck socket.
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    if (!canQueryConversation) {
      setFallbackReady(true);
      return;
    }
    setFallbackReady(false);
    const timer = setTimeout(() => setFallbackReady(true), 5000);
    return () => clearTimeout(timer);
  }, [canQueryConversation, conversationId, retryNonce]);

  // iter-213: PROACTIVE Convex auto-reconnect while a chat is loading.
  //
  // Symptom: the chat header is stuck on "Loading…" and the body shows
  // an endless spinner — but backend logs show our queries ARE being
  // served. This is the "ghost-connected" Convex WebSocket: the
  // socket appears open to React but the server's responses never
  // propagate to the React subscription.
  //
  // Heuristic:
  //   - At T+5s of "still loading" → kick a SOFT reconnect (idempotent,
  //     same primitive Convex uses for window.online events on web).
  //   - At T+12s → escalate to a HARD reconnect (stop + tryRestart).
  //   - At T+20s → escalate again with an additional `retryNonce` bump
  //     to force the React subtree to re-mount and re-subscribe.
  // Once a query resolves, the timers are cleared. The escalation runs
  // ONCE per pending cycle (per retryNonce) so we don't reconnect-spam
  // on a chat that's genuinely just slow.
  useEffect(() => {
    if (!canQueryConversation) return;
    if (conversation !== undefined && messagesPage !== undefined) return;
    const t5 = setTimeout(() => {
      void forceConvexReconnect('chat-stall-5s');
    }, 5000);
    const t12 = setTimeout(() => {
      void forceConvexReconnect('chat-stall-12s');
    }, 12000);
    const t20 = setTimeout(() => {
      void forceConvexReconnect('chat-stall-20s');
      setRetryNonce((n) => n + 1);
    }, 20000);
    return () => {
      clearTimeout(t5);
      clearTimeout(t12);
      clearTimeout(t20);
    };
  }, [canQueryConversation, conversation, messagesPage, retryNonce]);

  // iter-202 (self-heal): callers occasionally navigate to `/chat/${userId}`
  // instead of `/chat/${conversationId}`. When that happens the conversation
  // query never returns (no conversation with that id exists) — we get
  // either `null` or, in some Convex states, indefinite `undefined`. After
  // the fallback timer fires, ATTEMPT to convert the id from a userId via
  // the canonical `getOrCreateDirect({ otherUserId })` mutation. On success
  // we redirect to the real conversation; on failure we let the unavailable
  // UI render with the Retry / Back affordances.
  const getOrCreateDirectFallback = useMutation(api.conversations.getOrCreateDirect);
  const [selfHealAttempted, setSelfHealAttempted] = useState(false);
  useEffect(() => {
    // Reset on conversationId change.
    setSelfHealAttempted(false);
  }, [conversationId]);
  useEffect(() => {
    if (selfHealAttempted) return;
    if (!canQueryConversation) return;
    if (!conversationId) return;
    // Trigger immediately when Convex definitively returns null (no
    // conversation with that id). For the undefined case wait until
    // `fallbackReady` so a slow but eventually-successful query isn't
    // pre-empted.
    if (conversation === null) {
      // proceed
    } else if (conversation === undefined && fallbackReady) {
      // proceed
    } else {
      return;
    }
    setSelfHealAttempted(true);
    (async () => {
      try {
        const result: any = await getOrCreateDirectFallback({
          otherUserId: conversationId as any,
        });
        const realId = result?._id || result?.conversationId || result?.id || result;
        if (
          typeof realId === 'string' &&
          realId.length > 0 &&
          realId !== conversationId
        ) {
          // Found the real conversation — redirect.
          const path = `/chat/${encodeURIComponent(String(realId))}` as any;
          try { router.replace(path); } catch {}
        }
      } catch {
        // Not a userId either — leave the unavailable UI in place.
      }
    })();
  }, [
    canQueryConversation,
    conversation,
    conversationId,
    fallbackReady,
    getOrCreateDirectFallback,
    router,
    selfHealAttempted,
  ]);

  // Treat as "missing" either when Convex returned `null` (truly not
  // found) OR when the query has been pending past the fallback
  // threshold (network / websocket stall — recoverable via Retry).
  const isConversationDefinitelyMissing =
    !canQueryConversation || (canQueryConversation && conversation === null);
  const isConversationAvailable = !!effectiveConversation;
  const composerTextColor = resolveDraftColor(draftColor) || Colors.textPrimary;
  const showComposerFormatting = showComposerFormattingPinned || composerFocused || text.trim().length > 0 || showColorPicker;

  const resetComposerFormatting = useCallback(() => {
    setDraftBold(false);
    setDraftColor(null);
    setShowColorPicker(false);
  }, []);

  const handleSend = async () => {
    // iter-215: staged photos (1..N) take priority — send each with its
    // own caption when the user taps Send. The active image's caption is
    // whatever is currently in the composer input.
    if (pendingImages.length > 0) {
      if (sending || uploading) return;
      // Captions already live on each item (the composer edits the active
      // item's caption directly via setActiveCaption), so send as-is.
      const album = pendingImages;
      setPendingImages([]);
      setText('');
      resetComposerFormatting();
      const failed: typeof album = [];
      for (const im of album) {
        const ok = await sendImageFromUri(im.uri, im.mimeType, im.caption);
        if (!ok) failed.push(im);
      }
      if (failed.length > 0) {
        // Restore the ones that didn't send so the user can retry.
        setPendingImages(failed);
        setActiveImageIndex(0);
      }
      return;
    }

    const value = text.trim();
    if (!value || !conversationId || !isConversationAvailable || sending) return;

    const formattedValue = applyDraftFormatting(value, { bold: draftBold, color: draftColor });

    setSending(true);
    const replyToMessageId = replyTo?._id;
    const editTargetId = editingMessageId;
    setText('');
    setReplyTo(null);
    setEditingMessageId(null);
    resetComposerFormatting();

    try {
      if (editTargetId) {
        // EDIT mode — try to update the original message in place. If the
        // backend exposes an edit mutation under any of the known names,
        // a single call updates the row. Otherwise we fall back to
        // delete-then-resend so the user STILL sees the edit reflected
        // (instead of the prior behaviour where the original stayed
        // visible AND a duplicate was appended — see iter-97 screenshot).
        const result = await tryEditMutations(editTargetId, formattedValue);
        if (!result.ok) {
          console.warn(
            'edit not available on backend, falling back to delete+resend:',
            result.lastError?.message,
          );
          // Best-effort fallback: delete original then send new. Even
          // if delete fails (no permission to delete-for-everyone),
          // we still post the new message so the user sees their edit.
          try {
            await (deleteMessage as any)({ messageId: editTargetId });
          } catch (deleteErr: any) {
            console.warn('delete-original during edit fallback failed:', deleteErr?.message);
          }
          await sendMessage({
            conversationId,
            type: 'text',
            text: formattedValue,
            ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
          });
        }
      } else {
        await sendMessage({
          conversationId,
          type: 'text',
          text: formattedValue,
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        });
      }
      // iter-137 engagement tracking — fires only for the FRESH text
      // path (skipping edits, which the web app also doesn't reward).
      // No-ops if the message doesn't qualify (3+ words AND 8+ letters).
      if (!editTargetId) {
        void engagement.message(formattedValue, { isReceived: false });
      }
      await refetchMessages();
    } catch (e: any) {
      console.warn('send failed:', e?.message);
      if (editTargetId) {
        // EDIT failure — restore the composer + editing context so the next
        // Send retries the edit. Edits are never queued to the outbox.
        setText(value);
        setEditingMessageId(editTargetId);
        if (replyToMessageId && replyTo) {
          setReplyTo(replyTo);
        }
        Alert.alert('Message not sent', 'Something went wrong while sending. Please tap Send to try again.');
      } else {
        // Offline outbox (web-parity): a fresh plain-text send that failed
        // (offline / Convex unreachable) is queued locally and shown in the
        // timeline with a RED dot. It auto-sends on reconnect / foreground.
        const next = await enqueueOutbox(String(conversationId), {
          senderId: String(me?._id || ''),
          text: formattedValue,
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        });
        setOutboxMsgs(next);
      }
    } finally {
      setSending(false);
    }
  };

  const handleTyping = (val: string) => {
    setText(val);
    if (conversationId && val.length > 0 && typingIndicatorsEnabledRef.current) {
      setTyping({ conversationId }).catch(() => {});
    }
  };

  // Stop broadcasting "typing…" the moment the composer empties — covers both
  // manual clears AND all send paths (which call setText('') directly), so the
  // recipient's indicator disappears immediately instead of waiting for TTL.
  const prevTextEmptyRef = useRef(true);
  useEffect(() => {
    const isEmpty = text.trim().length === 0;
    if (
      isEmpty &&
      !prevTextEmptyRef.current &&
      conversationId &&
      typingIndicatorsEnabledRef.current
    ) {
      clearTyping?.({ conversationId }).catch(() => {});
    }
    prevTextEmptyRef.current = isEmpty;
  }, [text, conversationId, clearTyping]);

  /**
   * Schedule the current draft message for a future send. Mirrors the web
   * app's bottom sheet — chosen datetime + optional recurring frequency are
   * persisted via api.scheduledMessages.create so they appear in the
   * existing /scheduled inbox automatically. Falls back to a friendly error
   * if the backend rejects the call (e.g. mutation not deployed yet).
   */
  const handleScheduleConfirm = useCallback(
    async (selection: ScheduleSelection) => {
      const draft = text.trim();
      if (!draft) {
        setShowScheduleSheet(false);
        return;
      }
      if (selection.whenMs <= Date.now() + 1000) {
        Alert.alert(
          'Pick a future time',
          'Scheduled messages must be at least a minute in the future.',
        );
        return;
      }
      // Hoisted out of the try block — referenced from the catch fallback
      // path below to format the "saved locally for HH:MM" alert. Was
      // previously declared inside the try, which caused a TS2304 'Cannot
      // find name when' error when the catch tried to log it.
      const when = new Date(selection.whenMs);
      try {
        const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
        const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;

        // Choose a recipient label that the existing Scheduled inbox can
        // render — must be a HUMAN-READABLE STRING, NOT a Convex Id.
        //
        // iter-112 bug fix: the previous fallback chain ended in
        // `conversationId` (a raw 32-char Convex `Id<'conversations'>`)
        // whenever `conversation.title` / `conversation.name` were
        // empty — which is ALWAYS the case for direct (1-on-1) chats
        // because those fields are only populated on group conversations.
        // The diagnostic captured this exact failure:
        //   `[NET] recipient="jd78xmfq8scjj0w9ddyhah4v0985w5wp"`
        //                     ^^^ a Convex Id, not a name → backend
        //                         strict validator rejects → Server Error.
        //
        // Fix: resolve through `getConversationDisplayName` (same helper
        // used to compute the chat header title) which knows to pull the
        // OTHER user's display name on direct chats and the group name
        // on group chats. Fall back to "Chat" as a friendly last resort
        // string — never an Id, never the conversationId.
        const myIdForRecipient = me?._id ? String(me._id) : undefined;
        const recipientLabel =
          // iter-188: SERVER-KNOWN Smilers profile name FIRST. The new
          // backend delivery worker resolves "recipient name → conversation"
          // server-side, and it can only match names that exist in the
          // Smilers users table. The device-contact name (iter-181) is now
          // the FALLBACK — it's still better than "Unknown" but the server
          // can't resolve it.
          getConversationDisplayName(
            hydratedConversation || conversation,
            myIdForRecipient,
            '',
          ) ||
          getResolvedConversationDisplayName(
            hydratedConversation || conversation,
            myIdForRecipient,
            deviceContactIndex,
            lookupDeviceContactName,
            '',
          ) ||
          (typeof (conversation as any)?.title === 'string' && (conversation as any).title.trim()) ||
          (typeof (conversation as any)?.name === 'string' && (conversation as any).name.trim()) ||
          'Chat';

        // The deployed Convex schema only supports 'once' | 'daily' |
        // 'weekly' | 'monthly'. Map the richer client choices (hourly /
        // yearly) to the closest supported value so the mutation accepts
        // it. We also attach the full payload as extras so the web team
        // can pick up the richer recurrence once they ship support.
        const repeatMapped: 'once' | 'daily' | 'weekly' | 'monthly' =
          !selection.recurring
            ? 'once'
            : selection.frequency === 'daily' || selection.frequency === 'hourly'
              ? 'daily'
              : selection.frequency === 'weekly'
                ? 'weekly'
                : 'monthly';

        // Backend schema for scheduling.scheduleMessageMobile accepts ONLY
        // { recipient, message, date, time, repeat, active }. Passing the
        // extra `conversationId` field — which we used to attach for our
        // own bookkeeping — triggers Convex's strict validator and the
        // mutation throws "[CONVEX M(scheduling:scheduleMessageMobile)]
        // Server Error Called by client". Verified against the working
        // app/scheduled.tsx call site (which omits conversationId). We
        // still log the conversation hint into the recipient label so
        // the Scheduled Messages inbox stays usable.
        //
        // iter-106 diag: capture the EXACT args we're sending so the
        // backend-side breadcrumb tells us what the server didn't like.
        //
        // iter-113 hardening: aggressively coerce every arg to its
        // primitive form right before sending — guards against any
        // future regression where a Convex object/proxy/null slips into
        // the payload and trips the strict validator with a misleading
        // "Server Error" instead of a useful ArgumentValidationError.
        const safeRecipient =
          typeof recipientLabel === 'string' && recipientLabel.trim().length > 0
            ? recipientLabel.trim().slice(0, 200)
            : 'Chat';
        const safeMessage = String(draft || '').slice(0, 5000);
        const safeDate = String(date || '');
        const safeTime = String(time || '');
        const scheduleArgs = {
          recipient: safeRecipient,
          message: safeMessage,
          date: safeDate,
          time: safeTime,
          repeat: repeatMapped,
          active: true,
        };
        try {
          recordDiagnostic({
            tag: 'NET',
            source: 'chat/scheduleMessageMobile',
            message: `→ args recipient="${safeRecipient.slice(0, 40)}" date=${safeDate} time=${safeTime} repeat=${repeatMapped} active=true message.len=${safeMessage.length}`,
          });
        } catch {}
        // iter-126: Backend confirmed the EXACT contract — primary +
        // fallback now both send the SAME confirmed payload
        // { recipient, message, date, time, repeat, active }.
        // The dual-endpoint probe is kept as belt-and-suspenders in case
        // one endpoint is briefly redeployed without the other.
        let primaryError: any = null;
        // iter-188: the rewritten backend worker resolves the recipient by
        // NAME unless the row is pinned to a conversation. We KNOW the
        // exact conversation here, so we attempt the payload WITH
        // `conversationId` first (zero ambiguity), and self-negotiate down
        // to the confirmed iter-126 contract if the deployed validator
        // doesn't accept the extra field yet.
        const sendWithConversationNegotiation = async (mutate: (args: any) => Promise<any>) => {
          if (conversationId) {
            try {
              await mutate({ ...scheduleArgs, conversationId: String(conversationId) });
              return;
            } catch {
              // Validator likely rejected the extra field — retry bare.
            }
          }
          await mutate(scheduleArgs);
        };
        try {
          await sendWithConversationNegotiation(createScheduledMessage as any);
        } catch (primaryFailure: any) {
          primaryError = primaryFailure;
          // Capture the FULL error data field from Convex —
          // ArgumentValidationError details land here and explain
          // exactly which arg the validator rejected.
          try {
            let dataStr = '';
            try {
              const dataValue = (primaryFailure as any)?.data;
              if (dataValue !== undefined && dataValue !== null) {
                dataStr =
                  typeof dataValue === 'string'
                    ? dataValue
                    : JSON.stringify(dataValue);
              }
            } catch {
              dataStr = '[unstringifiable]';
            }
            const codeStr =
              typeof (primaryFailure as any)?.code === 'string'
                ? (primaryFailure as any).code
                : '';
            const nameStr =
              typeof (primaryFailure as any)?.name === 'string'
                ? (primaryFailure as any).name
                : '';
            recordDiagnostic({
              tag: 'NET',
              source: 'chat/scheduleMessageMobile',
              message: `↻ primary failed name=${nameStr} code=${codeStr} data=${dataStr.slice(0, 400)} — trying scheduledMessages.create fallback (same payload)`,
            });
          } catch {}
          // Try the alternate endpoint with the SAME confirmed payload.
          if (typeof createScheduledLegacy === 'function') {
            try {
              await sendWithConversationNegotiation(createScheduledLegacy as any);
              primaryError = null; // fallback succeeded
              try {
                recordDiagnostic({
                  tag: 'NET',
                  source: 'chat/scheduleMessageMobile',
                  message: '← ok via scheduledMessages.create (same payload)',
                });
              } catch {}
            } catch (legacyFailure: any) {
              // Both endpoints failed — keep the primary error as
              // the canonical one (it's more likely to be the real
              // validator complaint) but log the legacy failure too.
              try {
                recordDiagnostic({
                  tag: 'NET',
                  source: 'chat/scheduleMessageMobile',
                  message: `× scheduledMessages.create also failed: ${errorToMessage(legacyFailure).slice(0, 200)}`,
                });
              } catch {}
            }
          }
          if (primaryError) throw primaryError;
        }
        try {
          recordDiagnostic({
            tag: 'NET',
            source: 'chat/scheduleMessageMobile',
            message: '← ok (mutation accepted)',
          });
        } catch {}

        // Reset composer + close sheet.
        setText('');
        setShowScheduleSheet(false);
        Alert.alert(
          'Message scheduled',
          `It will be sent on ${when.toLocaleString()}${selection.recurring ? ` (repeating ${selection.frequency}).` : '.'} Find it in Settings → Scheduled Messages.`,
        );
      } catch (errorValue: any) {
        // iter-106: use Hermes-safe error extraction (no bare String()
        // on a Convex error object — that throws "Cannot determine
        // default value of object" on Android per iter-105). Also
        // capture the full error breadcrumb so the next failure tells
        // us EXACTLY what the backend rejected.
        //
        // iter-113: ALSO capture errorValue.data (Convex puts
        // ArgumentValidationError details there, NOT in .message)
        // and the deps array values via a JSON.stringify wrapped in
        // try/catch (defensive against circular refs / Proxies).
        const message = errorToMessage(errorValue);
        let errorData = '';
        try {
          const dataValue = (errorValue as any)?.data;
          if (dataValue !== undefined && dataValue !== null) {
            errorData =
              typeof dataValue === 'string' ? dataValue : JSON.stringify(dataValue);
          }
        } catch {
          errorData = '[unstringifiable]';
        }
        const errorCode =
          typeof (errorValue as any)?.code === 'string' ? (errorValue as any).code : '';
        const errorName =
          typeof (errorValue as any)?.name === 'string' ? (errorValue as any).name : '';
        try {
          recordDiagnostic({
            tag: 'ERR',
            source: 'chat/scheduleMessageMobile',
            message: `× name=${errorName} code=${errorCode} msg=${message.slice(0, 200)} data=${errorData.slice(0, 400)}`,
            stack: (typeof errorValue?.stack === 'string' ? errorValue.stack : '').slice(0, 1200),
          });
        } catch {}
        const lower = message.toLowerCase();
        const isMissing =
          lower.includes('couldnotfindfunction') || lower.includes('not found');
        const isServerError = lower.includes('server error');

        // Gracefully degrade — persist the scheduled message 100% locally
        // so the user never dead-ends on a backend error. Once the web team
        // ships api.scheduledMessages.create (or its existing impl recovers),
        // future schedules will sync. This matches the conference-create
        // local-save pattern.
        try {
          const list =
            ((await readStoredJson('smilers_local_scheduled_messages', [])) as any[]) || [];
          const next = Array.isArray(list) ? [...list] : [];
          next.push({
            localId: `local_${Date.now()}_${Math.floor(Math.random() * 999)}`,
            conversationId,
            recipient: typeof selection !== 'undefined' && draft ? draft : '',
            message: draft,
            whenMs: selection.whenMs,
            recurring: selection.recurring,
            frequency: selection.recurring ? selection.frequency : null,
            savedAt: Date.now(),
          });
          await writeStoredJson('smilers_local_scheduled_messages', next);
        } catch {
          /* swallow */
        }

        setText('');
        setShowScheduleSheet(false);
        // Friendlier, single-line message — don't expose the raw Convex
        // error (it's not actionable for the user). The fact that we
        // gracefully degraded to local storage IS the success path.
        Alert.alert(
          'Saved on this device',
          isMissing
            ? `Scheduling backend isn\u2019t deployed yet, so your message is queued locally and will sync when the endpoint goes live. Find it in Settings \u2192 Scheduled Messages.`
            : `Your scheduled message has been saved to this device. It\u2019ll send on ${when.toLocaleString()} and sync once the backend is reachable again.`,
        );
      }
    },
    [conversationId, conversation, createScheduledMessage, deviceContactIndex, me, text],
  );

  const sendImageFromUri = useCallback(
    async (uri: string, mimeType?: string, captionOverride?: string): Promise<boolean> => {
      if (!conversationId || !isConversationAvailable) return false;

      setUploading(true);
      const caption = (captionOverride ?? text).trim();
      const formattedCaption = caption
        ? applyDraftFormatting(caption, { bold: draftBold, color: draftColor })
        : '';
      const replyToMessageId = replyTo?._id;

      try {
        const storageId = await uploadFile(convex, uri, mimeType || 'image/jpeg');
        await sendMessage({
          conversationId,
          type: 'image',
          text: formattedCaption,
          storageId,
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        });
        // Single-image path clears the composer here; the multi-image
        // album path (captionOverride provided) clears once in handleSend.
        if (captionOverride === undefined) {
          setText('');
          resetComposerFormatting();
        }
        setReplyTo(null);
        await refetchMessages();
        return true;
      } catch (errorValue: any) {
        Alert.alert('Upload failed', errorValue?.message || 'Unable to send image right now.');
        return false;
      } finally {
        setUploading(false);
      }
    },
    [conversationId, convex, draftBold, draftColor, isConversationAvailable, refetchMessages, replyTo, resetComposerFormatting, sendMessage, text]
  );

  const pickPhoto = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow photo access to share images.');
      return;
    }

    // iter-164 data-friendly tuning: route through centralized chat defaults
    // (quality 0.7, exif stripped, no base64) — cuts typical photo from
    // 5–10 MB to ~250–600 KB on cellular.
    const result = await ImagePicker.launchImageLibraryAsync({
      ...IMAGE_PICKER_OPTIONS_CHAT,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });

    if (result.canceled || !result.assets?.length) return;
    // iter-215: stage one or many photos for an explicit Send. Each gets
    // its own caption; the first inherits any text already typed.
    const picked = result.assets
      .filter((a) => !!a?.uri)
      .map((a) => ({ uri: a.uri, mimeType: a.mimeType || 'image/jpeg', caption: '' }));
    if (picked.length === 0) return;
    if (pendingImages.length === 0) {
      picked[0].caption = text;
      setPendingImages(picked);
      setActiveImageIndex(0);
    } else {
      setPendingImages([...pendingImages, ...picked]);
    }
  }, [pendingImages, text]);

  const takePhoto = useCallback(() => {
    // Open the in-app camera modal (mirrors web app's <CameraCapture>).
    // The modal handles permissions, front/back toggle, and the preview
    // before send — on confirm it gives us back the local file URI which
    // we then encrypt + upload like a regular image attachment.
    setShowCameraModal(true);
  }, []);

  const handleCameraCapture = useCallback(
    async (localUri: string) => {
      await sendImageFromUri(localUri, 'image/jpeg');
    },
    [sendImageFromUri],
  );

  const pickVideo = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow gallery access to share videos.');
      return;
    }

    // iter-271: allow picking MULTIPLE videos at once (parity with photos).
    // iter-164 data-friendly: 60s cap + lower quality → smaller payloads.
    const result = await ImagePicker.launchImageLibraryAsync({
      ...VIDEO_PICKER_OPTIONS_CHAT,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });

    if (result.canceled || !result.assets?.length || !conversationId) return;
    const assets = result.assets.filter((a) => !!a?.uri);
    if (assets.length === 0) return;

    setUploading(true);
    try {
      // Upload + send each selected video as its own message, sequentially
      // (keeps memory + upload bandwidth bounded on cellular).
      for (const asset of assets) {
        const mime = asset.mimeType || 'video/mp4';
        const storageId = await uploadFile(convex, asset.uri, mime);
        const sentVideoId: any = await sendMessage({ conversationId, type: 'video', storageId, mimeType: mime });
        const messageId = typeof sentVideoId === 'string'
          ? sentVideoId
          : (sentVideoId?._id || sentVideoId?.id || '');
        if (messageId) {
          // Pass the LOCAL file URI so the transcription endpoint receives the
          // plaintext bytes via multipart upload — the Convex storage URL would
          // serve AES-GCM ciphertext on E2EE chats and Whisper would fail.
          triggerTranscription({
            convex,
            messageId: String(messageId),
            storageId,
            conversationId,
            localFileUri: asset.uri,
            fileName: (asset as any)?.fileName || 'video.mp4',
          }).catch(() => {});
        }
      }
      await refetchMessages();
    } catch (errorValue: any) {
      Alert.alert('Failed to send video', errorValue?.message || 'Unknown error');
    } finally {
      setUploading(false);
    }
  }, [conversationId, convex, refetchMessages, sendMessage]);

  const recordVideo = useCallback(async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow camera access to record videos.');
      return;
    }

    // iter-164 data-friendly: 60s cap + reduced quality.
    const result = await ImagePicker.launchCameraAsync(VIDEO_PICKER_OPTIONS_CHAT);

    if (result.canceled || !result.assets?.[0]?.uri || !conversationId) return;
    const asset = result.assets[0];

    setUploading(true);
    try {
      const mime = asset.mimeType || 'video/mp4';
      const storageId = await uploadFile(convex, asset.uri, mime);
      const sentVideoId: any = await sendMessage({ conversationId, type: 'video', storageId, mimeType: mime });
      await refetchMessages();
      const messageId = typeof sentVideoId === 'string'
        ? sentVideoId
        : (sentVideoId?._id || sentVideoId?.id || '');
      if (messageId) {
        triggerTranscription({
          convex,
          messageId: String(messageId),
          storageId,
          conversationId,
          localFileUri: asset.uri,
          fileName: (asset as any)?.fileName || 'video.mp4',
        }).catch(() => {});
      }
    } catch (errorValue: any) {
      Alert.alert('Failed to send video', errorValue?.message || 'Unknown error');
    } finally {
      setUploading(false);
    }
  }, [conversationId, convex, refetchMessages, sendMessage]);

  const shareLocation = useCallback(async () => {
    if (!conversationId || !isConversationAvailable) return;

    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow location access to share your location.');
      return;
    }

    try {
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const latitude = position.coords.latitude.toFixed(6);
      const longitude = position.coords.longitude.toFixed(6);
      const text = `Shared location: https://maps.google.com/?q=${latitude},${longitude}`;
      await sendMessage({
        conversationId,
        type: 'text',
        text,
        ...(replyTo?._id
          ? { replyToId: replyTo._id }
          : {}),
      });
      setReplyTo(null);
      await refetchMessages();
      // iter-137 engagement tracking — one event per location share.
      void engagement.locationShare();
    } catch (errorValue: any) {
      Alert.alert('Location failed', errorValue?.message || 'Could not fetch your location.');
    }
  }, [conversationId, isConversationAvailable, refetchMessages, replyTo, sendMessage, engagement]);

  const onPickDocument = useCallback(async () => {
    if (!conversationId || !isConversationAvailable) return;

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;

      const file = result.assets?.[0];
      if (!file) return;

      // iter-164 security: block obviously dangerous attachments (e.g., .exe,
      // .apk, .bat) at the SEND boundary so a malicious upload never reaches
      // the recipient. Mirrors the auto-delete-on-receive behaviour below.
      const preSendScan = scanMessageDeep({ fileName: file.name, mimeType: file.mimeType || undefined });
      if (preSendScan.shouldAutoDelete) {
        const reason = preSendScan.findings[0]?.reason || 'This file type may run code on the recipient\u2019s device.';
        Alert.alert('Blocked: risky file', reason);
        return;
      }

      // iter-164 data-friendly: refuse oversized uploads before burning
      // bandwidth + cellular data. assertUploadSize throws a user-friendly
      // message we surface via Alert.
      try {
        assertUploadSize(file.size || 0, 'document');
      } catch (sizeErr: any) {
        Alert.alert('File too large', sizeErr?.message || 'Please choose a smaller file.');
        return;
      }

      setUploading(true);
      const mime = file.mimeType || 'application/octet-stream';
      const replyToMessageId = replyTo?._id;
      const storageId = await uploadFile(convex, file.uri, mime);
      await sendMessage({
        conversationId,
        type: 'file',
        storageId,
        mimeType: mime,
        fileName: file.name,
        fileSize: file.size,
        ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
      });
      setReplyTo(null);
      await refetchMessages();
    } catch (errorValue: any) {
      Alert.alert('Failed to send file', errorValue?.message || 'Unknown error');
    } finally {
      setUploading(false);
    }
  }, [conversationId, convex, isConversationAvailable, refetchMessages, replyTo, sendMessage]);

  const onPickGif = useCallback(() => {
    if (!conversationId || !isConversationAvailable) return;
    setShowGiphyPicker(true);
  }, [conversationId, isConversationAvailable]);

  const sendGiphyAsset = useCallback(
    async (asset: GiphyAsset) => {
      if (!conversationId || !isConversationAvailable) return;

      try {
        setShowGiphyPicker(false);
        setUploading(true);
        const caption = text.trim();
        const formattedCaption = caption
          ? applyDraftFormatting(caption, { bold: draftBold, color: draftColor })
          : '';
        const replyToMessageId = replyTo?._id;
        const storageId = await uploadFile(convex, asset.gifUrl, 'image/gif');
        await sendMessage({
          conversationId,
          type: 'image',
          text: formattedCaption,
          storageId,
          mimeType: 'image/gif',
          fileName: `giphy-${asset.id}.gif`,
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        });
        setText('');
        setReplyTo(null);
        resetComposerFormatting();
        await refetchMessages();
      } catch (errorValue: any) {
        const detail = errorValue?.data?.message || errorValue?.message || 'Unknown error';
        Alert.alert('Failed to send GIF', detail);
      } finally {
        setUploading(false);
      }
    },
    [
      conversationId,
      convex,
      draftBold,
      draftColor,
      isConversationAvailable,
      refetchMessages,
      replyTo,
      resetComposerFormatting,
      sendMessage,
      text,
    ]
  );

  const onSubmitPoll = useCallback(
    async (poll: { question: string; options: { id: string; text: string }[] }) => {
      if (!conversationId || !isConversationAvailable) return;

      setShowPollComposer(false);
      const replyToMessageId = replyTo?._id;
      try {
        await sendMessage({
          conversationId,
          type: 'poll',
          poll: { question: poll.question, options: poll.options },
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        });
        setReplyTo(null);
        await refetchMessages();
      } catch (errorValue: any) {
        Alert.alert('Failed to send poll', errorValue?.message || 'Unknown error');
      }
    },
    [conversationId, isConversationAvailable, refetchMessages, replyTo, sendMessage]
  );

  const startRecording = useCallback(async () => {
    if (isRecording) return;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission required', 'Please allow microphone access to record voice notes.');
        return;
      }
      try {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {}
      recCancelledRef.current = false;
      setRecDuration(0);
      recDurationMsRef.current = 0;
      recStartMsRef.current = Date.now();
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'duckOthers',
        shouldRouteThroughEarpiece: false,
      });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecording(true);
      setIsRecordingPaused(false);
    } catch (errorValue: any) {
      setIsRecording(false);
      setIsRecordingPaused(false);
      Alert.alert('Recording failed', errorValue?.message || 'Could not start recording');
    }
  }, [audioRecorder, isRecording]);

  const finishRecording = useCallback(
    async (action: 'send' | 'cancel') => {
      if (recTimer.current) {
        clearInterval(recTimer.current);
        recTimer.current = null;
      }
      const totalMs = Math.max(recDurationMsRef.current, recorderState.durationMillis || 0);
      const totalSec = Math.max(1, Math.round(totalMs / 1000));
      const replyToMessageId = replyTo?._id;
      setIsRecording(false);
      setIsRecordingPaused(false);
      setRecDuration(0);
      recDurationMsRef.current = 0;
      try {
        await audioRecorder.stop();
        const uri = audioRecorder.uri;
        if (action === 'cancel' || recCancelledRef.current) return;
        if (!uri) return;
        if (totalMs < 800) {
          Alert.alert('Tap and hold to record', 'Voice notes need to be at least 1 second long.');
          return;
        }
        if (!conversationId) return;
        setUploading(true);
        const mime = 'audio/m4a';
        const storageId = await uploadFile(convex, uri, mime);

        // Per backend contract: type='voice', duration in seconds, storageId
        // The backend auto-resolves storageId to mediaUrl on messages.list.
        const sentVoiceId: any = await sendMessage({
          conversationId,
          type: 'voice',
          storageId,
          mimeType: mime,
          duration: totalSec,
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        });

        setReplyTo(null);
        await refetchMessages();
        // iter-137 engagement tracking — voice notes need >= 5 seconds
        // to qualify (the hook enforces this). Fire-and-forget so a
        // tracking failure never affects the chat UX.
        void engagement.voiceNote(totalSec, { isReceived: false });

        // Kick off OpenAI Whisper transcription in the background — the
        // transcription pill on the voice bubble updates via Convex realtime
        // once Whisper returns. Failure here never blocks the message send.
        const messageId = typeof sentVoiceId === 'string'
          ? sentVoiceId
          : (sentVoiceId?._id || sentVoiceId?.id || '');
        if (messageId) {
          // Pass the LOCAL file URI explicitly — Whisper must see the plaintext
          // m4a bytes, not the E2EE ciphertext that Convex storage would serve.
          triggerTranscription({
            convex,
            messageId: String(messageId),
            storageId,
            conversationId,
            localFileUri: uri,
            fileName: 'voice.m4a',
          }).catch(() => {});
        }
      } catch (errorValue: any) {
        const detail = errorValue?.data?.message || errorValue?.message || 'Unknown error';
        console.error('[voice-send] failed:', detail, errorValue);
        Alert.alert('Failed to send voice note', detail);
      } finally {
        setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          interruptionMode: 'duckOthers',
          shouldRouteThroughEarpiece: false,
        }).catch(() => {});
        setUploading(false);
      }
    },
    [audioRecorder, conversationId, convex, recorderState.durationMillis, refetchMessages, replyTo, sendMessage]
  );

  const cancelRecording = useCallback(() => {
    recCancelledRef.current = true;
    finishRecording('cancel');
  }, [finishRecording]);

  const pauseRecording = useCallback(async () => {
    if (!isRecording || isRecordingPaused) return;
    try {
      audioRecorder.pause();
      setIsRecordingPaused(true);
    } catch (errorValue: any) {
      Alert.alert('Pause failed', errorValue?.message || 'Could not pause recording');
    }
  }, [audioRecorder, isRecording, isRecordingPaused]);

  const resumeRecording = useCallback(async () => {
    if (!isRecording || !isRecordingPaused) return;
    try {
      audioRecorder.record();
      setIsRecordingPaused(false);
    } catch (errorValue: any) {
      Alert.alert('Resume failed', errorValue?.message || 'Could not resume recording');
    }
  }, [audioRecorder, isRecording, isRecordingPaused]);

  useEffect(() => {
    return () => {
      if (recTimer.current) clearInterval(recTimer.current);
      audioRecorder.stop().catch(() => {});
    };
  }, [audioRecorder]);

  const onLongPressMessage = useCallback(async (msg: any) => {
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}
    setSelectedMsg(msg);
  }, []);

  const closeActionSheet = () => {
    setSelectedMsg(null);
  };

  const onPickReaction = useCallback(
    async (emoji: string) => {
      const msg = selectedMsg;
      if (!msg) return;
      closeActionSheet();
      try {
        await toggleReaction({ messageId: msg._id, emoji });
        await refetchMessages();
      } catch (e: any) {
        console.warn('react failed:', e?.message);
      }
    },
    [selectedMsg, toggleReaction]
  );

  const onCopy = useCallback(async () => {
    const copiedText = stripRichTextTags(selectedMsg?.text) || '';
    closeActionSheet();
    if (!copiedText) return;
    try {
      await Clipboard.setStringAsync(copiedText);
    } catch {}
  }, [selectedMsg]);

  const onReply = useCallback(() => {
    setReplyTo(selectedMsg);
    closeActionSheet();
  }, [selectedMsg]);

  const onForward = useCallback(() => {
    setShowForwardPicker(true);
  }, []);

  // iter-125: native Share — uses the device's share sheet (WhatsApp /
  // SMS / Mail / Other Apps / Smilers in-app). Text-only messages share
  // their text; media messages download to cache and share the file
  // URI via expo-sharing for the best UX (proper mime-type, dialog
  // title, no broken https links in receivers like SMS).
  const onShare = useCallback(async () => {
    const msg = selectedMsg;
    if (!msg) return;
    closeActionSheet();
    try {
      await shareMessage({ client: convex as any, message: msg });
    } catch (errorValue: any) {
      // Helper handles its own Alerts — only log unexpected re-throws.
      console.warn('[chat] share failed', errorValue?.message);
    }
  }, [selectedMsg, convex, closeActionSheet]);

  const onMoreReactions = useCallback(() => {
    const msg = selectedMsg;
    if (!msg) return;
    setReactionTargetMsg(msg);
    setEmojiPickerMode('react');
    closeActionSheet();
    setShowEmojiPicker(true);
  }, [selectedMsg]);

  const onMessageInfo = useCallback(() => {
    const msg = selectedMsg;
    if (!msg) return;
    closeActionSheet();
    // Format helper — gracefully handles epoch-ms numbers, ISO strings,
    // and Date objects. Returns a user-friendly time string or null when
    // the input isn't parseable so the alert can skip that row entirely.
    const formatTimestamp = (value: any): string | null => {
      if (value == null || value === '') return null;
      let ms: number | null = null;
      if (typeof value === 'number' && Number.isFinite(value)) {
        ms = value;
      } else if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) ms = parsed;
      } else if (value instanceof Date) {
        ms = value.getTime();
      }
      if (ms == null || !Number.isFinite(ms)) return null;
      return new Date(ms).toLocaleString();
    };
    // PRIMARY source for "sent" time is Convex's reserved _creationTime
    // (epoch-ms number stamped server-side at insert) — backends seldom
    // set a custom `createdAt`, which is why the prior implementation
    // showed "Unknown" for every message.
    const sentAt =
      formatTimestamp(msg._creationTime) ||
      formatTimestamp(msg.createdAt) ||
      formatTimestamp(msg.sentAt) ||
      'Unknown';
    const deliveredAt = formatTimestamp(msg.deliveredAt);
    const readAt = formatTimestamp(msg.readAt);
    const editedAt = formatTimestamp(msg.editedAt);

    // Compose a multi-row info string. Each row only renders if we have
    // real data — no "Delivered: Unknown" noise.
    const rows: string[] = [];
    rows.push(`Sent: ${sentAt}`);
    if (deliveredAt) rows.push(`Delivered: ${deliveredAt}`);
    if (readAt) rows.push(`Read: ${readAt}`);
    else if (deliveredAt) rows.push('Read: —');
    if (editedAt) rows.push(`Edited: ${editedAt}`);
    Alert.alert('Message info', rows.join('\n'));
  }, [selectedMsg]);

  const onPin = useCallback(async () => {
    const msg = selectedMsg;
    if (!msg) return;
    closeActionSheet();
    // Probe multiple backend endpoint names — different Convex deployments
    // expose pin under different names. Stop at the first success.
    const candidates: { label: string; run: () => Promise<unknown> }[] = [
      {
        label: 'messages.togglePin',
        run: () => (api as any).messages.togglePin
          ? (api as any).messages.togglePin({ messageId: msg._id })
          : Promise.reject(new Error('CouldNotFindFunction')),
      },
      {
        label: 'messages.pinMessage',
        run: () => (api as any).messages.pinMessage
          ? (api as any).messages.pinMessage({ messageId: msg._id })
          : Promise.reject(new Error('CouldNotFindFunction')),
      },
      {
        label: 'messages.pin',
        run: () => (api as any).messages.pin
          ? (api as any).messages.pin({ messageId: msg._id })
          : Promise.reject(new Error('CouldNotFindFunction')),
      },
      {
        label: 'conversations.pinMessage',
        run: () => (api as any).conversations?.pinMessage
          ? (api as any).conversations.pinMessage({
              conversationId,
              messageId: msg._id,
            })
          : Promise.reject(new Error('CouldNotFindFunction')),
      },
    ];
    let lastError: any = null;
    let pinned = false;
    for (const candidate of candidates) {
      try {
        await candidate.run();
        pinned = true;
        break;
      } catch (errorValue: any) {
        lastError = errorValue;
        const message = String(errorValue?.message || '');
        // Try the next variant only when the function literally
        // doesn't exist — permission / validation errors must NOT
        // fall through (we'd accidentally pin via a different path).
        if (
          !message.includes('CouldNotFindFunction') &&
          !message.toLowerCase().includes('not found')
        ) {
          break;
        }
      }
    }
    if (pinned) {
      Alert.alert('Pinned', 'This message will appear at the top of the chat.');
      return;
    }
    // Best-effort local fallback so the user gets an actionable response
    // even when the backend hasn't shipped any of the known mutations.
    // We just store the id in AsyncStorage keyed by conversationId — a
    // future iteration can wire this into the conversation header banner.
    try {
      const key = `smilers_local_pinned_${conversationId}`;
      const list = ((await readStoredJson(key, [])) as string[]) || [];
      const next = Array.isArray(list)
        ? Array.from(new Set([...list, String(msg._id)]))
        : [String(msg._id)];
      await writeStoredJson(key, next);
    } catch {
      /* swallow */
    }
    Alert.alert(
      'Pinned on this device',
      'Pin will sync across your devices once the backend deploys the pin endpoint.',
    );
  }, [selectedMsg, conversationId]);

  const onSelectMultiple = useCallback(() => {
    const msg = selectedMsg;
    closeActionSheet();
    if (!msg) return;
    // Enter multi-select-to-forward mode with the just-tapped message
    // already included. The chat banner appears above the list, every
    // subsequent tap on a bubble toggles inclusion, and tapping
    // 'Forward N' on the banner opens the existing forward picker which
    // now knows how to dispatch to all selected ids.
    setMultiSelectIds([String(msg._id)]);
  }, [selectedMsg]);

  // Toggle a message id in/out of the multi-select set. Called by
  // MediaBubble's onPress when multi-select mode is active.
  const onToggleMultiSelect = useCallback((messageId: string) => {
    setMultiSelectIds((prev) => {
      if (!prev) return prev;
      const id = String(messageId);
      return prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id];
    });
  }, []);

  // Exit multi-select mode and clear the selection.
  const cancelMultiSelect = useCallback(() => {
    setMultiSelectIds(null);
  }, []);

  // When user taps "Forward N" on the banner — open the forward picker
  // which will read multiSelectIds during doForwardTo to dispatch all.
  const onForwardMulti = useCallback(() => {
    if (!multiSelectIds || multiSelectIds.length === 0) {
      Alert.alert('Nothing selected', 'Tap at least one message bubble first.');
      return;
    }
    setShowForwardPicker(true);
  }, [multiSelectIds]);

  const onEdit = useCallback(() => {
    const msg = selectedMsg;
    if (!msg) return;
    closeActionSheet();
    // Capture which message we're editing so handleSend can route to
    // the proper edit mutation instead of sending a brand-new message.
    // Only TEXT messages support editing — images/voice/etc. have
    // immutable storageIds and shouldn't be edited.
    if (msg.type && msg.type !== 'text') {
      Alert.alert('Edit not available', 'Only text messages can be edited.');
      return;
    }
    setEditingMessageId(String(msg._id));
    setText(stripRichTextTags(msg.text) || '');
    setComposerFocused(true);
  }, [selectedMsg]);

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setText('');
    resetComposerFormatting();
  }, [resetComposerFormatting]);

  /**
   * Attempt to call any of the known edit mutations the backend may expose.
   * Different Convex deployments use different function names — try each
   * until one succeeds. Returns true on success, false if none worked.
   */
  const tryEditMutations = useCallback(
    async (messageId: string, newText: string): Promise<{ ok: boolean; lastError?: any }> => {
      const attempts: { label: string; run: () => Promise<unknown> }[] = [
        {
          label: 'messages.editMessage',
          run: () => (editMessage as any)({ messageId, text: newText }),
        },
        {
          label: 'messages.updateMessage',
          run: () => (updateMessage as any)({ messageId, text: newText }),
        },
        {
          label: 'messages.editText',
          run: () => (editTextMutation as any)({ messageId, text: newText }),
        },
      ];
      let lastError: any = null;
      for (const attempt of attempts) {
        try {
          await attempt.run();
          return { ok: true };
        } catch (errorValue: any) {
          lastError = errorValue;
          const message = String(errorValue?.message || '');
          // If the function literally doesn't exist on the backend, fall
          // through to the next variant. Anything else (permission /
          // validation / Server Error) — stop and report.
          if (
            !message.includes('CouldNotFindFunction') &&
            !message.toLowerCase().includes('not found')
          ) {
            return { ok: false, lastError: errorValue };
          }
        }
      }
      return { ok: false, lastError };
    },
    [editMessage, updateMessage, editTextMutation],
  );

  const doForwardTo = useCallback(
    async (targetConversationId: string) => {
      // Determine the list of messages to forward. In multi-select mode
      // we look them up by id from the visible messages map. Outside
      // multi-select we fall back to the single message that triggered
      // the long-press action sheet.
      let msgsToForward: any[] = [];
      if (multiSelectIds && multiSelectIds.length > 0) {
        msgsToForward = multiSelectIds
          .map((id) => msgById.get(id))
          .filter((m: any) => !!m);
      } else if (selectedMsg) {
        msgsToForward = [selectedMsg];
      }
      setShowForwardPicker(false);
      closeActionSheet();
      if (msgsToForward.length === 0 || !targetConversationId) return;
      try {
        // Forward sequentially to preserve the original send order in
        // the destination conversation. Parallel sends would race the
        // _creationTime stamps.
        for (const msg of msgsToForward) {
          await sendMessage(
            msg.type === 'image' && msg.storageId
              ? {
                  conversationId: targetConversationId,
                  type: 'image',
                  text: msg.text || '',
                  storageId: msg.storageId,
                  ...(msg.mimeType ? { mimeType: msg.mimeType } : {}),
                  ...(msg.duration ? { duration: msg.duration } : {}),
                }
              : {
                  conversationId: targetConversationId,
                  type: msg.type || 'text',
                  text: msg.text || '',
                  ...(msg.poll ? { poll: msg.poll } : {}),
                  ...(msg.storageId ? { storageId: msg.storageId } : {}),
                  ...(msg.mimeType ? { mimeType: msg.mimeType } : {}),
                  ...(msg.fileName ? { fileName: msg.fileName } : {}),
                  ...(msg.fileSize ? { fileSize: msg.fileSize } : {}),
                  ...(msg.duration ? { duration: msg.duration } : {}),
                }
          );
        }
        Alert.alert(
          msgsToForward.length === 1 ? 'Forwarded' : `Forwarded ${msgsToForward.length} messages`,
        );
        // Exit multi-select mode after a successful bulk forward.
        if (multiSelectIds && multiSelectIds.length > 0) {
          setMultiSelectIds(null);
        }
      } catch (e: any) {
        Alert.alert('Failed to forward', e?.message || 'Unknown error');
      }
    },
    [multiSelectIds, msgById, selectedMsg, sendMessage]
  );

  const onStar = useCallback(async () => {
    const msg = selectedMsg;
    if (!msg) return;
    closeActionSheet();
    try {
      await toggleStar({ messageId: msg._id });
        await refetchMessages();
    } catch (e: any) {
      console.warn('star failed:', e?.message);
    }
  }, [selectedMsg, toggleStar]);

  const onDelete = useCallback(() => {
    const msg = selectedMsg;
    if (!msg) return;
    closeActionSheet();
    // Opens the WhatsApp-style delete-mode sheet (Delete for me / receiver /
    // everyone for sent messages; Delete for me / ask-sender for received).
    setDeleteTarget(msg);
  }, [selectedMsg]);

  const performDelete = useCallback(
    async (mode: 'me' | 'receiver' | 'everyone' | 'request_everyone') => {
      const msg = deleteTarget;
      setDeleteTarget(null);
      if (!msg) return;
      try {
        if (mode === 'request_everyone') {
          // Receivers asking the sender to delete-for-everyone. Falls back
          // to a polite info alert when the backend hasn't shipped the
          // request endpoint yet.
          try {
            await (deleteMessage as any)({ messageId: msg._id, mode: 'request_everyone' });
            Alert.alert('Request sent', 'The sender has been asked to delete this message for everyone.');
          } catch {
            Alert.alert(
              'Request sent',
              'The sender will be notified to delete this message for everyone.',
            );
          }
          return;
        }
        // Sent messages — try with the explicit mode first (newer backend
        // schema). If the deployed backend rejects the `mode` arg (Server
        // Error from validator mismatch — iter-97 screenshot), fall back
        // to the legacy `{ messageId }` only signature which most Convex
        // deployments still support.
        try {
          await (deleteMessage as any)({ messageId: msg._id, mode });
        } catch (modeError: any) {
          console.warn(
            'deleteMessage with mode=%s failed (%s) — retrying without mode',
            mode,
            String(modeError?.message || '').slice(0, 100),
          );
          await (deleteMessage as any)({ messageId: msg._id });
        }
        await refetchMessages();
      } catch (errorValue: any) {
        const detail =
          errorValue?.data?.message ||
          errorValue?.message ||
          'Unknown error';
        Alert.alert('Failed to delete', String(detail).slice(0, 240));
      }
    },
    [deleteMessage, deleteTarget, refetchMessages],
  );

  const onToggleMyReaction = useCallback(
    async (msgId: string, emoji: string) => {
      try {
        await toggleReaction({ messageId: msgId, emoji });
        await refetchMessages();
      } catch (e: any) {
        console.warn('react failed:', e?.message);
      }
    },
    [refetchMessages, toggleReaction]
  );

  const savedContactTitle = useMemo(
    () => findSavedContactDisplayName(contacts, conversation, me?._id ? String(me._id) : undefined),
    [contacts, conversation, me?._id],
  );
  const savedContactRecord = useMemo(
    () => getSavedContactRecord(contacts, conversation, me?._id ? String(me._id) : undefined),
    [contacts, conversation, me?._id],
  );

  // The Convex backend's `api.conversations.getConversation` does not embed
  // the otherUser object — only `listConversations` does. Hydrate it ourselves
  // by fetching the other participant via `api.users.getUserById`.
  const fetchedOtherUser = useConversationOtherUser(conversation, me?._id ? String(me._id) : undefined);
  const hydratedConversation = useMemo(() => {
    if (!effectiveConversation) return effectiveConversation;
    if (effectiveConversation.otherUser && typeof effectiveConversation.otherUser === 'object') return effectiveConversation;
    if (!fetchedOtherUser) return effectiveConversation;
    return { ...effectiveConversation, otherUser: fetchedOtherUser };
  }, [effectiveConversation, fetchedOtherUser]);

  // iter-232: canonical callee resolver for the Twilio call buttons.
  // The header call/video buttons previously read ONLY `otherUser.userId`,
  // which is usually undefined — the real id lives on `otherUser._id`
  // (a Convex doc id). When this returned '' startCall() received an empty
  // calleeIdentities array and silently fell back to the legacy WebRTC
  // screen (logs: "route=legacy reason=no-callees"). Mirror the same chain
  // the rest of this file uses so Twilio always gets a valid callee.
  const callCalleeId = useMemo(() => {
    const oc: any = hydratedConversation || {};
    return String(
      oc?.otherUser?._id ||
        oc?.otherUser?.userId ||
        oc?.otherUserId ||
        '',
    ).trim();
  }, [hydratedConversation]);

  // iter-198: keep the sender-side push context fresh (see sendMessage
  // wrapper above). Recipients = every other participant's Convex id.
  useEffect(() => {
    const meId = me?._id ? String(me._id) : null;
    const ids = new Set<string>();
    const addId = (value: any) => {
      const s = value == null ? '' : String(value).trim();
      if (s && s !== meId) ids.add(s);
    };
    const conv: any = hydratedConversation || {};
    addId(conv?.otherUser?._id);
    addId(conv?.otherUser?.userId);
    addId(conv?.otherUserId);
    [conv?.memberIds, conv?.participantIds, conv?.userIds].forEach((list: any) => {
      if (Array.isArray(list)) list.forEach(addId);
    });
    [conv?.participants, conv?.members].forEach((list: any) => {
      if (!Array.isArray(list)) return;
      list.forEach((p: any) => {
        if (p && typeof p === 'object') {
          addId(p.userId);
          addId(p._id);
        } else {
          addId(p);
        }
      });
    });
    const senderName = String(me?.name || me?.displayName || 'New message');
    pushNotifyCtxRef.current = { recipients: Array.from(ids).slice(0, 20), senderName };
    // iter-200: guarantee the backend learns my Convex id → enables
    // recipient matching for client-triggered pushes (see useEmergentPush).
    reportConvexUserIdForPush(meId);
  }, [hydratedConversation, me]);

  const mergedPresenceSource = useMemo(
    () => ({
      ...(hydratedConversation || {}),
      ...(savedContactRecord || {}),
      otherUser: {
        ...(hydratedConversation?.otherUser || {}),
        ...(savedContactRecord || {}),
      },
    }),
    [hydratedConversation, savedContactRecord],
  );
  // iter-111: isDiary detection REMOVED. Diary is now a fully separate
  // local-only screen (/app/diary.tsx) — the chat screen no longer has
  // any awareness of Diary mode. This eliminates the iter-109 leak
  // where a heuristic ("any conversation whose otherUserId equals me")
  // could falsely tag a regular chat as Diary and apply diary chrome.

  // iter-176: device address book overrides Smilers display name for
  // 1:1 chats. Saved-contact-from-Smilers name is still checked first
  // (for users without phone numbers / when device permission denied).
  const deviceTitle = getResolvedConversationDisplayName(
    hydratedConversation,
    me?._id ? String(me._id) : null,
    deviceContactIndex,
    lookupDeviceContactName,
    '',
  );
  // Broadcast conversations (sent from the shared "Smilers" system account
  // via the admin broadcast contract) are READ-ONLY on the recipient side:
  // no composer/reply, no reactions, no calling, and the sender identity is
  // ALWAYS shown as "Smilers" (the admin who sent it is never revealed).
  const isBroadcastReadOnly = (hydratedConversation as any)?.isBroadcast === true;
  const title = isBroadcastReadOnly
    ? 'Smilers'
    : deviceTitle ||
      savedContactTitle ||
      (conversationLoading && !hydratedConversation
        ? 'Loading…'
        : getConversationDisplayName(hydratedConversation, me?._id ? String(me._id) : undefined, 'Chat'));
  const isMineSelected = selectedMsg && me && selectedMsg.senderId === me._id;
  const typingLabel = useMemo(() => {
    const list = Array.isArray(typingUsersRaw) ? typingUsersRaw : [];
    const others = list.filter((u: any) => {
      const uid = u?.userId || u?._id || u?.id;
      return !uid || !me?._id || String(uid) !== String(me._id);
    });
    if (others.length === 0) return null;
    const names = others.map(
      (u: any) => u?.name || u?.userName || u?.displayName || 'Someone',
    );
    return names.length === 1
      ? `${names[0]} is typing\u2026`
      : `${names.join(', ')} are typing\u2026`;
  }, [typingUsersRaw, me?._id]);

  const subtitle = isBroadcastReadOnly
    ? 'Announcement · read-only'
    : (typingLabel || formatPresenceSubtitle(mergedPresenceSource));
  const avatarInitial = getDisplayInitials(title);
  // DM-only online state for the header avatar dot (mirrors web). Online if the
  // peer flag is set or they were seen within 2 min; never on groups/broadcast.
  const headerOnline = (() => {
    if (isBroadcastReadOnly) return false;
    const src: any = mergedPresenceSource;
    if (!src || src?.type === 'group') return false;
    const peer = src?.otherUser || src;
    if (peer?.isOnline === true || peer?.online === true || src?.isOnline === true) return true;
    const ls = peer?.lastSeen ?? src?.lastSeen;
    const t = typeof ls === 'number' ? ls : typeof ls === 'string' ? new Date(ls).getTime() : NaN;
    return Number.isFinite(t) && Date.now() - t < 120000;
  })();

  // Slice B of Groups spec — when the current user is suspended in this
  // group, switch into spectator mode (composer hidden, reactions disabled).
  const viewerSuspension = useViewerSuspension(hydratedConversation, me?._id ? String(me._id) : null);

  const handleMenuAction = useCallback(
    (key: string) => {
      switch (key) {
        case 'export':
          Alert.alert('Export chat', 'A copy of this chat will be prepared. This feature is rolling out — try again shortly.');
          break;
        case 'media':
          // Reuse the attachment sheet to surface media & files quickly
          setShowAttachSheet(true);
          break;
        case 'scheduled':
          router.push('/scheduled' as any);
          break;
        case 'mute':
          setMuted((m) => {
            const next = !m;
            Alert.alert(next ? 'Notifications muted' : 'Notifications unmuted', next ? 'You won\'t receive sounds or banners for this chat.' : 'You\'ll receive notifications again.');
            return next;
          });
          break;
        case 'location':
          // iter-141: bug fix — previously referenced an undefined `cid`
          // variable and used the wrong message shape (`kind`/`body`).
          // Now uses the correct `conversationId` in scope and the
          // canonical message shape (`type`/`text`) that the rest of
          // this file uses for `sendMessage`.
          (async () => {
            try {
              await sendMessage({
                conversationId,
                type: 'text',
                text:
                  '📍 I\'ve requested your live location. ' +
                  'Tap the 📎 attach button → Location to share with me.',
              });
            } catch (err: any) {
              Alert.alert(
                'Could not send live-location request',
                String(err?.message || err || 'Unknown error'),
              );
            }
          })();
          break;
        case 'sendMoney':
          router.push('/send-money' as any);
          break;
        case 'shareScreen': {
          // Route into the standalone screen-share request flow (the user
          // explicitly asked for this — sharing a screen should NOT start a
          // call; it sends a request that the recipient must accept). The
          // /screen-share entry pre-selects the contact via the recipient param.
          const otherUserId =
            (hydratedConversation?.otherUser as any)?._id ||
            (hydratedConversation?.otherUser as any)?.userId ||
            (hydratedConversation as any)?.otherUserId ||
            '';
          if (otherUserId) {
            router.push(
              `/screen-share?recipient=${encodeURIComponent(String(otherUserId))}&name=${encodeURIComponent(title)}` as any,
            );
          } else {
            // Fallback: open the picker without a preselected recipient.
            router.push('/screen-share' as any);
          }
          break;
        }
        case 'block':
          Alert.alert(
            `Block ${title}`,
            'They won\'t be able to send you messages or call you. You can unblock them at any time.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Block',
                style: 'destructive',
                onPress: () => Alert.alert('Blocked', `${title} has been blocked.`),
              },
            ]
          );
          break;
        case 'report':
          Alert.alert(
            `Report ${title}`,
            'Report this contact to Smilers? Recent messages will be shared with our safety team.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Report',
                style: 'destructive',
                onPress: () => Alert.alert('Reported', 'Thanks — our team will review this report.'),
              },
            ]
          );
          break;
      }
    },
    [conversationId, router, title]
  );

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: getWallpaperColor(chatAppearance.wallpaper) }]}
      edges={['top']}
      testID="chat-screen"
    >
      <View style={styles.chatHeader} testID="chat-header">
        {/* iter-174: chat header restructured into TWO ROWS for legibility.
            Row 1 = back arrow + avatar + name + presence subtitle (each get
            generous horizontal space so the contact's name reads clearly
            instead of getting truncated to "...").
            Row 2 = the 7 utility action buttons (search, call, video, time,
            shield, more).
            The user explicitly OK'd this layout in iter-174 feedback:
              "If you should shift that up on top of the call buttons, it
               should be fine. Just make them clearly readable." */}
        <View style={styles.chatHeaderTopRow}>
          <TouchableOpacity testID="chat-back-btn" onPress={() => router.back()} style={styles.headerIconButton}>
            <Ionicons name="arrow-back" size={24} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.chatHeaderIdentity}
            activeOpacity={0.7}
            onPress={() => {
              if (hydratedConversation?.type === 'group') {
                router.push(`/group/${conversationId}` as any);
                return;
              }
              // Direct chat — open the contact info page (mirrors web).
              const otherUserId =
                (hydratedConversation?.otherUser as any)?._id ||
                (hydratedConversation?.otherUser as any)?.userId ||
                (hydratedConversation as any)?.otherUserId ||
                '';
              if (otherUserId) {
                router.push(
                  `/user/${otherUserId}?conversationId=${conversationId}` as any,
                );
              }
            }}
            testID="chat-header-identity"
          >
            <View style={styles.headerAvatarWrap}>
              <View style={styles.headerAvatar} testID="chat-header-avatar">
                {(() => {
                  const headerAvatarUri =
                    (hydratedConversation?.otherUser as any)?.avatar ||
                    (hydratedConversation?.otherUser as any)?.avatarUrl ||
                    (hydratedConversation as any)?.avatar ||
                    null;
                  if (headerAvatarUri && /^https?:/i.test(headerAvatarUri)) {
                    return (
                      <Image
                        source={{ uri: headerAvatarUri }}
                        style={styles.headerAvatarImage}
                        resizeMode="cover"
                      />
                    );
                  }
                  return <Text style={styles.headerAvatarText}>{avatarInitial}</Text>;
                })()}
              </View>
              {headerOnline ? <View style={styles.headerOnlineDot} testID="chat-header-online" /> : null}
            </View>
            <View style={styles.headerTextWrap}>
              <Text style={styles.chatHeaderTitle} numberOfLines={1} testID="chat-header-title">{title}</Text>
              <Text style={styles.chatHeaderSubtitle} numberOfLines={1} testID="chat-header-subtitle">{subtitle}</Text>
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.chatHeaderActions}>
          {/* Search toggle — kept from iter-109 (originally introduced for Diary
              but useful for every chat). Tapping toggles the search input bar
              below the header. */}
          <TouchableOpacity
            testID="chat-search-toggle-btn"
            onPress={() =>
              setChatSearchQuery((q) => (q === null ? '' : null))
            }
            style={styles.headerIconButton}
          >
            <Feather
              name={chatSearchQuery === null ? 'search' : 'x'}
              size={20}
              color={Colors.white}
            />
          </TouchableOpacity>
          {isBroadcastReadOnly ? null : (
            <>
          <TouchableOpacity
            testID="call-btn"
            onPress={() => {
              startCall({
                router,
                callerIdentity: String(me?._id || ''),
                callerDisplayName: String((me as any)?.name || (me as any)?.displayName || ''),
                calleeIdentities: callCalleeId ? [callCalleeId] : [],
                conversationId: String(conversationId || ''),
                isVideo: false,
                displayName: title,
              });
            }}
            style={styles.headerIconButton}
          >
            <Ionicons name="call-outline" size={20} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="video-btn"
            onPress={() => {
              startCall({
                router,
                callerIdentity: String(me?._id || ''),
                callerDisplayName: String((me as any)?.name || (me as any)?.displayName || ''),
                calleeIdentities: callCalleeId ? [callCalleeId] : [],
                conversationId: String(conversationId || ''),
                isVideo: true,
                displayName: title,
              });
            }}
            style={styles.headerIconButton}
          >
            <Ionicons name="videocam-outline" size={21} color={Colors.white} />
          </TouchableOpacity>
            </>
          )}
          <TouchableOpacity testID="chat-disappearing-btn" onPress={() => setShowDisappearingSheet(true)} style={styles.headerIconButton}>
            <Ionicons name="time-outline" size={20} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="chat-encryption-btn" onPress={() => router.push('/encryption' as any)} style={styles.headerIconButton}>
            <Ionicons name="shield-checkmark-outline" size={20} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="chat-menu-btn" onPress={() => setShowOptionsMenu(true)} style={styles.headerIconButton}>
            <Feather name="more-vertical" size={20} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </View>

      {/* iter-147: Chat Once countdown banner — locked to the
          canonical field `chatOnceExpiresAt` (ISO 8601 string) from the
          conversation record. */}
      {(() => {
        const expiryRaw = (hydratedConversation as any)?.chatOnceExpiresAt;
        const expiresAt =
          typeof expiryRaw === 'string'
            ? new Date(expiryRaw).getTime()
            : typeof expiryRaw === 'number'
              ? expiryRaw
              : 0;
        if (
          expiresAt &&
          Number.isFinite(expiresAt) &&
          expiresAt > Date.now()
        ) {
          const msLeft = expiresAt - Date.now();
          const h = Math.floor(msLeft / 3_600_000);
          const m = Math.floor((msLeft % 3_600_000) / 60_000);
          const label =
            h > 0
              ? `${h}h ${m}m`
              : m > 0
                ? `${m}m`
                : 'less than a minute';
          return (
            <View
              style={[
                styles.encryptionBanner,
                { backgroundColor: '#FFF7E6' },
              ]}
              testID="chat-once-banner"
            >
              <Feather name="globe" size={16} color="#E97A00" />
              <Text style={[styles.encryptionBannerText, { color: '#A35200' }]}>
                Chat Once — this chat will auto-delete in {label}
              </Text>
            </View>
          );
        }
        return (
          <View style={styles.encryptionBanner} testID="chat-encryption-banner">
            <Ionicons name="shield-checkmark-outline" size={16} color="#2A7C48" />
            <Text style={styles.encryptionBannerText}>End-to-end encrypted</Text>
          </View>
        );
      })()}

      {/* iter-109 → iter-111: in-chat search bar — slides in below the
          header when the search button is tapped. Live-filters the
          message list by case-insensitive substring match. Kept as a
          general-purpose feature even after Diary was decoupled. */}
      {chatSearchQuery !== null ? (
        <View style={styles.searchNavBar} testID="chat-search-bar">
          <Feather name="search" size={18} color={Colors.primary} />
          <View style={styles.searchNavTextWrap}>
            <TextInput
              style={styles.searchNavInput}
              value={chatSearchQuery}
              onChangeText={setChatSearchQuery}
              placeholder="Search in conversation…"
              placeholderTextColor={Colors.textMuted}
              autoFocus={!initialSearchQ}
              returnKeyType="search"
              testID="chat-search-input"
            />
            {searchTermNorm.length > 0 ? (
              <Text style={styles.searchNavCount} testID="chat-search-count">
                {searchMatchPositions.length > 0
                  ? `${clampedActivePos + 1} of ${searchMatchPositions.length}`
                  : 'No results'}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            onPress={goPrevMatch}
            disabled={searchMatchPositions.length === 0}
            style={styles.searchNavBtn}
            hitSlop={6}
            testID="chat-search-prev"
          >
            <Feather
              name="chevron-up"
              size={22}
              color={searchMatchPositions.length === 0 ? Colors.textMuted : Colors.textPrimary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={goNextMatch}
            disabled={searchMatchPositions.length === 0}
            style={styles.searchNavBtn}
            hitSlop={6}
            testID="chat-search-next"
          >
            <Feather
              name="chevron-down"
              size={22}
              color={searchMatchPositions.length === 0 ? Colors.textMuted : Colors.textPrimary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setChatSearchQuery(null)}
            style={styles.searchNavBtn}
            hitSlop={6}
            testID="chat-search-close"
          >
            <Feather name="x" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>
      ) : null}

      {multiSelectIds && multiSelectIds.length >= 0 ? (
        <View style={styles.multiSelectBanner} testID="multi-select-banner">
          <TouchableOpacity onPress={cancelMultiSelect} hitSlop={10} testID="multi-select-cancel">
            <Feather name="x" size={20} color={Colors.white} />
          </TouchableOpacity>
          <Text style={styles.multiSelectCountText}>
            {multiSelectIds.length === 0
              ? 'Tap messages to select'
              : `${multiSelectIds.length} selected`}
          </Text>
          <TouchableOpacity
            onPress={onForwardMulti}
            style={styles.multiSelectForwardBtn}
            disabled={multiSelectIds.length === 0}
            testID="multi-select-forward"
          >
            <Feather
              name="send"
              size={16}
              color={multiSelectIds.length === 0 ? 'rgba(255,255,255,0.5)' : Colors.white}
              style={styles.multiSelectForwardIcon}
            />
            <Text
              style={[
                styles.multiSelectForwardLabel,
                multiSelectIds.length === 0 ? styles.multiSelectForwardLabelDim : null,
              ]}
            >
              Forward
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {/* Incoming live-location request for this chat — tap to confirm. */}
        {isConversationAvailable ? (
          <View style={styles.locationRequestBannerWrap}>
            <LiveLocationRequestBanner conversationId={String(conversationId || '')} />
            <LiveLocationSharingPill conversationId={String(conversationId || '')} />
          </View>
        ) : null}
        {(conversationLoading || messagesLoading) && !hasCachedTimeline ? (
          fallbackReady && conversation === undefined ? (
            // Pending past the threshold — surface an actionable
            // "transient unavailable" screen instead of an endless spinner.
            <View style={styles.unavailableWrap} testID="chat-unavailable-state">
              <MaterialCommunityIcons name="message-alert-outline" size={52} color={Colors.primary} />
              <Text style={styles.unavailableTitle}>Taking longer than usual</Text>
              <Text style={styles.unavailableText}>
                We couldn&apos;t load this chat just yet. Check your connection and try again.
              </Text>
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 18 }}>
                <TouchableOpacity
                  onPress={() => router.back()}
                  style={{ paddingVertical: 10, paddingHorizontal: 18, borderRadius: 24, borderWidth: 1, borderColor: Colors.border }}
                  testID="chat-loading-back"
                >
                  <Text style={{ color: Colors.textPrimary, fontWeight: '600' }}>Back to chats</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    // iter-213: also force a Convex socket reconnect. The
                    // previous router.replace re-issued the React subscription
                    // but if the underlying websocket was the actual problem
                    // (ghost-connected state), no new subscription would
                    // resolve either. forceConvexReconnect runs soft+hard
                    // reconnect via the WebSocketManager so the socket is
                    // guaranteed to be fresh by the time the re-mounted
                    // component re-subscribes.
                    void forceConvexReconnect('chat-retry-button');
                    setRetryNonce((n) => n + 1);
                    try {
                      const path = `/chat/${encodeURIComponent(String(conversationId || ''))}` as any;
                      router.replace(path);
                    } catch {}
                  }}
                  style={{ paddingVertical: 10, paddingHorizontal: 18, borderRadius: 24, backgroundColor: Colors.primary }}
                  testID="chat-loading-retry"
                >
                  <Text style={{ color: Colors.headerBg, fontWeight: '700' }}>Retry</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color={Colors.primary} />
            </View>
          )
        ) : isConversationDefinitelyMissing ? (
          <View style={styles.unavailableWrap} testID="chat-unavailable-state">
            <MaterialCommunityIcons name="message-alert-outline" size={52} color={Colors.primary} />
            <Text style={styles.unavailableTitle}>Conversation unavailable</Text>
            <Text style={styles.unavailableText}>
              This chat couldn’t be opened right now. Please return to your chat list and try again.
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={timeline}
            keyExtractor={(item: any) => item._id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item, index }) => {
              const previous = index > 0 ? timeline[index - 1] : null;
              const showDayChip = !previous || !isSameCalendarDay(item?._creationTime, previous?._creationTime);
              // Call-log pill branch (iter 156, web parity).
              if (item?.__kind === 'call') {
                return (
                  <>
                    {showDayChip ? (
                      <View style={styles.dayChipWrap} testID={`chat-day-chip-${item._id}`}>
                        <Text style={styles.dayChipText}>{formatChatDayChip(item?._creationTime)}</Text>
                      </View>
                    ) : null}
                    <CallPill
                      item={item}
                      hasRecording={item.wasRecorded && recordingByCallId.has(item._callId)}
                      onPress={() => {
                        const rec = recordingByCallId.get(item._callId);
                        if (rec && rec.url) {
                          setActiveRecording({
                            url: String(rec.url),
                            durationSeconds: Number(rec.durationSeconds || item.durationSeconds || 0),
                            callType: item.callType,
                            outcome: item.outcome,
                          });
                        }
                      }}
                      onCallBack={(callType) => {
                        // iter-231/232: route call-backs through the same
                        // Twilio path as the header call buttons, using the
                        // canonical callee resolver (was reading only
                        // otherUser.userId → empty → legacy WebRTC fallback).
                        startCall({
                          router,
                          callerIdentity: String(me?._id || ''),
                          callerDisplayName: String((me as any)?.name || (me as any)?.displayName || ''),
                          calleeIdentities: callCalleeId ? [callCalleeId] : [],
                          conversationId: String(conversationId || ''),
                          isVideo: callType === 'video',
                          displayName: title,
                        });
                      }}
                      testID={`chat-call-pill-${item._id}`}
                    />
                  </>
                );
              }
              return (
                <>
                  {showDayChip ? (
                    <View style={styles.dayChipWrap} testID={`chat-day-chip-${item._id}`}>
                      <Text style={styles.dayChipText}>{formatChatDayChip(item?._creationTime)}</Text>
                    </View>
                  ) : null}
                  <SwipeToReply
                    // iter-185 WhatsApp-style swipe-to-reply. Disabled in
                    // multi-select mode (pan conflicts with tap-to-toggle),
                    // for suspended viewers, and on deleted messages.
                    enabled={!viewerSuspension && !isBroadcastReadOnly && !multiSelectIds && !item.deletedAt && !item.__outbox && isConversationAvailable}
                    onReply={() => {
                      setReplyTo(item);
                      messageInputRef.current?.focus();
                    }}
                  >
                    <MediaBubble
                      msg={item}
                      isMine={item.senderId === effectiveMe?._id}
                      myUserId={effectiveMe?._id}
                      parentMsg={(() => {
                        // Backend field name normalisation (iter-101):
                        // Smilers Convex stores the parent reference under
                        // `replyToId` per the public spec, but the mobile
                        // client historically wrote `replyToMessageId`.
                        // Look up by either to be robust against both
                        // historical AND fresh messages.
                        const parentId = item.replyToId || item.replyToMessageId;
                        return parentId ? msgById.get(parentId) : undefined;
                      })()}
                      appearance={chatAppearance}
                      e2eeStatus={e2eeStatus}
                      onLongPress={viewerSuspension || isBroadcastReadOnly ? () => {} : () => {
                        // While in multi-select mode, long-press is reserved
                        // for toggling selection (matching the easier muscle
                        // memory of "tap to toggle, long-press to enter").
                        if (multiSelectIds) {
                          onToggleMultiSelect(String(item._id));
                          return;
                        }
                        // Local outbox (RED) messages aren't on the server yet —
                        // the action sheet's server ops don't apply. Long-press
                        // retries the send instead.
                        if (item.__outbox) {
                          void flushOutbox();
                          return;
                        }
                        onLongPressMessage(item);
                      }}
                      onPress={
                        item.__outbox
                          ? () => { void flushOutbox(); }
                          : multiSelectIds
                            ? () => onToggleMultiSelect(String(item._id))
                            : undefined
                      }
                      multiSelected={multiSelectIds ? multiSelectIds.includes(String(item._id)) : undefined}
                      searchTerm={searchTermNorm || null}
                      isActiveSearchMatch={activeMatchTimelineIdx >= 0 && index === activeMatchTimelineIdx}
                      onToggleReaction={
                        viewerSuspension || isBroadcastReadOnly || multiSelectIds
                          ? () => {}
                          : (emoji) => onToggleMyReaction(item._id, emoji)
                      }
                    />
                  </SwipeToReply>
                </>
              );
            }}
            onScroll={(e) => {
              // iter-231: remember if the user is near the bottom. Used to
              // decide whether content-size changes should snap to the latest
              // message — so scrolling up to read history is never interrupted.
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              const distanceFromBottom =
                contentSize.height - (contentOffset.y + layoutMeasurement.height);
              isNearBottomRef.current = distanceFromBottom < 120;
            }}
            scrollEventThrottle={16}
            onScrollBeginDrag={() => {
              isUserScrollingRef.current = true;
            }}
            onScrollEndDrag={() => {
              isUserScrollingRef.current = false;
            }}
            onMomentumScrollBegin={() => {
              isUserScrollingRef.current = true;
            }}
            onMomentumScrollEnd={() => {
              isUserScrollingRef.current = false;
            }}
            onContentSizeChange={() => {
              // iter-274: only snap to the bottom when the user is NEAR the
              // bottom AND is NOT actively scrolling. Virtualization + media
              // loading fire onContentSizeChange on nearly every frame while
              // the list scrolls; snapping to end each time yanked the view
              // back and produced the rapid up/down jitter the user reported.
              // Search owns scrolling when active, so skip then.
              if (
                chatSearchQuery === null &&
                isNearBottomRef.current &&
                !isUserScrollingRef.current
              ) {
                listRef.current?.scrollToEnd({ animated: false });
              }
            }}
            onScrollToIndexFailed={(info) => {
              // No getItemLayout → far-off indices can fail. Approximate by
              // offset, then retry centering the match shortly after.
              try {
                listRef.current?.scrollToOffset({
                  offset: (info.averageItemLength || 80) * info.index,
                  animated: false,
                });
              } catch {}
              setTimeout(() => {
                try {
                  listRef.current?.scrollToIndex({
                    index: info.index,
                    animated: true,
                    viewPosition: 0.5,
                  });
                } catch {}
              }, 220);
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>Say hello with a smile 😊</Text>
              </View>
            }
          />
        )}

        <View
          style={[
            styles.composerDock,
            { paddingBottom: isKeyboardVisible ? 0 : Math.max(insets.bottom, Platform.OS === 'ios' ? 8 : 6) },
          ]}
          testID="composer-dock"
        >
          {viewerSuspension ? (
            <View style={styles.suspensionBanner} testID="suspension-banner">
              <Feather name="alert-octagon" size={18} color="#7f1d1d" />
              <Text style={styles.suspensionBannerText} testID="suspension-banner-text">
                {viewerSuspension.label}
              </Text>
            </View>
          ) : isBroadcastReadOnly ? (
            <View style={styles.suspensionBanner} testID="broadcast-readonly-banner">
              <Feather name="radio" size={18} color="#7f1d1d" />
              <Text style={styles.suspensionBannerText} testID="broadcast-readonly-text">
                This is an announcement from Smilers. You can&apos;t reply.
              </Text>
            </View>
          ) : (
            <>
          {replyTo && isConversationAvailable ? (
            <View style={styles.replyPill} testID="reply-preview-pill">
              <View style={styles.replyAccent} />
              <View style={styles.flexOne}>
                <Text style={styles.replyLabel}>Replying to {replyTo.senderName || 'message'}</Text>
                <Text style={styles.replyText} numberOfLines={1} testID="reply-preview-text">
                  {stripRichTextTags(replyTo.text) || `[${replyTo.type}]`}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={10} testID="reply-preview-close">
                <Feather name="x" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Editing indicator — visible whenever the user tapped "Edit"
              on a message. Mirrors the reply-preview pill UI so the
              affordance is familiar. Tapping the X cancels the edit
              and clears the composer; tapping Send (handleSend) routes
              to the edit-mutation flow instead of a brand-new send. */}
          {editingMessageId && isConversationAvailable ? (
            <View style={styles.replyPill} testID="edit-preview-pill">
              <View style={[styles.replyAccent, styles.editAccent]} />
              <View style={styles.flexOne}>
                <Text style={styles.replyLabel}>Editing message</Text>
                <Text style={styles.replyText} numberOfLines={1} testID="edit-preview-text">
                  Tap send to save changes
                </Text>
              </View>
              <TouchableOpacity onPress={cancelEdit} hitSlop={10} testID="edit-preview-close">
                <Feather name="x" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : null}

          {uploading ? (
            <View style={styles.uploadBar} testID="uploading-bar">
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.uploadText}>Uploading…</Text>
            </View>
          ) : null}

          {pendingImages.length > 0 && !uploading ? (
            <View style={styles.pendingImagesBar} testID="pending-image-preview">
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pendingImagesStrip}
                keyboardShouldPersistTaps="handled"
              >
                {pendingImages.map((im, index) => (
                  <TouchableOpacity
                    key={`${im.uri}-${index}`}
                    activeOpacity={0.8}
                    onPress={() => setActiveImageIndex(index)}
                    style={[styles.pendingThumbWrap, index === activeImageIndex ? styles.pendingThumbActive : null]}
                    testID={`pending-image-${index}`}
                  >
                    <Image source={{ uri: im.uri }} style={styles.pendingImageThumb} />
                    {im.caption?.trim() ? <View style={styles.pendingThumbCaptionDot} /> : null}
                    <TouchableOpacity
                      onPress={() => removePendingImage(index)}
                      hitSlop={8}
                      style={styles.pendingThumbRemove}
                      testID={`pending-image-remove-${index}`}
                    >
                      <Feather name="x" size={12} color={Colors.white} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <Text style={styles.pendingImageHint} numberOfLines={1}>
                {pendingImages.length === 1
                  ? 'Add a caption (optional), then tap send'
                  : `${pendingImages.length} photos · tap a photo to caption it, then send`}
              </Text>
            </View>
          ) : null}

          {showComposerFormatting ? (
            <View style={styles.composerToolsWrap} testID="composer-tools-wrap">
              {showColorPicker ? (
                <View style={styles.colorPickerWrap} testID="composer-color-picker">
                  {DRAFT_TEXT_COLORS.map((option) => {
                    const selected = draftColor === option.key;
                    const isBlack = option.key === 'black';
                    return (
                      <TouchableOpacity
                        key={option.key}
                        style={[styles.colorChip, selected ? styles.colorChipSelected : null]}
                        onPress={() => setDraftColor(option.key)}
                        testID={`composer-color-${option.key}`}
                      >
                        <View
                          style={[
                            styles.colorChipInner,
                            isBlack ? styles.colorChipInnerLight : { backgroundColor: option.hex },
                            selected ? styles.colorChipInnerSelected : null,
                          ]}
                        >
                          <Text style={[styles.colorChipLabel, isBlack ? styles.colorChipLabelDark : null]}>{option.label}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : null}

              <View style={styles.composerToolbarRow}>
                <TouchableOpacity
                  style={[styles.composerToolBtn, draftBold ? styles.composerToolBtnActive : null]}
                  onPress={() => setDraftBold((current) => !current)}
                  testID="composer-bold-toggle"
                >
                  <Text style={[styles.composerToolText, draftBold ? styles.composerToolTextActive : null]}>B</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.composerToolBtn, showColorPicker ? styles.composerToolBtnActive : null]}
                  onPress={() => setShowColorPicker((current) => !current)}
                  testID="composer-palette-toggle"
                >
                  <Ionicons name="color-palette-outline" size={20} color={showColorPicker ? Colors.primary : Colors.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          <View style={styles.inputBar}>
          {isRecording ? (
            <View style={styles.recordingRow}>
              <TouchableOpacity style={styles.recCancelBtn} onPress={cancelRecording} testID="rec-cancel">
                <Feather name="x" size={22} color={Colors.danger} />
              </TouchableOpacity>
              <View style={styles.recIndicator}>
                <View style={styles.recWaveWrap}>
                  {[10, 16, 22, 14, 20, 26, 18, 12, 24, 15, 21, 13].map((height, index) => (
                    <View
                      key={`wave-${index}`}
                      style={[
                        styles.recWaveBar,
                        { height: height + ((recDuration + index) % 3) * 3 },
                        isRecordingPaused ? styles.recWaveBarPaused : null,
                      ]}
                    />
                  ))}
                </View>
                <Text style={styles.recTimer}>
                  {`${Math.floor(recDuration / 60)}:${(recDuration % 60).toString().padStart(2, '0')}`}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.recPauseBtn}
                onPress={isRecordingPaused ? resumeRecording : pauseRecording}
                testID="rec-pause-toggle"
              >
                <Feather name={isRecordingPaused ? 'play' : 'pause'} size={20} color={Colors.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.recSendBtn} onPress={() => finishRecording('send')} testID="rec-send">
                <Feather name="send" size={20} color={Colors.white} />
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TextInput
                ref={messageInputRef}
                value={pendingImages.length > 0 ? (pendingImages[activeImageIndex]?.caption ?? '') : text}
                onChangeText={pendingImages.length > 0 ? setActiveCaption : handleTyping}
                placeholder={pendingImages.length > 0 ? 'Add a caption…' : 'Type your message…'}
                placeholderTextColor={Colors.textMuted}
                style={[
                  styles.input,
                  { color: composerTextColor },
                  draftBold ? styles.inputBold : null,
                ]}
                multiline
                editable={isConversationAvailable && !sending && !uploading}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                testID="message-input"
              />
              {text.trim().length > 0 || pendingImages.length > 0 ? (
                <>
                  {text.trim().length > 0 && pendingImages.length === 0 ? (
                    <TouchableOpacity
                      style={styles.scheduleBtn}
                      onPress={() => setShowScheduleSheet(true)}
                      disabled={!isConversationAvailable || uploading || sending}
                      testID="schedule-message-btn"
                      accessibilityLabel="Schedule message"
                    >
                      <Feather name="clock" size={18} color={Colors.textSecondary} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity style={styles.sendBtn} onPress={handleSend} disabled={!isConversationAvailable || uploading} testID="send-btn">
                    <Feather name="send" size={20} color={Colors.white} />
                  </TouchableOpacity>
                </>
              ) : <View style={styles.sendBtnSpacer} testID="send-btn-spacer" />}
            </>
          )}
          </View>

          {!isRecording ? (
            <View style={styles.webToolbarRow} testID="composer-web-toolbar-row">
              <TouchableOpacity
                style={styles.webToolBtn}
                onPress={() => setShowAttachSheet(true)}
                disabled={!isConversationAvailable || uploading}
                testID="composer-toolbar-apps"
              >
                <Ionicons name="apps-outline" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.webToolBtn}
                onPress={onPickGif}
                disabled={!isConversationAvailable || uploading}
                testID="composer-toolbar-gif"
              >
                <Text style={styles.webToolGifLabel}>GIF</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.webToolBtn}
                onPress={() => setShowTemplatePicker(true)}
                disabled={!isConversationAvailable || uploading}
                testID="composer-toolbar-templates"
              >
                <Ionicons name="clipboard-outline" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.webToolBtn}
                onPress={() => {
                  setShowComposerFormattingPinned((current) => {
                    const nextValue = !current;
                    if (nextValue) {
                      InteractionManager.runAfterInteractions(() => {
                        setTimeout(() => messageInputRef.current?.focus(), 80);
                      });
                    } else {
                      setShowColorPicker(false);
                      messageInputRef.current?.blur();
                      Keyboard.dismiss();
                    }
                    return nextValue;
                  });
                }}
                disabled={!isConversationAvailable || uploading}
                testID="composer-toolbar-tools"
              >
                <Feather name="sliders" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.webToolBtn, text.trim().length > 0 ? styles.webToolBtnDisabled : null]}
                onPress={startRecording}
                disabled={!isConversationAvailable || uploading || text.trim().length > 0}
                testID="composer-toolbar-mic"
              >
                <Feather name="mic" size={18} color={text.trim().length > 0 ? Colors.textMuted : Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.webToolBtn}
                onPress={() => setShowEmojiPicker(true)}
                disabled={!isConversationAvailable || uploading}
                testID="composer-toolbar-palette"
              >
                <Ionicons name="color-palette-outline" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : null}
            </>
          )}
        </View>
      </KeyboardAvoidingView>

      <AttachmentSheet
        visible={showAttachSheet}
        onClose={() => setShowAttachSheet(false)}
        onPickPhoto={pickPhoto}
        onTakePhoto={takePhoto}
        onPickVideo={pickVideo}
        onRecordVideo={recordVideo}
        onPickDocument={onPickDocument}
        onShareLocation={shareLocation}
        onShareContact={() => setShowShareContacts(true)}
      />

      <ShareContactsDialog
        visible={showShareContacts}
        onClose={() => setShowShareContacts(false)}
        presetRecipientId={
          // Resolve the other-user id of the open direct chat so the
          // dialog can pre-select it as the default recipient. For
          // group conversations or unhydrated state we just leave it
          // null and let the user pick recipients manually.
          (() => {
            const other =
              (hydratedConversation?.otherUser as any)?._id ||
              (hydratedConversation?.otherUser as any)?.userId ||
              (hydratedConversation as any)?.otherUserId ||
              null;
            return other ? String(other) : null;
          })()
        }
      />

      <CameraCapture
        visible={showCameraModal}
        onCapture={handleCameraCapture}
        onClose={() => setShowCameraModal(false)}
      />

      <PollComposer
        visible={showPollComposer}
        onClose={() => setShowPollComposer(false)}
        onSubmit={onSubmitPoll}
      />

      <GiphyPicker
        visible={showGiphyPicker}
        onClose={() => setShowGiphyPicker(false)}
        onSelect={sendGiphyAsset}
      />

      <ScheduleMessageSheet
        visible={showScheduleSheet}
        onCancel={() => setShowScheduleSheet(false)}
        onConfirm={handleScheduleConfirm}
      />

      <EmojiPickerSheet
        visible={showEmojiPicker}
        onClose={() => {
          setShowEmojiPicker(false);
          // Reset the mode so subsequent opens default back to compose-insert.
          setEmojiPickerMode('compose');
          setReactionTargetMsg(null);
        }}
        recentEmojis={recentEmojis}
        onSelectEmoji={async (emoji) => {
          if (emojiPickerMode === 'react' && reactionTargetMsg) {
            // Apply as a reaction to the previously long-pressed message.
            try {
              await toggleReaction({ messageId: reactionTargetMsg._id, emoji });
              await refetchMessages();
            } catch (errorValue: any) {
              console.warn('react failed:', errorValue?.message);
            }
            setShowEmojiPicker(false);
            setEmojiPickerMode('compose');
            setReactionTargetMsg(null);
            return;
          }
          setText((current) => `${current}${current ? ' ' : ''}${emoji}`);
          setComposerFocused(true);
          setRecentEmojis((current) => [emoji, ...current.filter((item) => item !== emoji)].slice(0, 12));
        }}
      />

      <MessageActionSheet
        message={selectedMsg}
        canEdit={!!(isMineSelected && (selectedMsg?.type === 'text' || !selectedMsg?.type))}
        onClose={closeActionSheet}
        onPickReaction={onPickReaction}
        onReply={onReply}
        onCopy={onCopy}
        onEdit={onEdit}
        onForward={onForward}
        onShare={onShare}
        onSelectMultiple={onSelectMultiple}
        onStar={onStar}
        onPin={onPin}
        onMoreReactions={onMoreReactions}
        onMessageInfo={onMessageInfo}
        onDelete={onDelete}
      />

      {/* Tri-state delete-mode sheet (WhatsApp-style). For sent messages we
          expose Delete for me / receiver / everyone; for received messages
          we expose Delete for me / Ask sender to delete for everyone. */}
      <DeleteMessageSheet
        target={deleteTarget}
        isMine={!!(deleteTarget && deleteTarget.senderId === me?._id)}
        onClose={() => setDeleteTarget(null)}
        onSelect={performDelete}
      />

      <DisappearingSheet
        visible={showDisappearingSheet}
        mode={disappearingMode}
        onClose={() => setShowDisappearingSheet(false)}
        onSelect={async (option) => {
          setDisappearingMode(option.key);
          if (conversationId) {
            await writeStoredJson(`disappearing_mode_${conversationId}`, option.key);
          }
          // iter-151: canonical contract = `setDisappearingMessages`
          // with `disappearAfter` in SECONDS. Our local option
          // `ms` is in milliseconds (or 0 for "off"), so convert.
          try {
            if (
              conversationId &&
              typeof setDisappearingMessagesM === 'function'
            ) {
              const seconds = option.key === 'off' ? 0 : Math.round(option.ms / 1000);
              await (setDisappearingMessagesM as any)({
                conversationId,
                disappearAfter: seconds,
              });
            }
          } catch (errorValue: any) {
            const message = String(errorValue?.message || '');
            if (
              !message.includes('CouldNotFindFunction') &&
              !message.includes('not found') &&
              !message.includes('ArgumentValidationError')
            ) {
              console.warn('[chat] disappearAfter save failed', message);
            }
          }
          setShowDisappearingSheet(false);
        }}
      />

      <ForwardPickerSheet
        visible={showForwardPicker}
        conversations={Array.isArray(conversationsForForward) ? conversationsForForward : []}
        currentConversationId={conversationId as string}
        contacts={contacts}
        myUserId={me?._id ? String(me._id) : undefined}
        onClose={() => setShowForwardPicker(false)}
        onForwardTo={doForwardTo}
        onSaveToDiary={async () => {
          try {
            // Determine which messages we're forwarding — mirror
            // the doForwardTo logic so multi-select also flows.
            let targets: any[] = [];
            if (multiSelectIds && multiSelectIds.length > 0) {
              targets = multiSelectIds
                .map((id) => msgById.get(id))
                .filter((m: any) => !!m);
            } else if (selectedMsg) {
              targets = [selectedMsg];
            }
            if (targets.length === 0) {
              setShowForwardPicker(false);
              return;
            }
            const sourceConversationName =
              savedContactTitle ||
              getConversationDisplayName(
                hydratedConversation,
                me?._id ? String(me._id) : undefined,
                'Chat',
              );
            for (const m of targets) {
              const senderName =
                m?.senderName ||
                m?.sender?.name ||
                (me?._id && m?.senderId === me._id ? 'You' : 'a contact');
              const entry = chatMessageToDiaryEntry(m, {
                conversationId: conversationId as string,
                conversationName: sourceConversationName,
                originalSenderName: senderName,
                originalMessageId: m?._id || null,
                originalCreationTime: m?._creationTime || null,
              });
              // eslint-disable-next-line no-await-in-loop
              await appendDiaryEntry(me?._id ? String(me._id) : null, entry);
            }
            setShowForwardPicker(false);
            setMultiSelectIds(null);
            closeActionSheet();
            Alert.alert(
              targets.length === 1 ? 'Saved to Diary' : `${targets.length} notes saved`,
              'Open Diary from the Chats tab to see your saved notes.',
            );
          } catch (errorValue: any) {
            Alert.alert(
              'Could not save to Diary',
              errorToMessage(errorValue) || 'Please try again.',
            );
          }
        }}
      />

      <TemplatePickerSheet
        visible={showTemplatePicker}
        templates={quickTemplates}
        onClose={() => setShowTemplatePicker(false)}
        onInsert={(message) => {
          setText((current) => (current.trim().length ? `${current}\n${message}` : message));
          setShowTemplatePicker(false);
        }}
        onManage={() => {
          setShowTemplatePicker(false);
          router.push('/templates' as any);
        }}
      />

      <ChatOptionsMenu
        visible={showOptionsMenu}
        title={title}
        muted={muted}
        onClose={() => setShowOptionsMenu(false)}
        onAction={(key) => {
          setShowOptionsMenu(false);
          handleMenuAction(key);
        }}
      />
      {/* iter 157: recording playback for "Recorded" call-log pills */}
      <RecordingPlaybackModal
        recording={activeRecording}
        onClose={() => setActiveRecording(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // iter-169 web parity: conversation message area uses the dedicated
  // `chatWallpaper` token (#F5F1E7) instead of the app body color.
  container: { flex: 1, backgroundColor: Colors.chatWallpaper },
  chatHeader: {
    // iter-174: two-row header layout for legibility (Row 1 = identity,
    // Row 2 = action buttons). Header is now a column.
    minHeight: 130,
    backgroundColor: Colors.headerBg,
    paddingHorizontal: 8,
    paddingTop: 14,
    paddingBottom: 8,
    flexDirection: 'column',
    gap: 6,
  },
  chatHeaderTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 0,
    minWidth: 0,
  },
  chatHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  chatHeaderIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  chatHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 4,
    flexShrink: 0,
  },
  headerIconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#E4B53B',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
    overflow: 'hidden',
  },
  headerAvatarWrap: {
    width: 42,
    height: 42,
    marginHorizontal: 8,
  },
  headerOnlineDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#22C55E',
    borderWidth: 2,
    borderColor: Colors.headerBg,
  },
  // iter-109 Diary mode — blue avatar circle housing the book icon.
  headerAvatarDiary: {
    backgroundColor: Colors.diary,
  },
  headerAvatarImage: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  headerAvatarText: {
    fontSize: 18,
    fontWeight: FontWeight.bold,
    color: '#3D2A00',
  },
  headerTextWrap: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
    paddingRight: 8,
  },
  chatHeaderTitle: {
    // iter-174: bigger, bolder, more legible. Title now has full row width.
    fontSize: 20,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
  chatHeaderSubtitle: {
    // iter-174: brighter presence subtitle. Was 0.78 alpha → tougher to
    // read on a brown background; bumped to 0.92 + slightly larger font.
    marginTop: 3,
    fontSize: 14,
    color: 'rgba(255,255,255,0.92)',
    fontWeight: FontWeight.medium,
  },
  encryptionBanner: {
    minHeight: 34,
    backgroundColor: '#DFF1DB',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  // iter-109 in-chat search bar — yellow-bordered input under the
  // header. Matches the web app's "Search diary messages…" look.
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  // iter-220 in-conversation search highlight + ▲/▼ navigation bar.
  searchNavBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  searchNavTextWrap: { flex: 1 },
  searchNavInput: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  searchNavCount: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  searchNavBtn: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: Colors.background,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#E4B53B',
    backgroundColor: '#FFFCF4',
  },
  encryptionBannerText: {
    fontSize: 12,
    color: '#2A7C48',
    fontWeight: FontWeight.medium,
  },
  // ─── Multi-select forwarding banner (iter-99) ───
  // Sits between the encryption banner and the messages list. Mirrors
  // WhatsApp-style action bar with cancel-on-left + Forward-on-right.
  multiSelectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.base,
    paddingVertical: 10,
    gap: 14,
  },
  multiSelectCountText: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    flex: 1,
  },
  multiSelectForwardBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  multiSelectForwardIcon: { marginRight: 6 },
  multiSelectForwardLabel: {
    color: Colors.white,
    fontWeight: FontWeight.semibold,
    fontSize: FontSize.sm,
  },
  multiSelectForwardLabelDim: { color: 'rgba(255,255,255,0.5)' },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 20,
  },
  locationRequestBannerWrap: {
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  dayChipWrap: {
    alignItems: 'center',
    marginVertical: 8,
  },
  dayChipText: {
    fontSize: 11,
    color: '#766C5E',
    backgroundColor: 'rgba(247, 241, 224, 0.95)',
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 14,
    overflow: 'hidden',
  },
  empty: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  unavailableWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.base,
  },
  unavailableTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  unavailableText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  replyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.base,
    paddingVertical: 10,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  replyAccent: { width: 3, height: 32, borderRadius: 2, backgroundColor: Colors.primary },
  // editAccent — orange/warning accent so the editing pill is visually
  // distinct from the green reply pill. Same dimensions/shape.
  editAccent: { backgroundColor: Colors.warning ?? '#F59E0B' },
  replyLabel: { fontSize: 11, fontWeight: FontWeight.bold, color: Colors.primary },
  replyText: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  uploadBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.base,
    paddingVertical: 10,
    backgroundColor: Colors.primaryLight,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  uploadText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  pendingImageBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginHorizontal: Spacing.sm,
    marginBottom: 6,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
  },
  pendingImageThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: Colors.border,
  },
  pendingImageHint: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  pendingImageRemove: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingImagesBar: {
    marginHorizontal: Spacing.sm,
    marginBottom: 6,
    paddingVertical: 8,
    paddingHorizontal: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
  },
  pendingImagesStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 4,
    paddingTop: 4,
  },
  pendingThumbWrap: {
    width: 48,
    height: 48,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  pendingThumbActive: {
    borderColor: Colors.primary,
  },
  pendingThumbRemove: {
    position: 'absolute',
    top: -7,
    right: -7,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingThumbCaptionDot: {
    position: 'absolute',
    bottom: 3,
    right: 3,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: Colors.primary,
    borderWidth: 1,
    borderColor: Colors.white,
  },
  composerToolsWrap: {
    backgroundColor: '#F1E7D6',
    borderTopWidth: 1,
    borderTopColor: '#D9C9AE',
  },
  composerDock: {
    backgroundColor: '#EFE3CF',
  },
  suspensionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: Spacing.base,
    backgroundColor: '#fee2e2',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#fca5a5',
  },
  suspensionBannerText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: '#7f1d1d',
    fontWeight: FontWeight.medium,
    lineHeight: 20,
  },
  composerToolbarRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 6,
  },
  composerToolBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerToolBtnActive: {
    backgroundColor: '#FFF7DE',
  },
  composerToolText: {
    fontSize: 22,
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
  },
  composerToolTextActive: {
    color: Colors.primary,
    fontWeight: FontWeight.bold,
  },
  colorPickerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 2,
  },
  colorChip: {
    marginRight: 8,
  },
  colorChipSelected: {
    transform: [{ scale: 1.02 }],
  },
  colorChipInner: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  colorChipInnerLight: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D4CCBC',
  },
  colorChipInnerSelected: {
    borderColor: '#E5D8C2',
  },
  colorChipLabel: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: FontWeight.bold,
  },
  colorChipLabelDark: {
    color: Colors.textSecondary,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 3,
    gap: 4,
    backgroundColor: '#EFE3CF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#D9C9AE',
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 120,
    backgroundColor: '#FBF7F0',
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 14,
    fontSize: 13,
    lineHeight: 17,
    color: Colors.textPrimary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D7C4A5',
  },
  inputBold: {
    fontWeight: FontWeight.bold,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  scheduleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#EFE7D6',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  sendBtnSpacer: {
    width: 36,
    height: 36,
  },
  webToolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 2,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(175, 145, 94, 0.28)',
    backgroundColor: '#EFE3CF',
  },
  webToolBtn: {
    width: 34,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.58)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(175, 145, 94, 0.22)',
  },
  webToolBtnDisabled: {
    opacity: 0.45,
  },
  webToolGifLabel: {
    fontSize: 11,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    letterSpacing: 0.2,
  },
  recordingRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  recCancelBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FDE2E2' },
  recIndicator: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#F8F2E7',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#E7DAC2',
  },
  recWaveWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 },
  recWaveBar: { width: 4, borderRadius: 3, backgroundColor: Colors.primary },
  recWaveBarPaused: { opacity: 0.35 },
  recTimer: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary, fontVariant: ['tabular-nums'] as any },
  recPauseBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEE4D1' },
  recSendBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary },
  flexOne: { flex: 1 },
});

