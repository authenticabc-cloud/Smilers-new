import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  getCurrentAppVersion,
  compareVersions,
  fetchAppVersion,
} from '../lib/appVersion';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../theme';

/**
 * WhatsNewModal — pops up ONCE right after the app is updated to a newer
 * version, showing the release notes so users see what changed without
 * digging into Settings.
 *
 * Detection: we persist the last version the user has already "seen" in
 * AsyncStorage. On launch we compare it with the bundled version:
 *   - No stored value (fresh install) → store silently, show nothing.
 *   - Stored < current (app was updated) → show the modal, then store current.
 *   - Stored >= current → nothing to show.
 *
 * Release notes come from the backend /api/app-version (same source as the
 * Settings screen). If notes can't be fetched we skip the popup rather than
 * show an empty sheet.
 */
const LAST_SEEN_KEY = 'whatsNew:lastSeenVersion';

const ANDROID_PACKAGE = 'com.smilers.app';
const IOS_APP_ID = '6791345253';

// Opens the store listing on the "leave a review" surface where supported.
function openRateApp() {
  const url =
    Platform.OS === 'ios'
      ? `https://apps.apple.com/app/id${IOS_APP_ID}?action=write-review`
      : `market://details?id=${ANDROID_PACKAGE}`;
  Linking.openURL(url).catch(() => {
    // Fallback to the web store page if the native store app can't handle it.
    const web =
      Platform.OS === 'ios'
        ? `https://apps.apple.com/app/id${IOS_APP_ID}`
        : `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
    Linking.openURL(web).catch(() => {});
  });
}

export default function WhatsNewModal() {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      const current = getCurrentAppVersion();
      // Can't determine the build version (e.g. web preview) → do nothing.
      if (!current || current === '0.0.0') return;

      let lastSeen: string | null = null;
      try {
        lastSeen = await AsyncStorage.getItem(LAST_SEEN_KEY);
      } catch {
        // ignore storage errors
      }

      // Fresh install: remember the version but don't show anything.
      if (!lastSeen) {
        try {
          await AsyncStorage.setItem(LAST_SEEN_KEY, current);
        } catch {}
        return;
      }

      // Already up to date with what they've seen.
      if (compareVersions(lastSeen, current) >= 0) return;

      // The app was updated — fetch notes and show the popup.
      const info = await fetchAppVersion(controller.signal);
      const lines = (info?.releaseNotes || '')
        .split(/\r?\n|•/)
        .map((l) => l.trim())
        .filter(Boolean);

      // Persist now so the popup never shows twice for this version, even if
      // notes were empty.
      try {
        await AsyncStorage.setItem(LAST_SEEN_KEY, current);
      } catch {}

      if (cancelled || lines.length === 0) return;
      setVersion(current);
      setNotes(lines);
      setVisible(true);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => setVisible(false)}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { marginBottom: insets.bottom + Spacing.base }]} testID="whats-new-modal">
          <View style={styles.iconCircle}>
            <Ionicons name="sparkles" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.title}>What&apos;s New</Text>
          <Text style={styles.subtitle}>You&apos;re now on Smilers v{version}</Text>

          <ScrollView style={styles.notesScroll} contentContainerStyle={styles.notesContent}>
            {notes.map((line, i) => (
              <View key={i} style={styles.noteRow}>
                <Text style={styles.noteBullet}>•</Text>
                <Text style={styles.noteText}>{line}</Text>
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity
            style={styles.button}
            onPress={() => setVisible(false)}
            activeOpacity={0.85}
            testID="whats-new-dismiss"
          >
            <Text style={styles.buttonText}>Got it</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.rateBtn}
            onPress={() => {
              openRateApp();
              setVisible(false);
            }}
            activeOpacity={0.7}
            testID="whats-new-rate"
          >
            <Ionicons name="star" size={16} color={Colors.primaryDark} />
            <Text style={styles.rateText}>Rate Smilers</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: Colors.white,
    borderRadius: Radius.xl ?? 20,
    padding: Spacing.xl,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: Colors.black,
        shadowOpacity: 0.2,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
      },
      android: { elevation: 12 },
    }),
  },
  iconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  title: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  subtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 4,
    marginBottom: Spacing.base,
  },
  notesScroll: {
    alignSelf: 'stretch',
    maxHeight: 260,
  },
  notesContent: {
    paddingVertical: Spacing.xs,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 6,
  },
  noteBullet: {
    fontSize: FontSize.base,
    color: Colors.primary,
    lineHeight: 21,
  },
  noteText: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    lineHeight: 21,
  },
  button: {
    alignSelf: 'stretch',
    marginTop: Spacing.lg,
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonText: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  rateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.md,
    paddingVertical: 8,
  },
  rateText: {
    color: Colors.primaryDark,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
