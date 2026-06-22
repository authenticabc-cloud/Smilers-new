/**
 * CallReturnBanner — a slim "tap to return to call" bar pinned to the top of
 * every screen while a call is MINIMIZED (WhatsApp-style). It's a companion to
 * the draggable floating window: an always-visible, non-draggable way to jump
 * back into the call so a minimized call is never lost.
 */
import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { callHost, useCallHost } from '../../lib/call/callHost';

export default function CallReturnBanner() {
  const insets = useSafeAreaInsets();
  const { params, mode } = useCallHost();

  // Only while a call is minimized (full-screen mode already shows the call).
  if (Platform.OS === 'web' || !params || mode !== 'mini') return null;

  const name = String(params.displayName || '').trim();

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => callHost.maximize()}
      style={[styles.bar, { paddingTop: insets.top, height: insets.top + 38 }]}
      testID="call-return-banner"
    >
      <Ionicons name="call" size={15} color="#ffffff" />
      <Text style={styles.text} numberOfLines={1}>
        Tap to return to call{name ? ` · ${name}` : ''}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1FA855',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    zIndex: 9500,
    elevation: 9500,
  },
  text: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
});
