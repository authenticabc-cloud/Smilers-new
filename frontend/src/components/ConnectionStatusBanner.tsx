/**
 * ConnectionStatusBanner (iter-221)
 * ------------------------------------------------------------------
 * Thin orange banner that appears at the top of the screen whenever
 * the Convex WebSocket has been disconnected for more than 5 seconds.
 * Gives the user a clear visual signal that the app is in "ghost
 * connection" recovery, plus a one-tap Retry button.
 *
 * Why 5 seconds (and not immediately):
 *   - During a brief auth re-handshake or background → foreground
 *     transition the socket can be in the "connecting" state for 1-2
 *     seconds. We don't want to flash an alarming banner for normal
 *     reconnects.
 *   - 5 seconds is comfortably longer than a healthy reconnect but
 *     still short enough that a real stall is surfaced quickly.
 *
 * The banner is purely informational — useConvexAutoReconnect already
 * runs heartbeats + foreground reconnects + chat-screen 5/12/20s
 * timers in the background. This is the user-facing receipt of those.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useConvex } from 'convex/react';
import { forceConvexReconnect } from '../providers/useConvexAutoReconnect';
import { recreateConvexClient } from '../providers/ConvexClientProvider';
import { Colors, FontSize, FontWeight, Spacing } from '../theme';

const SHOW_DELAY_MS = 5_000;

export default function ConnectionStatusBanner() {
  const client = useConvex();
  const [disconnected, setDisconnected] = useState(false);
  const disconnectedRef = useRef(false);

  useEffect(() => {
    if (!client || Platform.OS === 'web') return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | undefined;

    try {
      unsub = (client as any).subscribeToConnectionState?.((state: any) => {
        try {
          const ok = state?.isWebSocketConnected !== false;
          if (ok) {
            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }
            disconnectedRef.current = false;
            setDisconnected(false);
          } else {
            if (timeout) return; // already counting down
            timeout = setTimeout(() => {
              disconnectedRef.current = true;
              setDisconnected(true);
            }, SHOW_DELAY_MS);
          }
        } catch {
          /* never let a subscription callback crash the app */
        }
      });
    } catch {
      /* subscribeToConnectionState is marked unstable in Convex docs */
    }

    return () => {
      if (timeout) clearTimeout(timeout);
      try {
        unsub?.();
      } catch {}
    };
  }, [client]);

  if (!disconnected) return null;

  return (
    <View style={styles.banner} testID="connection-status-banner">
      <Feather name="wifi-off" size={14} color="#fff" style={{ marginRight: 6 }} />
      <Text style={styles.text}>Reconnecting…</Text>
      <TouchableOpacity
        onPress={() => {
          void forceConvexReconnect('connection-banner');
          // iter-383: if a FATAL desync killed the client, soft/hard reconnect
          // can't recover it — only replacing the client does. If we're still
          // disconnected a few seconds after the user asked to retry, recreate.
          setTimeout(() => {
            if (disconnectedRef.current) recreateConvexClient();
          }, 3500);
        }}
        style={styles.retryBtn}
        activeOpacity={0.7}
        testID="connection-banner-retry"
      >
        <Text style={styles.retryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f57c00', // warning orange — matches Material Design Warning 700
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
  },
  text: {
    color: '#fff',
    flex: 1,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
  retryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  retryText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
