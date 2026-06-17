import React, { useMemo, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Avatar from '../src/components/Avatar';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useDebouncedValue } from '../src/hooks/useDebouncedValue';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type SearchTab = 'chats' | 'messages' | 'people';

export default function SearchScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SearchTab>('chats');
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);

  const { data: conversations } = useSafeConvexQuery<any[]>(api.conversations.listConversations, {}, []);
  const { data: users } = useSafeConvexQuery<any[]>(
    api.users.searchUsers,
    debouncedQuery.length >= 2 ? { query: debouncedQuery } : {},
    [],
    debouncedQuery.length >= 2
  );
  // iter-220: message-content search (web parity — Chats / Messages tabs).
  // Reuses the web-canonical `api.search.searchMessages`. Tapping a result
  // opens the conversation carrying `?q=<term>&mid=<messageId>` so the chat
  // screen highlights matches and jumps to the tapped message.
  const { data: messageHits } = useSafeConvexQuery<any[]>(
    (api as any).search.searchMessages,
    debouncedQuery.length >= 2 ? { query: debouncedQuery } : {},
    [],
    debouncedQuery.length >= 2
  );

  const conversationResults = useMemo(() => {
    const list = Array.isArray(conversations) ? conversations : [];
    if (!debouncedQuery) return list.slice(0, 20);
    const normalized = debouncedQuery.toLowerCase();
    return list.filter((item: any) => {
      const name = String(item?.name || item?.otherUserName || '').toLowerCase();
      const lastMessage = String(item?.lastMessageText || '').toLowerCase();
      return name.includes(normalized) || lastMessage.includes(normalized);
    });
  }, [conversations, debouncedQuery]);

  const messageResults = useMemo(() => (Array.isArray(messageHits) ? messageHits : []), [messageHits]);
  const userResults = useMemo(() => (Array.isArray(users) ? users : []), [users]);

  const activeResults = tab === 'chats' ? conversationResults : tab === 'messages' ? messageResults : userResults;

  const openConversationWithSearch = (conversationId: string, messageId?: string) => {
    const params = new URLSearchParams({ q: debouncedQuery });
    if (messageId) params.set('mid', String(messageId));
    router.push(`/chat/${conversationId}?${params.toString()}` as any);
  };

  const openDirect = async (userId: string) => {
    try {
      const result: any = await getOrCreateDirect({ otherUserId: userId });
      const conversationId = typeof result === 'string' ? result : result?._id || result?.conversationId;
      if (conversationId) {
        router.push(`/chat/${conversationId}` as any);
      }
    } catch {
      router.push(`/user/${userId}` as any);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="search-screen">
      <Header title="Search" showBack onBack={() => router.back()} variant="dark" />

      <View style={styles.searchWrap} testID="search-input-wrap">
        <Feather name="search" size={18} color={Colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats or people"
          placeholderTextColor={Colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          testID="global-search-input"
        />
        {query.length > 0 ? (
          <TouchableOpacity onPress={() => setQuery('')} testID="clear-search-button" style={styles.clearBtn}>
            <Feather name="x-circle" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.segmentWrap} testID="search-segments">
        <SegmentButton label="Chats" active={tab === 'chats'} onPress={() => setTab('chats')} testID="search-tab-chats" />
        <SegmentButton
          label={messageResults.length > 0 ? `Messages (${messageResults.length})` : 'Messages'}
          active={tab === 'messages'}
          onPress={() => setTab('messages')}
          testID="search-tab-messages"
        />
        <SegmentButton label="People" active={tab === 'people'} onPress={() => setTab('people')} testID="search-tab-people" />
      </View>

      <FlatList
        data={activeResults}
        keyExtractor={(item: any, index: number) => item?._id || item?.userId || `${tab}-${index}`}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) =>
          tab === 'chats' ? (
            <ConversationResultRow
              item={item}
              index={index}
              onPress={() => openConversationWithSearch(String(item._id))}
            />
          ) : tab === 'messages' ? (
            <MessageResultRow
              item={item}
              index={index}
              term={debouncedQuery}
              onPress={() =>
                openConversationWithSearch(
                  String(item?.conversationId || item?.conversation?._id || ''),
                  String(item?._id || item?.messageId || ''),
                )
              }
            />
          ) : (
            <UserResultRow
              item={item}
              index={index}
              onPress={() => router.push(`/user/${item?._id || item?.userId}` as any)}
              onMessage={() => openDirect(item?._id || item?.userId)}
            />
          )
        }
        ListHeaderComponent={
          <Text style={styles.sectionLabel} testID="search-results-label">
            {tab === 'chats' ? 'Chats' : tab === 'messages' ? 'Messages' : 'People'}
          </Text>
        }
        ListEmptyComponent={
          <View style={styles.empty} testID="search-empty-state">
            <Ionicons name="search-outline" size={34} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>
              {debouncedQuery
                ? 'No results found'
                : `Start typing to search ${tab === 'people' ? 'people' : tab === 'messages' ? 'messages' : 'chats'}`}
            </Text>
            <Text style={styles.emptySub}>
              {debouncedQuery
                ? 'Try a different name, email, or keyword.'
                : tab === 'people'
                  ? 'Type at least 2 characters to search people.'
                  : tab === 'messages'
                    ? 'Find any word inside your conversations.'
                    : 'We will search your existing conversations.'}
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

function SegmentButton({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.segmentButton, active ? styles.segmentButtonActive : null]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ConversationResultRow({ item, index, onPress }: { item: any; index: number; onPress: () => void }) {
  const name = item?.name || item?.otherUserName || 'Conversation';
  const subtitle = item?.lastMessageText || 'Open conversation';

  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7} testID={`search-chat-result-${index}`}>
      <Avatar name={name} uri={item?.photoUrl || item?.avatarUrl} size={48} />
      <View style={styles.rowMid}>
        <Text style={styles.rowTitle} numberOfLines={1}>{name}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={Colors.textMuted} />
    </TouchableOpacity>
  );
}

function MessageResultRow({
  item,
  index,
  term,
  onPress,
}: {
  item: any;
  index: number;
  term: string;
  onPress: () => void;
}) {
  const name =
    item?.conversationName ||
    item?.conversation?.name ||
    item?.name ||
    item?.otherUserName ||
    item?.senderName ||
    'Conversation';
  const snippet = String(item?.text || item?.snippet || item?.body || item?.lastMessageText || '');
  const lower = snippet.toLowerCase();
  const t = term.trim().toLowerCase();
  const matchAt = t ? lower.indexOf(t) : -1;
  // Build a highlighted snippet centred on the first match.
  let before = snippet;
  let hit = '';
  let after = '';
  if (matchAt >= 0) {
    const start = Math.max(0, matchAt - 24);
    before = (start > 0 ? '…' : '') + snippet.slice(start, matchAt);
    hit = snippet.slice(matchAt, matchAt + term.length);
    after = snippet.slice(matchAt + term.length);
  }

  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7} testID={`search-message-result-${index}`}>
      <Avatar name={name} uri={item?.photoUrl || item?.avatarUrl} size={48} />
      <View style={styles.rowMid}>
        <Text style={styles.rowTitle} numberOfLines={1}>{name}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {matchAt >= 0 ? (
            <>
              {before}
              <Text style={styles.snippetHighlight}>{hit}</Text>
              {after}
            </>
          ) : (
            snippet || 'Open message'
          )}
        </Text>
      </View>
      <Feather name="chevron-right" size={20} color={Colors.textMuted} />
    </TouchableOpacity>
  );
}

function UserResultRow({
  item,
  index,
  onPress,
  onMessage,
}: {
  item: any;
  index: number;
  onPress: () => void;
  onMessage: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7} testID={`search-user-result-${index}`}>
      <Avatar name={item?.name || 'Smilers User'} uri={item?.avatarUrl} size={48} />
      <View style={styles.rowMid}>
        <Text style={styles.rowTitle} numberOfLines={1}>{item?.name || 'Smilers User'}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>{item?.email || item?.phone || item?.about || 'View profile'}</Text>
      </View>
      <TouchableOpacity style={styles.messageBtn} onPress={onMessage} testID={`search-user-message-${index}`}>
        <Feather name="message-square" size={18} color={Colors.primary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.base,
    paddingHorizontal: Spacing.md,
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  clearBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  segmentWrap: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.base, marginTop: Spacing.base },
  segmentButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  segmentButtonActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  segmentText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textPrimary },
  segmentTextActive: { color: Colors.white, fontWeight: FontWeight.bold },
  listContent: { paddingHorizontal: Spacing.base, paddingBottom: 48 },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    letterSpacing: 1,
    paddingVertical: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
  },
  rowMid: { flex: 1 },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  snippetHighlight: { backgroundColor: '#FDE68A', color: '#1A1A1A', fontWeight: FontWeight.semibold },
  messageBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { alignItems: 'center', paddingTop: Spacing.xxl * 2, paddingHorizontal: Spacing.lg, gap: 8 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary, textAlign: 'center' },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
});