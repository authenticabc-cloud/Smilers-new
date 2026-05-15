import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { readStoredJson, writeStoredJson } from '../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const RINGTONE_PREFS_KEY = 'smilers_ringtone_prefs';

type RingId =
  | 'default'
  | 'classic'
  | 'chime'
  | 'marimba'
  | 'pulse'
  | 'bell'
  | 'pop'
  | 'whistle'
  | 'silent';

interface Ring {
  id: RingId;
  name: string;
  description: string;
  source: number | { uri: string } | null; // null = silent
}

const BUNDLED_RINGTONE = require('../assets/sounds/ringtone.mp3');

const RINGS: Ring[] = [
  { id: 'default', name: 'Smilers default', description: 'The original Smilers tone', source: BUNDLED_RINGTONE },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Warm orchestral phrase',
    source: { uri: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
  },
  {
    id: 'chime',
    name: 'Chime',
    description: 'Bright and crisp',
    source: { uri: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
  },
  {
    id: 'marimba',
    name: 'Marimba',
    description: 'Bouncy wooden tones',
    source: { uri: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
  },
  {
    id: 'pulse',
    name: 'Pulse',
    description: 'Steady, modern beat',
    source: { uri: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3' },
  },
  {
    id: 'bell',
    name: 'Bell',
    description: 'Clear and resonant',
    source: { uri: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3' },
  },
  {
    id: 'pop',
    name: 'Pop',
    description: 'Upbeat and short',
    source: { uri: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3' },
  },
  {
    id: 'whistle',
    name: 'Whistle',
    description: 'Light, attention-getting',
    source: { uri: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3' },
  },
  { id: 'silent', name: 'Silent', description: 'No sound, vibration only', source: null },
];

const SAVED_FOR_PREFIX = '_for_';

interface RingPrefs {
  ringtone: RingId;
  notificationSound: RingId;
  vibrate: boolean;
}

const DEFAULT_PREFS: RingPrefs = {
  ringtone: 'default',
  notificationSound: 'chime',
  vibrate: true,
};

type Mode = 'ringtone' | 'notificationSound';

export default function RingtonesScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: me, refetch } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    {},
    null,
    isAuthenticated,
  );
  const updateProfile = useMutation(api.users.updateProfile);

  const [prefs, setPrefs] = useState<RingPrefs>(DEFAULT_PREFS);
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<Mode>('ringtone');
  const [playingId, setPlayingId] = useState<RingId | null>(null);
  const [loadingId, setLoadingId] = useState<RingId | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Hydrate prefs.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let initial: RingPrefs | null = null;
      if (me?.ringtonePrefs && typeof me.ringtonePrefs === 'object') {
        initial = { ...DEFAULT_PREFS, ...me.ringtonePrefs };
      } else {
        const local = (await readStoredJson(RINGTONE_PREFS_KEY, null)) as RingPrefs | null;
        if (local) initial = { ...DEFAULT_PREFS, ...local };
      }
      // Backwards compat: respect simple `me.ringtone` field if present.
      if (!initial && me?.ringtone) {
        initial = { ...DEFAULT_PREFS, ringtone: me.ringtone as RingId };
      }
      if (!cancelled) {
        setPrefs(initial || DEFAULT_PREFS);
        setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me]);

  // Configure audio session for playback. Stop sound when leaving screen.
  useEffect(() => {
    void Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      allowsRecordingIOS: false,
      staysActiveInBackground: false,
    }).catch(() => undefined);
    return () => {
      const s = soundRef.current;
      soundRef.current = null;
      if (s) {
        s.unloadAsync().catch(() => undefined);
      }
    };
  }, []);

  const stopCurrentSound = useCallback(async () => {
    const s = soundRef.current;
    soundRef.current = null;
    setPlayingId(null);
    if (s) {
      try {
        await s.unloadAsync();
      } catch {}
    }
  }, []);

  const previewRing = useCallback(
    async (ring: Ring) => {
      // If user taps the same row that's already playing, stop it.
      if (playingId === ring.id) {
        await stopCurrentSound();
        return;
      }
      // Silent has nothing to preview.
      if (!ring.source) {
        await stopCurrentSound();
        Alert.alert('Silent', 'No sound will play for "Silent". Vibration still works when enabled.');
        return;
      }
      await stopCurrentSound();
      setLoadingId(ring.id);
      try {
        const { sound } = await Audio.Sound.createAsync(
          ring.source as any,
          { shouldPlay: true, volume: 1.0 },
          (status: any) => {
            if (!status?.isLoaded) return;
            if (status.didJustFinish) {
              // Auto-stop after the clip finishes.
              setPlayingId(null);
              if (soundRef.current) {
                soundRef.current.unloadAsync().catch(() => undefined);
                soundRef.current = null;
              }
            }
          },
        );
        soundRef.current = sound;
        setPlayingId(ring.id);
      } catch (errorValue: any) {
        console.warn('preview failed:', errorValue?.message);
        Alert.alert(
          'Preview unavailable',
          'Could not play this sample. Check your internet connection and try again.',
        );
      } finally {
        setLoadingId(null);
      }
    },
    [playingId, stopCurrentSound],
  );

  const persist = useCallback(
    async (next: RingPrefs) => {
      setPrefs(next);
      try {
        await writeStoredJson(RINGTONE_PREFS_KEY, next);
      } catch {}
      try {
        await updateProfile({ ringtonePrefs: next });
        try {
          await refetch();
        } catch {}
      } catch (errorValue: any) {
        console.warn('updateProfile(ringtonePrefs) failed:', errorValue?.message);
      }
    },
    [refetch, updateProfile],
  );

  const onSelect = useCallback(
    async (ring: Ring) => {
      const next = { ...prefs, [mode]: ring.id } as RingPrefs;
      await persist(next);
    },
    [mode, persist, prefs],
  );

  const setVibrate = useCallback(
    (v: boolean) => {
      void persist({ ...prefs, vibrate: v });
    },
    [persist, prefs],
  );

  // Stop preview when switching modes.
  useEffect(() => {
    void stopCurrentSound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const activeId = prefs[mode];

  const modeLabel = mode === 'ringtone' ? 'Ringtone' : 'Notification sound';
  const modeDescription =
    mode === 'ringtone'
      ? 'Plays for incoming voice and video calls.'
      : 'Plays for messages, group activity, and other alerts.';

  const list = useMemo(() => RINGS, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="ringtones-screen">
      <Header title="Ringtones" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }} testID="ringtones-scroll">
        {/* Mode switcher */}
        <View style={styles.segmentWrap}>
          <View style={styles.segment}>
            <TouchableOpacity
              style={[styles.segmentBtn, mode === 'ringtone' ? styles.segmentBtnActive : null]}
              onPress={() => setMode('ringtone')}
              testID="ringtones-mode-ringtone"
            >
              <Ionicons
                name="call-outline"
                size={16}
                color={mode === 'ringtone' ? Colors.headerBg : Colors.textSecondary}
              />
              <Text style={[styles.segmentText, mode === 'ringtone' ? styles.segmentTextActive : null]}>
                Ringtone
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentBtn, mode === 'notificationSound' ? styles.segmentBtnActive : null]}
              onPress={() => setMode('notificationSound')}
              testID="ringtones-mode-notification"
            >
              <Ionicons
                name="notifications-outline"
                size={16}
                color={mode === 'notificationSound' ? Colors.headerBg : Colors.textSecondary}
              />
              <Text
                style={[
                  styles.segmentText,
                  mode === 'notificationSound' ? styles.segmentTextActive : null,
                ]}
              >
                Notifications
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.intro}>
          <Text style={styles.introTitle}>{modeLabel}</Text>
          <Text style={styles.introBody}>{modeDescription}</Text>
        </View>

        {/* Ring list */}
        <View style={styles.list}>
          {list.map((ring, index) => {
            const selected = activeId === ring.id;
            const isPlaying = playingId === ring.id;
            const isLoading = loadingId === ring.id;
            return (
              <View
                key={ring.id}
                style={[styles.row, index === list.length - 1 ? styles.rowLast : null]}
                testID={`ringtone-row-${ring.id}`}
              >
                <TouchableOpacity
                  style={styles.playBtn}
                  onPress={() => previewRing(ring)}
                  activeOpacity={0.7}
                  disabled={isLoading}
                  testID={`ringtone-preview-${ring.id}`}
                >
                  {isLoading ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : ring.id === 'silent' ? (
                    <Ionicons name="volume-mute-outline" size={20} color={Colors.textSecondary} />
                  ) : (
                    <Ionicons
                      name={isPlaying ? 'pause' : 'play'}
                      size={20}
                      color={isPlaying ? Colors.danger : Colors.primary}
                    />
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.rowMid}
                  onPress={() => onSelect(ring)}
                  activeOpacity={0.7}
                  disabled={!hydrated}
                  testID={`ringtone-select-${ring.id}`}
                >
                  <View style={styles.rowTitleLine}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {ring.name}
                    </Text>
                    {selected ? (
                      <View style={styles.selectedBadge}>
                        <Text style={styles.selectedBadgeText}>Selected</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {ring.description}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.radio, selected ? styles.radioOn : null]}
                  onPress={() => onSelect(ring)}
                  testID={`ringtone-radio-${ring.id}`}
                  disabled={!hydrated}
                >
                  {selected ? <Ionicons name="checkmark" size={16} color={Colors.white} /> : null}
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        {/* Vibration */}
        <Text style={styles.sectionLabel}>Vibration</Text>
        <View style={styles.card}>
          <View style={styles.cardRow}>
            <Ionicons name="phone-portrait-outline" size={22} color={Colors.primary} />
            <View style={styles.cardRowMid}>
              <Text style={styles.cardRowTitle}>Vibrate</Text>
              <Text style={styles.cardRowSub}>Buzz alongside the sound (or alone in Silent mode)</Text>
            </View>
            <Switch
              value={prefs.vibrate}
              onValueChange={setVibrate}
              trackColor={{ true: Colors.primary, false: Colors.border }}
              thumbColor={Colors.white}
              testID="ringtones-vibrate"
            />
          </View>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="information-circle-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.tipText}>
            Per-contact ringtones can be set on a contact's profile. Your default ringtone plays for everyone else.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  segmentWrap: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    padding: 4,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: Radius.pill,
  },
  segmentBtnActive: { backgroundColor: Colors.primary },
  segmentText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
  },
  segmentTextActive: { color: Colors.headerBg },

  intro: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  introTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  introBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
    lineHeight: 20,
  },

  list: {
    marginHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  rowLast: { borderBottomWidth: 0 },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMid: { flex: 1 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  selectedBadge: {
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.sm,
  },
  selectedBadgeText: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    color: Colors.primaryDark,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  radioOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },

  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  card: {
    marginHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: Spacing.md,
  },
  cardRowMid: { flex: 1 },
  cardRowTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  cardRowSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },

  tipCard: {
    flexDirection: 'row',
    gap: Spacing.sm,
    margin: Spacing.base,
    padding: Spacing.md,
    backgroundColor: '#FFFBEB',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  tipText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
});
