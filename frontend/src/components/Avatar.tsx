import React, { useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { getDisplayInitials } from '../lib/displayName';
import { Colors, FontSize, FontWeight } from '../theme';

interface AvatarProps {
  name?: string;
  size?: number;
  uri?: string | null;
  backgroundColor?: string;
  textColor?: string;
}

/**
 * iter-140b: the Avatar component used to accept a `uri` prop but never
 * rendered an Image — so every conversation row, group header, and
 * status entry on native fell back to initials. Now we actually render
 * the photo when a URI is provided and gracefully fall back to initials
 * if the image fails to load (broken Convex storageId, expired CDN URL,
 * etc.). This brings the chat list, contact list, and conversation
 * headers into visual parity with the web app.
 */
export default function Avatar({
  name,
  size = 48,
  uri,
  backgroundColor,
  textColor,
}: AvatarProps) {
  const initial = getDisplayInitials(name);
  const fontSize = size * 0.45;
  const [imgFailed, setImgFailed] = useState(false);

  const radius = size / 2;
  const hasUri = typeof uri === 'string' && uri.trim().length > 0 && !imgFailed;

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: backgroundColor || Colors.primaryLight,
        },
      ]}
    >
      {hasUri ? (
        <Image
          source={{ uri: uri as string }}
          style={{ width: size, height: size, borderRadius: radius }}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <Text style={[styles.text, { fontSize, color: textColor || Colors.primary }]}>
          {initial}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  text: {
    fontWeight: FontWeight.bold,
  },
});
