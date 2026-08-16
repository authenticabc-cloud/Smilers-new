/**
 * Share Once — view a single post from an invite link (?t=token) or by id
 * (?postId=). Open/zoom photos, watch/play video & audio, download, share,
 * forward to chats, re-post, and delete (full 1:1 parity).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View, FlatList, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../src/convexApi';
import Header from '../../src/components/Header';
import { Colors } from '../../src/theme';
import AudiencePicker, { AudienceSelection } from '../../src/components/shareOnce/AudiencePicker';
import { ensureVoicePlaybackMode } from '../../src/lib/audio/voicePlaybackMode';
import ZoomableImage from '../../src/components/ZoomableImage';

export default function ShareOnceView() {
  const router = useRouter();
  const { t, postId } = useLocalSearchParams<{ t?: string; postId?: string }>();
  const byToken = useQuery(api.shareOnce.getPostByToken, t ? { shareToken: String(t) } : 'skip') as any;
  const byId = useQuery(api.shareOnce.getPost, postId ? { postId: String(postId) } : 'skip') as any;
  const access = t ? byToken : byId;

  const markViewed = useMutation(api.shareOnce.markViewed);
  const deletePost = useMutation(api.shareOnce.deletePost);
  const requestDeletion = useMutation(api.shareOnce.requestDeletion);
  const forwardTo = useMutation(api.shareOnce.forwardToConversations);
  const repost = useMutation(api.shareOnce.repostToShareOnce);
  const targets = useQuery(api.shareOnce.listForwardTargets, {}) as any[] | undefined;

  const [fwdOpen, setFwdOpen] = useState(false);
  const [repostOpen, setRepostOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [fwdSel, setFwdSel] = useState<Record<string, boolean>>({});
  const [fwdQ, setFwdQ] = useState('');

  const post = access?.post;
  const pid = post?._id;

  useEffect(() => {
    if (pid && access && !access.isAuthor && !access.viewed) markViewed({ postId: pid }).catch(() => {});
  }, [pid, access, markViewed]);

  const player = useVideoPlayer(post?.type === 'video' && post?.mediaUrl ? post.mediaUrl : '', (p) => { p.loop = false; });
  const audioPlayer = useVideoPlayer(post?.type === 'audio' || post?.type === 'voice' ? post?.mediaUrl || '' : '', (p) => { p.loop = false; });
  const audioStatus = useEvent(audioPlayer, 'playingChange', { isPlaying: audioPlayer?.playing ?? false });

  const download = useCallback(async () => {
    if (!post?.mediaUrl) return;
    try {
      const name = post.fileName || `smilers-${Date.now()}`;
      const dest = FileSystem.cacheDirectory + name.replace(/[^\w.\-]/g, '_');
      const dl = await FileSystem.downloadAsync(post.mediaUrl, dest);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(dl.uri);
      else Alert.alert('Saved', 'File downloaded.');
    } catch (e: any) {
      Alert.alert('Download failed', e?.message || 'Try again.');
    }
  }, [post]);

  const doDelete = useCallback(() => {
    if (!pid) return;
    const opts: any[] = [{ text: 'Cancel', style: 'cancel' }];
    if (access?.isAuthor) {
      opts.push({ text: 'Delete for everyone', style: 'destructive', onPress: () => deletePost({ postId: pid, forEveryone: true }).then(() => router.back()) });
      opts.push({ text: 'Delete for receivers', onPress: () => deletePost({ postId: pid, forReceiver: true }).then(() => router.back()) });
      opts.push({ text: 'Delete for me', onPress: () => deletePost({ postId: pid }).then(() => router.back()) });
    } else {
      opts.push({ text: 'Delete for me', onPress: () => deletePost({ postId: pid }).then(() => router.back()) });
      opts.push({ text: 'Ask author to delete', onPress: () => requestDeletion({ postId: pid }).then(() => Alert.alert('Requested', 'The author was asked to delete this.')) });
    }
    Alert.alert('Delete', 'Choose how to delete this post.', opts);
  }, [pid, access, deletePost, requestDeletion, router]);

  const confirmForward = useCallback(async () => {
    const ids = Object.keys(fwdSel).filter((k) => fwdSel[k]).slice(0, 10);
    if (!pid || !ids.length) return;
    try {
      const r: any = await forwardTo({ postId: pid, targetConversationIds: ids });
      setFwdOpen(false); setFwdSel({});
      Alert.alert('Forwarded', `Sent to ${r?.forwardedTo ?? ids.length} chat(s).`);
    } catch (e: any) {
      Alert.alert('Forward failed', e?.data?.message || e?.message || 'Try again.');
    }
  }, [fwdSel, pid, forwardTo]);

  const confirmRepost = useCallback(async (sel: AudienceSelection) => {
    if (!pid) return;
    try {
      const r: any = await repost({ postId: pid, ...sel });
      setRepostOpen(false);
      Alert.alert('Re-posted', `${r?.viewerCount ?? 0} people can now view it from your Share Once.`);
    } catch (e: any) {
      Alert.alert('Re-post failed', e?.data?.message || e?.message || 'Try again.');
    }
  }, [pid, repost]);

  const fwdFiltered = useMemo(() => {
    const s = fwdQ.trim().toLowerCase();
    const list = targets || [];
    return s ? list.filter((x) => x.name.toLowerCase().includes(s)) : list;
  }, [targets, fwdQ]);

  if (access === undefined && (t || postId)) {
    return <SafeAreaView style={styles.center}><ActivityIndicator color={Colors.primary} /></SafeAreaView>;
  }
  if (!access || !post) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Share Once" showBack onBack={() => router.back()} />
        <View style={styles.center}><Text style={styles.muted}>This post isn\u2019t available.</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header
        title={access.isAuthor ? 'Your post' : access.authorName}
        showBack
        onBack={() => router.back()}
        right={
          <TouchableOpacity onPress={doDelete} hitSlop={8} testID="share-once-view-delete">
            <Ionicons name="trash-outline" size={22} color="#e53935" />
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {post.isDeleted ? (
          <Text style={styles.tombstone}>{post.preview || 'This message was deleted'}</Text>
        ) : (
          <>
            {post.type === 'image' && post.mediaUrl ? (
              <TouchableOpacity activeOpacity={0.9} onPress={() => setZoomOpen(true)} testID="share-once-image">
                <Image source={{ uri: post.mediaUrl }} style={styles.media} resizeMode="contain" />
                <View style={styles.zoomHint}><Ionicons name="expand" size={14} color="#fff" /><Text style={styles.zoomHintText}>Tap to zoom</Text></View>
              </TouchableOpacity>
            ) : post.type === 'video' && post.mediaUrl ? (
              <VideoView player={player} style={styles.media} nativeControls allowsFullscreen />
            ) : (post.type === 'audio' || post.type === 'voice') && post.mediaUrl ? (
              <TouchableOpacity style={styles.audioBtn} onPress={async () => { if (audioStatus.isPlaying) { audioPlayer.pause(); } else { await ensureVoicePlaybackMode(); audioPlayer.play(); } }}>
                <Ionicons name={audioStatus.isPlaying ? 'pause-circle' : 'play-circle'} size={44} color={Colors.primary} />
                <Text style={styles.audioText}>{post.fileName || 'Audio'}</Text>
              </TouchableOpacity>
            ) : post.type === 'file' && post.mediaUrl ? (
              <TouchableOpacity style={styles.fileBox} onPress={download}>
                <Ionicons name="document" size={30} color={Colors.primary} />
                <Text style={styles.fileName} numberOfLines={2}>{post.fileName || 'File'}</Text>
              </TouchableOpacity>
            ) : null}

            {post.text ? <Text style={styles.body}>{post.text}</Text> : null}
            {post.isForwarded ? <Text style={styles.fw}>Forwarded{post.forwardCount ? ` ${post.forwardCount}\u00d7` : ''}</Text> : null}
          </>
        )}
      </ScrollView>

      {!post.isDeleted ? (
        <View style={styles.actionBar}>
          {post.mediaUrl ? <Action icon="download-outline" label="Save" onPress={download} /> : null}
          <Action icon="arrow-redo-outline" label="Forward" onPress={() => setFwdOpen(true)} />
          <Action icon="share-social-outline" label="Re-post" onPress={() => setRepostOpen(true)} />
        </View>
      ) : null}

      {/* Forward to chats */}
      {fwdOpen ? (
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Forward to chats</Text>
            <TouchableOpacity onPress={() => setFwdOpen(false)}><Ionicons name="close" size={24} color={Colors.textPrimary} /></TouchableOpacity>
          </View>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={18} color={Colors.textSecondary} />
            <TextInput style={styles.search} placeholder="Search" placeholderTextColor={Colors.textMuted} value={fwdQ} onChangeText={setFwdQ} />
          </View>
          <FlatList
            data={fwdFiltered}
            keyExtractor={(i) => i.conversationId}
            style={{ maxHeight: 320 }}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.fwRow} onPress={() => setFwdSel((p) => ({ ...p, [item.conversationId]: !p[item.conversationId] }))}>
                <Ionicons name={fwdSel[item.conversationId] ? 'checkbox' : 'square-outline'} size={22} color={fwdSel[item.conversationId] ? Colors.primary : Colors.textSecondary} />
                <Text style={styles.fwName} numberOfLines={1}>{item.name}{item.isGroup ? ' (group)' : ''}</Text>
              </TouchableOpacity>
            )}
          />
          <TouchableOpacity style={styles.sheetBtn} onPress={confirmForward}><Text style={styles.sheetBtnText}>Forward</Text></TouchableOpacity>
        </View>
      ) : null}

      <AudiencePicker visible={repostOpen} onClose={() => setRepostOpen(false)} onConfirm={confirmRepost} confirmLabel="Re-post" />

      {/* Full-screen pinch-to-zoom photo viewer */}
      <Modal visible={zoomOpen} transparent animationType="fade" onRequestClose={() => setZoomOpen(false)}>
        <View style={styles.zoomRoot}>
          {post.mediaUrl ? <ZoomableImage uri={post.mediaUrl} onClose={() => setZoomOpen(false)} /> : null}
          <TouchableOpacity style={styles.zoomClose} onPress={() => setZoomOpen(false)} testID="share-once-zoom-close">
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Action({ icon, label, onPress }: { icon: any; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.action} onPress={onPress} testID={`share-once-action-${label.toLowerCase()}`}>
      <Ionicons name={icon} size={22} color={Colors.primary} />
      <Text style={styles.actionText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.background },
  muted: { color: Colors.textSecondary, fontSize: 15 },
  media: { width: '100%', height: 320, borderRadius: 12, backgroundColor: '#000' },
  zoomHint: { position: 'absolute', bottom: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  zoomHintText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  zoomRoot: { flex: 1, backgroundColor: '#000' },
  zoomClose: { position: 'absolute', top: 44, right: 20, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  body: { fontSize: 16, color: Colors.textPrimary, marginTop: 14, lineHeight: 22 },
  fw: { fontSize: 12, color: Colors.textSecondary, marginTop: 8, fontStyle: 'italic' },
  tombstone: { fontSize: 15, color: Colors.textSecondary, fontStyle: 'italic', textAlign: 'center', padding: 30 },
  audioBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 18, borderRadius: 12, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  audioText: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  fileBox: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 18, borderRadius: 12, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  fileName: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  actionBar: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border || '#e5e7eb' },
  action: { alignItems: 'center', gap: 4 },
  actionText: { fontSize: 12, fontWeight: '700', color: Colors.textPrimary },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: Colors.background, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, elevation: 12, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 42, borderRadius: 10, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border || '#e5e7eb', marginBottom: 8 },
  search: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  fwRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  fwName: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  sheetBtn: { marginTop: 10, height: 48, borderRadius: 24, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  sheetBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
