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
  Modal,
  Platform,
  Pressable,
  ScrollView,
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
import { recordingActivity } from '../../src/lib/recordingActivity';
import * as Clipboard from 'expo-clipboard';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { pickImageLibrary, pickCamera, pickDocument } from '../../src/lib/nativePickers';
import * as Location from 'expo-location';
import AttachmentSheet from '../../src/components/AttachmentSheet';
import ShareContactsDialog from '../../src/components/ShareContactsDialog';
import { SharedContactBubble } from '../../src/components/chat/SharedContactBubble';
import EmojiPickerSheet from '../../src/components/EmojiPickerSheet';
import GiphyPicker, { GiphyAsset } from '../../src/components/GiphyPicker';
import MediaBubble from '../../src/components/MediaBubble';
import { ChatMessageRow } from '../../src/components/chat/ChatMessageRow';
import MessageInfoSheet from '../../src/components/chat/MessageInfoSheet';
import { processComposerChange, toggleListFormat, currentLineListKind } from '../../src/lib/autoNumbering';
import { LiveLocationRequestBanner } from '../../src/components/LiveLocationRequestBanner';
import { LiveLocationSharingPill } from '../../src/components/LiveLocationSharingPill';
import PollComposer from '../../src/components/PollComposer';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery, useSafeConvexSubscription } from '../../src/hooks/useSafeConvexQuery';
import { useReactiveSafeConvexQuery } from '../../src/hooks/useReactiveSafeConvexQuery';
import FilterIndicator from '../../src/components/FilterIndicator';
import { useScreenCaptureProtection } from '../../src/hooks/useScreenCaptureProtection';
import { useEngagementTracker } from '../../src/hooks/useEngagementTracker';
import { recordDiagnostic } from '../../src/lib/diagnostics';
import { callDebug } from '../../src/lib/callDebugLog';
import { errorToMessage } from '../../src/lib/safeString';
import { scanMessage as scanMessageDeep } from '../../src/lib/messageSecurityScanner';
import {
  IMAGE_PICKER_OPTIONS_CHAT,
  VIDEO_PICKER_OPTIONS_CHAT,
  assertUploadSize,
} from '../../src/lib/dataFriendlyDefaults';
import { readCache, writeCache } from '../../src/lib/offlineCache';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import NetInfo from '@react-native-community/netinfo';

// iter-301: tag used to keep the screen awake ONLY while a voice note is
// being recorded. If the screen turns off mid-record, Android can suspend
// the app and wipe the recorder's temp file in /cache/Audio — which produced
// the "holes"/loop on playback and the
// "Directory …/cache/Audio/recording-….m4a doesn't exist" upload failure.
const VOICE_REC_KEEP_AWAKE_TAG = 'smilers-voice-rec';
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
import { findSavedContactDisplayName, getConversationDisplayName, getResolvedConversationDisplayName, getResolvedDisplayName, getDisplayInitials, getSavedContactRecord } from '../../src/lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../src/lib/deviceContactIndex';
import { cacheUserName } from '../../src/push/notificationNameCache';
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
import { loadChatDraft, saveChatDraft, clearChatDraft, isChatDraftEmpty } from '../../src/lib/chatDrafts';
import { rememberChatRoute } from '../../src/lib/lastRoute';
import { translateIncomingMessageText } from '../../src/lib/translation';
import { uploadFile } from '../../src/lib/uploadFile';
import { computeFileHashFromUri } from '../../src/lib/fileHash';
import { useAuth } from '../../src/providers/AuthProvider';
import { useConversationOtherUser } from '../../src/hooks/useConversationOtherUser';
import { formatCityLocalTime } from '../../src/lib/localTime';
import { cityFromTimezone, formatTimeDifference, getLocalTimezone } from '../../src/lib/localTime';
import { useConversationE2EE } from '../../src/hooks/useConversationE2EE';
import { useViewerSuspension } from '../../src/hooks/useViewerSuspension';
import { decryptText } from '../../src/lib/e2eeCrypto';
import { triggerTranscription } from '../../src/lib/triggerTranscription';
import { markLocallyRead, noteReadBaseline, unreadMinusBaseline } from '../../src/lib/localReadState';
import { VOICE_RECORDING_OPTIONS } from '../../src/lib/audioRecording';
import ScheduleMessageSheet, { ScheduleSelection } from '../../src/components/ScheduleMessageSheet';
import CameraCapture from '../../src/components/CameraCapture';
import { Colors } from '../../src/theme';
import { styles } from '../../src/components/chat/chatScreenStyles';
import { RecordingPlaybackModal } from '../../src/components/chat/RecordingPlayback';
import { EditPermissionModals } from '../../src/components/chat/EditPermissionModals';
import { friendlyConvexError } from '../../src/lib/friendlyError';
import { ChatOptionsMenu } from '../../src/components/chat/ChatOptionsMenu';
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

/**
 * Read fileName + fileSize for a local media URI. The web app's
 * `messages.send` includes `fileName`, `fileSize` and `mimeType` for ALL
 * media (image/video/audio/file); the mobile image/video sends were omitting
 * fileName + fileSize, which the (strict) Convex backend rejected — the photo
 * stayed stuck in the composer and videos sent with broken metadata. This
 * derives both so mobile matches the web send signature exactly.
 */
async function getMediaMeta(
  uri: string,
  mime: string,
  fallbackBase: string,
): Promise<{ fileName: string; fileSize: number }> {
  let fileSize = 0;
  try {
    const info: any = await LegacyFileSystem.getInfoAsync(uri, { size: true } as any);
    if (info?.exists && typeof info.size === 'number') fileSize = info.size;
  } catch {
    /* size best-effort */
  }
  let fileName = '';
  try {
    fileName = (uri.split('/').pop() || '').split('?')[0];
  } catch {
    /* ignore */
  }
  if (!fileName) {
    const ext = (mime.split('/')[1] || 'bin').split(';')[0];
    fileName = `${fallbackBase}.${ext}`;
  }
  return { fileName, fileSize };
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
  // iter-294: caret tracking for cursor-aware auto-numbering (mid-list Enter
  // + renumber). `composerSelectionRef` mirrors the live caret; `forcedSelection`
  // is a one-shot controlled selection we set only after programmatically
  // moving the caret (then released on the next selection change).
  const composerSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  // iter-294: highlight the active list button when the caret sits in a list.
  const [activeListKind, setActiveListKind] = useState<'ordered' | 'bullet' | null>(null);
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
  // iter-291: tapping a reply's quoted preview jumps to the original message
  // and briefly flashes it. `jumpHighlightId` holds the target message id while
  // the highlight is visible; a timer clears it after a short interval.
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const jumpHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // iter-292: message selected for the rich "Message Info" sheet (Read by +
  // media consumption rows). null = sheet closed.
  const [infoMsg, setInfoMsg] = useState<any | null>(null);
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
  // iter-307: disposer for the "recording in progress" lock-suppression signal.
  const recActivityDisposeRef = useRef<null | (() => void)>(null);
  // iter-310: heartbeat interval id for broadcasting the "recording…" activity
  // to the other participant (must re-send < 5s or the indicator expires).
  const recBroadcastTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  const audioRecorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(audioRecorder, 200);

  // iter-304: voice-note REVIEW-before-send. After the user stops a recording
  // we stage it here (instead of sending immediately) so they can listen back
  // and re-record if it sounds off. `reviewUri` points at the stable copy.
  const [reviewUri, setReviewUri] = useState<string | null>(null);
  const [reviewDurationSec, setReviewDurationSec] = useState(0);
  const [reviewReplyToId, setReviewReplyToId] = useState<string | undefined>(undefined);
  const reviewSource = useMemo(() => (reviewUri ? { uri: reviewUri } : null), [reviewUri]);
  const reviewPlayer = useAudioPlayer(reviewSource);
  const reviewStatus = useAudioPlayerStatus(reviewPlayer);
  const reviewPlaying = !!reviewStatus?.playing;
  const reviewProgress =
    reviewStatus && reviewStatus.duration > 0
      ? Math.min(1, (reviewStatus.currentTime || 0) / reviewStatus.duration)
      : 0;
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
  // iter-336: group pinned post. Admins (chief/admin/creator) pin or unpin;
  // banner is visible to ALL members. Direct 1:1 chats — either person can
  // pin. Canonical contract: conversations.pinMessage({ conversationId,
  // messageId }) to pin/replace; omit messageId to unpin. getPinnedMessage
  // returns the pinned message doc (or null). Admin gate via
  // groupAdmin.getGroupAdminInfo → isAdmin.
  const isGroupChat = conversation?.type === 'group';
  const pinMessageMutation = useMutation((api as any).conversations?.pinMessage);
  const pinnedMessage = useQuery(
    (api as any).conversations?.getPinnedMessage,
    canQueryConversation ? { conversationId } : 'skip',
  ) as any;
  const groupAdminInfo = useQuery(
    (api as any).groupAdmin?.getGroupAdminInfo,
    canQueryConversation && isGroupChat ? { conversationId } : 'skip',
  ) as any;
  // iter-338: group members carry each sender's Smilers/Google account name
  // (and phone for device-contact resolution). Used by resolveSenderName so a
  // group message never falls back to the generic "Member" label.
  const groupMembers = useQuery(
    (api as any).conversations?.getGroupMembers,
    canQueryConversation && isGroupChat ? { conversationId } : 'skip',
  ) as any[] | undefined;
  const canPinMessages = isGroupChat ? !!groupAdminInfo?.isAdmin : true;
  const pinnedMessageId = pinnedMessage
    ? String(pinnedMessage._id || pinnedMessage.messageId || pinnedMessage.message?._id || '')
    : '';
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
  // iter-338: index group members by userId so we can resolve a sender's
  // real account name + phone from the message's senderId alone.
  const groupMemberById = useMemo(() => {
    const map = new Map<string, any>();
    (Array.isArray(groupMembers) ? groupMembers : []).forEach((m: any) => {
      const uid = String(m?.userId || m?._id || m?.user?._id || '');
      if (uid) map.set(uid, m);
    });
    return map;
  }, [groupMembers]);
  // iter-337/338: resolve a group message sender's display name. Device address-
  // book name takes priority (matched via the viewer's saved contact record OR
  // the group member's phone), falling back to the sender's Smilers/Google
  // account name — NOT the generic "Member" label. Mirrors group/[id].tsx's
  // displayNameForMember.
  const resolveSenderName = useCallback(
    (senderId: any, fallbackName?: string): string => {
      const uid = String(senderId || '');
      const member = groupMemberById.get(uid) || {};
      const record = getSavedContactRecord(contacts, { userId: uid });
      // Prefer the actual account name over the generic message fallback.
      const memberName =
        (member?.name && String(member.name).trim()) ||
        (member?.displayName && String(member.displayName).trim()) ||
        '';
      const fb =
        memberName ||
        (fallbackName && String(fallbackName).trim()) ||
        'Member';
      // Merge the saved-contact record (viewer's phonebook) over the group
      // member profile so phone numbers from either source enable device lookup.
      const base = { ...member, ...(record || {}) };
      return getResolvedDisplayName(
        { ...base, name: base.name || fb, displayName: base.displayName || fb },
        deviceContactIndex,
        lookupDeviceContactName,
        fb,
      );
    },
    [contacts, deviceContactIndex, groupMemberById],
  );

  // Persist each group member's resolved (device-contact-first) name by
  // userId so background push handlers can show the saved name for a group
  // message's sender when the push carries `senderId`.
  useEffect(() => {
    if (groupMemberById.size === 0) return;
    groupMemberById.forEach((_member, uid) => {
      const resolved = resolveSenderName(uid);
      if (resolved && resolved !== 'Member') cacheUserName(uid, resolved);
    });
  }, [groupMemberById, resolveSenderName]);

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

  // Clear this conversation's message notifications when the chat is open, so
  // already-read messages don't linger in the notification shade. Runs on open
  // and whenever new messages arrive while the chat is foregrounded.
  const unreadCounts = useQuery((api as any).messages.getUnreadCounts, isAuthenticated ? {} : 'skip') as
    | Record<string, number>
    | undefined;

  useEffect(() => {
    if (!conversationId || typeof conversationId !== 'string') return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../src/push/notifeeMessageDisplay');
      void mod.clearConversationNotifications(conversationId);
      // Instantly drop the launcher badge to the total unread of OTHER chats,
      // since this conversation is now being read (don't wait for the list).
      if (unreadCounts) {
        // This conversation is being read now — record its already-read
        // baseline so it stays cleared everywhere.
        noteReadBaseline(conversationId, Number((unreadCounts as any)[conversationId]) || 0);
        const others = Object.entries(unreadCounts).reduce(
          (sum, [id, c]) =>
            id === conversationId ? sum : sum + unreadMinusBaseline(id, Number(c) || 0),
          0,
        );
        void mod.setAppBadgeCount(others);
      }
    } catch {}
  }, [conversationId, messagesPage?.page?.length, unreadCounts]);

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
  const [isOffline, setIsOffline] = useState(false);
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

  // Auto-flush triggers: connectivity returns + app foreground. Also tracks
  // the offline state to drive the "showing saved messages" banner.
  useEffect(() => {
    if (!conversationId) return;
    const applyState = (state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => {
      const online = !!state.isConnected && state.isInternetReachable !== false;
      setIsOffline(!online);
      if (online) void flushOutbox();
    };
    const unsubNet = NetInfo.addEventListener(applyState);
    void NetInfo.fetch().then(applyState);
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void NetInfo.fetch().then(applyState);
        void flushOutbox();
      }
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
  const markRead = useMutation(api.messages.markRead);
  // Incoming "delete for everyone" requests addressed to me (as the sender of
  // the message). Mirrors the web app: getPendingDeletionRequests + a banner
  // with Delete / Decline → respondToDeletionRequest({ requestId, accept }).
  const pendingDeletionRequests = useQuery(
    (api as any).messages.getPendingDeletionRequests,
    isAuthenticated ? {} : 'skip',
  ) as any[] | undefined;
  const respondToDeletionRequest = useMutation((api as any).messages.respondToDeletionRequest);
  const toggleReaction = useMutation(api.messages.toggleReaction);
  const deleteMessage = useMutation(api.messages.deleteMessage);
  // iter-323 "Receive once" 🔂: reveal a hidden duplicate for this viewer.
  const allowReceiptMutation = useMutation(api.messages.allowReceipt);
  // iter-322: PER-VIEWER deletes ("Delete for me" / "Delete for receiver") are
  // handled by the shared Convex backend by REMOVING the message from the
  // actor's query results entirely (verified w/ Emergent support) — it does NOT
  // stamp deletedAt/isDeleted on the actor's own copy (only delete-for-EVERYONE
  // marks deletedAt globally). The user wants a WhatsApp-style "This message was
  // deleted" TOMBSTONE on the actor's device for these scopes (NOT a vanish).
  // Since the server drops the row, an overlay alone has nothing to attach to,
  // so we persist enough metadata (senderId + creationTime) to reconstruct a
  // SYNTHETIC tombstone entry in the timeline. Persisted per-conversation as
  // { [msgId]: { deletedAt, senderId, creationTime } }.
  const LOCAL_DELETED_KEY = `smilers:deleted_msgs:${String(conversationId || 'unknown')}`;
  type LocalDeletedEntry = { deletedAt: number; senderId: string; creationTime: number };
  const [locallyDeleted, setLocallyDeleted] = useState<Record<string, LocalDeletedEntry>>({});
  useEffect(() => {
    let alive = true;
    readStoredJson<Record<string, any>>(LOCAL_DELETED_KEY, {}).then((stored) => {
      if (!alive || !stored || typeof stored !== 'object') return;
      // Normalise legacy shape ({ id: number }) → { id: { deletedAt, ... } }.
      const normalised: Record<string, LocalDeletedEntry> = {};
      for (const [id, val] of Object.entries(stored)) {
        if (typeof val === 'number') {
          normalised[id] = { deletedAt: val, senderId: '', creationTime: val };
        } else if (val && typeof val === 'object') {
          normalised[id] = {
            deletedAt: Number((val as any).deletedAt) || Date.now(),
            senderId: String((val as any).senderId || ''),
            creationTime: Number((val as any).creationTime) || Number((val as any).deletedAt) || Date.now(),
          };
        }
      }
      setLocallyDeleted(normalised);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  const markDeletedLocally = useCallback(
    (msg: any) => {
      const id = msg?._id ? String(msg._id) : '';
      if (!id) return;
      setLocallyDeleted((prev) => {
        if (prev[id]) return prev;
        const entry: LocalDeletedEntry = {
          deletedAt: Date.now(),
          senderId: String(msg?.senderId || ''),
          creationTime: Number(msg?._creationTime) || Date.now(),
        };
        const next = { ...prev, [id]: entry };
        void writeStoredJson(LOCAL_DELETED_KEY, next);
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId]
  );

  // Optional edit mutations — different Convex deployments expose this under
  // different names (`editMessage`, `updateMessage`, `editText`). We try them
  // in order at call-time. `api: any` keeps TS happy even if the function
  // doesn't exist server-side; the runtime catch handles missing endpoints.
  const editMessage = useMutation((api as any).messages.editMessage);
  const updateMessage = useMutation((api as any).messages.updateMessage);
  const editTextMutation = useMutation((api as any).messages.editText);
  // iter-333 group-post edit permissions (Phase 1). mode ∈ owner|open|approval.
  const setEditModeMutation = useMutation((api as any).messages.setEditMode);
  const [editModeTarget, setEditModeTarget] = useState<any | null>(null);
  // iter-334 (Phase 2): propose / review edit workflow for "approval" mode.
  const proposeEditMutation = useMutation((api as any).messages.proposeEdit);
  const reviewEditMutation = useMutation((api as any).messages.reviewEdit);
  const [proposingMessageId, setProposingMessageId] = useState<string | null>(null);
  const [showPendingEdits, setShowPendingEdits] = useState(false);
  const pendingEditsList = useQuery(
    (api as any).messages.listPendingEdits,
    conversationId ? { conversationId } : 'skip',
  ) as any[] | undefined;
  const pendingEditsCount = useQuery(
    (api as any).messages.countPendingEdits,
    conversationId ? { conversationId } : 'skip',
  ) as number | undefined;
  const myPendingForSelected = useQuery(
    (api as any).messages.getMyPendingEdit,
    selectedMsg?._id ? { messageId: selectedMsg._id } : 'skip',
  ) as any;
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

  // ── Composer draft persistence ────────────────────────────────────────────
  // Save whatever the user has started (text, staged photos, reply target,
  // in-progress edit, formatting) per conversation so leaving the chat — or the
  // app — never loses it. On return the composer rehydrates exactly where they
  // paused. See src/lib/chatDrafts.ts.
  // Remember this conversation as the "resume target" so a full app restart
  // reopens it (see src/lib/lastRoute.ts + ResumeLastRoute in _layout).
  useEffect(() => {
    if (conversationId && hasValidConversationId) {
      void rememberChatRoute(`/chat/${conversationId}`);
    }
  }, [conversationId, hasValidConversationId]);

  const draftHydratedRef = useRef(false);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraftRef = useRef<{ conversationId: string; draft: any } | null>(null);

  // Hydrate the stored draft once per conversation open.
  useEffect(() => {
    draftHydratedRef.current = false;
    if (!conversationId) return;
    let alive = true;
    void loadChatDraft(String(conversationId)).then((draft) => {
      if (!alive) return;
      if (draft && !isChatDraftEmpty(draft)) {
        if (typeof draft.text === 'string' && draft.text.length > 0) setText(draft.text);
        if (draft.replyTo) setReplyTo(draft.replyTo);
        if (Array.isArray(draft.pendingImages) && draft.pendingImages.length > 0) {
          setPendingImages(draft.pendingImages);
        }
        if (draft.editingMessageId) setEditingMessageId(draft.editingMessageId);
        if (typeof draft.draftBold === 'boolean') setDraftBold(draft.draftBold);
        if (draft.draftColor) setDraftColor(draft.draftColor as DraftTextColorKey);
      }
      draftHydratedRef.current = true;
    });
    return () => {
      alive = false;
    };
  }, [conversationId]);

  // Persist the draft (debounced) whenever any composer field changes — but
  // only after hydration, so the initial empty state never wipes a saved draft.
  useEffect(() => {
    if (!conversationId || !draftHydratedRef.current) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    const draft = {
      text,
      replyTo,
      pendingImages,
      editingMessageId,
      draftBold,
      draftColor,
    };
    // Mirror the latest draft so we can flush it immediately on unmount (e.g.
    // the user hits Back within the debounce window).
    latestDraftRef.current = { conversationId: String(conversationId), draft };
    draftSaveTimerRef.current = setTimeout(() => {
      if (isChatDraftEmpty(draft)) {
        void clearChatDraft(String(conversationId));
      } else {
        void saveChatDraft(String(conversationId), draft);
      }
    }, 400);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [conversationId, text, replyTo, pendingImages, editingMessageId, draftBold, draftColor]);

  // Flush the latest draft immediately when the chat unmounts, so a quick Back
  // tap during the debounce window still persists (or clears) it.
  useEffect(() => {
    return () => {
      const pending = latestDraftRef.current;
      if (!pending || !pending.conversationId) return;
      if (isChatDraftEmpty(pending.draft)) {
        void clearChatDraft(pending.conversationId);
      } else {
        void saveChatDraft(pending.conversationId, pending.draft);
      }
    };
  }, []);

  // iter-340: also flush the draft the moment the app goes to background /
  // inactive. Cleanup callbacks do NOT run when the OS kills a backgrounded
  // app, so without this a message typed just before switching away could be
  // lost (the 400ms debounce may not have fired yet). Writing synchronously on
  // the background transition guarantees the draft is persisted before any kill.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        const pending = latestDraftRef.current;
        if (!pending || !pending.conversationId) return;
        if (isChatDraftEmpty(pending.draft)) {
          void clearChatDraft(pending.conversationId);
        } else {
          void saveChatDraft(pending.conversationId, pending.draft);
        }
      }
    });
    return () => sub.remove();
  }, []);

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
    const cutoff = ttlMs ? Date.now() - ttlMs : 0;
    const out: any[] = [];
    const presentIds = new Set<string>();
    for (const message of decryptedMessages) {
      if (cutoff && Number(message?._creationTime || 0) < cutoff) continue;
      const id = message?._id ? String(message._id) : '';
      if (id) presentIds.add(id);
      // iter-322: per-viewer deletes ("Delete for me" / "Delete for receiver")
      // must leave a "This message was deleted" TOMBSTONE on the actor's device
      // (NOT vanish). If the backend still returns the row, overlay a stable
      // deletedAt so MessageBubble/MediaBubble render the tombstone in place.
      const entry = id ? locallyDeleted[id] : undefined;
      if (entry && !message?.deletedAt && message?.isDeleted !== true) {
        out.push({ ...message, deletedAt: entry.deletedAt });
      } else {
        out.push(message);
      }
    }
    // iter-322: SECOND PASS — the shared backend REMOVES per-viewer-deleted rows
    // from the actor's query results, so an in-place overlay has nothing to
    // attach to. For every locally-deleted id NOT present in the server results,
    // synthesise a tombstone message so it still renders "This message was
    // deleted" in its original timeline position (and survives reopen).
    for (const [id, entry] of Object.entries(locallyDeleted)) {
      if (presentIds.has(id)) continue;
      out.push({
        _id: id,
        _creationTime: entry.creationTime || entry.deletedAt,
        senderId: entry.senderId,
        deletedAt: entry.deletedAt,
        isDeleted: true,
        text: '',
        __syntheticTombstone: true,
      });
    }
    // Timeline is ascending by _creationTime; keep synthetic entries positioned.
    out.sort((a: any, b: any) => Number(a?._creationTime || 0) - Number(b?._creationTime || 0));
    return out;
  }, [disappearingMode, serverDisappearMs, decryptedMessages, locallyDeleted]);

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

  // iter-320: hint the transcription backend which language(s) the sender
  // speaks. When Asante Twi (Akan, code 'ak') is among them the backend routes
  // to Gemini (far better Twi accuracy) instead of Whisper.
  const transcribeLangHint = useMemo(() => {
    const codes = new Set<string>();
    if (preferredLanguage) codes.add(preferredLanguage.trim().toLowerCase());
    const lists = [me?.spokenLanguages, me?.languages];
    lists.forEach((list) => {
      if (Array.isArray(list)) {
        list.forEach((code) => {
          if (typeof code === 'string' && code.trim()) codes.add(code.trim().toLowerCase());
        });
      }
    });
    return Array.from(codes).join(',') || undefined;
  }, [preferredLanguage, me?.spokenLanguages, me?.languages]);
  const transcribeLangHintRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    transcribeLangHintRef.current = transcribeLangHint;
  }, [transcribeLangHint]);


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

  // iter-291: jump to the original message a reply references. Scrolls it to
  // the centre of the viewport and briefly flashes it so the user can see
  // exactly which message the reply was about (WhatsApp-style).
  const jumpToMessage = useCallback(
    (messageId: string | null | undefined) => {
      if (!messageId) return;
      const idx = timeline.findIndex((it: any) => String(it?._id) === String(messageId));
      if (idx < 0) return; // parent not loaded in the current timeline window
      try {
        listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
      } catch {}
      // Light haptic so the "found it" moment feels responsive on-device.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      if (jumpHighlightTimerRef.current) clearTimeout(jumpHighlightTimerRef.current);
      setJumpHighlightId(String(messageId));
      jumpHighlightTimerRef.current = setTimeout(() => {
        setJumpHighlightId(null);
        jumpHighlightTimerRef.current = null;
      }, 1800);
    },
    [timeline],
  );

  // iter-323 "Receive once" 🔂: tapping the "file deleted for multiple
  // receipt" footprint offers to jump to the ORIGINAL copy of the file (in
  // this or another conversation) or to reveal (allow) this hidden copy.
  const handleReceiveOnceTombstone = useCallback(
    (message: any) => {
      const fileHash = message?.fileHash ? String(message.fileHash) : '';
      const messageId = message?._id ? String(message._id) : '';
      const buttons: any[] = [];
      if (fileHash) {
        buttons.push({
          text: 'View original',
          onPress: async () => {
            try {
              const origin: any = await convex.query((api as any).messages.getReceiveOnceOrigin, { fileHash });
              if (!origin || !origin.firstMessageId) {
                Alert.alert('Original not found', 'The first copy of this file is no longer available.');
                return;
              }
              const originConvId = String(origin.firstConversationId || '');
              const originMsgId = String(origin.firstMessageId || '');
              if (originConvId && originConvId === String(conversationId)) {
                jumpToMessage(originMsgId);
              } else if (originConvId) {
                router.push(`/chat/${originConvId}?mid=${originMsgId}` as any);
              }
            } catch {
              Alert.alert('Could not open original', 'Please try again.');
            }
          },
        });
      }
      if (messageId) {
        buttons.push({
          text: 'Allow receipt',
          onPress: async () => {
            try {
              await allowReceiptMutation({ messageId });
              await refetchMessages();
            } catch {
              Alert.alert('Could not allow receipt', 'Please try again.');
            }
          },
        });
      }
      buttons.push({ text: 'Cancel', style: 'cancel' });
      Alert.alert(
        'File received before',
        'You already received this file, so this copy was hidden. You can view the original or allow this copy.',
        buttons,
      );
    },
    [allowReceiptMutation, conversationId, convex, jumpToMessage, refetchMessages, router],
  );

  useEffect(
    () => () => {
      if (jumpHighlightTimerRef.current) clearTimeout(jumpHighlightTimerRef.current);
    },
    [],
  );


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
      // forEveryone:false = delete just for this viewer (private retraction),
      // matching the web app's `deleteMessage({ messageId, forEveryone:false })`.
      (deleteMessage as any)({ messageId: m._id, forEveryone: false }).catch(() => {});
    }
  }, [displayMessages, deleteMessage]);

  // NOTE: in-chat markDelivered was removed (iter-240) — it fired at the same
  // moment as markRead on chat open, making the sender's dot jump yellow→blue
  // and skip green. Delivery is now marked globally by useDeliveryReceipts
  // (watches getUnreadCounts), exactly like the web app. markRead still fires
  // here when messages are visible on screen.
  useEffect(() => {
    if (conversationId && visibleMessages.length > 0) {
      markRead({ conversationId }).catch(() => {});
      // iter-340: also record a LOCAL read stamp so the chat-list badge clears
      // immediately even if the backend `getUnreadCounts` doesn't reflect
      // `markRead`. Stamp "read up to" = the newest message we can see (or now),
      // so a genuinely newer incoming message re-surfaces the badge.
      const latestMs = visibleMessages.reduce(
        (max: number, m: any) => Math.max(max, Number(m?._creationTime) || 0),
        0,
      );
      markLocallyRead(String(conversationId), Math.max(Date.now(), latestMs));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const proposeTargetId = proposingMessageId;
    setText('');
    setReplyTo(null);
    setEditingMessageId(null);
    setProposingMessageId(null);
    resetComposerFormatting();

    try {
      if (proposeTargetId) {
        // iter-334: member proposing an edit on an "approval"-mode post.
        setSending(false);
        try {
          await proposeEditMutation({ messageId: proposeTargetId, text: formattedValue });
          callDebug.push('EDIT', `proposeEdit on ${proposeTargetId.slice(-6)}`);
          Alert.alert('Edit suggested', 'Your suggested edit was sent to the author for approval.');
        } catch (proposeErr: any) {
          Alert.alert('Could not suggest edit', proposeErr?.message || 'Please try again.');
        }
        return;
      }
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
        if (isOffline) {
          // OFFLINE: Convex mutations don't reject when there's no
          // connection — the promise just hangs until reconnect, so the
          // catch below never runs and the message would silently vanish
          // from the UI (the bug the user reported). Queue it immediately
          // → shows in the timeline with a RED dot and auto-sends on
          // reconnect (matches WhatsApp's pending-clock behaviour).
          const next = await enqueueOutbox(String(conversationId), {
            senderId: String(effectiveMe?._id || ''),
            text: formattedValue,
            ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
          });
          setOutboxMsgs(next);
          return;
        }
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

  // iter-294: one-tap list button — apply/remove a numbered or bulleted list
  // across the selected lines (or current line) and select the result.
  const applyListFormat = (kind: 'numeric' | 'bullet') => {
    const sel = composerSelectionRef.current;
    const result = toggleListFormat(text, sel, kind);
    setText(result.text);
    composerSelectionRef.current = result.selection;
    setForcedSelection(result.selection);
    setActiveListKind(currentLineListKind(result.text, result.selection.start));
    messageInputRef.current?.focus();
  };

  const handleTyping = (val: string) => {
    // iter-294: cursor-aware continuous auto-numbering + renumbering.
    // Handles Enter anywhere in a list (insert next marker at caret) and keeps
    // ordered lists sequential after inserts/deletes. Within-line edits pass
    // through untouched.
    const prevCursor = composerSelectionRef.current?.start ?? text.length;
    const result = processComposerChange(text, val, prevCursor);
    setText(result.text);
    if (result.selection) {
      composerSelectionRef.current = result.selection;
      setForcedSelection(result.selection);
    }
    setActiveListKind(currentLineListKind(result.text, result.selection?.start ?? prevCursor));
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

  // iter-310: broadcast the "recording audio…" activity to the other
  // participant while a voice note is being recorded. Contract:
  // setTyping({ conversationId, kind: 'recording_voice' }) must be re-sent
  // < 5s (indicator TTL), so we heartbeat every 3s and clearTyping on stop.
  // Gated behind the same "typing indicators" privacy setting as typing.
  useEffect(() => {
    if (recBroadcastTimerRef.current) {
      clearInterval(recBroadcastTimerRef.current);
      recBroadcastTimerRef.current = null;
    }
    if (isRecording && conversationId && typingIndicatorsEnabledRef.current) {
      const beat = () =>
        setTyping({ conversationId, kind: 'recording_voice' } as any).catch(() => {});
      beat();
      recBroadcastTimerRef.current = setInterval(beat, 3000);
      return () => {
        if (recBroadcastTimerRef.current) {
          clearInterval(recBroadcastTimerRef.current);
          recBroadcastTimerRef.current = null;
        }
        if (conversationId) clearTyping?.({ conversationId }).catch(() => {});
      };
    }
  }, [isRecording, conversationId, setTyping, clearTyping]);

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
      if (!conversationId || !isConversationAvailable) {
        callDebug.push('IMG', `send aborted: convId=${!!conversationId} available=${isConversationAvailable}`);
        Alert.alert('Cannot send photo', 'This conversation is still loading. Please reopen the chat and try again.');
        return false;
      }

      setUploading(true);
      const caption = (captionOverride ?? text).trim();
      const formattedCaption = caption
        ? applyDraftFormatting(caption, { bold: draftBold, color: draftColor })
        : '';
      const replyToMessageId = replyTo?._id;

      callDebug.push('IMG', `send start mime=${mimeType || 'image/jpeg'} uri=${String(uri).slice(-32)}`);
      try {
        const storageId = await uploadFile(convex, uri, mimeType || 'image/jpeg');
        callDebug.push('IMG', `upload OK storageId=${String(storageId).slice(0, 10)}…`);
        const meta = await getMediaMeta(uri, mimeType || 'image/jpeg', 'image');
        callDebug.push('IMG', `meta name=${meta.fileName} size=${meta.fileSize}`);
        // iter-323 "Receive once": SHA-256 of the plaintext file bytes so the
        // backend can hide duplicate copies for a receiver.
        const fileHash = await computeFileHashFromUri(uri);
        await sendMessage({
          conversationId,
          type: 'image',
          text: formattedCaption,
          storageId,
          // Match the web app's media send signature exactly: the backend's
          // messages.send requires fileName + fileSize + mimeType for media.
          // Omitting fileName/fileSize made strict validation reject the send
          // → the photo stayed stuck in the composer.
          fileName: meta.fileName,
          fileSize: meta.fileSize,
          mimeType: mimeType || 'image/jpeg',
          ...(fileHash ? { fileHash } : {}),
          ...(replyToMessageId ? { replyToId: replyToMessageId } : {}),
        });
        callDebug.push('IMG', 'messages.send OK');
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
        const detail = errorValue?.data?.message || errorValue?.message || String(errorValue);
        callDebug.push('ERR', `IMG send failed: ${String(detail).slice(0, 120)}`);
        Alert.alert('Upload failed', detail || 'Unable to send image right now.');
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
    const result = await pickImageLibrary({
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
    const result = await pickImageLibrary({
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
        const vmeta = await getMediaMeta(asset.uri, mime, 'video');
        const videoHash = await computeFileHashFromUri(asset.uri);
        const sentVideoId: any = await sendMessage({ conversationId, type: 'video', storageId, fileName: (asset as any)?.fileName || vmeta.fileName, fileSize: (asset as any)?.fileSize || vmeta.fileSize, mimeType: mime, ...(videoHash ? { fileHash: videoHash } : {}) });
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
            languageHint: transcribeLangHintRef.current,
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

    // iter-310: broadcast "recording video…" while the camera is open. Note:
    // this uses the OS camera (launchCameraAsync), so JS timers are paused
    // while it's foregrounded — we can't heartbeat, so the indicator naturally
    // clears after the ~5s TTL and again explicitly when the camera returns.
    if (conversationId && typingIndicatorsEnabledRef.current) {
      setTyping({ conversationId, kind: 'recording_video' } as any).catch(() => {});
    }

    // iter-164 data-friendly: 60s cap + reduced quality.
    let result: any;
    try {
      result = await pickCamera(VIDEO_PICKER_OPTIONS_CHAT);
    } finally {
      if (conversationId) clearTyping?.({ conversationId }).catch(() => {});
    }

    if (result.canceled || !result.assets?.[0]?.uri || !conversationId) return;
    const asset = result.assets[0];

    setUploading(true);
    try {
      const mime = asset.mimeType || 'video/mp4';
      const storageId = await uploadFile(convex, asset.uri, mime);
      const vmeta = await getMediaMeta(asset.uri, mime, 'video');
      const videoHash = await computeFileHashFromUri(asset.uri);
      const sentVideoId: any = await sendMessage({ conversationId, type: 'video', storageId, fileName: (asset as any)?.fileName || vmeta.fileName, fileSize: (asset as any)?.fileSize || vmeta.fileSize, mimeType: mime, ...(videoHash ? { fileHash: videoHash } : {}) });
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
          languageHint: transcribeLangHintRef.current,
        }).catch(() => {});
      }
    } catch (errorValue: any) {
      Alert.alert('Failed to send video', errorValue?.message || 'Unknown error');
    } finally {
      setUploading(false);
    }
  }, [conversationId, convex, refetchMessages, sendMessage, setTyping, clearTyping]);

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
      const result = await pickDocument({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled) return;

      const files = Array.isArray(result.assets) ? result.assets : [];
      if (files.length === 0) return;

      setUploading(true);
      const replyToMessageId = replyTo?._id;
      let sentAny = false;
      const skipped: string[] = [];

      for (const file of files) {
        if (!file) continue;

        // iter-164 security: block obviously dangerous attachments (e.g., .exe,
        // .apk, .bat) at the SEND boundary so a malicious upload never reaches
        // the recipient.
        const preSendScan = scanMessageDeep({ fileName: file.name, mimeType: file.mimeType || undefined });
        if (preSendScan.shouldAutoDelete) {
          skipped.push(`${file.name} (risky file type)`);
          continue;
        }

        // iter-164 data-friendly: refuse oversized uploads before burning bandwidth.
        try {
          assertUploadSize(file.size || 0, 'document');
        } catch {
          skipped.push(`${file.name} (too large)`);
          continue;
        }

        const mime = file.mimeType || 'application/octet-stream';
        const storageId = await uploadFile(convex, file.uri, mime);
        const docHash = await computeFileHashFromUri(file.uri);
        await sendMessage({
          conversationId,
          type: 'file',
          storageId,
          mimeType: mime,
          fileName: file.name,
          fileSize: file.size,
          ...(docHash ? { fileHash: docHash } : {}),
          // Only attach the reply to the FIRST file so a batch doesn't repeat it.
          ...(!sentAny && replyToMessageId ? { replyToId: replyToMessageId } : {}),
        });
        sentAny = true;
      }

      if (sentAny) setReplyTo(null);
      await refetchMessages();

      if (skipped.length > 0) {
        Alert.alert(
          'Some files were skipped',
          skipped.join('\n'),
        );
      }
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
    // iter-307: suppress "Lock when leaving" for the whole recording. The audio
    // session change (and the mic-permission prompt) can flip AppState, and on
    // return-to-active AppLockGate was locking the app mid-recording → the chat
    // screen unmounted, the recorder was torn down, and the user saw a
    // "Recording failed" error. Register recording activity BEFORE any of that.
    if (recActivityDisposeRef.current) {
      recActivityDisposeRef.current();
      recActivityDisposeRef.current = null;
    }
    recActivityDisposeRef.current = recordingActivity.enter();
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission required', 'Please allow microphone access to record voice notes.');
        if (recActivityDisposeRef.current) {
          recActivityDisposeRef.current();
          recActivityDisposeRef.current = null;
        }
        return;
      }
      try {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {}
      recCancelledRef.current = false;
      setRecDuration(0);
      recDurationMsRef.current = 0;
      recStartMsRef.current = Date.now();
      // iter-301: keep the screen ON for the whole recording. A screen-off
      // mid-record let Android suspend the app and clear the recorder's temp
      // file → audio "holes"/loop on playback. Best-effort; never blocks.
      try {
        await activateKeepAwakeAsync(VOICE_REC_KEEP_AWAKE_TAG);
      } catch {}
      // iter-301: make sure the cache "Audio" directory the recorder writes to
      // actually exists before we start (it can be missing after the OS clears
      // the cache), otherwise the later upload fails with
      // "Directory …/cache/Audio/… doesn't exist".
      try {
        const audioDir = `${LegacyFileSystem.cacheDirectory}Audio`;
        const dirInfo: any = await LegacyFileSystem.getInfoAsync(audioDir);
        if (!dirInfo?.exists) {
          await LegacyFileSystem.makeDirectoryAsync(audioDir, { intermediates: true });
        }
      } catch {}
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'duckOthers',
        shouldRouteThroughEarpiece: false,
      });
      // Give the native audio session a beat to actually reconfigure to a
      // mic-capturing category before we start recording. Without this, a
      // session still settling from a prior state (e.g. just after a call)
      // can start the recorder before the mic route is live → silent clip.
      await new Promise((resolve) => setTimeout(resolve, 120));
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecording(true);
      setIsRecordingPaused(false);
    } catch (errorValue: any) {
      setIsRecording(false);
      setIsRecordingPaused(false);
      if (recActivityDisposeRef.current) {
        recActivityDisposeRef.current();
        recActivityDisposeRef.current = null;
      }
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
        // iter-301: copy the recorded clip out of the volatile /cache/Audio dir
        // into a stable app-document path BEFORE uploading. If the OS cleared
        // the cache while the screen was off, the original uri may be gone;
        // copying immediately after stop (and verifying it's non-empty)
        // prevents both the "Directory …/cache/Audio/… doesn't exist" upload
        // crash and the corrupted/looping playback from a half-written file.
        let playableUri = uri;
        try {
          const destDir = `${LegacyFileSystem.documentDirectory}voice-notes`;
          const destInfo: any = await LegacyFileSystem.getInfoAsync(destDir);
          if (!destInfo?.exists) {
            await LegacyFileSystem.makeDirectoryAsync(destDir, { intermediates: true });
          }
          const dest = `${destDir}/vn-${Date.now()}.m4a`;
          await LegacyFileSystem.copyAsync({ from: uri, to: dest });
          const copied: any = await LegacyFileSystem.getInfoAsync(dest, { size: true } as any);
          if (copied?.exists && Number(copied?.size || 0) > 0) {
            playableUri = dest;
          }
        } catch (copyErr: any) {
          console.warn('[voice-send] stable-copy failed, using original uri:', copyErr?.message);
        }
        // Final guard: make sure we actually have a non-empty file to upload.
        const srcInfo: any = await LegacyFileSystem.getInfoAsync(playableUri, { size: true } as any);
        if (!srcInfo?.exists || Number(srcInfo?.size || 0) === 0) {
          Alert.alert(
            'Recording lost',
            'The voice note could not be saved. Please keep the screen on while recording and try again.',
          );
          return;
        }
        // iter-304: stage the clip for REVIEW instead of sending immediately.
        // The user can play it back and then Send or Discard from the review
        // bar (handled by sendReviewedVoice / discardReview below).
        setReviewUri(playableUri);
        setReviewDurationSec(totalSec);
        setReviewReplyToId(replyToMessageId);
      } catch (errorValue: any) {
        const detail = errorValue?.data?.message || errorValue?.message || 'Unknown error';
        console.error('[voice-send] stop failed:', detail, errorValue);
        Alert.alert('Recording failed', detail);
      } finally {
        try {
          deactivateKeepAwake(VOICE_REC_KEEP_AWAKE_TAG);
        } catch {}
        // iter-307: recording is over — allow App Lock to work normally again.
        if (recActivityDisposeRef.current) {
          recActivityDisposeRef.current();
          recActivityDisposeRef.current = null;
        }
        setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          interruptionMode: 'duckOthers',
          shouldRouteThroughEarpiece: false,
        }).catch(() => {});
      }
    },
    [audioRecorder, conversationId, recorderState.durationMillis, replyTo]
  );

  // iter-317: salvage-on-background. If the app is pushed to the background
  // WHILE recording (some aggressive-OEM power managers suspend the app after
  // ~30s even with the screen kept on), finalize the clip and stage it for
  // review instead of losing everything to a "Recording lost" error.
  const isRecordingRef = useRef(false);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' && isRecordingRef.current) {
        void finishRecording('send');
      }
    });
    return () => sub.remove();
  }, [finishRecording]);

  // iter-304: actually upload + send a (reviewed) voice note.
  const uploadAndSendVoice = useCallback(
    async (uri: string, totalSec: number, replyToMessageId?: string) => {
      if (!conversationId) return;
      try {
        setUploading(true);
        const mime = 'audio/m4a';
        const storageId = await uploadFile(convex, uri, mime);
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
        void engagement.voiceNote(totalSec, { isReceived: false });
        const messageId =
          typeof sentVoiceId === 'string' ? sentVoiceId : sentVoiceId?._id || sentVoiceId?.id || '';
        if (messageId) {
          triggerTranscription({
            convex,
            messageId: String(messageId),
            storageId,
            conversationId,
            localFileUri: uri,
            fileName: 'voice.m4a',
            languageHint: transcribeLangHintRef.current,
          }).catch(() => {});
        }
      } catch (errorValue: any) {
        const detail = errorValue?.data?.message || errorValue?.message || 'Unknown error';
        console.error('[voice-send] failed:', detail, errorValue);
        Alert.alert('Failed to send voice note', detail);
      } finally {
        setUploading(false);
      }
    },
    [conversationId, convex, refetchMessages, sendMessage],
  );

  const cancelRecording = useCallback(() => {
    recCancelledRef.current = true;
    finishRecording('cancel');
  }, [finishRecording]);

  // iter-304: review-bar actions.
  const toggleReviewPlay = useCallback(() => {
    if (!reviewPlayer) return;
    try {
      if (reviewStatus?.playing) {
        reviewPlayer.pause();
      } else {
        const dur = reviewStatus?.duration || 0;
        const cur = reviewStatus?.currentTime || 0;
        if (reviewStatus?.didJustFinish || (dur > 0 && cur >= dur - 0.05)) {
          reviewPlayer.seekTo(0);
        }
        reviewPlayer.play();
      }
    } catch {}
  }, [reviewPlayer, reviewStatus]);

  const clearReviewState = useCallback(() => {
    try {
      reviewPlayer?.pause?.();
    } catch {}
    setReviewUri(null);
    setReviewDurationSec(0);
    setReviewReplyToId(undefined);
  }, [reviewPlayer]);

  const sendReviewedVoice = useCallback(async () => {
    if (!reviewUri) return;
    const uri = reviewUri;
    const sec = reviewDurationSec;
    const reply = reviewReplyToId;
    clearReviewState();
    await uploadAndSendVoice(uri, sec, reply);
  }, [reviewUri, reviewDurationSec, reviewReplyToId, clearReviewState, uploadAndSendVoice]);

  const discardReview = useCallback(() => {
    const uri = reviewUri;
    clearReviewState();
    if (uri) {
      LegacyFileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }, [reviewUri, clearReviewState]);

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
      try {
        deactivateKeepAwake(VOICE_REC_KEEP_AWAKE_TAG);
      } catch {}
      if (recActivityDisposeRef.current) {
        recActivityDisposeRef.current();
        recActivityDisposeRef.current = null;
      }
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

  // iter-320: reactions kept failing with a generic Convex "Server Error".
  // A generic Server Error (not an ArgumentValidationError) means the args
  // validated but the function threw internally — consistent with the server
  // being unable to validate participant access without `conversationId`
  // (same contract as toggleStar, iter-147). We therefore send conversationId
  // and, if a backend rejects the extra field (ArgumentValidationError), we
  // transparently retry with the minimal {messageId, emoji} payload so we
  // remain compatible with either backend signature.
  const reactToMessage = useCallback(
    async (messageId: string, emoji: string) => {
      try {
        await toggleReaction({ messageId, emoji, conversationId } as any);
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (/extra field|ArgumentValidationError|conversationId/i.test(msg)) {
          await toggleReaction({ messageId, emoji } as any);
        } else {
          throw e;
        }
      }
    },
    [toggleReaction, conversationId]
  );

  const onPickReaction = useCallback(
    async (emoji: string) => {
      const msg = selectedMsg;
      if (!msg) return;
      closeActionSheet();
      try {
        await reactToMessage(msg._id, emoji);
        callDebug.push('REACT', `ok ${emoji} on ${String(msg._id).slice(-6)}`);
        try {
          await refetchMessages();
        } catch {}
      } catch (e: any) {
        // iter-317: reactions were failing SILENTLY (only console.warn), so the
        // sheet just closed with nothing applied. Surface the real reason into
        // the Diagnostic Log + a brief alert so the failure is diagnosable.
        const reason = e?.message || String(e);
        callDebug.push('ERR', `REACT failed ${emoji}: ${reason}`);
        Alert.alert('Reaction failed', reason);
      }
    },
    [selectedMsg, reactToMessage, refetchMessages]
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
    // iter-292: show the rich Message Info sheet (Read by + media
    // consumption: Played/Watched/Viewed/Opened by) instead of a plain Alert.
    setInfoMsg(msg);
  }, [selectedMsg]);

  const onPin = useCallback(async () => {
    const msg = selectedMsg;
    if (!msg) return;
    closeActionSheet();
    // iter-336: canonical group pinned-post contract. In groups only admins
    // may pin/unpin (the server enforces this too); 1:1 chats allow either
    // participant. Pinning replaces any existing pin (one per chat).
    if (!canPinMessages) {
      Alert.alert('Only admins can pin', 'Ask a group admin to pin or unpin posts.');
      return;
    }
    const isCurrentlyPinned = !!pinnedMessageId && pinnedMessageId === String(msg._id);
    try {
      if (isCurrentlyPinned) {
        // Unpin — omit messageId.
        await pinMessageMutation({ conversationId });
        callDebug.push('PIN', `unpin ${String(msg._id).slice(-6)}`);
      } else {
        // Pin / replace the current pin.
        await pinMessageMutation({ conversationId, messageId: msg._id });
        callDebug.push('PIN', `pin ${String(msg._id).slice(-6)}`);
      }
    } catch (e: any) {
      Alert.alert(
        isCurrentlyPinned ? 'Could not unpin' : 'Could not pin',
        friendlyConvexError(e, 'Please try again.'),
      );
    }
  }, [selectedMsg, conversationId, canPinMessages, pinnedMessageId, pinMessageMutation]);

  // iter-336: unpin from the pinned banner (admins in groups; either in 1:1).
  const onUnpinBanner = useCallback(async () => {
    try {
      await pinMessageMutation({ conversationId });
      callDebug.push('PIN', 'unpin via banner');
    } catch (e: any) {
      Alert.alert('Could not unpin', friendlyConvexError(e, 'Please try again.'));
    }
  }, [conversationId, pinMessageMutation]);

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
    setProposingMessageId(null);
    setText('');
    resetComposerFormatting();
  }, [resetComposerFormatting]);

  // iter-334 (Phase 2): member suggests an edit on an "approval"-mode post.
  const onSuggestEdit = useCallback(() => {
    const msg = selectedMsg;
    closeActionSheet();
    if (!msg?._id) return;
    if (msg.type && msg.type !== 'text') {
      Alert.alert('Not available', 'Only text posts can be edited.');
      return;
    }
    setEditingMessageId(null);
    setProposingMessageId(String(msg._id));
    setText(stripRichTextTags(msg.text) || '');
    setComposerFocused(true);
  }, [selectedMsg]);

  const handleReviewEdit = useCallback(
    async (pendingEditId: string, decision: 'approve' | 'reject', proposerName?: string) => {
      try {
        await reviewEditMutation({ pendingEditId, decision });
        callDebug.push('EDIT', `reviewEdit ${decision} ${String(pendingEditId).slice(-6)}`);
        // Post a lightweight, human-readable notice so the whole group sees
        // the outcome (syncs to web + native via a normal text message).
        if (decision === 'approve' && conversationId) {
          const who = (proposerName && proposerName.trim()) || 'A member';
          try {
            await sendMessage({
              conversationId,
              type: 'text',
              text: `✏️ ${who}'s suggested edit was approved`,
            });
          } catch {}
        }
        try {
          await refetchMessages();
        } catch {}
      } catch (e: any) {
        Alert.alert('Review failed', e?.message || 'Could not review this edit.');
      }
    },
    [reviewEditMutation, refetchMessages, sendMessage, conversationId],
  );

  // iter-333 (Phase 1): author opens the "Who can edit" picker for a group post.
  const onWhoCanEdit = useCallback(() => {
    const msg = selectedMsg;
    closeActionSheet();
    if (!msg?._id) return;
    setEditModeTarget(msg);
  }, [selectedMsg]);

  const applyEditMode = useCallback(
    async (mode: 'owner' | 'open' | 'approval') => {
      const msg = editModeTarget;
      setEditModeTarget(null);
      if (!msg?._id) return;
      try {
        await setEditModeMutation({ messageId: msg._id, mode });
        callDebug.push('EDIT', `setEditMode=${mode} on ${String(msg._id).slice(-6)}`);
        try {
          await refetchMessages();
        } catch {}
      } catch (e: any) {
        Alert.alert('Could not update', e?.message || 'Failed to change edit permissions.');
      }
    },
    [editModeTarget, setEditModeMutation, refetchMessages],
  );

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

  const respondToDeletion = useCallback(
    async (requestId: string, accept: boolean) => {
      try {
        await respondToDeletionRequest({ requestId, accept });
      } catch (e: any) {
        Alert.alert('Action failed', e?.message || 'Could not respond to the request.');
      }
    },
    [respondToDeletionRequest],
  );

  // Pending "delete for everyone" requests the OTHER party sent me about a
  // message I own, scoped to this conversation when the backend provides it.
  const deletionRequestsForChat = useMemo(() => {
    if (!Array.isArray(pendingDeletionRequests)) return [];
    return pendingDeletionRequests.filter((r: any) => {
      if (!r) return false;
      const rc = r.conversationId ? String(r.conversationId) : null;
      return rc ? rc === String(conversationId) : true;
    });
  }, [pendingDeletionRequests, conversationId]);

  const performDelete = useCallback(
    async (mode: 'me' | 'receiver' | 'everyone' | 'request_everyone') => {
      const msg = deleteTarget;
      setDeleteTarget(null);
      if (!msg) return;

      // EXACT web-app signatures (verified from the deployed web bundle —
      // `messages.deleteMessage({ messageId, forEveryone | forReceiver })` and
      // `messages.requestDeletion({ messageId })`). The shared Convex backend
      // validates args strictly, which is why the old `{mode:'everyone'}`
      // shape was rejected and silently downgraded to delete-for-me.
      try {
        if (mode === 'request_everyone') {
          await convex.mutation((api as any).messages.requestDeletion, {
            messageId: msg._id,
          });
          Alert.alert('Request sent', 'The sender has been asked to delete this message for everyone.');
          return;
        }
        if (mode === 'me') {
          await convex.mutation((api as any).messages.deleteMessage, {
            messageId: msg._id,
            forEveryone: false,
          });
          // iter-322: the backend REMOVES the actor's own copy for delete-for-me,
          // so persist metadata and synthesise a local tombstone.
          markDeletedLocally(msg);
        } else if (mode === 'receiver') {
          await convex.mutation((api as any).messages.deleteMessage, {
            messageId: msg._id,
            forReceiver: true,
          });
          // iter-322: user wants a "This message was deleted" tombstone on the
          // sender's device for delete-for-receiver too. Persist + synthesise.
          markDeletedLocally(msg);
        } else {
          // 'everyone'
          await convex.mutation((api as any).messages.deleteMessage, {
            messageId: msg._id,
            forEveryone: true,
          });
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
    [convex, deleteTarget, refetchMessages, markDeletedLocally],
  );

  const onToggleMyReaction = useCallback(
    async (msgId: string, emoji: string) => {
      try {
        await reactToMessage(msgId, emoji);
        callDebug.push('REACT', `toggle ok ${emoji} on ${String(msgId).slice(-6)}`);
        try {
          await refetchMessages();
        } catch {}
      } catch (e: any) {
        const reason = e?.message || String(e);
        callDebug.push('ERR', `REACT toggle failed ${emoji}: ${reason}`);
        Alert.alert('Reaction failed', reason);
      }
    },
    [refetchMessages, reactToMessage]
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

  // iter-319: peer CITY + LOCAL TIME for the DM header. Read the other user's
  // IANA timezone (getUserById is contract-guaranteed to return it) and derive
  // a "City HH:MM local time" label shown between the name and last-seen.
  const { data: peerProfileForTz } = useSafeConvexQuery<any | null>(
    (api as any).users?.getUserById,
    callCalleeId ? { userId: callCalleeId } : {},
    null,
    !!callCalleeId,
  );
  const peerTimezone =
    (mergedPresenceSource as any)?.otherUser?.timezone ||
    (peerProfileForTz as any)?.timezone ||
    null;
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!peerTimezone) return;
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [peerTimezone]);

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
    const nameOf = (u: any) => u?.name || u?.userName || u?.displayName || 'Someone';
    // iter-310: recording activity takes precedence over "typing…".
    // Backend contract: getTypingUsers returns { userId, name, kind } where
    // kind ∈ "typing" | "recording_voice" | "recording_video".
    const voiceRec = others.find((u: any) => u?.kind === 'recording_voice');
    if (voiceRec) return `${nameOf(voiceRec)} is recording audio\u2026`;
    const videoRec = others.find((u: any) => u?.kind === 'recording_video');
    if (videoRec) return `${nameOf(videoRec)} is recording video\u2026`;
    const names = others.map(nameOf);
    return names.length === 1
      ? `${names[0]} is typing\u2026`
      : `${names.join(', ')} are typing\u2026`;
  }, [typingUsersRaw, me?._id]);

  const subtitle = isBroadcastReadOnly
    ? 'Announcement · read-only'
    : (typingLabel || formatPresenceSubtitle(mergedPresenceSource));
  // iter-319: DM-only city + local time (hidden for broadcast; groups have no
  // single peer so `peerTimezone` is naturally null → label null).
  const isGroupConversation =
    (mergedPresenceSource as any)?.type === 'group' ||
    (hydratedConversation as any)?.isGroup === true;
  const cityLocalTimeLabel =
    !isBroadcastReadOnly && !isGroupConversation
      ? formatCityLocalTime(peerTimezone, new Date(nowTick))
      : null;
  // iter-319b: tapping the city/time line shows the full offset vs YOU.
  const onPressCityTime = useCallback(() => {
    const time = formatCityLocalTime(peerTimezone, new Date());
    const diff = formatTimeDifference(peerTimezone, getLocalTimezone(), new Date());
    Alert.alert(
      cityFromTimezone(peerTimezone) || 'Local time',
      [time, diff].filter(Boolean).join('\n') || 'Local time unavailable',
    );
  }, [peerTimezone]);
  const avatarInitial = getDisplayInitials(title);
  // DM-only online state for the header avatar dot (mirrors web). Online if the
  // peer flag is set or they were seen within 2 min; never on groups/broadcast.
  // Filter relationship for the header symbol (direct chats only). Reactive
  // so the indicator appears/updates the moment either side filters.
  const { data: chatFilterState } = useReactiveSafeConvexQuery<any>(
    (api as any).filtering?.isFiltered,
    !isGroupChat && callCalleeId ? { otherUserId: callCalleeId } : {},
    { iFilteredThem: false, theyFilteredMe: false },
    !isGroupChat && callCalleeId.length > 5,
  );

  const headerOnline = (() => {
    if (isBroadcastReadOnly) return false;
    const src: any = mergedPresenceSource;
    if (!src || src?.type === 'group') return false;
    const peer = src?.otherUser || src;
    // Online only if the flag is set AND lastSeen is within 2 min — a stale
    // cached isOnline flag must not keep the header dot lit indefinitely.
    if (peer?.isOnline !== true && peer?.online !== true && src?.isOnline !== true) return false;
    const ls = peer?.lastSeen ?? src?.lastSeen;
    const t = typeof ls === 'number' ? ls : typeof ls === 'string' ? new Date(ls).getTime() : NaN;
    return Number.isFinite(t) && Date.now() - t <= 120000;
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
              <View style={styles.headerTitleRow}>
                <FilterIndicator
                  iFilteredThem={chatFilterState?.iFilteredThem}
                  theyFilteredMe={chatFilterState?.theyFilteredMe}
                  size={15}
                  style={styles.headerFilterIcon}
                />
                <Text style={styles.chatHeaderTitle} numberOfLines={1} testID="chat-header-title">{title}</Text>
              </View>
              {cityLocalTimeLabel ? (
                <TouchableOpacity onPress={onPressCityTime} hitSlop={6} testID="chat-header-citytime-btn" activeOpacity={0.6}>
                  <Text style={styles.chatHeaderCityTime} numberOfLines={1} testID="chat-header-citytime">
                    {cityLocalTimeLabel}
                  </Text>
                </TouchableOpacity>
              ) : null}
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
              const callee = callCalleeId ? String(callCalleeId) : '';
              const callerName = String((me as any)?.name || (me as any)?.displayName || '');
              startCall({
                router,
                callerIdentity: String(me?._id || ''),
                callerDisplayName: callerName,
                callerPhone: String((me as any)?.phoneE164 || (me as any)?.phone || ''),
                calleeIdentities: callee ? [callee] : [],
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
              const callee = callCalleeId ? String(callCalleeId) : '';
              const callerName = String((me as any)?.name || (me as any)?.displayName || '');
              startCall({
                router,
                callerIdentity: String(me?._id || ''),
                callerDisplayName: callerName,
                callerPhone: String((me as any)?.phoneE164 || (me as any)?.phone || ''),
                calleeIdentities: callee ? [callee] : [],
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
          {pendingEditsCount && pendingEditsCount > 0 ? (
            <TouchableOpacity
              testID="chat-pending-edits-btn"
              onPress={() => setShowPendingEdits(true)}
              style={styles.headerIconButton}
            >
              <Feather name="edit-3" size={20} color={Colors.white} />
              <View style={styles.pendingEditsBadge}>
                <Text style={styles.pendingEditsBadgeText}>
                  {pendingEditsCount > 9 ? '9+' : pendingEditsCount}
                </Text>
              </View>
            </TouchableOpacity>
          ) : null}
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

      {/* iter-336: group pinned post banner — visible to ALL members.
          Admins (and either party in 1:1) get an unpin (✕) affordance. */}
      {pinnedMessage ? (
        <View style={styles.pinnedBanner} testID="chat-pinned-banner">
          <Feather name="bookmark" size={16} color={Colors.primary} />
          <TouchableOpacity
            style={styles.flexOne}
            activeOpacity={0.7}
            onPress={() => jumpToMessage(pinnedMessageId)}
            testID="chat-pinned-banner-jump"
          >
            <Text style={styles.pinnedBannerLabel}>Pinned message</Text>
            <Text style={styles.pinnedBannerText} numberOfLines={1}>
              {(() => {
                const p = pinnedMessage.message || pinnedMessage;
                const t = stripRichTextTags(p?.text);
                if (t) return t;
                return previewForMessageType(p?.type, typeof p?.text === 'string' ? p.text : null);
              })()}
            </Text>
          </TouchableOpacity>
          {canPinMessages ? (
            <TouchableOpacity onPress={onUnpinBanner} hitSlop={10} testID="chat-unpin-btn">
              <Feather name="x" size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

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
        {/* iter-240: incoming "delete for everyone" requests — the message
            owner sees Delete / Decline, mirroring the web app. */}
        {deletionRequestsForChat.length > 0 ? (
          <View style={styles.deletionReqBanner} testID="deletion-request-banner">
            <View style={styles.deletionReqInfo}>
              <Feather name="trash-2" size={15} color={Colors.tickRed} />
              <Text style={styles.deletionReqText} numberOfLines={2}>
                {deletionRequestsForChat.length === 1
                  ? `Asked you to delete a message${deletionRequestsForChat[0]?.messageText ? `: "${String(deletionRequestsForChat[0].messageText).slice(0, 40)}"` : ''}`
                  : `${deletionRequestsForChat.length} requests to delete messages for everyone`}
              </Text>
            </View>
            <View style={styles.deletionReqActions}>
              <TouchableOpacity
                style={[styles.deletionReqBtn, styles.deletionReqDecline]}
                onPress={() => respondToDeletion(String(deletionRequestsForChat[0]._id), false)}
                testID="deletion-decline-btn"
              >
                <Text style={styles.deletionReqDeclineText}>Decline</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.deletionReqBtn, styles.deletionReqDelete]}
                onPress={() => respondToDeletion(String(deletionRequestsForChat[0]._id), true)}
                testID="deletion-delete-btn"
              >
                <Text style={styles.deletionReqDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        {/* iter-234: offline banner — tells the user they're viewing saved
            (cached) history while there's no connection. */}
        {isOffline ? (
          <View style={styles.offlineBanner} testID="chat-offline-banner">
            <Feather name="wifi-off" size={13} color={Colors.headerBg} />
            <Text style={styles.offlineBannerText}>No internet — showing saved messages</Text>
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
            renderItem={({ item, index }) => (
              <ChatMessageRow
                item={item}
                index={index}
                timeline={timeline}
                recordingByCallId={recordingByCallId}
                setActiveRecording={setActiveRecording}
                router={router}
                me={me}
                effectiveMe={effectiveMe}
                callCalleeId={callCalleeId}
                conversationId={conversationId}
                title={title}
                viewerSuspension={viewerSuspension}
                isBroadcastReadOnly={isBroadcastReadOnly}
                multiSelectIds={multiSelectIds}
                isConversationAvailable={isConversationAvailable}
                setReplyTo={setReplyTo}
                messageInputRef={messageInputRef}
                msgById={msgById}
                jumpToMessage={jumpToMessage}
                jumpHighlightId={jumpHighlightId}
                handleReceiveOnceTombstone={handleReceiveOnceTombstone}
                chatAppearance={chatAppearance}
                e2eeStatus={e2eeStatus}
                isGroupChat={isGroupChat}
                resolveSenderName={resolveSenderName}
                onToggleMultiSelect={onToggleMultiSelect}
                flushOutbox={flushOutbox}
                onLongPressMessage={onLongPressMessage}
                searchTermNorm={searchTermNorm}
                activeMatchTimelineIdx={activeMatchTimelineIdx}
                onToggleMyReaction={onToggleMyReaction}
              />
            )}
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

          {proposingMessageId && isConversationAvailable ? (
            <View style={styles.replyPill} testID="propose-preview-pill">
              <View style={[styles.replyAccent, styles.editAccent]} />
              <View style={styles.flexOne}>
                <Text style={styles.replyLabel}>Suggesting an edit</Text>
                <Text style={styles.replyText} numberOfLines={1}>
                  Tap send to submit for the author's approval
                </Text>
              </View>
              <TouchableOpacity onPress={cancelEdit} hitSlop={10} testID="propose-preview-close">
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
                  style={[styles.composerToolBtn, activeListKind === 'ordered' ? styles.composerToolBtnActive : null]}
                  onPress={() => applyListFormat('numeric')}
                  testID="composer-numbered-list"
                >
                  <Ionicons name="list-outline" size={20} color={activeListKind === 'ordered' ? Colors.primary : Colors.textSecondary} />
                  <Text style={[styles.composerToolBadge, activeListKind === 'ordered' ? styles.composerToolTextActive : null]}>1.</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.composerToolBtn, activeListKind === 'bullet' ? styles.composerToolBtnActive : null]}
                  onPress={() => applyListFormat('bullet')}
                  testID="composer-bullet-list"
                >
                  <Ionicons name="ellipse" size={8} color={activeListKind === 'bullet' ? Colors.primary : Colors.textSecondary} style={styles.composerBulletDot} />
                  <Ionicons name="list-outline" size={20} color={activeListKind === 'bullet' ? Colors.primary : Colors.textSecondary} />
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
          {reviewUri ? (
            <View style={styles.recordingRow}>
              <TouchableOpacity style={styles.recCancelBtn} onPress={discardReview} testID="review-discard">
                <Feather name="trash-2" size={20} color={Colors.danger} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.recPauseBtn}
                onPress={toggleReviewPlay}
                testID="review-play-toggle"
              >
                <Feather name={reviewPlaying ? 'pause' : 'play'} size={20} color={Colors.textPrimary} />
              </TouchableOpacity>
              <View style={styles.recIndicator}>
                <View style={styles.recWaveWrap}>
                  {[10, 16, 22, 14, 20, 26, 18, 12, 24, 15, 21, 13, 17, 23, 11].map((height, index, arr) => {
                    const filled = index / arr.length <= reviewProgress;
                    return (
                      <View
                        key={`rwave-${index}`}
                        style={[
                          styles.recWaveBar,
                          { height },
                          filled ? null : styles.recWaveBarPaused,
                        ]}
                      />
                    );
                  })}
                </View>
                <Text style={styles.recTimer}>
                  {`${Math.floor(reviewDurationSec / 60)}:${(reviewDurationSec % 60).toString().padStart(2, '0')}`}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.recSendBtn}
                onPress={sendReviewedVoice}
                testID="review-send"
                disabled={uploading}
              >
                <Feather name="send" size={20} color={Colors.white} />
              </TouchableOpacity>
            </View>
          ) : isRecording ? (
            <View style={styles.recordingRow}>
              <TouchableOpacity style={styles.recCancelBtn} onPress={cancelRecording} testID="rec-cancel">
                <Feather name="x" size={22} color={Colors.danger} />
              </TouchableOpacity>
              <View style={styles.recIndicator}>
                <View style={styles.recWaveWrap}>
                  {[10, 16, 22, 14, 20, 26, 18, 12, 24, 15, 21, 13].map((height, index) => {
                    // Drive the bars from the REAL mic level (metering, in dB).
                    // If the mic is capturing your voice the bars react; if they
                    // stay flat the microphone isn't being captured. On web
                    // (no metering) fall back to the decorative animation.
                    const m = recorderState.metering;
                    const hasLevel = typeof m === 'number' && Number.isFinite(m);
                    const level = hasLevel ? Math.max(0, Math.min(1, (m + 60) / 55)) : null;
                    const barHeight =
                      level != null
                        ? 4 + Math.round((height / 26) * 30 * Math.max(0.06, level))
                        : height + ((recDuration + index) % 3) * 3;
                    return (
                      <View
                        key={`wave-${index}`}
                        style={[
                          styles.recWaveBar,
                          { height: barHeight },
                          isRecordingPaused ? styles.recWaveBarPaused : null,
                        ]}
                      />
                    );
                  })}
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
                selection={pendingImages.length > 0 ? undefined : forcedSelection}
                onSelectionChange={(e) => {
                  const sel = e.nativeEvent.selection;
                  composerSelectionRef.current = sel;
                  setActiveListKind(currentLineListKind(text, sel.start));
                  // Release the one-shot controlled selection once applied so
                  // the user can move the caret freely afterwards.
                  if (forcedSelection) setForcedSelection(undefined);
                }}
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
              await reactToMessage(reactionTargetMsg._id, emoji);
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
        canEdit={
          !!(
            (selectedMsg?.type === 'text' || !selectedMsg?.type) &&
            (isMineSelected || selectedMsg?.editMode === 'open')
          )
        }
        canSetEditMode={
          !!(
            isMineSelected &&
            conversation?.type === 'group' &&
            (selectedMsg?.type === 'text' || !selectedMsg?.type)
          )
        }
        canSuggestEdit={
          !!(
            !isMineSelected &&
            conversation?.type === 'group' &&
            selectedMsg?.editMode === 'approval' &&
            (selectedMsg?.type === 'text' || !selectedMsg?.type)
          )
        }
        suggestPending={!!myPendingForSelected}
        canPin={canPinMessages}
        isPinned={!!pinnedMessageId && pinnedMessageId === String(selectedMsg?._id || '')}
        onClose={closeActionSheet}
        onPickReaction={onPickReaction}
        onReply={onReply}
        onCopy={onCopy}
        onEdit={onEdit}
        onWhoCanEdit={onWhoCanEdit}
        onSuggestEdit={onSuggestEdit}
        onForward={onForward}
        onShare={onShare}
        onSelectMultiple={onSelectMultiple}
        onStar={onStar}
        onPin={onPin}
        onMoreReactions={onMoreReactions}
        onMessageInfo={onMessageInfo}
        onDelete={onDelete}
      />

      <EditPermissionModals
        editModeTarget={editModeTarget}
        onCloseEditMode={() => setEditModeTarget(null)}
        onApplyEditMode={applyEditMode}
        showPendingEdits={showPendingEdits}
        onClosePendingEdits={() => setShowPendingEdits(false)}
        pendingEditsList={pendingEditsList}
        onReviewEdit={handleReviewEdit}
      />

      {/* iter-292: rich Message Info sheet — Read by + media consumption
          (Played/Watched/Viewed/Opened by), mirroring the web app. */}
      <MessageInfoSheet
        visible={!!infoMsg}
        message={infoMsg}
        recipientCount={Math.max(0, (conversation?.participants?.length || conversation?.memberCount || 2) - 1)}
        onClose={() => setInfoMsg(null)}
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
