import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { callDebug, useCallDebugLog } from '../lib/callDebugLog';

/**
 * CallDebugOverlay — a small floating "bug" badge that the user can tap to
 * see the last ~60 call/screen-share events as plain English on screen.
 * Designed for production-APK debugging where `console.log` and
 * `adb logcat` aren't accessible.
 *
 * Place this once inside the call screen. It auto-subscribes to the
 * `callDebug` ring buffer and updates in real time.
 *
 * Color coding:
 *   • ERR  → red       — exceptions / failed mutations
 *   • PC   → cyan      — peer-connection lifecycle
 *   • SIG  → yellow    — signaling traffic (offer/answer/ICE)
 *   • SCRN → green     — screen-capture lifecycle
 *   • CALL → orange    — call-screen state transitions
 *   • OTHER→ white
 */
export default function CallDebugOverlay() {
  const events = useCallDebugLog();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Floating badge — bottom-right. Always visible, tap to open. */}
      <TouchableOpacity
        style={styles.badge}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.8}
        testID="call-debug-badge"
      >
        <Feather name="activity" size={16} color="#fff" />
        <Text style={styles.badgeText}>{events.length}</Text>
      </TouchableOpacity>

      {open ? (
        <View style={styles.panel} pointerEvents="box-none">
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Call Debug — last {events.length} events</Text>
            <TouchableOpacity
              style={styles.headerBtn}
              onPress={() => callDebug.clear()}
              testID="call-debug-clear"
            >
              <Feather name="trash-2" size={14} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.headerBtn}
              onPress={() => setOpen(false)}
              testID="call-debug-close"
            >
              <Feather name="x" size={16} color="#fff" />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {events.length === 0 ? (
              <Text style={styles.empty}>No events yet — start a call or screen share.</Text>
            ) : (
              events.slice().reverse().map((event) => (
                <View key={event.id} style={styles.row}>
                  <Text style={styles.rowTs}>
                    {new Date(event.ts).toLocaleTimeString().slice(-8)}
                  </Text>
                  <View style={[styles.tagWrap, tagStyles(event.tag)]}>
                    <Text style={styles.tagText}>{event.tag}</Text>
                  </View>
                  <Text style={styles.rowMsg} numberOfLines={3}>
                    {event.message}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>
          <Pressable style={styles.backdropTap} onPress={() => setOpen(false)} />
        </View>
      ) : null}
    </>
  );
}

const tagStyles = (tag: string) => {
  const t = tag.toUpperCase();
  if (t === 'ERR') return { backgroundColor: '#c0392b' };
  if (t === 'PC' || t === 'WEBRTC') return { backgroundColor: '#2980b9' };
  if (t === 'SIG') return { backgroundColor: '#d4ac0d' };
  if (t === 'SCRN' || t === 'SCREEN') return { backgroundColor: '#27ae60' };
  if (t === 'CALL') return { backgroundColor: '#d35400' };
  return { backgroundColor: '#555' };
};

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    minWidth: 54,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: 'rgba(20,20,20,0.85)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    zIndex: 9999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  panel: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 50,
    maxHeight: '60%',
    minHeight: 200,
    backgroundColor: 'rgba(15,15,15,0.97)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    zIndex: 9998,
    overflow: 'hidden',
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.15)',
    gap: 8,
  },
  panelTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  headerBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  empty: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
    fontStyle: 'italic',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 4,
    gap: 6,
  },
  rowTs: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    fontVariant: ['tabular-nums'],
    width: 64,
    marginTop: 2,
  },
  tagWrap: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    minWidth: 40,
    alignItems: 'center',
  },
  tagText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  rowMsg: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 11,
    lineHeight: 14,
    flex: 1,
  },
  backdropTap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: -1,
  },
});
