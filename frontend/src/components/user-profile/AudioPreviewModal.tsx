/**
 * AudioPreviewModal — plays a shared AUDIO file (m4a/mp3/etc.) from the user
 * profile "Files" list instead of opening it as a document. It decrypts the
 * E2EE media the same way the gallery does (useDecryptedMediaUrl) and plays it
 * with expo-audio, after restoring the playback audio session so iOS doesn't
 * route it silently to the earpiece.
 */
import React, { useCallback, useEffect } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useDecryptedMediaUrl } from '../../hooks/useDecryptedMediaUrl';
import { ensureVoicePlaybackMode } from '../../lib/audio/voicePlaybackMode';
import { Colors } from '../../theme';

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export default function AudioPreviewModal({
  visible,
  message,
  e2eeStatus,
  onClose,
}: {
  visible: boolean;
  message: any | null;
  e2eeStatus: any;
  onClose: () => void;
}) {
  const { url } = useDecryptedMediaUrl(message || undefined, e2eeStatus);
  const player = useAudioPlayer(visible && url ? { uri: url } : null);
  const status = useAudioPlayerStatus(player);

  // Stop playback when the sheet closes.
  useEffect(() => {
    if (!visible && player) {
      try {
        player.pause();
      } catch {}
    }
  }, [visible, player]);

  const toggle = useCallback(async () => {
    if (!player) return;
    try {
      if (status?.playing) {
        player.pause();
      } else {
        await ensureVoicePlaybackMode();
        const dur = status?.duration || 0;
        const cur = status?.currentTime || 0;
        if (status?.didJustFinish || (dur > 0 && cur >= dur - 0.05)) player.seekTo(0);
        player.play();
      }
    } catch {}
  }, [player, status]);

  const dur = status?.duration || 0;
  const cur = status?.currentTime || 0;
  const pct = dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Ionicons name="musical-notes" size={20} color={Colors.primary} />
            <Text style={styles.name} numberOfLines={1}>{message?.fileName || 'Audio'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {!url ? (
            <View style={styles.loading}>
              <ActivityIndicator color={Colors.primary} />
              <Text style={styles.loadingText}>Preparing audio…</Text>
            </View>
          ) : (
            <View style={styles.playerRow}>
              <TouchableOpacity style={styles.playBtn} onPress={toggle} testID="audio-preview-play">
                <Ionicons name={status?.playing ? 'pause' : 'play'} size={26} color="#fff" />
              </TouchableOpacity>
              <View style={styles.progressWrap}>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${pct}%` }]} />
                </View>
                <Text style={styles.time}>{fmt(cur)} / {dur > 0 ? fmt(dur) : '--:--'}</Text>
              </View>
            </View>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, backgroundColor: Colors.surface, borderRadius: 18, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  name: { flex: 1, fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  loading: { alignItems: 'center', gap: 10, paddingVertical: 14 },
  loadingText: { fontSize: 13, color: Colors.textSecondary },
  playerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  playBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  progressWrap: { flex: 1, gap: 6 },
  progressTrack: { height: 5, borderRadius: 3, backgroundColor: 'rgba(0,0,0,0.1)', overflow: 'hidden' },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: Colors.primary },
  time: { fontSize: 12, color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
});
