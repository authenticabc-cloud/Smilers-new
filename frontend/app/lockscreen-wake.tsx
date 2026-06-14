/**
 * Lockscreen Wake Permission settings screen (iter-215).
 *
 * Android 14+ requires the `USE_FULL_SCREEN_INTENT` permission to be
 * explicitly granted via Settings BEFORE the OS will wake the screen
 * from a `fullScreenAction` notification. Until granted, the OS
 * silently downgrades full-screen intents to heads-up banners — which
 * is exactly what the user reported: rings + banner on unlocked phone,
 * but no screen wake on a locked phone.
 *
 * This screen:
 *   - Explains what the permission does (in plain language).
 *   - Opens the Android `MANAGE_APP_USE_FULL_SCREEN_INTENT` Settings
 *     activity with one tap.
 *   - Falls back to the regular app-notification-settings page on
 *     older Android or OEMs that don't expose the dedicated activity.
 *   - On non-Android-14+ devices, shows a friendly "no action needed"
 *     message instead of pretending there's something to fix.
 */

import React, { useCallback, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight } from '../src/theme';
import {
  isAndroid14Plus,
  openFullScreenIntentSettings,
  markPrompted,
} from '../src/lib/fullScreenIntentPermission';

export default function LockscreenWakeScreen() {
  const router = useRouter();
  const [opening, setOpening] = useState(false);

  const handleOpenSettings = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      const ok = await openFullScreenIntentSettings();
      await markPrompted();
      if (!ok) {
        Alert.alert(
          'Could not open Settings',
          'Open your phone Settings → Apps → Smilers → Notifications → Full-screen notifications, and turn it ON.',
        );
      }
    } finally {
      setOpening(false);
    }
  }, [opening]);

  const android14Plus = isAndroid14Plus();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header
        title="Lockscreen Wake"
        showBack
        onBack={() => router.back()}
        variant="dark"
      />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.iconWrap}>
          <MaterialCommunityIcons
            name="cellphone-screenshot"
            size={80}
            color={Colors.primary || '#1e88e5'}
          />
        </View>
        <Text style={styles.title}>Wake the screen for incoming calls</Text>
        <Text style={styles.body}>
          On Android 14 and newer, Smilers needs an extra permission to wake
          your locked screen and show the full-screen incoming-call UI. Without
          it, calls still ring and a banner shows on the lockscreen — but the
          screen itself stays dark.
        </Text>

        {Platform.OS !== 'android' ? (
          <View style={styles.iosNote}>
            <Text style={styles.iosNoteText}>
              On iPhone, this is handled automatically by the system. Nothing
              to do here.
            </Text>
          </View>
        ) : !android14Plus ? (
          <View style={styles.iosNote}>
            <Text style={styles.iosNoteText}>
              Your Android version doesn't need this extra permission — it's
              already granted from the app manifest. Lockscreen wake should
              work as soon as your incoming-call channels are set up.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.stepHeader}>How to enable it</Text>
            <Text style={styles.step}>
              <Text style={styles.stepNum}>1. </Text>
              Tap the button below — we'll open the right Settings page.
            </Text>
            <Text style={styles.step}>
              <Text style={styles.stepNum}>2. </Text>
              On the page that opens, turn the toggle <Text style={styles.bold}>ON</Text>.
            </Text>
            <Text style={styles.step}>
              <Text style={styles.stepNum}>3. </Text>
              Come back to Smilers — you're done. Next time you receive a call
              on a locked phone, the screen will wake.
            </Text>

            <TouchableOpacity
              style={[styles.primaryBtn, opening && styles.primaryBtnDisabled]}
              onPress={handleOpenSettings}
              disabled={opening}
              activeOpacity={0.8}
            >
              <MaterialCommunityIcons
                name="cog-outline"
                size={20}
                color={Colors.white || '#fff'}
                style={{ marginRight: 8 }}
              />
              <Text style={styles.primaryBtnText}>
                {opening ? 'Opening…' : 'Open Settings'}
              </Text>
            </TouchableOpacity>

            <Text style={styles.subtle}>
              You can revoke this permission anytime from the same place.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 20, paddingBottom: 40 },
  iconWrap: { alignItems: 'center', paddingVertical: 16 },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    lineHeight: 22,
    marginBottom: 24,
    textAlign: 'center',
  },
  stepHeader: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginTop: 8,
    marginBottom: 12,
  },
  step: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    lineHeight: 22,
    marginBottom: 8,
  },
  stepNum: { fontWeight: FontWeight.bold, color: Colors.primary },
  bold: { fontWeight: FontWeight.bold },
  primaryBtn: {
    marginTop: 24,
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: {
    color: '#fff',
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  subtle: {
    marginTop: 16,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  iosNote: {
    backgroundColor: '#e3f2fd',
    padding: 16,
    borderRadius: 10,
    marginTop: 8,
  },
  iosNoteText: {
    fontSize: FontSize.base,
    color: '#0d47a1',
    lineHeight: 22,
  },
});
