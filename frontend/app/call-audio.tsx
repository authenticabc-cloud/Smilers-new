/**
 * Call Audio settings screen.
 *
 * Lets the user set their default noise-cancellation preference BEFORE a
 * call starts. The same toggle is also available live inside the call
 * (in-call controls → "Noise"). Both write to the shared preference used by
 * getVoiceAudioConstraints() so react-native-webrtc requests the matching
 * DSP flags on the next getUserMedia.
 *
 * Echo cancellation (AEC) always stays ON regardless of this toggle — it is
 * what stops your mic re-capturing the other person's voice from the speaker.
 * This toggle only controls noise suppression + auto-gain, which some users
 * prefer OFF when sharing music or in a quiet room.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Spacing } from '../src/theme';
import {
  isNoiseCancellationEnabled,
  loadNoiseCancellationPref,
  setNoiseCancellationPref,
} from '../src/lib/webrtc/audioConstraints';

export default function CallAudioScreen() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(isNoiseCancellationEnabled());

  // Re-sync from storage on mount in case the pref changed elsewhere.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadNoiseCancellationPref();
      if (!cancelled) setEnabled(isNoiseCancellationEnabled());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = useCallback((next: boolean) => {
    setEnabled(next);
    void setNoiseCancellationPref(next);
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="call-audio-screen">
      <Header title="Call Audio" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.iconWrap}>
          <MaterialCommunityIcons name="waveform" size={72} color={Colors.primary} />
        </View>
        <Text style={styles.title}>Noise cancellation</Text>
        <Text style={styles.body}>
          Reduces background noise (fans, traffic, keyboard) so your voice comes
          through clearly. Turn it off when sharing music or in a quiet room
          where you want the most natural sound.
        </Text>

        <View style={styles.card}>
          <View style={styles.rowMid}>
            <Text style={styles.rowTitle}>Noise cancellation</Text>
            <Text style={styles.rowSub}>Applies to voice & video calls</Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={onToggle}
            trackColor={{ false: '#D1D5DB', true: Colors.primary }}
            thumbColor={Colors.white}
            testID="call-audio-noise-toggle"
          />
        </View>

        <View style={styles.note}>
          <MaterialCommunityIcons name="shield-check-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.noteText}>
            Echo cancellation always stays on to prevent echo, even when noise
            cancellation is off. You can also toggle this during a call.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: Spacing.lg, paddingBottom: 40 },
  iconWrap: { alignItems: 'center', marginTop: Spacing.lg, marginBottom: Spacing.md },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold as any,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  body: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.lg,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  rowMid: { flex: 1, paddingRight: Spacing.md },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold as any, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textMuted, marginTop: 2 },
  note: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.sm,
  },
  noteText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
});
