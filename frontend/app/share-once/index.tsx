/**
 * Share Once home — your posts + posts shared with you, a compose FAB, and a
 * banner for pending delete requests on your posts.
 */
import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useMutation, useQuery } from 'convex/react';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../../src/convexApi';
import { Colors } from '../../src/theme';
import AudiencePicker, { AudienceSelection } from '../../src/components/shareOnce/AudiencePicker';
import Avatar from '../../src/components/Avatar';
import ShareOncePostThumb from '../../src/components/shareOnce/ShareOncePostThumb';
import ZoomableImage from '../../src/components/ZoomableImage';
import { getResolvedDisplayName, getSavedContactRecord } from '../../src/lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../../src/lib/deviceContactIndex';

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
  const repost = useMutation(api.shareOnce.repostToShareOnce);
  const deletePost = useMutation(api.shareOnce.deletePost);
  // Resolve author names to the viewer's DEVICE-saved contact name (not the
  // account name), matching the rest of the app.
  const myContacts = useQuery(api.contacts.getContacts, {}) as any[] | undefined;
  const deviceIndex = useDeviceContactIndex();
  const resolveAuthorName = (item: any) => {
    const rec = getSavedContactRecord(myContacts, { userId: item?.authorId }) || { _id: item?.authorId, name: item?.authorName };
    return getResolvedDisplayName(rec, deviceIndex, lookupDeviceContactName, item?.authorName || 'Smilers user');
  };

  // A post that hasn't been shared with anyone yet (e.g. forwarded from chat) —
  // the author picks its audience via the picker below.
  const [shareDraft, setShareDraft] = useState<any | null>(null);
  // Quick-peek at a photo/video from the list thumbnail (without opening the post).
  const [preview, setPreview] = useState<any | null>(null);
  const previewPlayer = useVideoPlayer(preview?.type === 'video' && preview?.mediaUrl ? preview.mediaUrl : '', (p) => {
    p.loop = false;
  });
  // Quick filter within My posts: show everything or only unshared drafts.
  const [mineFilter, setMineFilter] = useState<'all' | 'drafts'>('all');

  const isDraft = (p: any) => (p?.viewerCount ?? 0) === 0 && !p?.isDeleted;
  const draftCount = (mine || []).filter(isDraft).length;

  // Received posts grouped by sender (device-saved name), most-recent sender
  // first, newest post first within each sender — so multiple posts from one
  // person are easy to scan. A `__header` row is inserted before each group.
  const receivedGrouped = useMemo(() => {
    if (!received) return undefined;
    const groups = new Map<string, any[]>();
    for (const p of received) {
      const key = String(p.authorId || 'unknown');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    const entries = Array.from(groups.entries()).sort((a, b) => {
      const am = Math.max(...a[1].map((x) => x._creationTime || 0));
      const bm = Math.max(...b[1].map((x) => x._creationTime || 0));
      return bm - am;
    });
    const out: any[] = [];
    for (const [key, posts] of entries) {
      posts.sort((x, y) => (y._creationTime || 0) - (x._creationTime || 0));
      out.push({ __header: true, _id: `hdr-${key}`, title: resolveAuthorName(posts[0]), count: posts.length });
      out.push(...posts);
    }
    return out;
  }, [received, myContacts, deviceIndex]);

  const data =
    tab === 'mine'
      ? mineFilter === 'drafts'
        ? (mine || []).filter(isDraft)
        : mine
      : receivedGrouped;
  const loading = data === undefined;

  const shareDraftAudience = async (sel: AudienceSelection) => {
    const post = shareDraft;
    setShareDraft(null);
    if (!post) return;
    try {
      const res: any = await repost({ postId: post._id, ...sel });
      // The draft (0 viewers) has now been shared as a fresh post; remove the
      // leftover draft from my page to avoid a confusing duplicate.
      try {
        await deletePost({ postId: post._id });
      } catch {}
      Alert.alert('Shared', `${res?.viewerCount ?? 0} people can now view this.`);
    } catch (e: any) {
      Alert.alert('Could not share', e?.data?.message || e?.message || 'Try again.');
    }
  };

  const handleReq = (req: any) => {
    Alert.alert('Delete request', `${req.requesterName} asked to delete "${req.postPreview}". Delete it for them?`, [
      { text: 'Decline', onPress: () => respond({ requestId: req._id, accept: false }) },
      { text: 'Delete', style: 'destructive', onPress: () => respond({ requestId: req._id, accept: true }) },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <LinearGradient
        colors={['#7C3AED', '#C026D3']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.gradientHeader}
      >
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.gradientBack} testID="share-once-back">
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.gradientTitleWrap}>
          <Text style={styles.gradientTitle}>Share Once</Text>
          <Text style={styles.gradientSubtitle}>Post once, choose exactly who can view</Text>
        </View>
      </LinearGradient>

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

      {tab === 'mine' ? (
        <View style={styles.filterRow}>
          <TouchableOpacity
            style={[styles.filterChip, mineFilter === 'all' && styles.filterChipActive]}
            onPress={() => setMineFilter('all')}
            testID="share-once-filter-all"
          >
            <Text style={[styles.filterChipText, mineFilter === 'all' && styles.filterChipTextActive]}>All</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterChip, mineFilter === 'drafts' && styles.filterChipActive]}
            onPress={() => setMineFilter('drafts')}
            testID="share-once-filter-drafts"
          >
            <Ionicons name="cloud-offline-outline" size={13} color={mineFilter === 'drafts' ? '#fff' : '#b26a00'} />
            <Text style={[styles.filterChipText, mineFilter === 'drafts' && styles.filterChipTextActive]}>
              Drafts{draftCount > 0 ? ` (${draftCount})` : ''}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <FlatList
        data={data || []}
        keyExtractor={(i) => i._id}
        renderItem={({ item }) => (
          item.__header ? (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionHeaderText} numberOfLines={1}>{item.title}</Text>
              {item.count > 1 ? <Text style={styles.sectionHeaderCount}>{item.count}</Text> : null}
            </View>
          ) : (
          <TouchableOpacity
            style={styles.row}
            onPress={() => router.push(`/share-once/view?postId=${item._id}` as any)}
            testID={`share-once-post-${item._id}`}
          >
            {tab === 'received' ? (
              <View style={styles.avatarWrap}>
                <Avatar name={resolveAuthorName(item)} size={46} uri={item.authorAvatar || undefined} />
                <View style={styles.typeBadge}>
                  <Ionicons name={iconFor(item.type) as any} size={12} color={Colors.primary} />
                </View>
              </View>
            ) : (
              <ShareOncePostThumb
                type={item.type}
                mediaUrl={item.mediaUrl}
                icon={iconFor(item.type)}
                onPress={
                  (item.type === 'image' || item.type === 'video') && item.mediaUrl && !item.isDeleted
                    ? () => setPreview(item)
                    : undefined
                }
              />
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {tab === 'received' ? resolveAuthorName(item) : item.preview}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {tab === 'mine'
                  ? `${item.viewedCount ?? 0}/${item.viewerCount ?? 0} viewed`
                  : item.preview}
              </Text>
              {tab === 'mine' && (item.viewerCount ?? 0) === 0 && !item.isDeleted ? (
                <TouchableOpacity
                  style={styles.notSharedBadge}
                  onPress={() => setShareDraft(item)}
                  testID={`share-once-choose-audience-${item._id}`}
                >
                  <Ionicons name="people" size={13} color="#b26a00" />
                  <Text style={styles.notSharedText} numberOfLines={1}>Not shared yet — tap to choose who can view</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {tab === 'received' && (item.type === 'image' || item.type === 'video') && item.mediaUrl && !item.isDeleted ? (
              <ShareOncePostThumb type={item.type} mediaUrl={item.mediaUrl} icon={iconFor(item.type)} onPress={() => setPreview(item)} />
            ) : null}
            {tab === 'received' && !item.viewed ? <View style={styles.dot} /> : null}
            {tab === 'mine' && (item.viewerCount ?? 0) > 0 && !item.isDeleted ? (
              <View style={styles.seenBadge} testID={`share-once-seen-${item._id}`}>
                <Ionicons name="eye" size={13} color={Colors.primary} />
                <Text style={styles.seenBadgeText}>{item.viewedCount ?? 0}/{item.viewerCount ?? 0}</Text>
              </View>
            ) : null}
            <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
          )
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="share-social-outline" size={40} color={Colors.textSecondary} />
            <Text style={styles.emptyText}>{loading ? 'Loading…' : tab === 'mine' ? (mineFilter === 'drafts' ? 'No drafts — everything you\u2019ve posted is shared.' : 'You haven\u2019t shared anything yet.') : 'Nothing shared with you yet.'}</Text>
          </View>
        }
        contentContainerStyle={data && data.length === 0 ? { flexGrow: 1, justifyContent: 'center' } : { paddingVertical: 8 }}
      />

      <TouchableOpacity style={styles.fab} onPress={() => router.push('/share-once/compose' as any)} testID="share-once-fab">
        <Ionicons name="add" size={30} color="#fff" />
      </TouchableOpacity>

      <AudiencePicker
        visible={!!shareDraft}
        onClose={() => setShareDraft(null)}
        onConfirm={shareDraftAudience}
        confirmLabel="Share"
      />

      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <View style={styles.previewRoot}>
          {preview?.type === 'image' && preview?.mediaUrl ? (
            <ZoomableImage uri={preview.mediaUrl} onClose={() => setPreview(null)} />
          ) : preview?.type === 'video' && preview?.mediaUrl ? (
            <VideoView player={previewPlayer} style={styles.previewVideo} nativeControls allowsFullscreen />
          ) : null}
          <TouchableOpacity style={styles.previewClose} onPress={() => setPreview(null)} testID="share-once-preview-close">
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
        </View>
      </Modal>
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
  gradientHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 18, gap: 12 },
  gradientBack: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  gradientTitleWrap: { flex: 1 },
  gradientTitle: { fontSize: 24, fontWeight: '800', color: '#fff' },
  gradientSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.9)', marginTop: 2 },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.05)' },
  filterChipActive: { backgroundColor: '#b26a00' },
  filterChipText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  filterChipTextActive: { color: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  rowIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(233,181,59,0.15)', alignItems: 'center', justifyContent: 'center' },
  avatarWrap: { width: 46, height: 46 },
  typeBadge: { position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(233,181,59,0.25)', borderWidth: 2, borderColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  seenBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, backgroundColor: 'rgba(233,181,59,0.15)', marginRight: 4 },
  seenBadgeText: { fontSize: 12, fontWeight: '700', color: Colors.primary, fontVariant: ['tabular-nums'] },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  sectionHeaderText: { flex: 1, fontSize: 13, fontWeight: '800', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4 },
  sectionHeaderCount: { fontSize: 12, fontWeight: '700', color: Colors.primary, backgroundColor: 'rgba(233,181,59,0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  previewRoot: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  previewVideo: { width: '100%', height: '70%' },
  previewClose: { position: 'absolute', top: 48, right: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  rowSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  notSharedBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(233,181,59,0.18)', borderWidth: 1, borderColor: 'rgba(233,181,59,0.5)' },
  notSharedText: { fontSize: 11, fontWeight: '700', color: '#b26a00', maxWidth: 240 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },
  empty: { alignItems: 'center', gap: 10, padding: 24 },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  fab: { position: 'absolute', right: 20, bottom: 30, width: 58, height: 58, borderRadius: 29, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
});
