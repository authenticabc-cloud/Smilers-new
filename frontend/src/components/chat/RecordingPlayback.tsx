/**
 * RecordingPlaybackModal (iter 157, extracted iter-184) — minimal audio
 * player for a saved call recording. Mounted/unmounted on demand so
 * useAudioPlayer is recreated for each new recording.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Colors } from '../../theme';
import { formatCallDuration } from '../../lib/chatFormat';

type RecordingInfo = { url: string; durationSeconds?: number; callType?: string; outcome?: string };

export function RecordingPlaybackModal({
  recording,
  onClose,
}: {
  recording: RecordingInfo | null;
  onClose: () => void;
}) {
  if (!recording) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={recPlayStyles.backdrop} onPress={onClose}>
        <Pressable style={recPlayStyles.card} onPress={() => {}}>
          <RecordingPlayer recording={recording} onClose={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function RecordingPlayer({
  recording,
  onClose,
}: {
  recording: RecordingInfo;
  onClose: () => void;
}) {
  const player = useAudioPlayer({ uri: recording.url });
  const status = useAudioPlayerStatus(player);
  const isPlaying = !!status?.playing;

  return (
    <View style={recPlayStyles.body}>
      <View style={recPlayStyles.headerRow}>
        <MaterialCommunityIcons name="record-rec" size={20} color="#EF4444" />
        <Text style={recPlayStyles.title}>Call Recording</Text>
        <TouchableOpacity onPress={onClose} hitSlop={10} testID="rec-close">
          <Feather name="x" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>
      <Text style={recPlayStyles.subtitle}>
        {recording.callType === 'video' ? 'Video' : 'Voice'} call{' '}
        {recording.durationSeconds ? `\u00B7 ${formatCallDuration(recording.durationSeconds)}` : ''}
      </Text>
      <View style={recPlayStyles.controls}>
        <TouchableOpacity
          onPress={() => {
            if (isPlaying) {
              player.pause();
            } else {
              player.play();
            }
          }}
          style={recPlayStyles.playBtn}
          activeOpacity={0.8}
          testID="rec-play-pause"
        >
          <Ionicons
            name={isPlaying ? 'pause' : 'play'}
            size={28}
            color={Colors.headerBg}
            style={!isPlaying ? { marginLeft: 3 } : null}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const recPlayStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
  },
  body: { gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  subtitle: { fontSize: 13, color: Colors.textSecondary },
  controls: { alignItems: 'center', justifyContent: 'center', paddingTop: 8 },
  playBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
