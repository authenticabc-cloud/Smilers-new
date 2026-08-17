/**
 * ShareOncePostThumb — leading visual for a row in the Share Once "My posts"
 * list. Shows a small preview thumbnail for photo posts (mediaUrl) and video
 * posts (a still frame extracted with expo-video-thumbnails, with a play badge);
 * every other type falls back to the coloured type icon.
 */
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Colors } from '../../theme';

export default function ShareOncePostThumb({
  type,
  mediaUrl,
  icon,
}: {
  type: string;
  mediaUrl?: string | null;
  icon: string;
}) {
  const isPhoto = type === 'image';
  const isVideo = type === 'video';
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

  const thumb = isPhoto ? mediaUrl : isVideo ? videoThumb : null;

  if (thumb) {
    return (
      <View style={styles.wrap}>
        <Image source={{ uri: thumb }} style={styles.img} resizeMode="cover" />
        {isVideo ? (
          <View style={styles.play}>
            <Ionicons name="play" size={13} color="#fff" />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.icon}>
      <Ionicons name={icon as any} size={22} color={Colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: 42, height: 42, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
  img: { width: 42, height: 42 },
  play: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  icon: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(233,181,59,0.15)', alignItems: 'center', justifyContent: 'center' },
});
