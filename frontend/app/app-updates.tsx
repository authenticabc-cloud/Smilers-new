import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Linking,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import Header from '../src/components/Header';
import { getCurrentAppVersion, fetchAppVersion, type AppVersionInfo } from '../src/lib/appVersion';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../src/theme';

// The app's public App Store listing (Apple ID 6791345253) — used for the
// manual "Check for updates" flow on iOS.
const IOS_STORE_URL = 'https://apps.apple.com/app/id6791345253';

function getBuildNumber(): string {
  const ios = (Constants.expoConfig as any)?.ios?.buildNumber;
  const android = (Constants.expoConfig as any)?.android?.versionCode;
  const v = Platform.OS === 'ios' ? ios : android;
  return v != null ? String(v) : '';
}

type CheckState = 'idle' | 'checking' | 'uptodate' | 'available';

export default function AppUpdatesScreen() {
  const router = useRouter();
  const [state, setState] = useState<CheckState>('idle');
  const [info, setInfo] = useState<AppVersionInfo | null>(null);
  const version = getCurrentAppVersion() || '—';
  const build = getBuildNumber();

  useEffect(() => {
    const controller = new AbortController();
    void fetchAppVersion(controller.signal).then((data) => {
      if (data) setInfo(data);
    });
    return () => controller.abort();
  }, []);

  // Split release notes into individual bullet lines (supports newline- or
  // bullet-separated strings from the backend).
  const noteLines = (info?.releaseNotes || '')
    .split(/\r?\n|•/)
    .map((l) => l.trim())
    .filter(Boolean);

  const checkForUpdates = async () => {
    setState('checking');
    try {
      if (Platform.OS === 'ios') {
        // Play's in-app update API is Android-only; on iOS we send the user to
        // the App Store listing to update.
        await Linking.openURL(IOS_STORE_URL).catch(() => {});
        setState('idle');
        return;
      }

      if (__DEV__) {
        Alert.alert(
          'Not available in development',
          'In-app updates only work for builds installed from Google Play. Publish to Play (or use Internal App Sharing) to test this.',
        );
        setState('idle');
        return;
      }

      // Lazily required (NOT a static top-level import): expo-in-app-updates
      // calls requireNativeModule("ExpoInAppUpdates") at its own module scope,
      // which throws synchronously on iOS (Android/Play-only). A static import
      // would run at bundle-load — and because expo-router eagerly loads every
      // route file at boot, that fatally crashed the iOS JS thread on the
      // splash screen. This require only runs on Android, non-dev.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const InAppUpdates = require('expo-in-app-updates');
      const info = await InAppUpdates.checkForUpdate();
      if (info?.updateAvailable) {
        setState('available');
        const highPriority =
          (typeof info.serverPriority === 'number' && info.serverPriority >= 4) ||
          info.serverUpdateType === 'IMMEDIATE';
        await InAppUpdates.startUpdate(highPriority && !!info.immediateAllowed);
      } else {
        setState('uptodate');
      }
    } catch {
      Alert.alert(
        "Couldn't check for updates",
        'Please make sure you are online and installed the app from the store, then try again.',
      );
      setState('idle');
    }
  };

  const busy = state === 'checking';

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="app-updates-screen">
      <Header title="App Version & Updates" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.iconCircle}>
          <Ionicons name="rocket-outline" size={40} color={Colors.primary} />
        </View>
        <Text style={styles.appName}>Smilers</Text>
        <Text style={styles.version}>
          Version {version}
          {build ? ` (${build})` : ''}
        </Text>

        {state === 'uptodate' ? (
          <View style={[styles.statusPill, styles.statusOk]} testID="app-updates-uptodate">
            <Ionicons name="checkmark-circle" size={16} color="#16A34A" />
            <Text style={styles.statusOkText}>You&apos;re on the latest version</Text>
          </View>
        ) : null}
        {state === 'available' ? (
          <View style={[styles.statusPill, styles.statusInfo]} testID="app-updates-available">
            <Ionicons name="cloud-download-outline" size={16} color={Colors.primaryDark} />
            <Text style={styles.statusInfoText}>Update started…</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={checkForUpdates}
          disabled={busy}
          activeOpacity={0.85}
          testID="app-updates-check-btn"
        >
          {busy ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <Ionicons name="sync-outline" size={18} color={Colors.white} />
              <Text style={styles.buttonText}>
                {Platform.OS === 'ios' ? 'Open App Store' : 'Check for updates'}
              </Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.hint}>
          {Platform.OS === 'ios'
            ? 'Updates for iOS are delivered through the App Store.'
            : 'Smilers checks Google Play automatically on launch. You can also check manually here anytime.'}
        </Text>

        {noteLines.length > 0 ? (
          <View style={styles.notesCard} testID="app-updates-whatsnew">
            <View style={styles.notesHeader}>
              <Ionicons name="sparkles-outline" size={16} color={Colors.primaryDark} />
              <Text style={styles.notesTitle}>
                What&apos;s New{info?.latestVersion ? ` in v${info.latestVersion}` : ''}
              </Text>
            </View>
            {noteLines.map((line, i) => (
              <View key={i} style={styles.noteRow}>
                <Text style={styles.noteBullet}>•</Text>
                <Text style={styles.noteText}>{line}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  body: { alignItems: 'center', paddingHorizontal: Spacing.xl, paddingTop: Spacing.xl },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.base,
  },
  appName: {
    fontSize: 24,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  version: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    marginTop: 4,
    marginBottom: Spacing.lg,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    marginBottom: Spacing.base,
  },
  statusOk: { backgroundColor: '#DCFCE7' },
  statusOkText: { color: '#16A34A', fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  statusInfo: { backgroundColor: Colors.primaryLight },
  statusInfoText: { color: Colors.primaryDark, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.xl,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    minHeight: 48,
    minWidth: 220,
    marginTop: Spacing.sm,
  },
  buttonDisabled: { opacity: 0.7 },
  buttonText: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  hint: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: Spacing.lg,
    lineHeight: 20,
  },
  notesCard: {
    alignSelf: 'stretch',
    marginTop: Spacing.xl,
    padding: Spacing.base,
    borderRadius: Radius.lg,
    backgroundColor: Colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(60, 40, 0, 0.12)',
  },
  notesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: Spacing.sm,
  },
  notesTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 4,
  },
  noteBullet: {
    fontSize: FontSize.base,
    color: Colors.primary,
    lineHeight: 20,
  },
  noteText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
});
