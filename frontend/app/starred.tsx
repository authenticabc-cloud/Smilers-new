import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useConvex } from 'convex/react';
import Header from '../src/components/Header';
import Avatar from '../src/components/Avatar';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { decryptText } from '../src/lib/e2eeCrypto';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

interface E2EEStatus {
  enabled: boolean;
  salt: string | null;
  passphrase: string | null;
}

export default function StarredScreen() {
  const router = useRouter();
  const convex = useConvex();
  const { data: starredMessages } = useSafeConvexQuery<any[]>(
    api.starred.getStarredMessages,
    {},
    [],
  );
  const list = useMemo(
    () => (Array.isArray(starredMessages) ? starredMessages : []),
    [starredMessages],
  );

  // iter-147: starred entries can be E2EE-encrypted (matches the chat
  // screen). Each entry carries `encrypted: true` + base64 `iv` + base64
  // ciphertext in `text`. Fetch the conversation's E2EE key once per
  // unique conversationId, then derive a plaintext preview to render.
  const [e2eeMap, setE2eeMap] = useState<Record<string, E2EEStatus>>({});

  const uniqueConversationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of list) {
      const cid = String(entry?.conversationId || '').trim();
      if (cid && !e2eeMap[cid]) ids.add(cid);
    }
    return Array.from(ids);
  }, [list, e2eeMap]);

  useEffect(() => {
    if (uniqueConversationIds.length === 0) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, E2EEStatus> = {};
      await Promise.all(
        uniqueConversationIds.map(async (conversationId) => {
          try {
            const result: any = await convex.query(
              (api as any).e2ee.getE2EEStatus,
              { conversationId },
            );
            next[conversationId] = {
              enabled: !!(result && result.enabled),
              salt: result?.salt || null,
              passphrase: result?.passphrase || null,
            };
          } catch {
            next[conversationId] = { enabled: false, salt: null, passphrase: null };
          }
        }),
      );
      if (!cancelled && Object.keys(next).length > 0) {
        setE2eeMap((current) => ({ ...current, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, uniqueConversationIds]);

  const decryptedList = useMemo(() => {
    return list.map((entry: any) => {
      if (!entry?.encrypted || !entry?.iv || typeof entry?.text !== 'string') {
        return entry;
      }
      const cid = String(entry?.conversationId || '');
      const e2ee = e2eeMap[cid];
      if (!e2ee?.enabled || !e2ee.passphrase || !e2ee.salt) {
        // Key not fetched yet (or E2EE disabled server-side) — show a
        // lock placeholder so we never leak ciphertext as a preview.
        return { ...entry, text: '🔒 Encrypted message', _wasEncrypted: true };
      }
      try {
        const plain = decryptText(entry.text, entry.iv, e2ee.passphrase, e2ee.salt);
        return { ...entry, text: plain, _wasEncrypted: true };
      } catch {
        return { ...entry, text: '🔒 Could not decrypt', _wasEncrypted: true, _decryptError: true };
      }
    });
  }, [list, e2eeMap]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="starred-screen">
      <Header title="Starred Messages" showBack onBack={() => router.back()} variant="dark" />
      <FlatList
        data={decryptedList}
        keyExtractor={(item: any, index: number) => item?._id || `${item?.conversationId}-${index}`}
        contentContainerStyle={styles.listContent}
        renderItem={({ item, index }) => (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.75}
            onPress={() => router.push(`/chat/${item.conversationId}` as any)}
            testID={`starred-message-${index}`}
          >
            <View style={styles.cardTop}>
              <Avatar
                name={item?.senderName || item?.conversationName || 'Smilers'}
                uri={item?.senderAvatarUrl || item?.conversationAvatarUrl}
                size={42}
              />
              <View style={styles.flexOne}>
                <Text style={styles.senderName} numberOfLines={1}>
                  {item?.senderName || 'Unknown sender'}
                </Text>
                <Text style={styles.conversationName} numberOfLines={1}>
                  {item?.conversationName || 'Conversation'}
                </Text>
              </View>
              <View style={styles.starChip}>
                <Ionicons name="star" size={14} color={Colors.primary} />
              </View>
            </View>

            <Text style={styles.messagePreview} numberOfLines={4}>
              {item?.text || item?.messageText || item?.preview || item?.fileName || item?.type || 'Starred message'}
            </Text>

            <View style={styles.cardBottom}>
              <Text style={styles.metaText} numberOfLines={1}>
                {item?.type ? String(item.type).toUpperCase() : 'MESSAGE'}
              </Text>
              <Feather name="arrow-up-right" size={16} color={Colors.textMuted} />
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.empty} testID="starred-empty-state">
            <Feather name="star" size={36} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No starred messages yet</Text>
            <Text style={styles.emptySub}>Long-press a message in chat and tap Star to keep it here.</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { padding: Spacing.base, paddingBottom: 40, gap: Spacing.base },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.base,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  flexOne: { flex: 1 },
  senderName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  conversationName: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  starChip: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messagePreview: { fontSize: FontSize.base, color: Colors.textPrimary, lineHeight: 22, marginTop: Spacing.base },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.base },
  metaText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.primary, letterSpacing: 1 },
  empty: { alignItems: 'center', paddingTop: Spacing.xxl * 2, paddingHorizontal: Spacing.lg, gap: 8 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary, textAlign: 'center' },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
});
