// Privacy settings — backed by `api.privacy.getSettings` / `updateSettings`.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Modal,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

type VisibilityKey = 'lastSeen' | 'profilePhoto' | 'about' | 'status';
type VisibilityValue = 'everyone' | 'contacts' | 'nobody';

interface PrivacySettings {
  lastSeen: VisibilityValue;
  profilePhoto: VisibilityValue;
  about: VisibilityValue;
  status: VisibilityValue;
  readReceipts: boolean;
}

const DEFAULTS: PrivacySettings = {
  lastSeen: 'everyone',
  profilePhoto: 'everyone',
  about: 'everyone',
  status: 'contacts',
  readReceipts: true,
};

const VISIBILITY_LABEL: Record<VisibilityValue, string> = { everyone: 'Everyone', contacts: 'My contacts', nobody: 'Nobody' };
const VISIBILITY_OPTIONS: VisibilityValue[] = ['everyone', 'contacts', 'nobody'];

const SECTIONS: Array<{ key: VisibilityKey; label: string; sub: string; icon: keyof typeof Feather.glyphMap }> = [
  { key: 'lastSeen', label: 'Last seen', sub: 'Who can see when you were last online', icon: 'clock' },
  { key: 'profilePhoto', label: 'Profile photo', sub: 'Who can see your profile picture', icon: 'user' },
  { key: 'about', label: 'About', sub: 'Who can see your About text', icon: 'info' },
  { key: 'status', label: 'Status', sub: 'Who can see your story updates', icon: 'eye' },
];

export default function PrivacyScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const cloudSyncEnabled = isAuthenticated && Platform.OS !== 'web';
  const { data: serverSettings, loading } = useSafeConvexQuery<PrivacySettings>(api.privacy.getSettings, {}, DEFAULTS, cloudSyncEnabled);
  const updateSettings = useMutation(api.privacy.updateSettings);
  const [draft, setDraft] = useState<PrivacySettings>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [pickerKey, setPickerKey] = useState<VisibilityKey | GroupsKey | null>(null);
  const controlsDisabled = !cloudSyncEnabled || saving;

  useEffect(() => {
    if (serverSettings) setDraft({ ...DEFAULTS, ...serverSettings });
  }, [serverSettings]);

  const persist = useCallback(async (next: PrivacySettings) => {
    if (!cloudSyncEnabled) {
      return;
    }
    setDraft(next);
    setSaving(true);
    try {
      await updateSettings({ settings: next });
    } catch {
      if (serverSettings) setDraft({ ...DEFAULTS, ...serverSettings });
    } finally {
      setSaving(false);
    }
  }, [cloudSyncEnabled, updateSettings, serverSettings]);

  const syncBannerText = Platform.OS === 'web'
    ? 'Privacy sync is available in the native app'
    : !isAuthenticated
    ? 'Sign in to sync your privacy settings'
    : saving
      ? 'Saving…'
      : 'Synced with Smilers cloud';

  const onPickVisibility = (key: VisibilityKey | GroupsKey, value: VisibilityValue | GroupsValue) => {
    setPickerKey(null);
    persist({ ...draft, [key]: value } as PrivacySettings);
  };

  const onToggle = (key: 'readReceipts' | 'typingIndicators', value: boolean) => {
    persist({ ...draft, [key]: value });
  };

  const currentPickerOptions = useMemo(() => {
    if (!pickerKey) return [];
    return pickerKey === 'groups' ? GROUPS_OPTIONS : VISIBILITY_OPTIONS;
  }, [pickerKey]);

  const currentPickerLabels: Record<string, string> = pickerKey === 'groups' ? GROUPS_LABEL : VISIBILITY_LABEL;

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Privacy" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.loadingWrap}><ActivityIndicator size="large" color={Colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="privacy-screen">
      <Header title="Privacy" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.heroBanner} testID="privacy-sync-banner">
          <MaterialCommunityIcons name="shield-account" size={20} color={Colors.primary} />
          <Text style={styles.heroText} testID="privacy-saved-note">{syncBannerText}</Text>
        </View>

        <Text style={styles.section}>WHO CAN SEE MY INFO</Text>
        {SECTIONS.map((section) => {
          const value = draft[section.key];
          const labelMap = section.groups ? GROUPS_LABEL : VISIBILITY_LABEL;
          return (
            <TouchableOpacity key={section.key} style={styles.row} activeOpacity={0.7} onPress={() => setPickerKey(section.key)} disabled={controlsDisabled} testID={`privacy-${section.key}`}>
              <View style={styles.iconWrap}><Feather name={section.icon} size={20} color={Colors.primary} /></View>
              <View style={styles.flexOne}>
                <Text style={styles.rowTitle}>{section.label}</Text>
                <Text style={styles.rowSub}>{section.sub}</Text>
              </View>
              <Text style={styles.rowValue}>{labelMap[value as VisibilityValue & GroupsValue]}</Text>
              <Feather name="chevron-right" size={18} color={Colors.textMuted} />
            </TouchableOpacity>
          );
        })}

        <Text style={styles.section}>MESSAGING</Text>
        <View style={styles.row} testID="privacy-read-receipts-row">
          <View style={styles.iconWrap}><Feather name="check-circle" size={20} color={Colors.primary} /></View>
          <View style={styles.flexOne}>
            <Text style={styles.rowTitle}>Read receipts</Text>
            <Text style={styles.rowSub}>Let others see when you've read their messages.</Text>
          </View>
          <Switch value={draft.readReceipts} onValueChange={(value) => onToggle('readReceipts', value)} disabled={controlsDisabled} trackColor={{ false: Colors.border, true: Colors.primary }} thumbColor={Colors.white} testID="toggle-read-receipts" />
        </View>
        <View style={styles.row} testID="privacy-typing-row">
          <View style={styles.iconWrap}><MaterialCommunityIcons name="dots-horizontal" size={22} color={Colors.primary} /></View>
          <View style={styles.flexOne}>
            <Text style={styles.rowTitle}>Typing indicators</Text>
            <Text style={styles.rowSub}>Let others see when you're typing.</Text>
          </View>
          <Switch value={draft.typingIndicators} onValueChange={(value) => onToggle('typingIndicators', value)} disabled={controlsDisabled} trackColor={{ false: Colors.border, true: Colors.primary }} thumbColor={Colors.white} testID="toggle-typing" />
        </View>

        <Text style={styles.footnote}>Privacy settings apply across all your linked Smilers devices.</Text>
      </ScrollView>

      <Modal visible={!!pickerKey} transparent animationType="fade" onRequestClose={() => setPickerKey(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPickerKey(null)}>
          <Pressable style={styles.sheet} onPress={() => {}} testID="privacy-picker-sheet">
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>{pickerKey ? SECTIONS.find((section) => section.key === pickerKey)?.label : ''}</Text>
            {currentPickerOptions.map((option) => {
              const selected = pickerKey ? draft[pickerKey] === option : false;
              return (
                <TouchableOpacity key={option} style={styles.optionRow} onPress={() => pickerKey && onPickVisibility(pickerKey, option as VisibilityValue | GroupsValue)} testID={`privacy-opt-${option}`}>
                  <Text style={styles.optionLabel}>{currentPickerLabels[option]}</Text>
                  {selected ? <Feather name="check" size={20} color={Colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.base, marginTop: Spacing.md, padding: 12, backgroundColor: Colors.primaryLight, borderRadius: Radius.md },
  heroText: { color: Colors.textPrimary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  section: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.primary, letterSpacing: 1, paddingHorizontal: Spacing.base, paddingTop: Spacing.lg, paddingBottom: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: Spacing.base, paddingVertical: 14, backgroundColor: Colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderLight },
  iconWrap: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  rowValue: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.semibold },
  footnote: { fontSize: FontSize.xs, color: Colors.textMuted, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, lineHeight: 16, fontStyle: 'italic' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 24, ...Shadow.lg },
  grabber: { width: 40, height: 4, backgroundColor: Colors.border, borderRadius: 2, alignSelf: 'center', marginVertical: Spacing.sm },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, paddingHorizontal: Spacing.base, paddingBottom: Spacing.sm },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: Spacing.base },
  optionLabel: { fontSize: FontSize.base, color: Colors.textPrimary },
  flexOne: { flex: 1 },
});