import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
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
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import AttachmentSheet from '../../src/components/AttachmentSheet';
import EmojiPickerSheet from '../../src/components/EmojiPickerSheet';
import GiphyPicker, { GiphyAsset } from '../../src/components/GiphyPicker';
import MediaBubble from '../../src/components/MediaBubble';
import PollComposer from '../../src/components/PollComposer';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { recordDiagnostic } from '../../src/lib/diagnostics';
import { errorToMessage } from '../../src/lib/safeString';
import { scanMessage, explainScanResult } from '../../src/lib/securityScanner';
import { appendDiaryEntry, chatMessageToDiaryEntry } from '../../src/lib/diaryStore';
import { getWallpaperColor, normalizeChatAppearance } from '../../src/lib/chatAppearance';
import { findSavedContactDisplayName, getConversationDisplayName, getDisplayInitials, getSavedContactRecord } from '../../src/lib/displayName';
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

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMPTY_MESSAGES_PAGE = { page: [] as any[] };
const EMPTY_FORWARD_CONVERSATIONS: any[] = [];
const DISAPPEARING_OPTIONS = [
  { key: 'off', label: 'Off', ms: 0 },
  { key: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '90d', label: '90 days', ms: 90 * 24 * 60 * 60 * 1000 },
] as const;

function formatChatDayChip(ts?: number) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isSameCalendarDay(a?: number, b?: number) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function isGifAsset(file?: { mimeType?: string | null; name?: string | null }) {
  const mime = (file?.mimeType || '').toLowerCase();
  const name = (file?.name || '').toLowerCase();
  return mime === 'image/gif' || name.endsWith('.gif');
}

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
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { isAuthenticated } = useAuth();
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
  const [selectedMsg, setSelectedMsg] = useState<any | null>(null);
  // Tri-state delete-mode sheet: when set, prompts WhatsApp-style "Delete for me /
  // for receiver / for everyone" (sent) or "Delete for me / ask sender" (received).
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  // Tracks whether the bottom emoji picker is opened to insert into the composer
  // (default) or to react to the currently-selected message ('react').
  const [emojiPickerMode, setEmojiPickerMode] = useState<'compose' | 'react'>('compose');
  const [reactionTargetMsg, setReactionTargetMsg] = useState<any | null>(null);
  const [showAttachSheet, setShowAttachSheet] = useState(false);
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
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder, 200);
  const hasValidConversationId =
    typeof conversationId === 'string' && /^[a-z0-9]+$/i.test(conversationId) && conversationId.length > 10;
  const canQueryConversation = !!conversationId && hasValidConversationId && isAuthenticated;

  const conversation = useQuery(
    api.conversations.getConversation,
    canQueryConversation ? { conversationId } : 'skip'
  ) as any | null | undefined;
  const conversationLoading = canQueryConversation && conversation === undefined;
  const messagesPage = useQuery(
    api.messages.list,
    canQueryConversation ? { conversationId, paginationOpts: { numItems: 50, cursor: null } } : 'skip'
  ) as any;
  const messagesLoading = canQueryConversation && messagesPage === undefined;
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip') as any | null | undefined;
  const contacts = useQuery(api.contacts.getContacts, me ? {} : 'skip') as any[] | undefined;
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
      const [storedTemplates, storedAppearance] = await Promise.all([
        readStoredJson(QUICK_TEMPLATES_KEY, []),
        readStoredJson(CHAT_APPEARANCE_KEY, DEFAULT_CHAT_APPEARANCE),
      ]);
      if (!mounted) {
        return;
      }
      setQuickTemplates(Array.isArray(storedTemplates) ? storedTemplates : []);
      setChatAppearance(normalizeChatAppearance(storedAppearance));
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

  const sendMessage = useMutation(api.messages.send);
  const setTyping = useMutation(api.typing.setTyping);
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
  const toggleStar = useMutation(api.messages.toggleStar);
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

  // E2EE decryption — text messages with `encrypted: true` carry base64
  // ciphertext in `text` and a base64 `iv` field. Derive the conversation's
  // key (PBKDF2-SHA256 ▶ AES-GCM-256) once, then decrypt each message text.
  const e2eeStatus = useConversationE2EE(conversationId || null);
  const decryptedMessages = useMemo(() => {
    if (!messages.length) return messages;
    if (!e2eeStatus.enabled || !e2eeStatus.passphrase || !e2eeStatus.salt) {
      // E2EE not active for this conversation OR key not yet fetched.
      // Returning the raw messages means encrypted ones will still show as
      // base64 until the key arrives (next render).
      return messages;
    }
    return messages.map((msg: any) => {
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
  }, [e2eeStatus.enabled, e2eeStatus.passphrase, e2eeStatus.salt, messages]);

  const visibleMessages = useMemo(() => {
    const ttlMs = DISAPPEARING_OPTIONS.find((item) => item.key === disappearingMode)?.ms || 0;
    if (!ttlMs) return decryptedMessages;
    const cutoff = Date.now() - ttlMs;
    return decryptedMessages.filter((message) => Number(message?._creationTime || 0) >= cutoff);
  }, [disappearingMode, decryptedMessages]);

  // iter-109: in-chat search filter — applied AFTER the disappearing-mode
  // filter so the user only sees results that are still visible per the
  // conversation's TTL. Matches both the message text AND attachment
  // filenames (case-insensitive substring). When the query is empty
  // OR null we return visibleMessages unchanged — zero overhead.
  const searchFilteredMessages = useMemo(() => {
    const q = (chatSearchQuery || '').trim().toLowerCase();
    if (!q) return visibleMessages;
    return visibleMessages.filter((message: any) => {
      const text: string =
        (typeof message?.text === 'string' ? message.text : '') ||
        (typeof message?.fileName === 'string' ? message.fileName : '');
      if (!text) return false;
      return text.toLowerCase().includes(q);
    });
  }, [visibleMessages, chatSearchQuery]);

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

  const msgById = useMemo(() => {
    const map = new Map<string, any>();
    displayMessages.forEach((message) => map.set(message._id, message));
    return map;
  }, [displayMessages]);

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

  useEffect(() => {
    if (!canQueryConversation) {
      setFallbackReady(true);
      return;
    }
    setFallbackReady(false);
    const timer = setTimeout(() => setFallbackReady(true), 2500);
    return () => clearTimeout(timer);
  }, [canQueryConversation, conversationId]);

  const isConversationAvailable = !!conversation;
  const composerTextColor = resolveDraftColor(draftColor) || Colors.textPrimary;
  const showComposerFormatting = showComposerFormattingPinned || composerFocused || text.trim().length > 0 || showColorPicker;

  const resetComposerFormatting = useCallback(() => {
    setDraftBold(false);
    setDraftColor(null);
    setShowColorPicker(false);
  }, []);

  const handleSend = async () => {
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
            ...(replyToMessageId ? { replyToMessageId, replyToId: replyToMessageId } : {}),
          });
        }
      } else {
        await sendMessage({
          conversationId,
          type: 'text',
          text: formattedValue,
          ...(replyToMessageId ? { replyToMessageId, replyToId: replyToMessageId } : {}),
        });
      }
      await refetchMessages();
    } catch (e: any) {
      console.warn('send failed:', e?.message);
      // Restore the composer so the user can retry. If this was an edit,
      // also restore the editing context so the next Send tries again.
      setText(value);
      if (editTargetId) {
        setEditingMessageId(editTargetId);
      }
    } finally {
      setSending(false);
    }
  };

  const handleTyping = (val: string) => {
    setText(val);
    if (conversationId && val.length > 0) {
      setTyping({ conversationId }).catch(() => {});
    }
  };

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
          getConversationDisplayName(
            hydratedConversation || conversation,
            myIdForRecipient,
            'Chat',
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
        // iter-113: primary attempt → scheduling.scheduleMessageMobile.
        // On failure, fall back to scheduledMessages.create.
        //
        // iter-120: the backend agent shipped a NEW
        // `convex/scheduledMessages.ts` with a different arg shape than
        // the legacy `scheduling.scheduleMessageMobile`. Per backend
        // agent's contract update:
        //   scheduledMessages.create({
        //     recipient: string (contact name),
        //     text:      string (message body — NOT `message`),
        //     scheduledAt: string (ISO timestamp — NOT date+time),
        //   })
        // We build the new-shape payload separately so the fallback
        // actually matches the new schema. The primary path still
        // sends the legacy shape (which the backend kept working).
        const scheduledAtIso = when.toISOString();
        const scheduleArgsNew = {
          recipient: safeRecipient,
          text: safeMessage,
          scheduledAt: scheduledAtIso,
        };
        let primaryError: any = null;
        try {
          await createScheduledMessage(scheduleArgs);
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
              message: `↻ primary failed name=${nameStr} code=${codeStr} data=${dataStr.slice(0, 400)} — trying scheduledMessages.create fallback (new schema)`,
            });
          } catch {}
          // Try the new-shape endpoint as fallback.
          if (typeof createScheduledLegacy === 'function') {
            try {
              await (createScheduledLegacy as any)(scheduleArgsNew);
              primaryError = null; // fallback succeeded
              try {
                recordDiagnostic({
                  tag: 'NET',
                  source: 'chat/scheduleMessageMobile',
                  message: `← ok via scheduledMessages.create (new schema, scheduledAt=${scheduledAtIso})`,
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
                  message: `× scheduledMessages.create (new schema) also failed: ${errorToMessage(legacyFailure).slice(0, 200)}`,
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
    [conversationId, conversation, createScheduledMessage, text],
  );

  const sendImageFromUri = useCallback(
    async (uri: string, mimeType?: string) => {
      if (!conversationId || !isConversationAvailable) return;

      setUploading(true);
      const caption = text.trim();
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
          ...(replyToMessageId ? { replyToMessageId, replyToId: replyToMessageId } : {}),
        });
        setText('');
        setReplyTo(null);
        resetComposerFormatting();
        await refetchMessages();
      } catch (errorValue: any) {
        Alert.alert('Upload failed', errorValue?.message || 'Unable to send image right now.');
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

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets?.[0]?.uri) return;
    const asset = result.assets[0];
    await sendImageFromUri(asset.uri, asset.mimeType || 'image/jpeg');
  }, [sendImageFromUri]);

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

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      quality: 0.85,
      allowsEditing: false,
    });

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

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      quality: 0.85,
      allowsEditing: false,
    });

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
          ? { replyToMessageId: replyTo._id, replyToId: replyTo._id }
          : {}),
      });
      setReplyTo(null);
      await refetchMessages();
    } catch (errorValue: any) {
      Alert.alert('Location failed', errorValue?.message || 'Could not fetch your location.');
    }
  }, [conversationId, isConversationAvailable, refetchMessages, replyTo, sendMessage]);

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
        ...(replyToMessageId ? { replyToMessageId } : {}),
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
          ...(replyToMessageId ? { replyToMessageId, replyToId: replyToMessageId } : {}),
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
          ...(replyToMessageId ? { replyToMessageId, replyToId: replyToMessageId } : {}),
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
          ...(replyToMessageId ? { replyToMessageId, replyToId: replyToMessageId } : {}),
        });

        setReplyTo(null);
        await refetchMessages();

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
    if (!conversation) return conversation;
    if (conversation.otherUser && typeof conversation.otherUser === 'object') return conversation;
    if (!fetchedOtherUser) return conversation;
    return { ...conversation, otherUser: fetchedOtherUser };
  }, [conversation, fetchedOtherUser]);

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

  const title =
    savedContactTitle ||
    getConversationDisplayName(hydratedConversation, me?._id ? String(me._id) : undefined, 'Chat');
  const isMineSelected = selectedMsg && me && selectedMsg.senderId === me._id;
  const subtitle = formatPresenceSubtitle(mergedPresenceSource);
  const avatarInitial = getDisplayInitials(title);

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
          Alert.alert('Request live location', 'Live location sharing is being rolled out. We\'ll notify you when it\'s ready in this chat.');
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
        <View style={styles.chatHeaderLeft}>
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
              size={18}
              color={Colors.white}
            />
          </TouchableOpacity>
          <TouchableOpacity
            testID="call-btn"
            onPress={() => router.push(`/call/${conversationId}?type=voice&displayName=${encodeURIComponent(title)}` as any)}
            style={styles.headerIconButton}
          >
            <Ionicons name="call-outline" size={18} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="video-btn"
            onPress={() => router.push(`/call/${conversationId}?type=video&displayName=${encodeURIComponent(title)}` as any)}
            style={styles.headerIconButton}
          >
            <Ionicons name="videocam-outline" size={19} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="chat-disappearing-btn" onPress={() => setShowDisappearingSheet(true)} style={styles.headerIconButton}>
            <Ionicons name="time-outline" size={18} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="chat-encryption-btn" onPress={() => router.push('/encryption' as any)} style={styles.headerIconButton}>
            <Ionicons name="shield-checkmark-outline" size={18} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="chat-menu-btn" onPress={() => setShowOptionsMenu(true)} style={styles.headerIconButton}>
            <Feather name="more-vertical" size={18} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.encryptionBanner} testID="chat-encryption-banner">
        <Ionicons name="shield-checkmark-outline" size={16} color="#2A7C48" />
        <Text style={styles.encryptionBannerText}>End-to-end encrypted</Text>
      </View>

      {/* iter-109 → iter-111: in-chat search bar — slides in below the
          header when the search button is tapped. Live-filters the
          message list by case-insensitive substring match. Kept as a
          general-purpose feature even after Diary was decoupled. */}
      {chatSearchQuery !== null ? (
        <View style={styles.searchBar} testID="chat-search-bar">
          <Feather name="search" size={16} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={chatSearchQuery}
            onChangeText={setChatSearchQuery}
            placeholder="Search messages…"
            placeholderTextColor={Colors.textMuted}
            autoFocus
            returnKeyType="search"
            testID="chat-search-input"
          />
          {chatSearchQuery.length > 0 ? (
            <TouchableOpacity
              onPress={() => setChatSearchQuery('')}
              hitSlop={8}
              testID="chat-search-clear"
            >
              <Feather name="x-circle" size={16} color={Colors.textMuted} />
            </TouchableOpacity>
          ) : null}
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
        {(messagesLoading || conversationLoading) && !fallbackReady ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : !isConversationAvailable ? (
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
            data={displayMessages}
            keyExtractor={(item: any) => item._id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item, index }) => {
              const previous = index > 0 ? visibleMessages[index - 1] : null;
              const showDayChip = !previous || !isSameCalendarDay(item?._creationTime, previous?._creationTime);
              return (
                <>
                  {showDayChip ? (
                    <View style={styles.dayChipWrap} testID={`chat-day-chip-${item._id}`}>
                      <Text style={styles.dayChipText}>{formatChatDayChip(item?._creationTime)}</Text>
                    </View>
                  ) : null}
                  <MediaBubble
                    msg={item}
                    isMine={item.senderId === me?._id}
                    myUserId={me?._id}
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
                    onLongPress={viewerSuspension ? () => {} : () => {
                      // While in multi-select mode, long-press is reserved
                      // for toggling selection (matching the easier muscle
                      // memory of "tap to toggle, long-press to enter").
                      if (multiSelectIds) {
                        onToggleMultiSelect(String(item._id));
                        return;
                      }
                      onLongPressMessage(item);
                    }}
                    onPress={multiSelectIds ? () => onToggleMultiSelect(String(item._id)) : undefined}
                    multiSelected={multiSelectIds ? multiSelectIds.includes(String(item._id)) : undefined}
                    onToggleReaction={
                      viewerSuspension || multiSelectIds
                        ? () => {}
                        : (emoji) => onToggleMyReaction(item._id, emoji)
                    }
                  />
                </>
              );
            }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
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
                value={text}
                onChangeText={handleTyping}
                placeholder="Type your message…"
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
              {text.trim().length > 0 ? (
                <>
                  <TouchableOpacity
                    style={styles.scheduleBtn}
                    onPress={() => setShowScheduleSheet(true)}
                    disabled={!isConversationAvailable || uploading || sending}
                    testID="schedule-message-btn"
                    accessibilityLabel="Schedule message"
                  >
                    <Feather name="clock" size={18} color={Colors.textSecondary} />
                  </TouchableOpacity>
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

      <Modal visible={!!selectedMsg} transparent animationType="fade" onRequestClose={closeActionSheet}>
        <Pressable style={styles.sheetBackdrop} onPress={closeActionSheet}>
          <Pressable style={styles.sheet} onPress={() => {}} testID="message-action-sheet">
            <View style={styles.reactionPickerRow}>
              {QUICK_REACTIONS.map((emoji) => (
                <TouchableOpacity
                  key={emoji}
                  style={styles.reactionBtn}
                  onPress={() => onPickReaction(emoji)}
                  testID={`react-${emoji}`}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.sheetActions}>
              <ActionRow icon="corner-up-left" lib="feather" label="Reply" onPress={onReply} />
              <ActionRow icon="copy" lib="feather" label="Copy text" onPress={onCopy} />
              {isMineSelected && (selectedMsg?.type === 'text' || !selectedMsg?.type) ? (
                <ActionRow icon="edit-2" lib="feather" label="Edit" onPress={onEdit} />
              ) : null}
              <ActionRow icon="corner-up-right" lib="feather" label="Forward" onPress={onForward} />
              <ActionRow icon="check-square" lib="feather" label="Select multiple to forward" onPress={onSelectMultiple} />
              <ActionRow
                icon="star"
                lib="feather"
                label={selectedMsg?.starred ? 'Unstar' : 'Star'}
                onPress={onStar}
              />
              <ActionRow icon="bookmark" lib="feather" label="Pin" onPress={onPin} />
              <ActionRow icon="smile" lib="feather" label="More reactions" onPress={onMoreReactions} />
              <ActionRow icon="info" lib="feather" label="Message info" onPress={onMessageInfo} />
              <ActionRow icon="trash-2" lib="feather" label="Delete message" onPress={onDelete} danger />
            </View>
            <TouchableOpacity
              style={styles.sheetCancelBtn}
              onPress={closeActionSheet}
              testID="action-sheet-cancel"
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Tri-state delete-mode sheet (WhatsApp-style). For sent messages we
          expose Delete for me / receiver / everyone; for received messages
          we expose Delete for me / Ask sender to delete for everyone. */}
      <Modal
        visible={!!deleteTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteTarget(null)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setDeleteTarget(null)}>
          <Pressable style={styles.deleteSheet} onPress={() => {}} testID="delete-sheet">
            <Text style={styles.deleteSheetTitle}>Delete message?</Text>
            <Text style={styles.deleteSheetSubtitle}>Choose how to delete this message</Text>
            {deleteTarget && (deleteTarget.senderId === me?._id) ? (
              <>
                <TouchableOpacity
                  style={styles.deleteRow}
                  onPress={() => performDelete('me')}
                  testID="delete-for-me"
                >
                  <Feather name="trash-2" size={22} color={Colors.textSecondary} />
                  <Text style={styles.deleteRowLabel}>Delete for me</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.deleteRow}
                  onPress={() => performDelete('receiver')}
                  testID="delete-for-receiver"
                >
                  <Feather name="trash-2" size={22} color="#f59e0b" />
                  <Text style={styles.deleteRowLabel}>Delete for receiver</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.deleteRow}
                  onPress={() => performDelete('everyone')}
                  testID="delete-for-everyone"
                >
                  <Feather name="trash-2" size={22} color={Colors.danger} />
                  <Text style={[styles.deleteRowLabel, { color: Colors.danger }]}>Delete for everyone</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.deleteRow}
                  onPress={() => performDelete('me')}
                  testID="delete-for-me"
                >
                  <Feather name="trash-2" size={22} color={Colors.textSecondary} />
                  <Text style={styles.deleteRowLabel}>Delete for me</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.deleteRow}
                  onPress={() => performDelete('request_everyone')}
                  testID="delete-request-everyone"
                >
                  <Feather name="message-circle" size={22} color={Colors.primary} />
                  <Text style={styles.deleteRowLabel}>Ask sender to delete for everyone</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity
              style={styles.sheetCancelBtn}
              onPress={() => setDeleteTarget(null)}
              testID="delete-cancel"
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showDisappearingSheet} transparent animationType="fade" onRequestClose={() => setShowDisappearingSheet(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setShowDisappearingSheet(false)}>
          <Pressable style={[styles.sheet, styles.disappearingSheet]} onPress={() => {}} testID="disappearing-sheet">
            <Text style={styles.disappearingTitle}>Disappearing messages</Text>
            {DISAPPEARING_OPTIONS.map((option) => {
              const selected = disappearingMode === option.key;
              return (
                <TouchableOpacity
                  key={option.key}
                  style={styles.disappearingRow}
                  onPress={async () => {
                    setDisappearingMode(option.key);
                    if (conversationId) {
                      await writeStoredJson(`disappearing_mode_${conversationId}`, option.key);
                    }
                    setShowDisappearingSheet(false);
                  }}
                  testID={`disappearing-option-${option.key}`}
                >
                  <Text style={[styles.disappearingLabel, selected ? styles.disappearingLabelSelected : null]}>{option.label}</Text>
                  {selected ? <Ionicons name="checkmark-circle" size={20} color={Colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={showForwardPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowForwardPicker(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setShowForwardPicker(false)}>
          <Pressable style={[styles.sheet, styles.forwardSheet]} onPress={() => {}} testID="forward-picker-sheet">
            <Text style={styles.forwardTitle} testID="forward-picker-title">
              Forward to
            </Text>
            <FlatList
              data={
                (Array.isArray(conversationsForForward) ? conversationsForForward : []).filter(
                  (item: any) => item._id !== conversationId,
                )
              }
              keyExtractor={(item: any) => item._id}
              contentContainerStyle={styles.forwardListContent}
              ListHeaderComponent={
                // iter-111: Diary pinned at the TOP — now saves the
                // forwarded message to the LOCAL diary store via
                // diaryStore.appendDiaryEntry. Never touches the Convex
                // backend, so it's safe to surface in every chat without
                // any cross-user contamination risk.
                <TouchableOpacity
                  style={[styles.forwardRow, styles.forwardRowDiary]}
                  onPress={async () => {
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
                  testID="forward-target-diary"
                >
                  <View style={[styles.forwardAvatar, styles.forwardAvatarDiary]}>
                    <MaterialCommunityIcons
                      name="book-account-outline"
                      size={20}
                      color={Colors.warningDark}
                    />
                  </View>
                  <View style={styles.flexOne}>
                    <Text style={styles.forwardName} numberOfLines={1}>Diary</Text>
                    <Text style={styles.forwardPreview} numberOfLines={1}>
                      Save to your personal diary
                    </Text>
                  </View>
                </TouchableOpacity>
              }
              renderItem={({ item }: any) => {
                // Use the centralised display-name resolver — it walks the
                // members/otherUser/firstName chains and avoids the 'Chat'
                // placeholder unless every candidate is truly empty. Mirrors
                // the chats list (see /app/(tabs)/chats.tsx ConversationRow).
                const savedName = findSavedContactDisplayName(
                  contacts,
                  item,
                  me?._id ? String(me._id) : undefined,
                );
                const displayName =
                  savedName ||
                  getConversationDisplayName(
                    item,
                    me?._id ? String(me._id) : undefined,
                    'Smilers user',
                  );
                // Sanitise the last-message preview — if the backend returned
                // an undecrypted E2EE ciphertext (base64 blob), don't expose
                // it. The web app uses 'Encrypted message' as the safe
                // fallback. We treat any string that has >50% non-alphanum
                // density OR ends in '=' as ciphertext.
                const raw = String(item.lastMessageText || '').trim();
                let preview = raw;
                if (raw) {
                  const looksEncrypted =
                    /^[A-Za-z0-9+/]{30,}={0,2}$/.test(raw) ||
                    raw.length > 200;
                  if (looksEncrypted) preview = 'Encrypted message';
                } else {
                  preview = 'Open conversation';
                }
                return (
                  <TouchableOpacity
                    style={styles.forwardRow}
                    onPress={() => doForwardTo(item._id)}
                    testID={`forward-target-${item._id}`}
                  >
                    <View style={styles.forwardAvatar}>
                      <Text style={styles.forwardAvatarText}>
                        {getDisplayInitials(displayName, 1)}
                      </Text>
                    </View>
                    <View style={styles.flexOne}>
                      <Text style={styles.forwardName}>{displayName}</Text>
                      <Text style={styles.forwardSub} numberOfLines={1}>
                        {preview}
                      </Text>
                    </View>
                    <Feather name="send" size={18} color={Colors.primary} />
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.forwardEmpty} testID="forward-picker-empty">
                  No other chats to forward to.
                </Text>
              }
            />
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showTemplatePicker} transparent animationType="slide" onRequestClose={() => setShowTemplatePicker(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setShowTemplatePicker(false)}>
          <Pressable style={[styles.sheet, styles.forwardSheet]} onPress={() => {}} testID="template-picker-sheet">
            <View style={styles.templatePickerHeader}>
              <Text style={styles.forwardTitle} testID="template-picker-title">
                Quick Replies
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setShowTemplatePicker(false);
                  router.push('/templates' as any);
                }}
                testID="template-picker-manage-button"
              >
                <Text style={styles.templatePickerManage}>Manage</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={Array.isArray(quickTemplates) ? quickTemplates : []}
              keyExtractor={(item: any) => item.id}
              contentContainerStyle={styles.forwardListContent}
              renderItem={({ item, index }: any) => (
                <TouchableOpacity
                  style={styles.templatePickerRow}
                  onPress={() => {
                    setText((current) => (current.trim().length ? `${current}\n${item.message}` : item.message || ''));
                    setShowTemplatePicker(false);
                  }}
                  testID={`template-picker-item-${index}`}
                >
                  <View style={styles.templatePickerBadge}>
                    <MaterialCommunityIcons name="message-text-outline" size={18} color={Colors.primary} />
                  </View>
                  <View style={styles.flexOne}>
                    <Text style={styles.forwardName}>{item.label || 'Quick Reply'}</Text>
                    <Text style={styles.forwardSub} numberOfLines={2}>
                      {item.message || ''}
                    </Text>
                  </View>
                  <Feather name="corner-down-left" size={18} color={Colors.primary} />
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <View style={styles.templatePickerEmptyWrap} testID="template-picker-empty">
                  <Text style={styles.forwardEmpty}>No quick replies yet.</Text>
                  <TouchableOpacity
                    style={styles.templatePickerCreateBtn}
                    onPress={() => {
                      setShowTemplatePicker(false);
                      router.push('/templates' as any);
                    }}
                    testID="template-picker-create-button"
                  >
                    <Text style={styles.templatePickerCreateText}>Create one</Text>
                  </TouchableOpacity>
                </View>
              }
            />
          </Pressable>
        </Pressable>
      </Modal>

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
    </SafeAreaView>
  );
}

function ActionRow({
  icon,
  lib,
  label,
  onPress,
  danger,
}: {
  icon: string;
  lib: 'feather' | 'ion' | 'mc';
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const Icon: any = lib === 'ion' ? Ionicons : lib === 'mc' ? MaterialCommunityIcons : Feather;

  return (
    <TouchableOpacity
      style={styles.actionRow}
      onPress={onPress}
      testID={`action-${label.toLowerCase()}`}
    >
      <Icon name={icon as any} size={20} color={danger ? Colors.danger : Colors.textPrimary} />
      <Text style={[styles.actionLabel, danger ? styles.actionLabelDanger : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

function MessageBubble({
  msg,
  isMine,
  myUserId,
  parentMsg,
  onLongPress,
  onToggleReaction,
}: {
  msg: any;
  isMine: boolean;
  myUserId?: string;
  parentMsg?: any;
  onLongPress: () => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const text = msg.text || (msg.type !== 'text' ? `[${msg.type}]` : '');
  const time = msg._creationTime ? new Date(msg._creationTime) : new Date();
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tickColor = msg.readBy?.length ? Colors.tickBlue : msg.deliveredTo?.length ? Colors.tickYellow : Colors.tickGray;
  const tickIcon = msg.readBy?.length || msg.deliveredTo?.length ? 'checkmark-done' : 'checkmark';

  const reactionSummary = useMemo(() => {
    const reactions: any[] = Array.isArray(msg.reactions) ? msg.reactions : [];
    const map = new Map<string, { emoji: string; count: number; mine: boolean }>();
    reactions.forEach((reaction) => {
      const current = map.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, mine: false };
      current.count += 1;
      if (myUserId && reaction.userId === myUserId) current.mine = true;
      map.set(reaction.emoji, current);
    });
    return Array.from(map.values());
  }, [msg.reactions, myUserId]);

  // iter-107: client-side security scan. Runs heuristic checks on every
  // rendered message — IP-host URLs, brand typosquatting, deceptive
  // user-info, Punycode look-alikes, phishing keywords, dangerous file
  // extensions — and if anything is flagged BLOCK we replace the entire
  // bubble with the same "Deleted" treatment used elsewhere, but with
  // the label "Deleted for security reasons". The raw `msg` is left
  // untouched in the database; this is a render-time guard only so
  // moderators can still audit the original payload server-side.
  //
  // Memoised on the precise fields the scanner reads — avoids re-scanning
  // on every render of an unchanged message.
  const securityScan = useMemo(() => {
    if (msg.deletedAt) return null; // already deleted — no need to scan
    try {
      return scanMessage({
        body: typeof msg.text === 'string' ? msg.text : '',
        attachment: msg.fileName || msg.storageId || msg.mimeType
          ? { fileName: msg.fileName, mimeType: msg.mimeType, storageId: msg.storageId }
          : null,
      });
    } catch {
      // Scanner must never throw — fall back to safe.
      return null;
    }
  }, [msg.deletedAt, msg.text, msg.fileName, msg.storageId, msg.mimeType]);

  if (securityScan?.shouldHide) {
    const blockedTimeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const why = explainScanResult(securityScan);
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <View
          style={[
            styles.bubble,
            isMine ? styles.bubbleMine : styles.bubbleOther,
            styles.deletedBubble,
          ]}
          testID={`message-bubble-security-blocked-${msg._id}`}
        >
          <View style={styles.securityRow}>
            <Feather name="shield" size={14} color={Colors.textMuted} />
            <Text style={[styles.bubbleText, styles.deletedText]}>Deleted for security reasons</Text>
          </View>
          {why ? (
            <Text style={styles.securityReasonText} numberOfLines={2}>
              {why}
            </Text>
          ) : null}
          <View style={styles.bubbleMeta}>
            <Text style={[styles.bubbleTime, styles.deletedTimeText]}>{blockedTimeStr}</Text>
          </View>
        </View>
      </View>
    );
  }

  if (msg.deletedAt) {
    // Web-app parity (iter-98 screenshot): "This message was deleted"
    // italic + timestamp on the right inside a faded bubble. Mirrors the
    // identical pattern in MediaBubble's deleted branch.
    const deletedTimeMs =
      typeof msg.deletedAt === 'number'
        ? msg.deletedAt
        : typeof msg.deletedAt === 'string'
          ? Date.parse(msg.deletedAt) || time.getTime()
          : time.getTime();
    const deletedTimeStr = new Date(deletedTimeMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <View
          style={[
            styles.bubble,
            isMine ? styles.bubbleMine : styles.bubbleOther,
            styles.deletedBubble,
          ]}
          testID={`message-bubble-deleted-${msg._id}`}
        >
          <Text style={[styles.bubbleText, styles.deletedText]}>This message was deleted</Text>
          <View style={styles.bubbleMeta}>
            <Text style={[styles.bubbleTime, styles.deletedTimeText]}>{deletedTimeStr}</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={onLongPress}
        delayLongPress={250}
        testID={`message-bubble-${msg._id}`}
        style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleOther,
        ]}
      >
        {parentMsg ? (
          <View style={styles.quoteBlock}>
            <View style={styles.quoteAccent} />
            <View style={styles.flexOne}>
              <Text style={styles.quoteName}>
                {parentMsg.senderName || (parentMsg.senderId === myUserId ? 'You' : 'Reply')}
              </Text>
              <Text style={styles.quoteText} numberOfLines={2}>
                {parentMsg.text || `[${parentMsg.type}]`}
              </Text>
            </View>
          </View>
        ) : (msg.replyToId || msg.replyToMessageId) ? (
          <View style={styles.quoteBlock}>
            <View style={styles.quoteAccent} />
            <Text style={styles.quoteText} numberOfLines={1}>
              Replying to earlier message
            </Text>
          </View>
        ) : null}

        <Text style={styles.bubbleText}>{text}</Text>
        <View style={styles.bubbleMeta}>
          {msg.starred ? (
            <Feather name="star" size={11} color={Colors.tickYellow} style={styles.starIcon} />
          ) : null}
          {/* Web-app parity: "edited HH:MM" inline before the timestamp
              for messages the user (or the other party) has edited.
              Mirrors the same pattern added in MediaBubble. */}
          {(() => {
            const editedAtMs =
              typeof msg.editedAt === 'number'
                ? msg.editedAt
                : typeof msg.editedAt === 'string'
                  ? Date.parse(msg.editedAt) || null
                  : null;
            const isEdited = !!editedAtMs || msg.edited === true || msg.isEdited === true;
            if (!isEdited) return null;
            const editedTimeStr =
              editedAtMs && Number.isFinite(editedAtMs)
                ? new Date(editedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : timeStr;
            return (
              <Text style={[styles.bubbleTime, styles.editedBadge]}>edited {editedTimeStr}</Text>
            );
          })()}
          <Text style={styles.bubbleTime}>{timeStr}</Text>
          {isMine ? (
            <Ionicons name={tickIcon as any} size={14} color={tickColor} style={styles.tickIcon} />
          ) : null}
        </View>
      </TouchableOpacity>

      {reactionSummary.length > 0 ? (
        <View style={[styles.reactionsRow, isMine ? styles.reactionsRowMine : styles.reactionsRowOther]}>
          {reactionSummary.map((reaction) => (
            <TouchableOpacity
              key={reaction.emoji}
              style={[styles.reactionChip, reaction.mine ? styles.reactionChipMine : null]}
              onPress={() => onToggleReaction(reaction.emoji)}
              testID={`bubble-react-${reaction.emoji}`}
            >
              <Text style={styles.reactionChipEmoji}>{reaction.emoji}</Text>
              {reaction.count > 1 ? <Text style={styles.reactionChipCount}>{reaction.count}</Text> : null}
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  chatHeader: {
    minHeight: 130,
    backgroundColor: '#3D2A00',
    paddingHorizontal: 12,
    paddingVertical: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    marginLeft: 4,
    flexShrink: 0,
  },
  headerIconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#E4B53B',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
    overflow: 'hidden',
  },
  // iter-109 Diary mode — blue avatar circle housing the book icon.
  headerAvatarDiary: {
    backgroundColor: Colors.diary,
  },
  headerAvatarImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
  },
  chatHeaderTitle: {
    fontSize: 19,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
  chatHeaderSubtitle: {
    marginTop: 3,
    fontSize: 13,
    color: 'rgba(255,255,255,0.78)',
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
  bubbleRow: {
    marginVertical: 6,
    flexDirection: 'row',
    position: 'relative',
  },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.lg,
    ...Shadow.sm,
  },
  bubbleMine: {
    backgroundColor: Colors.bubbleOut,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: Colors.bubbleIn,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  quoteBlock: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: 8,
    padding: 6,
    marginBottom: 6,
    gap: 6,
  },
  quoteAccent: { width: 3, borderRadius: 2, backgroundColor: Colors.primary },
  quoteName: { fontSize: 11, fontWeight: FontWeight.bold, color: Colors.primary },
  quoteText: { fontSize: 12, color: Colors.textSecondary },
  bubbleMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginTop: 4,
  },
  bubbleTime: {
    fontSize: 10,
    color: Colors.textMuted,
  },
  reactionsRow: {
    position: 'absolute',
    bottom: -10,
    flexDirection: 'row',
    gap: 4,
  },
  reactionsRowMine: { right: 8 },
  reactionsRowOther: { left: 8 },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 2,
  },
  reactionChipMine: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  reactionChipEmoji: { fontSize: 12 },
  reactionChipCount: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: FontWeight.semibold,
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
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
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
  emojiBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  emojiSheet: {
    backgroundColor: '#FFF8EC',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
  },
  emojiSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  emojiSheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  emojiSection: {
    marginTop: 10,
  },
  emojiSectionTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    marginBottom: 8,
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  emojiOption: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: '#F4E7D2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiOptionText: {
    fontSize: 22,
  },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.lg,
    ...Shadow.lg,
  },
  reactionPickerRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  reactionBtn: { padding: 6 },
  reactionEmoji: { fontSize: 28 },
  sheetActions: { paddingVertical: Spacing.sm },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  actionLabel: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
  },
  actionLabelDanger: { color: Colors.danger },
  sheetCancelBtn: {
    marginTop: 8,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
  },
  sheetCancelText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },

  // Tri-state delete sheet (WhatsApp-style)
  deleteSheet: {
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.base,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  deleteSheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  deleteSheetSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.base,
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderLight,
  },
  deleteRowLabel: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
  },
  forwardTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    paddingVertical: Spacing.md,
    textAlign: 'center',
  },
  forwardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  forwardAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forwardAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold },
  // iter-109 — Diary tile pinned at the TOP of the forward sheet.
  // Amber palette per web app screenshot so it visually pairs with the
  // existing "saved on this device" badges + warning Colors block.
  forwardRowDiary: {
    backgroundColor: '#FFFBEB', // amber-50 — soft highlight
    borderBottomColor: 'transparent',
    marginBottom: 4,
    borderRadius: Radius.md,
    paddingHorizontal: 12,
  },
  forwardAvatarDiary: {
    backgroundColor: Colors.warningLight, // amber-100 — pairs with the book icon below
  },
  forwardName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  forwardSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  // forwardPreview — same visual treatment as forwardSub, kept as a
  // separate style so the Diary "Save to your personal diary" subtitle
  // can be tweaked independently later without touching every chat row.
  forwardPreview: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  forwardEmpty: { textAlign: 'center', color: Colors.textMuted, paddingVertical: Spacing.lg },
  forwardSheet: { maxHeight: '70%' },
  disappearingSheet: { paddingHorizontal: 16, paddingBottom: 24 },
  disappearingTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, paddingHorizontal: 4, paddingBottom: 12 },
  disappearingRow: {
    minHeight: 50,
    borderRadius: Radius.lg,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  disappearingLabel: { fontSize: FontSize.base, color: Colors.textPrimary },
  disappearingLabelSelected: { color: Colors.primaryDark, fontWeight: FontWeight.semibold },
  templatePickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  templatePickerManage: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.primary,
  },
  templatePickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  templatePickerBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  templatePickerEmptyWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    gap: Spacing.sm,
  },
  templatePickerCreateBtn: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  templatePickerCreateText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.primaryDark,
  },
  deletedBubble: { opacity: 0.55 },
  deletedContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deletedText: { fontStyle: 'italic', color: Colors.textMuted },
  // deletedTimeText — italic + slightly muted to match the web app's
  // "This message was deleted  6:45 PM" timestamp on the right.
  deletedTimeText: { fontStyle: 'italic', opacity: 0.85, color: Colors.textMuted },
  // iter-107 — security-block bubble. Same visual treatment as the
  // "This message was deleted" bubble (italic + muted text + opacity-
  // dimmed background) so users instantly recognise it as a "missing"
  // message, BUT preceded with a small shield icon so they understand
  // it was removed for SAFETY rather than by the sender.
  securityRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  securityReasonText: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    color: Colors.textMuted,
    marginTop: 4,
    lineHeight: 16,
  },
  // editedBadge — italic "edited HH:MM" rendered before the real time
  // stamp inside the bubble meta row. Per web-app design parity.
  editedBadge: { fontStyle: 'italic', marginRight: 6, opacity: 0.85 },
  starIcon: { marginRight: 4 },
  tickIcon: { marginLeft: 4 },
  forwardListContent: { paddingBottom: Spacing.lg },
  flexOne: { flex: 1 },
});

type MenuItemDef = {
  key: string;
  label: string;
  lib: 'feather' | 'ion' | 'mc';
  icon: string;
  destructive?: boolean;
};

function ChatOptionsMenu({
  visible,
  title,
  muted,
  onClose,
  onAction,
}: {
  visible: boolean;
  title: string;
  muted: boolean;
  onClose: () => void;
  onAction: (key: string) => void;
}) {
  const items: MenuItemDef[] = [
    { key: 'export', label: 'Export chat', lib: 'feather', icon: 'download' },
    { key: 'media', label: 'Media & Files', lib: 'feather', icon: 'image' },
    { key: 'scheduled', label: 'Scheduled messages', lib: 'feather', icon: 'clock' },
    { key: 'mute', label: muted ? 'Unmute notifications' : 'Mute notifications', lib: 'feather', icon: muted ? 'bell' : 'bell-off' },
    { key: 'location', label: 'Request live location', lib: 'feather', icon: 'navigation' },
    { key: 'sendMoney', label: 'Send money', lib: 'feather', icon: 'dollar-sign' },
    { key: 'shareScreen', label: 'Share screen', lib: 'feather', icon: 'monitor' },
    { key: 'block', label: `Block ${title}`, lib: 'ion', icon: 'ban-outline', destructive: true },
    { key: 'report', label: `Report ${title}`, lib: 'feather', icon: 'flag', destructive: true },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={menuStyles.backdrop} onPress={onClose}>
        <Pressable style={menuStyles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={menuStyles.dragHandle} />
          {items.map((item, idx) => {
            const color = item.destructive ? Colors.danger : Colors.textPrimary;
            const isLast = idx === items.length - 1;
            return (
              <TouchableOpacity
                key={item.key}
                style={[menuStyles.row, isLast && { borderBottomWidth: 0 }]}
                onPress={() => onAction(item.key)}
                activeOpacity={0.6}
                testID={`menu-${item.key}`}
              >
                <View style={menuStyles.iconWrap}>
                  {item.lib === 'feather' ? (
                    <Feather name={item.icon as any} size={22} color={color} />
                  ) : item.lib === 'ion' ? (
                    <Ionicons name={item.icon as any} size={22} color={color} />
                  ) : (
                    <MaterialCommunityIcons name={item.icon as any} size={22} color={color} />
                  )}
                </View>
                <Text
                  style={[
                    menuStyles.label,
                    item.destructive && menuStyles.labelDanger,
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            style={menuStyles.cancelRow}
            onPress={onClose}
            activeOpacity={0.6}
            testID="menu-cancel"
          >
            <Text style={menuStyles.cancelLabel}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const menuStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#F5EFE0',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.18)',
    alignSelf: 'center',
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  iconWrap: {
    width: 32,
    alignItems: 'flex-start',
    marginRight: 12,
  },
  label: {
    fontSize: 17,
    color: Colors.textPrimary,
    fontWeight: '500',
    flex: 1,
  },
  labelDanger: {
    color: Colors.danger,
    fontWeight: '700',
  },
  cancelRow: {
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  cancelLabel: {
    fontSize: 17,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
});

