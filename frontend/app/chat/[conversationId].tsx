import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import Header from '../../src/components/Header';
import Avatar from '../../src/components/Avatar';
import { api } from '../../src/convexApi';
import { useAuth } from '../../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../../src/theme';

export default function ChatScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { userInfo } = useAuth();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);

  const conversation = useQuery(
    api.conversations.getConversation,
    conversationId ? { conversationId } : 'skip'
  );
  const messagesPage = useQuery(
    api.messages.list,
    conversationId
      ? { conversationId, paginationOpts: { numItems: 50, cursor: null } }
      : 'skip'
  );
  const me = useQuery(api.users.getCurrentUser);
  const sendMessage = useMutation(api.messages.send);
  const setTyping = useMutation(api.typing.setTyping);
  const markRead = useMutation(api.messages.markRead);

  const messages: any[] = useMemo(() => {
    const page = messagesPage as any;
    const arr = page?.page || page || [];
    return Array.isArray(arr) ? [...arr].reverse() : [];
  }, [messagesPage]);

  useEffect(() => {
    if (conversationId && messages.length > 0) {
      markRead({ conversationId }).catch(() => {});
    }
  }, [conversationId, messages.length, markRead]);

  const handleSend = async () => {
    const value = text.trim();
    if (!value || !conversationId || sending) return;
    setSending(true);
    setText('');
    try {
      await sendMessage({ conversationId, type: 'text', text: value });
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

  const title = conversation?.name || conversation?.otherUserName || 'Chat';

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
        {messagesPage === undefined ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item: any) => item._id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => (
              <MessageBubble msg={item} isMine={item.senderId === me?._id} />
            )}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>Say hello with a smile 😊</Text>
              </View>
            }
          />
        )}

        <View style={styles.inputBar}>
          <TouchableOpacity style={styles.iconBtn} testID="attach-btn">
            <Feather name="paperclip" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <TextInput
            value={text}
            onChangeText={handleTyping}
            placeholder="Type your message…"
            placeholderTextColor={Colors.textMuted}
            style={styles.input}
            multiline
            testID="message-input"
          />
          <TouchableOpacity style={styles.iconBtn} testID="camera-btn">
            <Feather name="camera" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          {text.trim().length === 0 ? (
            <TouchableOpacity style={styles.sendBtn} testID="mic-btn">
              <Feather name="mic" size={20} color={Colors.white} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.sendBtn} onPress={handleSend} testID="send-btn">
              <Feather name="send" size={20} color={Colors.white} />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageBubble({ msg, isMine }: { msg: any; isMine: boolean }) {
  const text = msg.text || (msg.type !== 'text' ? `[${msg.type}]` : '');
  const time = msg._creationTime ? new Date(msg._creationTime) : new Date();
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const tickColor = msg.readBy?.length > 1 ? Colors.tickBlue : msg.deliveredTo?.length ? Colors.tickYellow : Colors.tickGray;
  const tickIcon = msg.readBy?.length > 1 || msg.deliveredTo?.length ? 'checkmark-done' : 'checkmark';

  return (
    <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
      <View
        style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleOther,
        ]}
      >
        <Text style={styles.bubbleText}>{text}</Text>
        <View style={styles.bubbleMeta}>
          <Text style={styles.bubbleTime}>{timeStr}</Text>
          {isMine && <Ionicons name={tickIcon as any} size={14} color={tickColor} style={{ marginLeft: 4 }} />}
        </View>
      </View>
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
    marginVertical: 3,
    flexDirection: 'row',
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
  empty: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
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
});
