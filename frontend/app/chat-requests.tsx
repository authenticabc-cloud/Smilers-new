/**
 * Chat requests inbox — accept-first messaging for non-contacts (#4).
 * Incoming pending requests can be Accepted (opens the 1:1) or Declined.
 * Outgoing requests show their status and can be Cancelled while pending.
 * Backend: native-chat-requests-contract.json (api.chatRequests.*).
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../src/convexApi';
import Header from '../src/components/Header';
import { Colors } from '../src/theme';

type RequestView = {
  requestId: string;
  otherUserId: string;
  otherUserName: string;
  otherUserAvatar?: string;
  status: 'pending' | 'accepted' | 'declined';
  message: string | null;
  conversationId: string | null;
  createdAt: string;
};

function initials(name?: string): string {
  if (!name) return '?';
  const p = String(name).trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p.length === 1 ? p[0][0] : p[0][0] + p[p.length - 1][0]).toUpperCase();
}

export default function ChatRequestsScreen() {
  const router = useRouter();
  const incoming = useQuery((api as any).chatRequests?.listIncoming, {}) as RequestView[] | undefined;
  const outgoing = useQuery((api as any).chatRequests?.listOutgoing, {}) as RequestView[] | undefined;
  const acceptM = useMutation((api as any).chatRequests?.accept);
  const declineM = useMutation((api as any).chatRequests?.decline);
  const cancelM = useMutation((api as any).chatRequests?.cancel);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming');

  const run = useCallback(
    async (id: string, fn: () => Promise<any>, onOk?: (r: any) => void) => {
      if (busyId) return;
      setBusyId(id);
      try {
        const r = await fn();
        onOk?.(r);
      } catch (e: any) {
        Alert.alert('Something went wrong', e?.data?.message || e?.message || 'Please try again.');
      } finally {
        setBusyId(null);
      }
    },
    [busyId],
  );

  const data = tab === 'incoming' ? incoming : outgoing;
  const loading = data === undefined;

  const renderItem = ({ item }: { item: RequestView }) => {
    const isBusy = busyId === item.requestId;
    return (
      <View style={styles.row} testID={`chat-request-${item.requestId}`}>
        <TouchableOpacity
          style={styles.avatarWrap}
          onPress={() => router.push(`/user/${item.otherUserId}` as any)}
          activeOpacity={0.7}
        >
          {item.otherUserAvatar ? (
            <Image source={{ uri: item.otherUserAvatar }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarText}>{initials(item.otherUserName)}</Text>
          )}
        </TouchableOpacity>
        <View style={styles.mid}>
          <Text style={styles.name} numberOfLines={1}>
            {item.otherUserName}
          </Text>
          {item.message ? (
            <Text style={styles.msg} numberOfLines={2}>
              “{item.message}”
            </Text>
          ) : (
            <Text style={styles.msgMuted} numberOfLines={1}>
              {tab === 'incoming' ? 'wants to chat with you' : `Request ${item.status}`}
            </Text>
          )}
        </View>

        {tab === 'incoming' ? (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.iconBtn, styles.acceptBtn]}
              disabled={isBusy}
              onPress={() =>
                run(item.requestId, () => acceptM({ requestId: item.requestId }), (r) => {
                  if (r?.conversationId) router.replace(`/chat/${r.conversationId}` as any);
                })
              }
              testID={`chat-request-accept-${item.requestId}`}
            >
              {isBusy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark" size={20} color="#fff" />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.iconBtn, styles.declineBtn]}
              disabled={isBusy}
              onPress={() => run(item.requestId, () => declineM({ requestId: item.requestId }))}
              testID={`chat-request-decline-${item.requestId}`}
            >
              <Ionicons name="close" size={20} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.actions}>
            {item.status === 'pending' ? (
              <TouchableOpacity
                style={[styles.iconBtn, styles.declineBtn]}
                disabled={isBusy}
                onPress={() => run(item.requestId, () => cancelM({ requestId: item.requestId }))}
                testID={`chat-request-cancel-${item.requestId}`}
              >
                {isBusy ? (
                  <ActivityIndicator size="small" color={Colors.textPrimary} />
                ) : (
                  <Text style={styles.cancelText}>Cancel</Text>
                )}
              </TouchableOpacity>
            ) : (
              <View style={[styles.statusPill, item.status === 'accepted' ? styles.pillOk : styles.pillNo]}>
                <Text style={[styles.statusPillText, item.status === 'accepted' ? { color: '#15803D' } : { color: Colors.textSecondary }]}>
                  {item.status === 'accepted' ? 'Accepted' : 'Declined'}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header title="Chat requests" showBack onBack={() => router.back()} />
      <View style={styles.tabs}>
        {(['incoming', 'outgoing'] as const).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabActive]}
            onPress={() => setTab(t)}
            testID={`chat-requests-tab-${t}`}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'incoming' ? 'Received' : 'Sent'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(i) => i.requestId}
          renderItem={renderItem}
          contentContainerStyle={data && data.length === 0 ? styles.center : styles.listContent}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="mail-open-outline" size={40} color={Colors.textSecondary} />
              <Text style={styles.emptyText}>
                {tab === 'incoming' ? 'No chat requests right now.' : "You haven't sent any requests."}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingVertical: 8 },
  tabs: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, gap: 10 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.05)', alignItems: 'center' },
  tabActive: { backgroundColor: Colors.primary },
  tabText: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  tabTextActive: { color: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  avatarWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: { width: 46, height: 46 },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  mid: { flex: 1 },
  name: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  msg: { fontSize: 13, color: Colors.textPrimary, marginTop: 2, fontStyle: 'italic' },
  msgMuted: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: { minWidth: 44, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  acceptBtn: { backgroundColor: '#1f9d57' },
  declineBtn: { backgroundColor: 'rgba(0,0,0,0.06)' },
  cancelText: { fontSize: 13, fontWeight: '700', color: Colors.textPrimary },
  statusPill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  pillOk: { backgroundColor: 'rgba(21,128,61,0.10)' },
  pillNo: { backgroundColor: 'rgba(0,0,0,0.05)' },
  statusPillText: { fontSize: 13, fontWeight: '700' },
  empty: { alignItems: 'center', gap: 10, padding: 24 },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
});
