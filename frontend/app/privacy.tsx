import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';
import {
  DEFAULT_PRIVACY_SETTINGS,
  PRIVACY_SETTINGS_KEY,
  readStoredJson,
  writeStoredJson,
} from '../src/lib/settingsStorage';

const VISIBILITY_OPTIONS = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'contacts', label: 'My Contacts' },
  { key: 'nobody', label: 'Nobody' },
];

const GROUP_OPTIONS = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'contacts', label: 'My Contacts' },
  { key: 'admins', label: 'Admins Only' },
];

export default function PrivacyScreen() {
  const router = useRouter();
  const { data: remoteSettings, refetch: refetchRemote } = useSafeConvexQuery(api.privacy.getSettings, {}, null);
  const updateRemoteSettings = useMutation(api.privacy.updateSettings);
  const [settings, setSettings] = useState(DEFAULT_PRIVACY_SETTINGS);
  const [isReady, setIsReady] = useState(false);
  const [savedNote, setSavedNote] = useState('Loading your privacy choices…');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const stored = await readStoredJson(PRIVACY_SETTINGS_KEY, DEFAULT_PRIVACY_SETTINGS);
      if (mounted) {
        setSettings({ ...DEFAULT_PRIVACY_SETTINGS, ...(stored || {}) });
        setSavedNote('Saved on this device');
        setIsReady(true);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!remoteSettings || typeof remoteSettings !== 'object') {
      return;
    }

    const merged = { ...DEFAULT_PRIVACY_SETTINGS, ...remoteSettings };
    setSettings(merged);
    void writeStoredJson(PRIVACY_SETTINGS_KEY, merged);
    setSavedNote('Synced with Smilers cloud');
    setIsReady(true);
  }, [remoteSettings]);

  const summary = useMemo(() => `${settings.lastSeen} · photo ${settings.profilePhoto} · groups ${settings.groups}`, [settings]);

  const updateSetting = async (key: string, value: string | boolean) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    setSavedNote('Saving…');
    await writeStoredJson(PRIVACY_SETTINGS_KEY, next);
    try {
      await updateRemoteSettings({ settings: next });
      await refetchRemote();
      setSavedNote('Synced with Smilers cloud');
    } catch (errorValue) {
      console.warn('privacy.updateSettings unavailable, using device storage', errorValue);
      setSavedNote('Saved on this device');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="privacy-screen">
      <Header title="Privacy" showBack onBack={() => router.back()} variant="dark" subtitle="Last seen, profile photo, about" />
      <ScrollView contentContainerStyle={styles.content} testID="privacy-scroll-view">
        <View style={styles.heroCard} testID="privacy-summary-card">
          <View style={styles.heroIconWrap} testID="privacy-summary-icon-wrap">
            <Ionicons name="shield-checkmark-outline" size={24} color={Colors.primary} />
          </View>
          <View style={styles.flexOne}>
            <Text style={styles.heroTitle} testID="privacy-summary-title">Privacy Controls</Text>
            <Text style={styles.heroSub} testID="privacy-summary-subtitle">
              Choose who can see your profile details and who can reach you.
            </Text>
          </View>
        </View>

        <Text style={styles.savedNote} testID="privacy-saved-note">{isReady ? savedNote : 'Loading your privacy choices…'}</Text>
        <Text style={styles.summaryPill} testID="privacy-summary-pill">{summary}</Text>

        <OptionSection
          title="Who can see my personal info"
          description="Match the web privacy flow by controlling visibility for profile details."
          items={[
            { key: 'lastSeen', label: 'Last Seen & Online', value: settings.lastSeen, options: VISIBILITY_OPTIONS },
            { key: 'profilePhoto', label: 'Profile Photo', value: settings.profilePhoto, options: VISIBILITY_OPTIONS },
            { key: 'about', label: 'About', value: settings.about, options: VISIBILITY_OPTIONS },
            { key: 'status', label: 'Status / Stories', value: settings.status, options: VISIBILITY_OPTIONS },
          ]}
          onSelect={updateSetting}
        />

        <OptionSection
          title="Who can contact me"
          description="Control who can add you to groups and who can call you directly."
          items={[
            { key: 'groups', label: 'Groups', value: settings.groups, options: GROUP_OPTIONS },
            { key: 'calls', label: 'Calls', value: settings.calls, options: VISIBILITY_OPTIONS },
          ]}
          onSelect={updateSetting}
        />

        <View style={styles.card} testID="privacy-messaging-card">
          <Text style={styles.sectionTitle} testID="privacy-messaging-title">Messaging Privacy</Text>
          <Text style={styles.sectionSub} testID="privacy-messaging-subtitle">
            Fine-tune how people see your activity when chatting with you.
          </Text>

          <ToggleRow
            title="Read Receipts"
            subtitle="If off, you won't send or receive read receipts."
            value={settings.readReceipts}
            onValueChange={(value) => updateSetting('readReceipts', value)}
            testID="privacy-read-receipts"
          />
          <ToggleRow
            title="Typing Indicators"
            subtitle="Show when you are typing or recording a voice note."
            value={settings.typingIndicators}
            onValueChange={(value) => updateSetting('typingIndicators', value)}
            testID="privacy-typing-indicators"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function OptionSection({
  title,
  description,
  items,
  onSelect,
}: {
  title: string;
  description: string;
  items: Array<{ key: string; label: string; value: string; options: Array<{ key: string; label: string }> }>;
  onSelect: (key: string, value: string) => void;
}) {
  return (
    <View style={styles.card} testID={`privacy-section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionSub}>{description}</Text>
      {items.map((item, itemIndex) => (
        <View key={item.key} style={[styles.optionBlock, itemIndex === items.length - 1 ? styles.optionBlockLast : null]}>
          <Text style={styles.rowTitle} testID={`privacy-label-${item.key}`}>{item.label}</Text>
          <View style={styles.chipRow} testID={`privacy-options-${item.key}`}>
            {item.options.map((option) => {
              const selected = item.value === option.key;
              return (
                <TouchableOpacity
                  key={option.key}
                  style={[styles.chip, selected ? styles.chipActive : null]}
                  onPress={() => onSelect(item.key, option.key)}
                  testID={`privacy-option-${item.key}-${option.key}`}
                >
                  <Text style={[styles.chipText, selected ? styles.chipTextActive : null]}>{option.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

function ToggleRow({
  title,
  subtitle,
  value,
  onValueChange,
  testID,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  testID: string;
}) {
  return (
    <View style={styles.toggleRow} testID={`${testID}-row`}>
      <View style={styles.flexOne}>
        <Text style={styles.rowTitle} testID={`${testID}-title`}>{title}</Text>
        <Text style={styles.rowSub} testID={`${testID}-subtitle`}>{subtitle}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: Colors.primary, false: '#d1d5db' }}
        testID={`${testID}-switch`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.base, paddingBottom: 56, gap: Spacing.base },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  heroIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
  },
  heroTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  heroSub: { marginTop: 4, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  savedNote: { fontSize: FontSize.sm, color: Colors.textSecondary },
  summaryPill: {
    fontSize: FontSize.sm,
    color: Colors.primaryDark,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  sectionSub: { marginTop: 6, marginBottom: Spacing.base, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  optionBlock: { paddingBottom: Spacing.base, marginBottom: Spacing.base, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  optionBlockLast: { paddingBottom: 0, marginBottom: 0, borderBottomWidth: 0 },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { marginTop: 4, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    justifyContent: 'center',
  },
  chipActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  chipText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textSecondary },
  chipTextActive: { color: Colors.primaryDark },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  flexOne: { flex: 1 },
});