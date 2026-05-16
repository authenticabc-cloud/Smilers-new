import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useConvex, useMutation } from 'convex/react';
import { Audio } from 'expo-av';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import AttachmentSheet from '../../src/components/AttachmentSheet';
import MediaBubble from '../../src/components/MediaBubble';
import PollComposer from '../../src/components/PollComposer';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { getWallpaperColor, normalizeChatAppearance } from '../../src/lib/chatAppearance';
import {
  CHAT_APPEARANCE_KEY,
  DEFAULT_CHAT_APPEARANCE,
  QUICK_TEMPLATES_KEY,
  readStoredJson,
} from '../../src/lib/settingsStorage';
import { uploadFile } from '../../src/lib/uploadFile';
import { useAuth } from '../../src/providers/AuthProvider';
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
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function isSameCalendarDay(a?: number, b?: number) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function formatPresenceSubtitle(conversation: any) {
  if (!conversation) return 'tap for info';
  if (conversation.type === 'group') {
    return `${conversation?.participants?.length || conversation?.memberCount || 0} members`;
  }
  if (conversation.otherUser?.lastSeen) {
    return `last seen ${new Date(conversation.otherUser.lastSeen).toLocaleDateString()}`;
  }
  if (conversation.lastSeen) {
    return `last seen ${new Date(conversation.lastSeen).toLocaleDateString()}`;
  }
  return 'last seen recently';
}

export default function ChatScreen() {
  const router = useRouter();
  const convex = useConvex();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  useAuth();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [replyTo, setReplyTo] = useState<any | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<any | null>(null);
  const [showAttachSheet, setShowAttachSheet] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  const [showForwardPicker, setShowForwardPicker] = useState(false);
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
  const recRef = useRef<Audio.Recording | null>(null);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recCancelledRef = useRef(false);
  const recStartMsRef = useRef(0);
  const recDurationMsRef = useRef(0);
  const listRef = useRef<FlatList<any>>(null);
  const hasValidConversationId =
    typeof conversationId === 'string' && /^[a-z0-9]+$/i.test(conversationId) && conversationId.length > 10;
  const canQueryConversation = !!conversationId && hasValidConversationId;

  const { data: conversation, loading: conversationLoading } = useSafeConvexQuery<any | null>(
    api.conversations.getConversation,
    conversationId ? { conversationId } : {},
    null,
    canQueryConversation
  );
  const { data: messagesPage, loading: messagesLoading, refetch: refetchMessages } = useSafeConvexQuery<any>(
    api.messages.list,
    conversationId
      ? { conversationId, paginationOpts: { numItems: 50, cursor: null } }
      : {},
    EMPTY_MESSAGES_PAGE,
    canQueryConversation
  );
  const { data: me } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null);
  const { data: conversationsForForward } = useSafeConvexQuery<any[]>(
    api.conversations.listConversations,
    {},
    EMPTY_FORWARD_CONVERSATIONS,
    showForwardPicker
  );

  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
    }).catch(() => {});
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
  const markRead = useMutation(api.messages.markRead);
  const toggleReaction = useMutation(api.messages.toggleReaction);
  const deleteMessage = useMutation(api.messages.deleteMessage);
  const toggleStar = useMutation(api.messages.toggleStar);

  const messages: any[] = useMemo(() => {
    const page = messagesPage as any;
    const arr = page?.page || page || [];
    return Array.isArray(arr) ? [...arr].reverse() : [];
  }, [messagesPage]);

  const visibleMessages = useMemo(() => {
    const ttlMs = DISAPPEARING_OPTIONS.find((item) => item.key === disappearingMode)?.ms || 0;
    if (!ttlMs) return messages;
    const cutoff = Date.now() - ttlMs;
    return messages.filter((message) => Number(message?._creationTime || 0) >= cutoff);
  }, [disappearingMode, messages]);

  const msgById = useMemo(() => {
    const map = new Map<string, any>();
    visibleMessages.forEach((message) => map.set(message._id, message));
    return map;
  }, [visibleMessages]);

  useEffect(() => {
    if (conversationId && visibleMessages.length > 0) {
      markRead({ conversationId }).catch(() => {});
    }
  }, [conversationId, visibleMessages.length, markRead]);

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

  const handleSend = async () => {
    const value = text.trim();
    if (!value || !conversationId || !isConversationAvailable || sending) return;

    setSending(true);
    const replyToMessageId = replyTo?._id;
    setText('');
    setReplyTo(null);

    try {
      await sendMessage({
        conversationId,
        type: 'text',
        text: value,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      await refetchMessages();
    } catch (e: any) {
      console.warn('send failed:', e?.message);
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

  const sendImageFromUri = useCallback(
    async (uri: string, mimeType?: string) => {
      if (!conversationId || !isConversationAvailable) return;

      setUploading(true);
      const caption = text.trim();
      const replyToMessageId = replyTo?._id;

      try {
        const storageId = await uploadFile(convex, uri, mimeType || 'image/jpeg');
        await sendMessage({
          conversationId,
          type: 'image',
          text: caption,
          storageId,
          ...(replyToMessageId ? { replyToMessageId } : {}),
        });
        setText('');
        setReplyTo(null);
        await refetchMessages();
      } catch (errorValue: any) {
        Alert.alert('Upload failed', errorValue?.message || 'Unable to send image right now.');
      } finally {
        setUploading(false);
      }
    },
    [conversationId, convex, isConversationAvailable, refetchMessages, replyTo, sendMessage, text]
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

  const takePhoto = useCallback(async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow camera access to take photos.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets?.[0]?.uri) return;
    const asset = result.assets[0];
    await sendImageFromUri(asset.uri, asset.mimeType || 'image/jpeg');
  }, [sendImageFromUri]);

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
          ...(replyToMessageId ? { replyToMessageId } : {}),
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
      const permission = await Audio.requestPermissionsAsync();
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
      setIsRecording(true);
      setIsRecordingPaused(false);
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recording.setProgressUpdateInterval(200);
      recording.setOnRecordingStatusUpdate((status) => {
        if (!status.isLoaded) return;
        recDurationMsRef.current = status.durationMillis || 0;
        setRecDuration(Math.floor((status.durationMillis || 0) / 1000));
      });
      recRef.current = recording;
    } catch (errorValue: any) {
      setIsRecording(false);
      setIsRecordingPaused(false);
      Alert.alert('Recording failed', errorValue?.message || 'Could not start recording');
    }
  }, [isRecording]);

  const finishRecording = useCallback(
    async (action: 'send' | 'cancel') => {
      if (recTimer.current) {
        clearInterval(recTimer.current);
        recTimer.current = null;
      }
      const recording = recRef.current;
      recRef.current = null;
      const totalMs = recDurationMsRef.current;
      const totalSec = Math.max(1, Math.round(totalMs / 1000));
      const replyToMessageId = replyTo?._id;
      setIsRecording(false);
      setIsRecordingPaused(false);
      setRecDuration(0);
      recDurationMsRef.current = 0;
      if (!recording) return;
      try {
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
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
        await sendMessage({
          conversationId,
          type: 'voice',
          storageId,
          mimeType: mime,
          audioDuration: totalSec,
          ...(replyToMessageId ? { replyToMessageId } : {}),
        });
        setReplyTo(null);
        await refetchMessages();
      } catch (errorValue: any) {
        Alert.alert('Failed to send voice note', errorValue?.message || 'Unknown error');
      } finally {
        setUploading(false);
      }
    },
    [conversationId, convex, refetchMessages, replyTo, sendMessage]
  );

  const cancelRecording = useCallback(() => {
    recCancelledRef.current = true;
    finishRecording('cancel');
  }, [finishRecording]);

  const pauseRecording = useCallback(async () => {
    if (!recRef.current || isRecordingPaused) return;
    try {
      await recRef.current.pauseAsync();
      setIsRecordingPaused(true);
    } catch (errorValue: any) {
      Alert.alert('Pause failed', errorValue?.message || 'Could not pause recording');
    }
  }, [isRecordingPaused]);

  const resumeRecording = useCallback(async () => {
    if (!recRef.current || !isRecordingPaused) return;
    try {
      await recRef.current.startAsync();
      setIsRecordingPaused(false);
    } catch (errorValue: any) {
      Alert.alert('Resume failed', errorValue?.message || 'Could not resume recording');
    }
  }, [isRecordingPaused]);

  useEffect(() => {
    return () => {
      if (recTimer.current) clearInterval(recTimer.current);
      const recording = recRef.current;
      recRef.current = null;
      if (recording) {
        recording.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, []);

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
    const copiedText = selectedMsg?.text || '';
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

  const doForwardTo = useCallback(
    async (targetConversationId: string) => {
      const msg = selectedMsg;
      setShowForwardPicker(false);
      closeActionSheet();
      if (!msg || !targetConversationId) return;
      try {
        await sendMessage(
          msg.type === 'image' && msg.storageId
            ? {
                conversationId: targetConversationId,
                type: 'image',
                text: msg.text || '',
                storageId: msg.storageId,
                ...(msg.mimeType ? { mimeType: msg.mimeType } : {}),
                ...(msg.audioDuration ? { audioDuration: msg.audioDuration } : {}),
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
                ...(msg.audioDuration ? { audioDuration: msg.audioDuration } : {}),
              }
        );
        Alert.alert('Forwarded');
      } catch (e: any) {
        Alert.alert('Failed to forward', e?.message || 'Unknown error');
      }
    },
    [selectedMsg, sendMessage]
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
    Alert.alert('Delete message?', "This can’t be undone.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteMessage({ messageId: msg._id });
            await refetchMessages();
          } catch (e: any) {
            Alert.alert('Failed to delete', e?.message || 'Unknown error');
          }
        },
      },
    ]);
  }, [selectedMsg, deleteMessage]);

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

  const title = conversation?.name || conversation?.otherUserName || 'Chat';
  const isMineSelected = selectedMsg && me && selectedMsg.senderId === me._id;
  const subtitle = formatPresenceSubtitle(conversation);
  const avatarInitial = title.charAt(0).toUpperCase();

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
        case 'shareScreen':
          if (Platform.OS === 'ios') {
            Alert.alert(
              'Screen sharing on iOS',
              'iOS screen sharing requires a Broadcast Upload Extension built into the app. We\'ll enable this in a future build — for now, screen sharing is available on Android.'
            );
            return;
          }
          router.push(`/call/${conversationId}?type=screen` as any);
          break;
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
      edges={['top', 'bottom']}
      testID="chat-screen"
    >
      <View style={styles.chatHeader} testID="chat-header">
        <View style={styles.chatHeaderLeft}>
          <TouchableOpacity testID="chat-back-btn" onPress={() => router.back()} style={styles.headerIconButton}>
            <Ionicons name="arrow-back" size={24} color={Colors.white} />
          </TouchableOpacity>
          <View style={styles.headerAvatar} testID="chat-header-avatar">
            <Text style={styles.headerAvatarText}>{avatarInitial}</Text>
          </View>
          <View style={styles.headerTextWrap}>
            <Text style={styles.chatHeaderTitle} numberOfLines={1} testID="chat-header-title">{title.toUpperCase()}</Text>
            <Text style={styles.chatHeaderSubtitle} numberOfLines={1} testID="chat-header-subtitle">{subtitle}</Text>
          </View>
        </View>

        <View style={styles.chatHeaderActions}>
          <TouchableOpacity testID="call-btn" onPress={() => router.push(`/call/${conversationId}?type=voice` as any)} style={styles.headerIconButton}>
            <Ionicons name="call-outline" size={21} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="video-btn" onPress={() => router.push(`/call/${conversationId}?type=video` as any)} style={styles.headerIconButton}>
            <Ionicons name="videocam-outline" size={22} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="chat-disappearing-btn" onPress={() => setShowDisappearingSheet(true)} style={styles.headerIconButton}>
            <Ionicons name="time-outline" size={21} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="chat-encryption-btn" onPress={() => router.push('/encryption' as any)} style={styles.headerIconButton}>
            <Ionicons name="shield-checkmark-outline" size={21} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity testID="chat-menu-btn" onPress={() => setShowOptionsMenu(true)} style={styles.headerIconButton}>
            <Feather name="more-vertical" size={20} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.encryptionBanner} testID="chat-encryption-banner">
        <Ionicons name="shield-checkmark-outline" size={16} color="#2A7C48" />
        <Text style={styles.encryptionBannerText}>End-to-end encrypted</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
            data={visibleMessages}
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
                    parentMsg={item.replyToMessageId ? msgById.get(item.replyToMessageId) : undefined}
                    appearance={chatAppearance}
                    onLongPress={() => onLongPressMessage(item)}
                    onToggleReaction={(emoji) => onToggleMyReaction(item._id, emoji)}
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

        {replyTo && isConversationAvailable ? (
          <View style={styles.replyPill} testID="reply-preview-pill">
            <View style={styles.replyAccent} />
            <View style={styles.flexOne}>
              <Text style={styles.replyLabel}>Replying to {replyTo.senderName || 'message'}</Text>
              <Text style={styles.replyText} numberOfLines={1} testID="reply-preview-text">
                {replyTo.text || `[${replyTo.type}]`}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={10} testID="reply-preview-close">
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
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={() => setText((current) => `${current}${current ? ' ' : ''}😊`)}
                disabled={!isConversationAvailable || uploading}
                testID="emoji-btn"
              >
                <Ionicons name="happy-outline" size={22} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={() => setShowAttachSheet(true)}
                disabled={!isConversationAvailable || uploading}
                testID="attach-btn"
              >
                <Feather name="paperclip" size={22} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={() => setShowTemplatePicker(true)}
                disabled={!isConversationAvailable || uploading}
                testID="templates-btn"
              >
                <MaterialCommunityIcons name="message-text-outline" size={22} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TextInput
                value={text}
                onChangeText={handleTyping}
                placeholder="Type your message…"
                placeholderTextColor={Colors.textMuted}
                style={styles.input}
                multiline
                editable={isConversationAvailable && !sending && !uploading}
                testID="message-input"
              />
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={() => router.push('/scheduled' as any)}
                disabled={!isConversationAvailable || uploading}
                testID="schedule-btn"
              >
                <Feather name="clock" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
              {text.trim().length === 0 ? (
                <TouchableOpacity style={styles.sendBtn} onPress={startRecording} disabled={!isConversationAvailable || uploading} testID="mic-btn">
                  <Feather name="mic" size={20} color={Colors.white} />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.sendBtn} onPress={handleSend} disabled={!isConversationAvailable || uploading} testID="send-btn">
                  <Feather name="send" size={20} color={Colors.white} />
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </KeyboardAvoidingView>

      <AttachmentSheet
        visible={showAttachSheet}
        onClose={() => setShowAttachSheet(false)}
        onPickPhoto={pickPhoto}
        onTakePhoto={takePhoto}
        onPickDocument={onPickDocument}
        onCreatePoll={() => setShowPollComposer(true)}
      />

      <PollComposer
        visible={showPollComposer}
        onClose={() => setShowPollComposer(false)}
        onSubmit={onSubmitPoll}
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
              <ActionRow icon="copy" lib="feather" label="Copy" onPress={onCopy} />
              <ActionRow icon="corner-up-right" lib="feather" label="Forward" onPress={onForward} />
              <ActionRow
                icon="star"
                lib="feather"
                label={selectedMsg?.starred ? 'Unstar' : 'Star'}
                onPress={onStar}
              />
              {isMineSelected ? (
                <ActionRow icon="trash-2" lib="feather" label="Delete" onPress={onDelete} danger />
              ) : null}
            </View>
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
                  (item: any) => item._id !== conversationId
                )
              }
              keyExtractor={(item: any) => item._id}
              contentContainerStyle={styles.forwardListContent}
              renderItem={({ item }: any) => (
                <TouchableOpacity
                  style={styles.forwardRow}
                  onPress={() => doForwardTo(item._id)}
                  testID={`forward-target-${item._id}`}
                >
                  <View style={styles.forwardAvatar}>
                    <Text style={styles.forwardAvatarText}>
                      {((item.name || item.otherUserName || '?') as string).charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.flexOne}>
                    <Text style={styles.forwardName}>{item.name || item.otherUserName || 'Chat'}</Text>
                    <Text style={styles.forwardSub} numberOfLines={1}>
                      {item.lastMessageText || ''}
                    </Text>
                  </View>
                  <Feather name="send" size={18} color={Colors.primary} />
                </TouchableOpacity>
              )}
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
  const tickColor = msg.readBy?.length > 1 ? Colors.tickBlue : msg.deliveredTo?.length ? Colors.tickYellow : Colors.tickGray;
  const tickIcon = msg.readBy?.length > 1 || msg.deliveredTo?.length ? 'checkmark-done' : 'checkmark';

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

  if (msg.deletedAt) {
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther, styles.deletedBubble]}>
          <View style={styles.deletedContent}>
            <Feather name="slash" size={12} color={Colors.textMuted} />
            <Text style={[styles.bubbleText, styles.deletedText]}>Message deleted</Text>
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
        ) : msg.replyToMessageId ? (
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
    minHeight: 74,
    backgroundColor: '#3D2A00',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chatHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  chatHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  headerIconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#E4B53B',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
  },
  headerAvatarText: {
    fontSize: 18,
    fontWeight: FontWeight.bold,
    color: '#3D2A00',
  },
  headerTextWrap: {
    flex: 1,
  },
  chatHeaderTitle: {
    fontSize: 18,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
  chatHeaderSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: 'rgba(255,255,255,0.84)',
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
  encryptionBannerText: {
    fontSize: 13,
    color: '#2A7C48',
    fontWeight: FontWeight.medium,
  },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
  },
  dayChipWrap: {
    alignItems: 'center',
    marginVertical: 10,
  },
  dayChipText: {
    fontSize: 12,
    color: '#766C5E',
    backgroundColor: 'rgba(247, 241, 224, 0.95)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
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
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: '#F4EFE3',
    borderTopWidth: 1,
    borderTopColor: '#E5D8C2',
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: '#F8F2E7',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: '#E7DAC2',
  },
  sendBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
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
  forwardName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  forwardSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
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

