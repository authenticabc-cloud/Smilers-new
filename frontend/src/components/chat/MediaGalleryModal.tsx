import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useConvex } from 'convex/react';
import { useDecryptedMediaUrl } from '../../hooks/useDecryptedMediaUrl';
import { saveMessageMediaToGallery, shareMessage } from '../../lib/messageMedia';
import {
  closeGallery,
  getOpenMsgId,
  setGalleryHostMounted,
  subscribeGallery,
} from '../../lib/chat/mediaGalleryStore';
import { Colors } from '../../theme';

export type GalleryItem = { msgId: string; type: 'image' | 'video'; msg: any };

function GalleryImagePage({ msg, e2eeStatus, width }: { msg: any; e2eeStatus: any; width: number }) {
  const { url } = useDecryptedMediaUrl(msg, e2eeStatus);
  if (!url) {
    return (
      <View style={[styles.page, { width }]}>
        <ActivityIndicator color={Colors.white} />
      </View>
    );
  }
  return (
    <View style={[styles.page, { width }]}>
      <Image source={{ uri: url }} style={styles.media} resizeMode="contain" />
    </View>
  );
}

function GalleryVideoPage({
  msg,
  e2eeStatus,
  width,
  active,
}: {
  msg: any;
  e2eeStatus: any;
  width: number;
  active: boolean;
}) {
  const { url } = useDecryptedMediaUrl(msg, e2eeStatus);
  const player = useVideoPlayer(url ? { uri: url } : null, (p) => {
    p.loop = false;
  });
  // Only the visible page plays; pause the others so audio doesn't overlap.
  useEffect(() => {
    try {
      if (!active) player?.pause?.();
    } catch {
      /* ignore */
    }
  }, [active, player]);
  if (!url) {
    return (
      <View style={[styles.page, { width }]}>
        <ActivityIndicator color={Colors.white} />
      </View>
    );
  }
  return (
    <View style={[styles.page, { width }]}>
      <VideoView player={player} style={styles.media} contentFit="contain" nativeControls />
    </View>
  );
}

export default function MediaGalleryModal({
  items,
  e2eeStatus,
}: {
  items: GalleryItem[];
  e2eeStatus: any;
}) {
  const insets = useSafeAreaInsets();
  const convex = useConvex();
  const { width } = useWindowDimensions();
  const [openId, setOpenId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState<null | 'download' | 'share'>(null);
  const listRef = useRef<FlatList<GalleryItem>>(null);

  useEffect(() => {
    setGalleryHostMounted(true);
    const unsub = subscribeGallery(() => setOpenId(getOpenMsgId()));
    return () => {
      unsub();
      setGalleryHostMounted(false);
    };
  }, []);

  const visible = !!openId && items.length > 0;
  const initialIndex = Math.max(
    0,
    items.findIndex((it) => it.msgId === openId)
  );

  // Jump to the tapped item whenever the gallery is (re)opened.
  useEffect(() => {
    if (!visible) return;
    setActiveIndex(initialIndex);
    const t = setTimeout(() => {
      try {
        listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
      } catch {
        /* index may be momentarily out of range */
      }
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, openId]);

  const onScroll = useCallback(
    (e: any) => {
      const x = e?.nativeEvent?.contentOffset?.x ?? 0;
      const idx = Math.round(x / Math.max(1, width));
      if (idx !== activeIndex) setActiveIndex(idx);
    },
    [width, activeIndex]
  );

  const current = items[activeIndex];

  const handleDownload = useCallback(async () => {
    if (busy || !current) return;
    setBusy('download');
    try {
      await saveMessageMediaToGallery({ client: convex as any, message: current.msg });
    } finally {
      setBusy(null);
    }
  }, [busy, current, convex]);

  const handleShare = useCallback(async () => {
    if (busy || !current) return;
    setBusy('share');
    try {
      await shareMessage({ client: convex as any, message: current.msg });
    } finally {
      setBusy(null);
    }
  }, [busy, current, convex]);

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={closeGallery}
    >
      <View style={styles.wrap} testID="media-gallery">
        <FlatList
          ref={listRef}
          data={items}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(it) => it.msgId}
          getItemLayout={(_d, i) => ({ length: width, offset: width * i, index: i })}
          initialScrollIndex={initialIndex}
          onScroll={onScroll}
          scrollEventThrottle={16}
          onScrollToIndexFailed={({ index }) => {
            setTimeout(() => {
              try {
                listRef.current?.scrollToOffset({ offset: index * width, animated: false });
              } catch {
                /* ignore */
              }
            }, 60);
          }}
          renderItem={({ item, index }) =>
            item.type === 'video' ? (
              <GalleryVideoPage
                msg={item.msg}
                e2eeStatus={e2eeStatus}
                width={width}
                active={index === activeIndex}
              />
            ) : (
              <GalleryImagePage msg={item.msg} e2eeStatus={e2eeStatus} width={width} />
            )
          }
        />

        <TouchableOpacity
          style={[styles.close, { top: insets.top + 8 }]}
          onPress={closeGallery}
          hitSlop={12}
          testID="media-gallery-close"
        >
          <Feather name="x" size={28} color={Colors.white} />
        </TouchableOpacity>

        {items.length > 1 ? (
          <View style={[styles.counter, { top: insets.top + 12 }]} pointerEvents="none">
            <Text style={styles.counterText}>
              {activeIndex + 1} / {items.length}
            </Text>
          </View>
        ) : null}

        <View style={[styles.toolbar, { paddingBottom: Math.max(12, insets.bottom + 8) }]}>
          <TouchableOpacity style={styles.action} onPress={handleDownload} disabled={!!busy}>
            {busy === 'download' ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Feather name="download" size={22} color={Colors.white} />
            )}
            <Text style={styles.actionLabel}>Save</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.action} onPress={handleShare} disabled={!!busy}>
            {busy === 'share' ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Feather name="share-2" size={22} color={Colors.white} />
            )}
            <Text style={styles.actionLabel}>Share</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#000' },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  media: { width: '100%', height: '100%' },
  close: {
    position: 'absolute',
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  counterText: { color: Colors.white, fontSize: 14, fontWeight: '700' },
  toolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 40,
    paddingTop: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  action: { alignItems: 'center', gap: 4 },
  actionLabel: { color: Colors.white, fontSize: 12, fontWeight: '600' },
});
