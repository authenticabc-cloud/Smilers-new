/**
 * ConnectionStatusPill (iter-192) — tiny live indicator for the share
 * screen so it's instantly obvious whether the app is online, still
 * signing in (cold-start token refresh), or offline showing cached data.
 *
 *   🟢 Connected      — websocket up + Convex authenticated
 *   🟡 Signing in…    — websocket up but auth handshake still running
 *   ⚪ Offline        — no websocket; lists come from the saved cache
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useConvexAuth, useConvexConnectionState } from 'convex/react';
import { FontSize, FontWeight, Radius } from '../theme';

export function ConnectionStatusPill() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const connection = useConvexConnectionState();
  const socketUp = !!connection?.isWebSocketConnected;

  let dotColor = '#9CA3AF';
  let label = 'Offline — showing saved contacts';
  if (socketUp && isAuthenticated) {
    dotColor = '#16A34A';
    label = 'Connected';
  } else if (socketUp || isLoading) {
    dotColor = '#F59E0B';
    label = 'Signing in…';
  }

  return (
    <View style={styles.pill} testID="connection-status-pill">
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={styles.label} testID="connection-status-label">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginHorizontal: 16,
    marginTop: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
    color: '#6B7280',
  },
});
