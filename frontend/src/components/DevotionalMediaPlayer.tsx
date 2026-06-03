/**
 * DevotionalMediaPlayer — inline player for voice / video devotionals.
 *
 * Resolves the storageId to a URL via api.files.getUrl (the same
 * mechanism MediaBubble uses) and renders either:
 *   - voice  : an audio play/pause control with elapsed-time read-out
 *   - video  : an expo-video VideoView with native controls
 *
 * Designed for the devotionals feed list — it tears down the
 * audio player on unmount so scrolling away kills any active playback.
 *
 * NOTE on imports: `expo-audio` and `expo-video` are required LAZILY
 * (inside the sub-components, not at module top-level). If a native
 * link issue makes one of them throw on import — e.g. the user's APK
 * predates the expo-audio config plugin — the WHOLE feed screen would
 * otherwise blow up. By deferring the require we contain the failure
 * to the specific bubble that needs it, and let the rest of the feed
 * render normally.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';

import { api } from '../convexApi';
import { Colors, FontSize, FontWeight, Radius } from '../theme';
import { useReactiveSafeConvexQuery } from '../hooks/useReactiveSafeConvexQuery';

interface Props {
  storageId: string;
  type: 'voice' | 'video';
  durationSec?: number;
  mimeType?: string;
  /** Optional accent colour for the play button (defaults to Colors.primary). */
  accentColor?: string;
}

function formatDuration(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────
// Lazy loaders — wrap `require()` in try/catch so a missing native
// module never crashes the JS bundle at module-load time.
// ─────────────────────────────────────────────────────────────────────
function loadExpoAudio(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-audio');
  } catch (err) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[DevotionalMediaPlayer] expo-audio require failed:', (err as Error)?.message);
    }
    return null;
  }
}

function loadExpoVideo(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-video');
  } catch (err) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[DevotionalMediaPlayer] expo-video require failed:', (err as Error)?.message);
    }
    return null;
  }
}

export default function DevotionalMediaPlayer({ storageId, type, durationSec, accentColor }: Props) {
  // Defensive — never call the query with an empty/bogus storageId, which
  // would surface a Convex validator error and could blow up the feed.
  const safeStorageId = typeof storageId === 'string' && storageId.length > 0 ? storageId : null;
  // Use a NON-THROWING safe query wrapper. Convex's vanilla `useQuery`
  // throws synchronously on a Server Error (which is what happened on
  // user device at iter-103 — the backend's files.getUrl returned
  // [CONVEX Q(files:getUrl)] Server Error, which propagated to the
  // ErrorBoundary and killed the whole Devotionals screen). With
  // useReactiveSafeConvexQuery the error becomes a value (`error`) and
  // we render an inline 'Media unavailable' placeholder instead of
  // crashing — the rest of the feed keeps working.
  const { data: mediaUrl, loading: mediaLoading, error: mediaError } = useReactiveSafeConvexQuery<string | null>(
    (api as any).files?.getUrl,
    safeStorageId ? { storageId: safeStorageId } : undefined,
    null,
    Boolean(safeStorageId),
  );

  if (!safeStorageId) {
    return (
      <View style={styles.errorWrap}>
        <Feather name="alert-circle" size={16} color={Colors.danger} />
        <Text style={styles.errorText}>Missing media</Text>
      </View>
    );
  }
  if (mediaLoading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={accentColor || Colors.primary} />
      </View>
    );
  }
  if (mediaError || !mediaUrl) {
    return (
      <View style={styles.errorWrap}>
        <Feather name="alert-circle" size={16} color={Colors.danger} />
        <Text style={styles.errorText}>
          {mediaError ? 'Media couldn\u2019t load' : 'Media unavailable'}
        </Text>
      </View>
    );
  }
  if (type === 'video') {
    return <DevotionalVideo url={mediaUrl as string} />;
  }
  return <DevotionalVoice url={mediaUrl as string} durationSec={durationSec} accentColor={accentColor} />;
}

function DevotionalVoice({
  url,
  durationSec,
  accentColor,
}: {
  url: string;
  durationSec?: number;
  accentColor?: string;
}) {
  const playerRef = useRef<any>(null);
  const statusSubRef = useRef<{ remove: () => void } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionSec, setPositionSec] = useState(0);
  const [audioAvailable, setAudioAvailable] = useState(true);

  useEffect(() => {
    // Check that expo-audio actually loaded; if not, render the disabled
    // state instead of a broken play button that throws on tap.
    const mod = loadExpoAudio();
    setAudioAvailable(!!mod?.createAudioPlayer);
    return () => {
      try {
        statusSubRef.current?.remove?.();
      } catch {}
      const p = playerRef.current;
      playerRef.current = null;
      if (p) {
        try {
          p.pause();
        } catch {}
        try {
          p.remove?.();
        } catch {}
      }
    };
  }, []);

  const toggle = () => {
    try {
      const mod = loadExpoAudio();
      if (!mod?.createAudioPlayer) {
        setAudioAvailable(false);
        return;
      }
      let p = playerRef.current;
      if (!p) {
        const newP = mod.createAudioPlayer({ uri: url });
        const sub = newP.addListener('playbackStatusUpdate', (status: any) => {
          if (!status) return;
          if (typeof status.isLoaded === 'boolean' && !status.isLoaded) return;
          setPlaying(!!status.playing);
          const cur = typeof status.currentTime === 'number' ? status.currentTime : 0;
          setPositionSec(cur);
          if (status.didJustFinish) {
            setPlaying(false);
            setPositionSec(0);
            try {
              newP.pause();
            } catch {}
            try {
              if (typeof newP.seekTo === 'function') void newP.seekTo(0);
              else newP.currentTime = 0;
            } catch {}
          }
        });
        statusSubRef.current = sub;
        playerRef.current = newP;
        p = newP;
      }
      if (p.playing) {
        p.pause();
      } else {
        p.play();
      }
    } catch (err) {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.warn('[DevotionalVoice] toggle failed:', (err as Error)?.message);
      }
    }
  };

  const total = durationSec || 0;
  const elapsedLabel = formatDuration(positionSec);
  const totalLabel = formatDuration(total);
  const playBg = accentColor || Colors.primary;

  return (
    <View style={styles.voiceWrap} testID="devotional-voice-player">
      <TouchableOpacity
        onPress={toggle}
        style={[styles.playButton, { backgroundColor: audioAvailable ? playBg : Colors.textMuted }]}
        hitSlop={8}
        testID="devotional-voice-toggle"
        disabled={!audioAvailable}
      >
        <Feather name={playing ? 'pause' : 'play'} size={20} color={Colors.white} />
      </TouchableOpacity>
      <View style={styles.voiceMeta}>
        <MaterialCommunityIcons
          name="microphone"
          size={16}
          color={Colors.textSecondary}
          style={styles.voiceIcon}
        />
        <Text style={styles.voiceTime}>
          {elapsedLabel}
          {total ? ` / ${totalLabel}` : ''}
          {!audioAvailable ? '  • audio unavailable' : ''}
        </Text>
      </View>
    </View>
  );
}

function DevotionalVideo({ url }: { url: string }) {
  // Resolve expo-video lazily. If the module isn't linked, render a
  // friendly placeholder instead of crashing the whole feed.
  const expoVideo = React.useMemo(() => loadExpoVideo(), []);
  const player = expoVideo?.useVideoPlayer
    ? expoVideo.useVideoPlayer({ uri: url }, (p: any) => {
        try {
          p.loop = false;
        } catch {}
      })
    : null;

  useEffect(() => {
    return () => {
      try {
        player?.pause();
      } catch {}
    };
  }, [player]);

  if (!expoVideo?.VideoView || !player) {
    return (
      <View style={[styles.videoWrap, styles.videoPlaceholder]}>
        <Feather name="alert-circle" size={20} color={Colors.white} />
        <Text style={styles.videoPlaceholderText}>Video unavailable on this build</Text>
      </View>
    );
  }

  const VideoView = expoVideo.VideoView;
  return (
    <View style={styles.videoWrap}>
      <VideoView
        player={player}
        style={styles.videoView}
        contentFit="cover"
        nativeControls
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    backgroundColor: Colors.background,
    paddingVertical: 18,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  errorWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.background,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: Radius.md,
  },
  errorText: { fontSize: FontSize.sm, color: Colors.danger },
  voiceWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.background,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: Radius.md,
    marginTop: 8,
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  voiceIcon: { marginRight: 2 },
  voiceTime: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.medium },
  videoWrap: {
    borderRadius: Radius.md,
    overflow: 'hidden',
    marginTop: 8,
    backgroundColor: '#000',
  },
  videoView: { width: '100%', height: 220 },
  videoPlaceholder: {
    paddingVertical: 32,
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 8,
  },
  videoPlaceholderText: {
    color: Colors.white,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
});
