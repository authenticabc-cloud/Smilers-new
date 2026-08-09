/**
 * DevotionalMediaPlayer — inline player for voice / video devotionals.
 *
 * iter-106 SWITCHOVER: the Convex `api.files.getUrl` endpoint is NOT
 * deployed on this app's backend (the `messages.list` query already
 * server-side-resolves storage IDs into a `mediaUrl` field — see
 * src/hooks/useResolvedStorageUrl.ts). Calling `files.getUrl` from
 * the device returned `[CONVEX Q(files:getUrl)] Server Error` →
 * "Media couldn't load" red bubble in screenshot from user.
 *
 * Devotional feed items already carry the resolved URL on at least
 * one of `mediaUrl` / `fileUrl` / `url` (depending on backend
 * version). This component now reads THAT field directly and only
 * shows the "Media unavailable" placeholder when NO URL field
 * exists at all — which is the only situation that's actually
 * unrecoverable from the client.
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
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';

import { Colors, FontSize, FontWeight, Radius } from '../theme';
import { ensureVoicePlaybackMode } from '../lib/audio/voicePlaybackMode';
import { recordDiagnostic } from '../lib/diagnostics';

interface Props {
  /** Optional — the raw storage ID. Kept for backwards compat / logs. */
  storageId?: string;
  /** Pre-resolved playable URL from the backend (`mediaUrl` / `fileUrl`). */
  mediaUrl?: string | null;
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
    const m = require('expo-audio');
    if (!m?.createAudioPlayer) {
      // Loaded, but the native side is missing/unlinked — this is what a
      // silently-absent module looks like from JS. Report it.
      recordDiagnostic({
        tag: 'AUDIO',
        source: 'DevotionalMediaPlayer',
        message: 'expo-audio loaded but createAudioPlayer is missing (native module not linked?)',
      });
    }
    return m;
  } catch (err) {
    // Was __DEV__-only, so production had ZERO signal for dead audio.
    recordDiagnostic({
      tag: 'AUDIO',
      source: 'DevotionalMediaPlayer',
      message: `expo-audio require failed: ${(err as Error)?.message}`,
    });
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

export default function DevotionalMediaPlayer({ mediaUrl, type, durationSec, accentColor }: Props) {
  // The backend's `devotionals.getFeed` resolves storage IDs into a
  // `mediaUrl` field. Some older deployments may use `fileUrl` or `url`
  // — we accept any of them at the call site via the union type.
  const resolved = typeof mediaUrl === 'string' && mediaUrl.length > 0 ? mediaUrl : null;

  if (!resolved) {
    return (
      <View style={styles.errorWrap} testID="devotional-media-unavailable">
        <Feather name="alert-circle" size={16} color={Colors.danger} />
        <Text style={styles.errorText}>Media unavailable</Text>
      </View>
    );
  }
  if (type === 'video') {
    return <DevotionalVideo url={resolved} />;
  }
  return <DevotionalVoice url={resolved} durationSec={durationSec} accentColor={accentColor} />;
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

  const toggle = async () => {
    try {
      const mod = loadExpoAudio();
      if (!mod?.createAudioPlayer) {
        setAudioAvailable(false);
        return;
      }
      // Configure the audio session (playsInSilentMode / background) BEFORE
      // the first play so voice devotionals actually produce sound on iOS —
      // without this the clip loads but stays silent when the ringer switch
      // is on. Safe to call repeatedly; it self-guards after the first apply.
      await ensureVoicePlaybackMode();
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
  // Resolve expo-video lazily. If the module isn't linked at all (missing
  // `useVideoPlayer` / `VideoView` exports), render a friendly placeholder
  // instead of crashing the whole feed. The module-loaded state is stable
  // for the life of the process, so this early return never changes the
  // hook order between renders (the real player hook lives in the inner
  // component below, called unconditionally).
  const expoVideo = React.useMemo(() => loadExpoVideo(), []);
  if (!expoVideo?.useVideoPlayer || !expoVideo?.VideoView) {
    return (
      <View style={[styles.videoWrap, styles.videoPlaceholder]}>
        <Feather name="alert-circle" size={20} color={Colors.white} />
        <Text style={styles.videoPlaceholderText}>Video unavailable on this build</Text>
      </View>
    );
  }
  return <ExpoVideoInner expoVideo={expoVideo} url={url} />;
}

// Rendered ONLY when expo-video is available, so `useVideoPlayer` is always
// called (never behind a conditional) — satisfying the rules of hooks.
function ExpoVideoInner({ expoVideo, url }: { expoVideo: any; url: string }) {
  const player = expoVideo.useVideoPlayer({ uri: url }, (p: any) => {
    try {
      p.loop = false;
    } catch {}
  });

  useEffect(() => {
    return () => {
      try {
        player?.pause();
      } catch {}
    };
  }, [player]);

  const VideoView = expoVideo.VideoView;
  return (
    <View style={styles.videoWrap}>
      {/* If the native ExpoVideo Fabric view isn't registered in this iOS
          build (the "Unimplemented component: ViewManagerAdapter_ExpoVideo_
          VideoView" error), rendering <VideoView> throws at native mount.
          The VideoErrorBoundary catches that and shows a clean placeholder
          instead of a full-width red error box. */}
      <VideoErrorBoundary>
        <VideoView player={player} style={styles.videoView} contentFit="cover" nativeControls />
      </VideoErrorBoundary>
    </View>
  );
}

// Local error boundary — the ONLY reliable way to intercept a native
// "Unimplemented component" render failure from JS and degrade gracefully.
class VideoErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[DevotionalVideo] native VideoView failed:', (err as Error)?.message);
    }
  }
  render() {
    if (this.state.failed) {
      return (
        <View style={styles.videoPlaceholderInline}>
          <Feather name="video-off" size={20} color={Colors.white} />
          <Text style={styles.videoPlaceholderText}>Video can&apos;t play on this build</Text>
        </View>
      );
    }
    return this.props.children as React.ReactElement;
  }
}

const styles = StyleSheet.create({
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
  videoPlaceholderInline: {
    width: '100%',
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#000',
  },
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
