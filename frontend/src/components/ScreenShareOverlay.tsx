/**
 * ScreenShareOverlay — full-screen UI used by /call/[id] when the route
 * is in standalone screen-share mode (`?screenOnly=1`).
 *
 * Two roles:
 *   • Sender (broadcaster): pulsing "Sharing your screen" indicator + Start/Stop
 *     button + optional mic toggle (only when sender opted-in to mic narration).
 *   • Receiver (viewer): fullscreen render of the incoming RTC stream + Stop button.
 *
 * The overlay sits on top of the call screen's normal layout; the underlying
 * WebRTC peer / signaling / screen capture continues to run untouched.
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';
import ScreenShareSwitchControls from './ScreenShareSwitchControls';

interface ScreenShareOverlayProps {
  isReceiver: boolean;
  remoteStreamURL: string | null;
  allowMic: boolean;
  muted: boolean;
  onToggleMic: () => void;
  screenSharing: boolean;
  /** iter-189: true only once the WebRTC connection is actually live —
   * drives honest "Waiting for recipient…" copy on the sharer side. */
  peerConnected?: boolean;
  onToggleScreenShare: () => void | Promise<void>;
  onStop: () => void;
  RTCViewImpl: any;
  /** Screen-share quality profile + setter (sender-side toggle). */
  screenQuality?: 'sharp' | 'smooth';
  onSelectQuality?: (mode: 'sharp' | 'smooth') => void;
  /** Active screen-share session id (used by switch-share controls). */
  sessionId?: string | null;
  /** Conversation id backing the session (sharer-side `getActiveSession` query). */
  conversationId?: string | null;
}

export default function ScreenShareOverlay({
  isReceiver,
  remoteStreamURL,
  allowMic,
  muted,
  onToggleMic,
  screenSharing,
  peerConnected = false,
  onToggleScreenShare,
  onStop,
  RTCViewImpl,
  screenQuality = 'sharp',
  onSelectQuality,
  sessionId,
  conversationId,
}: ScreenShareOverlayProps) {
  const insets = useSafeAreaInsets();
  const pulse = useRef(new Animated.Value(0)).current;

  // Pulse animation on the broadcasting dot.
  useEffect(() => {
    if (isReceiver || !screenSharing) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, isReceiver, screenSharing]);

  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.45],
  });
  const pulseOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.55, 0],
  });

  // ---- Receiver mode --------------------------------------------------------
  if (isReceiver) {
    return (
      <View style={styles.viewerRoot} testID="screen-share-overlay-receiver">
        {remoteStreamURL && RTCViewImpl ? (
          <RTCViewImpl
            streamURL={remoteStreamURL}
            style={StyleSheet.absoluteFill}
            objectFit="contain"
            mirror={false}
          />
        ) : (
          <View style={styles.viewerPlaceholder}>
            <MaterialCommunityIcons name="monitor-share" size={72} color="rgba(255,255,255,0.6)" />
            <Text style={styles.viewerWaitTitle}>Connecting to screen…</Text>
            <Text style={styles.viewerWaitBody}>
              {'Waiting for the sender\u2019s screen to start broadcasting.'}
            </Text>
          </View>
        )}

        <SafeAreaView edges={['top']} style={styles.viewerTopBar} pointerEvents="box-none">
          <View style={styles.viewerLiveTag}>
            <View style={styles.liveDot} />
            <Text style={styles.viewerLiveText}>Watching shared screen</Text>
          </View>
        </SafeAreaView>

        <View style={[styles.viewerStopWrap, { paddingBottom: Math.max(insets.bottom, 18) }]}>
          {/* Switch-share request (viewer asks sharer to swap roles). */}
          <ScreenShareSwitchControls sessionId={sessionId || null} role="viewer" />
          <TouchableOpacity
            style={styles.stopBtnDanger}
            onPress={onStop}
            activeOpacity={0.85}
            testID="screen-share-stop-viewer"
          >
            <Feather name="x" size={22} color={Colors.white} />
            <Text style={styles.stopBtnText}>Leave screen share</Text>
          </TouchableOpacity>
        </View>
        {/* If this device is also the sharer in another flow (shouldn't normally
            happen on viewer route), still mount the sharer modal listener so
            edge cases work. */}
        <ScreenShareSwitchControls
          sessionId={sessionId || null}
          conversationId={conversationId || null}
          role="sharer"
        />
      </View>
    );
  }

  // ---- Sender (broadcaster) mode -------------------------------------------
  return (
    <View style={styles.senderRoot} testID="screen-share-overlay-sender">
      <SafeAreaView edges={['top']} style={styles.senderTopBar}>
        <Text style={styles.senderTopBarText}>Screen Share</Text>
      </SafeAreaView>

      <View style={styles.senderBody}>
        {/* Pulsing broadcast dot */}
        <View style={styles.broadcastWrap}>
          <Animated.View
            style={[
              styles.broadcastPulse,
              { transform: [{ scale: pulseScale }], opacity: pulseOpacity },
            ]}
          />
          <View style={styles.broadcastDot}>
            <MaterialCommunityIcons name="monitor-share" size={42} color="#3D2A00" />
          </View>
        </View>

        <Text style={styles.senderHeading} testID="screen-share-sender-heading">
          {screenSharing
            ? peerConnected
              ? 'You\u2019re sharing your screen'
              : 'Waiting for the recipient to accept\u2026'
            : Platform.OS === 'ios'
              ? 'Tap "Start sharing" — iOS will show its broadcast picker'
              : 'Tap "Start sharing" to begin'}
        </Text>
        <Text style={styles.senderSubtitle} testID="screen-share-sender-subtitle">
          {screenSharing
            ? peerConnected
              ? `The recipient can see everything on your screen${
                  allowMic && !muted ? ' and hear you talking.' : '.'
                }`
              : 'Your screen will start broadcasting the moment they accept your request.'
            : 'You\u2019ll be asked to confirm screen recording before broadcasting starts.'}
        </Text>

        {/* Start/Stop screen-share button */}
        <TouchableOpacity
          style={[styles.broadcastBtn, screenSharing ? styles.broadcastBtnActive : null]}
          onPress={onToggleScreenShare}
          activeOpacity={0.85}
          testID="screen-share-toggle-broadcast"
        >
          <MaterialCommunityIcons
            name={screenSharing ? 'stop-circle' : 'play-circle'}
            size={22}
            color="#3D2A00"
          />
          <Text style={styles.broadcastBtnText}>
            {screenSharing ? 'Stop sharing' : 'Start sharing'}
          </Text>
        </TouchableOpacity>

        {/* Quality toggle — Sharp (resolution, best for text) vs Smooth
            (framerate, best for video/motion). */}
        {onSelectQuality ? (
          <View style={styles.qualityRow} testID="screen-share-quality-toggle">
            <TouchableOpacity
              style={[styles.qualityChip, screenQuality === 'sharp' ? styles.qualityChipActive : null]}
              onPress={() => onSelectQuality('sharp')}
              activeOpacity={0.85}
              testID="screen-share-quality-sharp"
            >
              <MaterialCommunityIcons
                name="text-box-outline"
                size={16}
                color={screenQuality === 'sharp' ? '#3D2A00' : 'rgba(255,255,255,0.85)'}
              />
              <Text style={[styles.qualityChipText, screenQuality === 'sharp' ? styles.qualityChipTextActive : null]}>
                Sharp
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.qualityChip, screenQuality === 'smooth' ? styles.qualityChipActive : null]}
              onPress={() => onSelectQuality('smooth')}
              activeOpacity={0.85}
              testID="screen-share-quality-smooth"
            >
              <MaterialCommunityIcons
                name="play-speed"
                size={16}
                color={screenQuality === 'smooth' ? '#3D2A00' : 'rgba(255,255,255,0.85)'}
              />
              <Text style={[styles.qualityChipText, screenQuality === 'smooth' ? styles.qualityChipTextActive : null]}>
                Smooth
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {onSelectQuality ? (
          <Text style={styles.qualityHint}>
            {screenQuality === 'sharp'
              ? 'Crisp text & detail — best for documents and code.'
              : 'Higher frame rate — best for video and animation.'}
          </Text>
        ) : null}

        {/* Optional mic toggle — only when the sender opted-in to mic narration */}
        {allowMic ? (
          <TouchableOpacity
            style={styles.micRow}
            onPress={onToggleMic}
            activeOpacity={0.85}
            testID="screen-share-toggle-mic"
          >
            <Feather name={muted ? 'mic-off' : 'mic'} size={18} color={Colors.textSecondary} />
            <Text style={styles.micRowText}>
              {muted ? 'Microphone muted' : 'Microphone live'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={[styles.senderFooter, { paddingBottom: Math.max(insets.bottom, 18) }]}>
        <TouchableOpacity
          style={styles.stopBtnDanger}
          onPress={onStop}
          activeOpacity={0.85}
          testID="screen-share-stop-sender"
        >
          <Feather name="x" size={22} color={Colors.white} />
          <Text style={styles.stopBtnText}>End screen share</Text>
        </TouchableOpacity>
      </View>
      {/* Sharer-side listener: shows accept/decline modal when a viewer
          requests to take over the share. Safe no-op if backend mutations
          aren't deployed yet. */}
      <ScreenShareSwitchControls
        sessionId={sessionId || null}
        conversationId={conversationId || null}
        role="sharer"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // ---- Sender ----
  senderRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#3D2A00',
  },
  senderTopBar: {
    backgroundColor: 'transparent',
    paddingHorizontal: Spacing.lg,
    paddingTop: 4,
  },
  senderTopBarText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.lg,
    paddingVertical: 12,
  },
  senderBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: 18,
  },
  broadcastWrap: {
    width: 132,
    height: 132,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  broadcastPulse: {
    position: 'absolute',
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: Colors.primary,
  },
  broadcastDot: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  senderHeading: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    textAlign: 'center',
  },
  senderSubtitle: {
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.78)',
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 20,
  },
  broadcastBtn: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  broadcastBtnActive: {
    backgroundColor: '#FFEAA0',
  },
  broadcastBtnText: {
    color: '#3D2A00',
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },
  micRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: Radius.pill,
  },
  micRowText: {
    color: 'rgba(255,255,255,0.85)',
    fontWeight: FontWeight.semibold,
    fontSize: FontSize.sm,
  },
  qualityRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  qualityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  qualityChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  qualityChipText: {
    color: 'rgba(255,255,255,0.85)',
    fontWeight: FontWeight.semibold,
    fontSize: FontSize.sm,
  },
  qualityChipTextActive: {
    color: '#3D2A00',
  },
  qualityHint: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: FontSize.sm,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 20,
  },
  senderFooter: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
  },
  stopBtnDanger: {
    minHeight: 56,
    borderRadius: Radius.md,
    backgroundColor: '#DC2626',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  stopBtnText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
  },

  // ---- Receiver / viewer ----
  viewerRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0B0B0E',
  },
  viewerPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: Spacing.xl,
  },
  viewerWaitTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: 'rgba(255,255,255,0.9)',
    textAlign: 'center',
  },
  viewerWaitBody: {
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.65)',
    textAlign: 'center',
    lineHeight: 22,
  },
  viewerTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.lg,
  },
  viewerLiveTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
    marginTop: 12,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  viewerLiveText: {
    color: Colors.white,
    fontWeight: FontWeight.semibold,
    fontSize: FontSize.sm,
  },
  viewerStopWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
  },
});
