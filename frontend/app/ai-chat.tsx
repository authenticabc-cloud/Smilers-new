import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAction } from 'convex/react';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

export default function AiChatScreen() {
  const router = useRouter();
  const { data: messages, refetch: refetchMessages } = useSafeConvexQuery<any[]>(
    api.ai.chat.getMessages,
    {},
    []
  );
  const generate = useAction(api.ai.chat.generateResponse);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<any>>(null);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    setInput('');
    setBusy(true);
    try {
      await generate({ prompt: text });
      await refetchMessages();
    } catch (errorValue: any) {
      // iter-131: previously swallowed silently → user saw "nothing happens"
      // and assumed AI was broken. Now surface the actual reason + restore
      // the input so they don't lose their question.
      console.warn('AI chat error', errorValue);
      setInput(text);
      const raw = String(errorValue?.message || errorValue || 'Unknown error');
      // iter-134: capture Convex Request ID when present (e.g. "[Request ID: abcd1234]")
      // so the user can paste it to the backend agent to look up the exact stack.
      const reqIdMatch = raw.match(/Request ID:\s*([a-f0-9]+)/i);
      const reqIdLine = reqIdMatch ? `\n\nRequest ID: ${reqIdMatch[1]}` : '';
      const friendly = raw.includes('Server Error')
        ? `The AI backend isn't configured yet (Convex action ai.chat.generateResponse returned Server Error). Please ask the backend agent to wire up the Hercules AI integration.${reqIdLine}`
        : raw.includes('Network') || raw.includes('fetch')
          ? 'Network problem — check your connection and try again.'
          : raw.length > 220
            ? raw.slice(0, 220) + '…'
            : raw;
      Alert.alert('AI assistant unavailable', friendly);
    } finally {
      setBusy(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [busy, generate, input, refetchMessages]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="ai-chat-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="ai-chat-back-button">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} testID="ai-chat-header-title">
            AI Assistant
          </Text>
          <Text style={styles.headerSub} testID="ai-chat-header-subtitle">
            Powered by Hercules
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push('/study' as any)}
          hitSlop={12}
          style={styles.studyBtn}
          testID="ai-chat-study-button"
        >
          <Ionicons name="school" size={20} color={Colors.primary} />
          <Text style={styles.studyBtnText}>Study</Text>
        </TouchableOpacity>
      </View>
      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior="padding"
        keyboardVerticalOffset={80}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item: any) => item._id}
          contentContainerStyle={styles.listContent}
          testID="ai-chat-message-list"
          renderItem={({ item, index }: any) => (
            <View
              style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.aiBubble]}
              testID={`ai-chat-message-${index}`}
            >
              <Text
                style={item.role === 'user' ? styles.userText : styles.aiText}
                testID={`ai-chat-message-text-${index}`}
              >
                {item.content}
              </Text>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty} testID="ai-chat-empty-state">
              <Ionicons name="sparkles" size={48} color={Colors.primary} />
              <Text style={styles.emptyTitle}>Ask me anything</Text>
              <Text style={styles.emptySub}>
                I can help draft messages, translate, summarise, or answer questions.
              </Text>
            </View>
          }
        />
        <View style={styles.composer} testID="ai-chat-composer">
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Message AI…"
            placeholderTextColor={Colors.textMuted}
            style={styles.input}
            multiline
            editable={!busy}
            testID="ai-chat-input"
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || busy) && styles.sendBtnDisabled]}
            onPress={onSend}
            disabled={!input.trim() || busy}
            testID="ai-chat-send-button"
          >
            {busy ? <ActivityIndicator color={Colors.white} /> : <Ionicons name="send" size={20} color={Colors.white} />}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  studyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  studyBtnText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000022',
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerSpacer: { width: 26 },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  headerSub: { fontSize: FontSize.xs, color: Colors.textSecondary },
  bubble: { maxWidth: '85%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: Radius.lg },
  userBubble: { alignSelf: 'flex-end', backgroundColor: Colors.primary },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#00000011' },
  userText: { color: Colors.white, fontSize: FontSize.base },
  aiText: { color: Colors.textPrimary, fontSize: FontSize.base },
  empty: { alignItems: 'center', padding: Spacing.xl, gap: 8 },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginTop: 12,
  },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: Spacing.base,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#00000022',
    backgroundColor: Colors.background,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: Radius.lg,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: '#00000011',
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.6 },
  listContent: { padding: Spacing.base, gap: 10 },
  flexOne: { flex: 1 },
});