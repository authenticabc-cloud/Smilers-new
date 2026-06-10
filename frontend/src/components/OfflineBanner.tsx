/**
 * OfflineBanner — iter 162.
 *
 * Tiny pill that surfaces when a screen is rendering stale cached data
 * (no live response yet). Tells the user WHY they're not seeing fresh
 * content and how old the cache is.
 *
 * Usage:
 *   <OfflineBanner ts={cacheTs} visible={!liveData && !!cacheTs} />
 *
 * `visible` is controlled by the parent so each screen decides what
 * "offline" means for its own data source.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

function formatAge(ts?: number): string {
  if (!ts) return '';
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function OfflineBanner({
  ts,
  visible,
}: {
  ts?: number;
  visible: boolean;
}) {
  if (!visible) return null;
  const age = ts ? formatAge(ts) : '';
  return (
    <View style={styles.bar} testID="offline-banner">
      <Feather name="wifi-off" size={14} color="#7C2D12" />
      <Text style={styles.text}>
        Offline {age ? `\u00B7 last synced ${age}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    backgroundColor: '#FEF3C7',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F59E0B66',
  },
  text: {
    fontSize: FontSize.sm,
    color: '#7C2D12',
    fontWeight: FontWeight.semibold,
  },
});

// re-export so we don't drop the Radius/Colors imports if tree-shaken
export const _OFFLINE_BANNER_PALETTE = { primary: Colors.primary, radius: Radius.md };
