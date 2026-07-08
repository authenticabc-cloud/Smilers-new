import React, { useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../theme';

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/**
 * iter-331 — inline player for a Diary voice note / audio attachment.
 * Self-contained (own expo-audio player) so it can be used inside the
 * memoized diary renderItem without re-render churn.
 */
export default function DiaryAudioBubble({
  uri,
  duration,
  fileName,
}: {
  uri: string;
  duration?: number | null;
  fileName?: string | null;
}) {
  const player = useAudioPlayer(uri ? { uri } : null);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {}
    };
  }, [player]);

  const playing = !!status?.playing;
  const totalSec = duration || status?.duration || 0;
  const currentSec = status?.currentTime || 0;
  const progress = totalSec > 0 ? Math.min(1, currentSec / totalSec) : 0;

  const toggle = () => {
    try {
      if (playing) {
        player.pause();
      } else {
        if (status?.didJustFinish || (totalSec > 0 && currentSec >= totalSec - 0.2)) {
          player.seekTo(0);
        }
        player.play();
      }
    } catch {}
  };

  return (
    <View style={styles.wrap}>
      <TouchableOpacity onPress={toggle} style={styles.playBtn} hitSlop={8} testID="diary-audio-play">
        <MaterialCommunityIcons name={playing ? 'pause' : 'play'} size={20} color={Colors.white} />
      </TouchableOpacity>
      <View style={styles.flexOne}>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
        <Text style={styles.time} numberOfLines={1}>
          {fileName ? `${fileName} · ` : ''}
          {fmt(playing || currentSec > 0 ? currentSec : totalSec)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 200 },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.diaryDark || Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flexOne: { flex: 1 },
  track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.15)', overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: Colors.diaryDark || Colors.primary },
  time: { marginTop: Spacing.xs, fontSize: FontSize.xs, color: Colors.textMuted, fontWeight: FontWeight.medium },
});
