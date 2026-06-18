/**
 * Media Auto-Download — per-type toggles (iter-223).
 *
 * Lets the user choose which kinds of RECEIVED media are auto-saved to the
 * device: Photos / Videos / Audio (→ gallery) and Documents (→ a Smilers
 * Downloads folder). All OFF by default. State lives in AsyncStorage via
 * `useAutoDownloadPrefs`; the chat bubbles read the same prefs to decide
 * whether to silently save incoming media.
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import {
  AUTO_DOWNLOAD_META,
  useAutoDownloadPrefs,
  type AutoDownloadType,
} from '../src/lib/mediaAutoDownload';
import { Colors, FontSize, FontWeight, Spacing } from '../src/theme';

export default function MediaAutoDownloadScreen() {
  const router = useRouter();
  const { prefs, setPref } = useAutoDownloadPrefs();

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="media-auto-download-screen">
      <Header title="Media Auto-Download" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={styles.intro}>
          Choose which media you receive should be saved to your device automatically.
          Everything stays manual when a toggle is off.
        </Text>

        {AUTO_DOWNLOAD_META.map((item) => (
          <View key={item.key} style={styles.row} testID={`autodl-row-${item.key}`}>
            <View style={styles.iconWrap}>
              <Ionicons name={item.icon as any} size={22} color={Colors.primary} />
            </View>
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>{item.label}</Text>
              <Text style={styles.rowSub}>{item.sub}</Text>
            </View>
            <Switch
              value={prefs[item.key as AutoDownloadType]}
              onValueChange={(v) => setPref(item.key as AutoDownloadType, v)}
              trackColor={{ false: Colors.border, true: Colors.primary }}
              thumbColor={Platform.OS === 'android' ? Colors.white : undefined}
              testID={`autodl-switch-${item.key}`}
            />
          </View>
        ))}

        <Text style={styles.footnote}>
          Photos, videos and audio are saved to your gallery; documents are saved to a
          “SmilersDownloads” folder. Auto-download applies to new media as it loads.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  intro: {
    fontSize: 13,
    color: Colors.textSecondary,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    lineHeight: 19,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 16,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(60, 40, 0, 0.08)',
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMid: { flex: 1 },
  rowTitle: { fontSize: 17, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  rowSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 3 },
  footnote: {
    fontSize: 12,
    color: Colors.textMuted,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    lineHeight: 17,
  },
});
