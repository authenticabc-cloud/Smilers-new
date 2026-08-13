/**
 * ShareOnceInvitePreview — the leading visual of a Share Once invite chat card.
 * For photo posts it lazily resolves a small thumbnail via getPostByToken (does
 * NOT mark the post viewed); for video posts it extracts a single still frame
 * with expo-video-thumbnails; every other content type shows the coloured type
 * icon. Kept as its own component so the getPostByToken subscription (and frame
 * extraction) only ever run for photo/video invites (hooks stay unconditional).
 */
import React, { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { useQuery } from 'convex/react';
import { api } from '../../convexApi';
import { styles } from './chatScreenStyles';

export default function ShareOnceInvitePreview({
  contentType,
  shareToken,
  icon,
}: {
  contentType: string;
  shareToken: string;
  icon: string;
}) {
  const isPhoto = contentType === 'photo';
  const isVideo = contentType === 'video';
  const wantMedia = isPhoto || isVideo;

  const data = useQuery(
    api.shareOnce.getPostByToken,
    wantMedia && shareToken ? { shareToken } : 'skip',
  ) as { post?: { mediaUrl?: string | null; isDeleted?: boolean } } | null | undefined;

  const mediaUrl = wantMedia && data?.post && !data.post.isDeleted ? data.post.mediaUrl || null : null;
  const [videoThumb, setVideoThumb] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (isVideo && mediaUrl) {
      VideoThumbnails.getThumbnailAsync(mediaUrl, { time: 1000, quality: 0.6 })
        .then((r) => {
          if (!cancelled) setVideoThumb(r.uri);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [isVideo, mediaUrl]);

  const thumbUrl = isVideo ? videoThumb : isPhoto ? mediaUrl : null;

  if (thumbUrl) {
    return (
      <View style={styles.shareOnceThumbWrap}>
        <Image source={{ uri: thumbUrl }} style={styles.shareOnceThumb} resizeMode="cover" />
        {isVideo ? (
          <View style={styles.shareOnceThumbPlay}>
            <Ionicons name="play" size={14} color="#fff" />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.shareOnceIcon}>
      <Ionicons name={icon as any} size={22} color="#fff" />
    </View>
  );
}
