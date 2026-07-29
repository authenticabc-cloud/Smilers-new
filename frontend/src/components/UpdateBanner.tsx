import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, Radius, FontSize, FontWeight } from '../theme';
import { useUpdateBanner } from '../lib/appVersion';

/**
 * UpdateBanner — a dismissible "Update available" banner shown at the top of
 * the app on launch when a newer version has been published. Mounted once at
 * the app root. Links to the Play Store (Android) / App Store (iOS). A forced
 * update (below min supported version) hides the dismiss button.
 *
 * Renders nothing when the app is up to date, offline, or already dismissed
 * this session.
 */
export default function UpdateBanner() {
  const insets = useSafeAreaInsets();
  const { visible, forceUpdate, latestVersion, storeUrl, releaseNotes, dismiss, acknowledgeUpdate } =
    useUpdateBanner();

  if (!visible) return null;

  const openStore = () => {
    if (storeUrl) {
      Linking.openURL(storeUrl).catch(() => {});
    }
    // Tapping "Update now" hides the banner immediately and keeps it hidden
    // until a newer version ships. A forced update stays until the app is
    // actually updated (version changes), so we don't acknowledge it away.
    if (!forceUpdate) {
      acknowledgeUpdate();
    }
  };

  return (
    <View
      style={[styles.wrap, { paddingTop: insets.top + Spacing.sm }]}
      testID="update-banner"
    >
      <View style={styles.row}>
        <View style={styles.iconCircle}>
          <Ionicons name="cloud-download-outline" size={20} color={Colors.headerBg} />
        </View>
        <View style={styles.textCol}>
          <Text style={styles.title}>
            {forceUpdate ? 'Update required' : 'Update available'}
          </Text>
          <Text style={styles.subtitle} numberOfLines={2}>
            {releaseNotes
              ? releaseNotes
              : `A new version (${latestVersion || 'latest'}) of Smilers is ready to install.`}
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        {!forceUpdate ? (
          <TouchableOpacity
            onPress={dismiss}
            style={styles.laterBtn}
            hitSlop={10}
            testID="update-banner-later"
          >
            <Text style={styles.laterText}>Later</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={openStore}
          style={styles.updateBtn}
          testID="update-banner-update"
        >
          <Text style={styles.updateText}>
            {Platform.OS === 'ios' ? 'Update' : 'Update now'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    elevation: 12,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.md,
    borderBottomLeftRadius: Radius.lg,
    borderBottomRightRadius: Radius.lg,
    shadowColor: Colors.black,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },
  textCol: { flex: 1 },
  title: {
    color: Colors.headerBg,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
  },
  subtitle: {
    color: Colors.headerBg,
    fontSize: FontSize.sm,
    marginTop: 2,
    opacity: 0.85,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: Spacing.sm,
    gap: Spacing.sm,
  },
  laterBtn: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.base,
    borderRadius: Radius.pill,
  },
  laterText: {
    color: Colors.headerBg,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  updateBtn: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.pill,
    backgroundColor: Colors.headerBg,
    minHeight: 44,
    justifyContent: 'center',
  },
  updateText: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },
});
