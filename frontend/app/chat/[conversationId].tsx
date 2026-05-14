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
import Header from '../../src/components/Header';
import AttachmentSheet from '../../src/components/AttachmentSheet';
import MediaBubble from '../../src/components/MediaBubble';
import PollComposer from '../../src/components/PollComposer';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { uploadFile } from '../../src/lib/uploadFile';
import { useAuth } from '../../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMPTY_MESSAGES_PAGE = { page: [] as any[] };
const EMPTY_FORWARD_CONVERSATIONS: any[] = [];

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
  const [fallbackReady, setFallbackReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const recRef = useRef<Audio.Recording | null>(null);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recCancelledRef = useRef(false);
  const recStartMsRef = useRef(0);
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

  const msgById = useMemo(() => {
    const map = new Map<string, any>();
    messages.forEach((message) => map.set(message._id, message));
    return map;
  }, [messages]);

  useEffect(() => {
    if (conversationId && messages.length > 0) {
      markRead({ conversationId }).catch(() => {});
    }
  }, [conversationId, messages.length, markRead]);

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
      recStartMsRef.current = Date.now();
      setIsRecording(true);
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recRef.current = recording;
      recTimer.current = setInterval(() => {
        setRecDuration(Math.floor((Date.now() - recStartMsRef.current) / 1000));
      }, 250);
    } catch (errorValue: any) {
      setIsRecording(false);
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
      const totalMs = Date.now() - recStartMsRef.current;
      const totalSec = Math.max(1, Math.round(totalMs / 1000));
      const replyToMessageId = replyTo?._id;
      setIsRecording(false);
      setRecDuration(0);
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

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="chat-screen">
      <Header
        title={title}
        showBack
        onBack={() => router.back()}
        variant="dark"
        subtitle={conversation?.type === 'group' ? `${conversation?.participants?.length || 0} members` : 'tap for info'}
        right={
          <>
            <TouchableOpacity testID="call-btn">
              <Ionicons name="call-outline" size={22} color={Colors.white} />
            </TouchableOpacity>
            <TouchableOpacity testID="video-btn">
              <Ionicons name="videocam-outline" size={22} color={Colors.white} />
            </TouchableOpacity>
          </>
        }
      />

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
            data={messages}
            keyExtractor={(item: any) => item._id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => (
              <MediaBubble
                msg={item}
                isMine={item.senderId === me?._id}
                myUserId={me?._id}
                parentMsg={item.replyToMessageId ? msgById.get(item.replyToMessageId) : undefined}
                onLongPress={() => onLongPressMessage(item)}
                onToggleReaction={(emoji) => onToggleMyReaction(item._id, emoji)}
              />
            )}
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
                <Feather name="trash-2" size={20} color={Colors.danger} />
              </TouchableOpacity>
              <View style={styles.recIndicator}>
                <View style={styles.recDot} />
                <Text style={styles.recTimer}>
                  {`${Math.floor(recDuration / 60)}:${(recDuration % 60).toString().padStart(2, '0')}`}
                </Text>
                <Text style={styles.recHint} numberOfLines={1}>Recording…</Text>
              </View>
              <TouchableOpacity style={styles.recSendBtn} onPress={() => finishRecording('send')} testID="rec-send">
                <Feather name="send" size={20} color={Colors.white} />
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={() => setShowAttachSheet(true)}
                disabled={!isConversationAvailable || uploading}
                testID="attach-btn"
              >
                <Feather name="paperclip" size={22} color={Colors.textSecondary} />
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
                onPress={takePhoto}
                disabled={!isConversationAvailable || uploading}
                testID="camera-btn"
              >
                <Feather name="camera" size={22} color={Colors.textSecondary} />
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
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: {
    padding: Spacing.base,
    paddingBottom: Spacing.md,
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
    padding: Spacing.sm,
    gap: 6,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  iconBtn: {
    padding: 8,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: Colors.background,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.lg,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  recCancelBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FEE2E2' },
  recIndicator: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: Colors.background, borderRadius: Radius.lg },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.danger },
  recTimer: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary, fontVariant: ['tabular-nums'] as any },
  recHint: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary },
  recSendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary },
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
  deletedBubble: { opacity: 0.55 },
  deletedContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deletedText: { fontStyle: 'italic', color: Colors.textMuted },
  starIcon: { marginRight: 4 },
  tickIcon: { marginLeft: 4 },
  forwardListContent: { paddingBottom: Spacing.lg },
  flexOne: { flex: 1 },
});
