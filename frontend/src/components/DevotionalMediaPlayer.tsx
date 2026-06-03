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
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import {
  createAudioPlayer,
  type AudioPlayer,
} from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';

import { api } from '../convexApi';
import { Colors, FontSize, FontWeight, Radius } from '../theme';

interface Props {
  storageId: string;
  type: 'voice' | 'video';
  durationSec?: number;
  mimeType?: string;
}

function formatDuration(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function DevotionalMediaPlayer({ storageId, type, durationSec }: Props) {
  const mediaUrl = useQuery((api as any).files?.getUrl, { storageId });

  if (mediaUrl === undefined) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  if (!mediaUrl) {
    return (
      <View style={styles.errorWrap}>
        <Feather name="alert-circle" size={16} color={Colors.danger} />
        <Text style={styles.errorText}>Media unavailable</Text>
      </View>
    );
  }

  if (type === 'video') {
    return <DevotionalVideo url={mediaUrl as string} />;
  }
  return <DevotionalVoice url={mediaUrl as string} durationSec={durationSec} />;
}

function DevotionalVoice({ url, durationSec }: { url: string; durationSec?: number }) {
  const playerRef = useRef<AudioPlayer | null>(null);
  const statusSubRef = useRef<{ remove: () => void } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionSec, setPositionSec] = useState(0);

  useEffect(() => {
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
          p.remove();
        } catch {}
      }
    };
  }, []);

  const toggle = () => {
    try {
      let p = playerRef.current;
      if (!p) {
        const newP = createAudioPlayer({ uri: url });
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
    } catch {}
  };

  const total = durationSec || 0;
  const elapsedLabel = formatDuration(positionSec);
  const totalLabel = formatDuration(total);

  return (
    <View style={styles.voiceWrap} testID="devotional-voice-player">
      <TouchableOpacity
        onPress={toggle}
        style={styles.playButton}
        hitSlop={8}
        testID="devotional-voice-toggle"
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
        </Text>
      </View>
    </View>
  );
}

function DevotionalVideo({ url }: { url: string }) {
  const player = useVideoPlayer({ uri: url }, (p) => {
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
});
