/**
 * ShareOnceInvitePreview — the leading visual of a Share Once invite chat card.
 * For photo posts it lazily resolves a small thumbnail via getPostByToken (does
 * NOT mark the post viewed); for every other content type it shows the coloured
 * type icon. Kept as its own component so the getPostByToken subscription is
 * only ever mounted for photo invites (hooks stay unconditional here).
 */
import React from 'react';
import { Image, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
  const wantThumb = contentType === 'photo';
  const data = useQuery(
    api.shareOnce.getPostByToken,
    wantThumb && shareToken ? { shareToken } : 'skip',
  ) as { post?: { mediaUrl?: string | null; isDeleted?: boolean } } | null | undefined;

  const thumbUrl = wantThumb && data?.post && !data.post.isDeleted ? data.post.mediaUrl || null : null;

  if (thumbUrl) {
    return (
      <View style={styles.shareOnceThumbWrap}>
        <Image source={{ uri: thumbUrl }} style={styles.shareOnceThumb} resizeMode="cover" />
      </View>
    );
  }

  return (
    <View style={styles.shareOnceIcon}>
      <Ionicons name={icon as any} size={22} color="#fff" />
    </View>
  );
}
