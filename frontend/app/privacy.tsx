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
  Image,
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
import {
  PRIVACY_SETTINGS_KEY,
  DEFAULT_PRIVACY_SETTINGS,
  readStoredJson,
  writeStoredJson,
} from '../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

type VisibilityKey = 'lastSeen' | 'profilePhoto' | 'about' | 'status';
type VisibilityValue = 'everyone' | 'contacts' | 'nobody' | 'only' | 'everyone_except';
type ListKey = 'lastSeenList' | 'profilePhotoList' | 'aboutList' | 'statusList';

interface PrivacySettings {
  lastSeen: VisibilityValue;
  profilePhoto: VisibilityValue;
  about: VisibilityValue;
  status: VisibilityValue;
  lastSeenList: string[];
  profilePhotoList: string[];
  aboutList: string[];
  statusList: string[];
  readReceipts: boolean;
  typingIndicators: boolean;
}

const DEFAULTS: PrivacySettings = {
  lastSeen: 'everyone',
  profilePhoto: 'everyone',
  about: 'everyone',
  status: 'contacts',
  lastSeenList: [],
  profilePhotoList: [],
  aboutList: [],
  statusList: [],
  readReceipts: true,
  typingIndicators: true,
};

// Maps each visibility field to the users-id list that backs its
// `only` (allow-list) / `everyone_except` (deny-list) policy.
const LIST_KEY: Record<VisibilityKey, ListKey> = {
  lastSeen: 'lastSeenList',
  profilePhoto: 'profilePhotoList',
  about: 'aboutList',
  status: 'statusList',
};

const VISIBILITY_LABEL: Record<VisibilityValue, string> = {
  everyone: 'Everyone',
  contacts: 'My contacts',
  nobody: 'Nobody',
  only: 'Nobody except…',
  everyone_except: 'Everyone except…',
};
const VISIBILITY_OPTIONS: VisibilityValue[] = ['everyone', 'contacts', 'nobody', 'only', 'everyone_except'];

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
  const [pickerKey, setPickerKey] = useState<VisibilityKey | null>(null);
  const controlsDisabled = !cloudSyncEnabled || saving;
  // People-picker (for `only` / `everyone_except` policies).
  const [contactPicker, setContactPicker] = useState<{ key: VisibilityKey; mode: VisibilityValue } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { data: contacts } = useSafeConvexQuery<any[]>(
    api.contacts.getContacts,
    {},
    [],
    cloudSyncEnabled && !!contactPicker,
  );

  useEffect(() => {
    // Preserve the locally-managed typingIndicators across server echoes —
    // the cloud `settings` may not include it (see persist()).
    if (serverSettings) {
      setDraft((prev) => ({ ...DEFAULTS, ...serverSettings, typingIndicators: prev.typingIndicators }));
    }
  }, [serverSettings]);

  // Seed typingIndicators from on-device storage on mount.
  useEffect(() => {
    let active = true;
    (async () => {
      const local = await readStoredJson(PRIVACY_SETTINGS_KEY, DEFAULT_PRIVACY_SETTINGS);
      if (active && local && typeof local.typingIndicators === 'boolean') {
        setDraft((prev) => ({ ...prev, typingIndicators: local.typingIndicators }));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const persist = useCallback(async (next: PrivacySettings) => {
    if (!cloudSyncEnabled) {
      return;
    }
    setDraft(next);
    // typingIndicators is managed ON-DEVICE and kept OUT of the cloud payload.
    // The Convex `updateSettings` validator may not define it; sending an
    // unknown field would reject the WHOLE mutation and revert every toggle
    // (the exact "typing indicators can't be turned on" symptom). Persist it
    // locally; sync the rest to the cloud.
    void writeStoredJson(PRIVACY_SETTINGS_KEY, { ...DEFAULT_PRIVACY_SETTINGS, ...next });
    setSaving(true);
    try {
      // iter-330: the Convex `updateSettings` mutation now takes TOP-LEVEL args
      // (per the web team's contract) — the policy strings, their allow/deny
      // user-id lists, and readReceipts. typingIndicators stays device-local.
      await updateSettings({
        lastSeen: next.lastSeen,
        profilePhoto: next.profilePhoto,
        about: next.about,
        status: next.status,
        lastSeenList: next.lastSeenList,
        profilePhotoList: next.profilePhotoList,
        aboutList: next.aboutList,
        statusList: next.statusList,
        readReceipts: next.readReceipts === true,
      });
    } catch {
      if (serverSettings) {
        setDraft((prev) => ({ ...DEFAULTS, ...serverSettings, typingIndicators: prev.typingIndicators }));
      }
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

  const onPickVisibility = (key: VisibilityKey, value: VisibilityValue) => {
    setPickerKey(null);
    // `only` / `everyone_except` need a people list → open the contact picker,
    // seeded with the field's current list. Other policies persist right away.
    if (value === 'only' || value === 'everyone_except') {
      const k = key as VisibilityKey;
      const existing = draft[LIST_KEY[k]];
      setSelectedIds(Array.isArray(existing) ? [...existing] : []);
      setContactPicker({ key: k, mode: value });
      return;
    }
    persist({ ...draft, [key]: value } as PrivacySettings);
  };

  const confirmContactPicker = () => {
    if (!contactPicker) return;
    const { key, mode } = contactPicker;
    persist({ ...draft, [key]: mode, [LIST_KEY[key]]: selectedIds } as PrivacySettings);
    setContactPicker(null);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // Row summary, e.g. "Everyone except (3)" / "Nobody except (2)".
  const summarizeValue = (key: VisibilityKey): string => {
    const v = draft[key] as VisibilityValue;
    if (v === 'only' || v === 'everyone_except') {
      const list = draft[LIST_KEY[key]];
      const count = Array.isArray(list) ? list.length : 0;
      return `${VISIBILITY_LABEL[v]} (${count})`;
    }
    return VISIBILITY_LABEL[v];
  };

  const onToggle = (key: 'readReceipts' | 'typingIndicators', value: boolean) => {
    persist({ ...draft, [key]: value });
  };

  const currentPickerOptions = useMemo(() => {
    if (!pickerKey) return [];
    return VISIBILITY_OPTIONS;
  }, [pickerKey]);

  const currentPickerLabels: Record<string, string> = VISIBILITY_LABEL;

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
          return (
            <TouchableOpacity key={section.key} style={styles.row} activeOpacity={0.7} onPress={() => setPickerKey(section.key)} disabled={controlsDisabled} testID={`privacy-${section.key}`}>
              <View style={styles.iconWrap}><Feather name={section.icon} size={20} color={Colors.primary} /></View>
              <View style={styles.flexOne}>
                <Text style={styles.rowTitle}>{section.label}</Text>
                <Text style={styles.rowSub}>{section.sub}</Text>
              </View>
              <Text style={styles.rowValue}>{summarizeValue(section.key)}</Text>
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
                <TouchableOpacity key={option} style={styles.optionRow} onPress={() => pickerKey && onPickVisibility(pickerKey, option as VisibilityValue)} testID={`privacy-opt-${option}`}>
                  <Text style={styles.optionLabel}>{currentPickerLabels[option]}</Text>
                  {selected ? <Feather name="check" size={20} color={Colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!contactPicker} animationType="slide" onRequestClose={() => setContactPicker(null)}>
        <SafeAreaView style={styles.container} edges={['top']} testID="privacy-contact-picker">
          <View style={styles.pickerHeader}>
            <TouchableOpacity onPress={() => setContactPicker(null)} testID="privacy-contact-cancel">
              <Text style={styles.pickerCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.pickerHeaderTitle} numberOfLines={1}>
              {contactPicker ? VISIBILITY_LABEL[contactPicker.mode].replace('…', '') : ''}
            </Text>
            <TouchableOpacity onPress={confirmContactPicker} testID="privacy-contact-done">
              <Text style={styles.pickerDone}>Done</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.pickerSubtitle}>
            {contactPicker?.mode === 'only'
              ? 'Only the people you select can see this.'
              : 'Everyone can see this except the people you select.'}
          </Text>
          <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
            {(Array.isArray(contacts) ? contacts : []).map((c: any) => {
              const id = String(c._id);
              const sel = selectedIds.includes(id);
              const name = c.name || 'Unknown';
              return (
                <TouchableOpacity key={id} style={styles.contactRow} onPress={() => toggleSelected(id)} testID={`privacy-contact-${id}`}>
                  {c.avatar ? (
                    <Image source={{ uri: c.avatar }} style={styles.contactAvatar} />
                  ) : (
                    <View style={[styles.contactAvatar, styles.contactAvatarFallback]}>
                      <Text style={styles.contactInitial}>{name.charAt(0).toUpperCase()}</Text>
                    </View>
                  )}
                  <Text style={styles.contactName} numberOfLines={1}>{name}</Text>
                  <View style={[styles.checkCircle, sel && styles.checkCircleOn]}>
                    {sel ? <Feather name="check" size={14} color={Colors.white} /> : null}
                  </View>
                </TouchableOpacity>
              );
            })}
            {!contacts || contacts.length === 0 ? (
              <Text style={styles.emptyContacts}>No contacts to choose from yet.</Text>
            ) : null}
          </ScrollView>
        </SafeAreaView>
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
  pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.base, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderLight, backgroundColor: Colors.surface },
  pickerHeaderTitle: { flex: 1, textAlign: 'center', fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginHorizontal: 8 },
  pickerCancel: { fontSize: FontSize.base, color: Colors.textSecondary },
  pickerDone: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primary },
  pickerSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: Spacing.base, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderLight },
  contactAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: Colors.primaryLight },
  contactAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  contactInitial: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primary },
  contactName: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  checkCircle: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  checkCircleOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  emptyContacts: { textAlign: 'center', color: Colors.textMuted, fontSize: FontSize.sm, paddingVertical: 40 },
});