/**
 * Share Once home — your posts + posts shared with you, a compose FAB, and a
 * banner for pending delete requests on your posts.
 */
import React, { useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../src/convexApi';
import Header from '../../src/components/Header';
import { Colors } from '../../src/theme';

function iconFor(type: string) {
  return type === 'image' ? 'image' : type === 'video' ? 'videocam' : type === 'audio' || type === 'voice' ? 'musical-notes' : type === 'file' ? 'document' : 'chatbubble-ellipses';
}

export default function ShareOnceHome() {
  const router = useRouter();
  const [tab, setTab] = useState<'mine' | 'received'>('mine');
  const mine = useQuery(api.shareOnce.listMyPosts, {}) as any[] | undefined;
  const received = useQuery(api.shareOnce.listReceived, {}) as any[] | undefined;
  const pending = useQuery(api.shareOnce.getPendingDeletionRequests, {}) as any[] | undefined;
  const respond = useMutation(api.shareOnce.respondToDeletionRequest);

  const data = tab === 'mine' ? mine : received;
  const loading = data === undefined;

  const handleReq = (req: any) => {
    Alert.alert('Delete request', `${req.requesterName} asked to delete "${req.postPreview}". Delete it for them?`, [
      { text: 'Decline', onPress: () => respond({ requestId: req._id, accept: false }) },
      { text: 'Delete', style: 'destructive', onPress: () => respond({ requestId: req._id, accept: true }) },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header title="Share Once" showBack onBack={() => router.back()} />

      {pending && pending.length > 0 ? (
        <TouchableOpacity style={styles.reqBanner} onPress={() => handleReq(pending[0])} testID="share-once-delreq">
          <Ionicons name="alert-circle" size={18} color="#fff" />
          <Text style={styles.reqText} numberOfLines={1}>{pending.length} delete request{pending.length > 1 ? 's' : ''} — tap to review</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.tabs}>
        {(['mine', 'received'] as const).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)} testID={`share-once-tab-${t}`}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t === 'mine' ? 'My posts' : 'Received'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={data || []}
        keyExtractor={(i) => i._id}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => router.push(`/share-once/view?postId=${item._id}` as any)}
            testID={`share-once-post-${item._id}`}
          >
            <View style={styles.rowIcon}>
              <Ionicons name={iconFor(item.type) as any} size={22} color={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {tab === 'received' ? item.authorName : item.preview}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {tab === 'mine'
                  ? `${item.viewedCount ?? 0}/${item.viewerCount ?? 0} viewed`
                  : item.preview}
              </Text>
            </View>
            {tab === 'received' && !item.viewed ? <View style={styles.dot} /> : null}
            <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="share-social-outline" size={40} color={Colors.textSecondary} />
            <Text style={styles.emptyText}>{loading ? 'Loading…' : tab === 'mine' ? 'You haven\u2019t shared anything yet.' : 'Nothing shared with you yet.'}</Text>
          </View>
        }
        contentContainerStyle={data && data.length === 0 ? { flexGrow: 1, justifyContent: 'center' } : { paddingVertical: 8 }}
      />

      <TouchableOpacity style={styles.fab} onPress={() => router.push('/share-once/compose' as any)} testID="share-once-fab">
        <Ionicons name="add" size={30} color="#fff" />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  reqBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#e67e22', marginHorizontal: 16, marginTop: 10, padding: 10, borderRadius: 10 },
  reqText: { flex: 1, color: '#fff', fontWeight: '700', fontSize: 13 },
  tabs: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.05)' },
  tabActive: { backgroundColor: Colors.primary },
  tabText: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  tabTextActive: { color: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  rowIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(233,181,59,0.15)', alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  rowSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },
  empty: { alignItems: 'center', gap: 10, padding: 24 },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  fab: { position: 'absolute', right: 20, bottom: 30, width: 58, height: 58, borderRadius: 29, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
});
