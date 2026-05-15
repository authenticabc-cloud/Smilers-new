import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as LocalAuthentication from 'expo-local-authentication';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';
import {
  APP_LOCK_PIN_KEY,
  APP_LOCK_SETTINGS_KEY,
  DEFAULT_APP_LOCK_SETTINGS,
  readStoredJson,
  readStoredString,
  removeStoredValue,
  writeStoredJson,
  writeStoredString,
} from '../src/lib/settingsStorage';

const AUTO_LOCK_OPTIONS = [
  { key: 'immediately', label: 'Immediately' },
  { key: '1-minute', label: 'After 1 minute' },
  { key: '15-minutes', label: 'After 15 minutes' },
  { key: '1-hour', label: 'After 1 hour' },
];

export default function AppLockScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState(DEFAULT_APP_LOCK_SETTINGS);
  const [hasPin, setHasPin] = useState(false);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinMode, setPinMode] = useState<'create' | 'change' | 'verify'>('create');
  const [pinInput, setPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [supportState, setSupportState] = useState({ available: false, label: 'Biometric unlock' });
  const [statusNote, setStatusNote] = useState('Checking device security…');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const storedSettings = await readStoredJson(APP_LOCK_SETTINGS_KEY, DEFAULT_APP_LOCK_SETTINGS);
      const storedPin = await readStoredString(APP_LOCK_PIN_KEY);
      const available = Platform.OS !== 'web' && (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
      const supportedTypes = available ? await LocalAuthentication.supportedAuthenticationTypesAsync() : [];
      const label = supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
        ? 'Face ID'
        : supportedTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
          ? 'Fingerprint'
          : 'Biometric unlock';

      if (mounted) {
        setSettings({ ...DEFAULT_APP_LOCK_SETTINGS, ...(storedSettings || {}) });
        setHasPin(!!storedPin);
        setSupportState({ available, label });
        setStatusNote(storedPin ? 'PIN saved on this device' : 'Add a PIN to protect Smilers');
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const statusText = useMemo(() => {
    if (!settings.enabled) {
      return 'App Lock is off';
    }
    return settings.biometric && supportState.available ? `App Lock is on · ${supportState.label} + PIN` : 'App Lock is on · PIN required';
  }, [settings, supportState]);

  const saveSettings = async (next: typeof DEFAULT_APP_LOCK_SETTINGS) => {
    setSettings(next);
    await writeStoredJson(APP_LOCK_SETTINGS_KEY, next);
  };

  const openPinModal = (mode: 'create' | 'change' | 'verify') => {
    setPinMode(mode);
    setPinInput('');
    setConfirmPinInput('');
    setPinModalVisible(true);
  };

  const onToggleEnabled = async (value: boolean) => {
    if (value && !hasPin) {
      openPinModal('create');
      return;
    }
    const next = { ...settings, enabled: value };
    await saveSettings(next);
    setStatusNote(value ? 'App Lock enabled on this device' : 'App Lock turned off');
  };

  const onToggleBiometric = async (value: boolean) => {
    if (!value) {
      await saveSettings({ ...settings, biometric: false });
      setStatusNote('Biometric unlock turned off');
      return;
    }
    if (!supportState.available) {
      Alert.alert('Not available', 'Biometric unlock is not set up on this device yet.');
      return;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: `Enable ${supportState.label}`,
      fallbackLabel: 'Use PIN',
      cancelLabel: 'Cancel',
    });
    if (result.success) {
      await saveSettings({ ...settings, biometric: true, enabled: true });
      setStatusNote(`${supportState.label} enabled`);
      return;
    }
    setStatusNote(`${supportState.label} was not enabled`);
  };

  const savePin = async () => {
    const cleanPin = pinInput.trim();
    const cleanConfirm = confirmPinInput.trim();
    if (!/^\d{4,6}$/.test(cleanPin)) {
      Alert.alert('Use 4 to 6 digits', 'Choose a numeric PIN between 4 and 6 digits.');
      return;
    }
    if (pinMode !== 'verify' && cleanPin !== cleanConfirm) {
      Alert.alert('PIN mismatch', 'Make sure both PIN entries match.');
      return;
    }

    if (pinMode === 'verify') {
      const storedPin = await readStoredString(APP_LOCK_PIN_KEY);
      if (storedPin !== cleanPin) {
        Alert.alert('Wrong PIN', 'That PIN does not match the one saved on this device.');
        return;
      }
      setPinModalVisible(false);
      setStatusNote('Unlock test successful');
      return;
    }

    await writeStoredString(APP_LOCK_PIN_KEY, cleanPin);
    const next = { ...settings, enabled: true };
    await saveSettings(next);
    setHasPin(true);
    setPinModalVisible(false);
    setStatusNote(pinMode === 'change' ? 'PIN updated successfully' : 'App Lock enabled with a new PIN');
  };

  const removePin = () => {
    Alert.alert('Turn off App Lock?', 'This removes the PIN from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Turn Off',
        style: 'destructive',
        onPress: async () => {
          await removeStoredValue(APP_LOCK_PIN_KEY);
          await saveSettings({ ...DEFAULT_APP_LOCK_SETTINGS });
          setHasPin(false);
          setStatusNote('PIN removed from this device');
        },
      },
    ]);
  };

  const testUnlock = async () => {
    if (settings.biometric && supportState.available) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Smilers',
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
      });
      if (result.success) {
        setStatusNote('Biometric unlock successful');
        return;
      }
    }
    openPinModal('verify');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="app-lock-screen">
      <Header title="App Lock" showBack onBack={() => router.back()} variant="dark" subtitle="PIN code and biometric unlock" />
      <ScrollView contentContainerStyle={styles.content} testID="app-lock-scroll-view">
        <View style={styles.heroCard} testID="app-lock-hero-card">
          <View style={styles.heroIconWrap} testID="app-lock-hero-icon-wrap">
            <Ionicons name="lock-closed-outline" size={24} color={Colors.primary} />
          </View>
          <View style={styles.flexOne}>
            <Text style={styles.heroTitle} testID="app-lock-hero-title">Protect Smilers</Text>
            <Text style={styles.heroSub} testID="app-lock-hero-subtitle">
              Lock the app with a device PIN, and optionally use {supportState.label.toLowerCase()} when available.
            </Text>
          </View>
        </View>

        <Text style={styles.statusText} testID="app-lock-status-text">{statusText}</Text>
        <Text style={styles.noteText} testID="app-lock-note-text">{statusNote}</Text>

        <View style={styles.card} testID="app-lock-main-card">
          <SettingRow
            title="Require App Lock"
            subtitle={hasPin ? 'Ask for your PIN before opening protected content.' : 'Create a PIN to turn on App Lock.'}
            value={settings.enabled}
            onValueChange={onToggleEnabled}
            testID="app-lock-enable"
          />
          <SettingRow
            title={supportState.label}
            subtitle={supportState.available ? 'Use biometrics after you confirm once on this device.' : 'Set up biometrics on your device to enable this.'}
            value={settings.biometric}
            onValueChange={onToggleBiometric}
            disabled={!supportState.available || !hasPin}
            testID="app-lock-biometric"
          />
          <SettingRow
            title="Hide Message Preview"
            subtitle="Blur message content when the app is locked."
            value={settings.previewContent}
            onValueChange={(value) => saveSettings({ ...settings, previewContent: value })}
            disabled={!settings.enabled}
            testID="app-lock-preview"
          />
          <SettingRow
            title="Lock When App Goes to Background"
            subtitle="Require unlock again after switching away from Smilers."
            value={settings.lockOnBackground}
            onValueChange={(value) => saveSettings({ ...settings, lockOnBackground: value })}
            disabled={!settings.enabled}
            testID="app-lock-background"
          />
        </View>

        <View style={styles.card} testID="app-lock-auto-lock-card">
          <Text style={styles.sectionTitle} testID="app-lock-auto-lock-title">Auto-lock timer</Text>
          <Text style={styles.sectionSub} testID="app-lock-auto-lock-subtitle">
            Choose how quickly Smilers asks for your PIN again.
          </Text>
          <View style={styles.optionGrid} testID="app-lock-auto-lock-options">
            {AUTO_LOCK_OPTIONS.map((option) => {
              const selected = settings.autoLock === option.key;
              return (
                <TouchableOpacity
                  key={option.key}
                  style={[styles.optionChip, selected ? styles.optionChipActive : null, !settings.enabled ? styles.optionChipDisabled : null]}
                  disabled={!settings.enabled}
                  onPress={() => saveSettings({ ...settings, autoLock: option.key })}
                  testID={`app-lock-auto-lock-${option.key}`}
                >
                  <Text style={[styles.optionChipText, selected ? styles.optionChipTextActive : null]}>{option.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.buttonGroup} testID="app-lock-actions-group">
          <TouchableOpacity
            style={[styles.primaryButton, !hasPin ? styles.primaryButtonDisabled : null]}
            disabled={!hasPin}
            onPress={() => openPinModal('change')}
            testID="app-lock-change-pin-button"
          >
            <Text style={styles.primaryButtonText}>Change PIN</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryButton, !hasPin ? styles.secondaryButtonDisabled : null]}
            disabled={!hasPin}
            onPress={testUnlock}
            testID="app-lock-test-unlock-button"
          >
            <MaterialCommunityIcons name="shield-check-outline" size={18} color={Colors.primary} />
            <Text style={styles.secondaryButtonText}>Test Unlock</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryButton, !hasPin ? styles.secondaryButtonDisabled : null]}
            disabled={!hasPin}
            onPress={removePin}
            testID="app-lock-turn-off-button"
          >
            <Ionicons name="trash-outline" size={18} color={Colors.danger} />
            <Text style={styles.turnOffText}>Turn Off App Lock</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal visible={pinModalVisible} transparent animationType="slide" onRequestClose={() => setPinModalVisible(false)}>
        <View style={styles.modalBackdrop} testID="app-lock-pin-modal-backdrop">
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalKeyboardWrap}>
            <View style={styles.modalCard} testID="app-lock-pin-modal">
              <Text style={styles.modalTitle} testID="app-lock-pin-modal-title">
                {pinMode === 'create' ? 'Create PIN' : pinMode === 'change' ? 'Change PIN' : 'Enter PIN'}
              </Text>
              <Text style={styles.modalSub} testID="app-lock-pin-modal-subtitle">
                {pinMode === 'verify'
                  ? 'Enter your saved PIN to unlock Smilers.'
                  : 'Choose a 4 to 6 digit PIN for this device.'}
              </Text>
              <TextInput
                value={pinInput}
                onChangeText={setPinInput}
                placeholder="PIN"
                placeholderTextColor={Colors.textMuted}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={6}
                style={styles.input}
                testID="app-lock-pin-input"
              />
              {pinMode !== 'verify' ? (
                <TextInput
                  value={confirmPinInput}
                  onChangeText={setConfirmPinInput}
                  placeholder="Confirm PIN"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={6}
                  style={styles.input}
                  testID="app-lock-confirm-pin-input"
                />
              ) : null}
              <View style={styles.modalActions} testID="app-lock-pin-modal-actions">
                <TouchableOpacity style={styles.modalSecondaryButton} onPress={() => setPinModalVisible(false)} testID="app-lock-pin-cancel-button">
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalPrimaryButton} onPress={savePin} testID="app-lock-pin-save-button">
                  <Text style={styles.modalPrimaryButtonText}>{pinMode === 'verify' ? 'Unlock' : 'Save PIN'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function SettingRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled,
  testID,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <View style={styles.row} testID={`${testID}-row`}>
      <View style={styles.flexOne}>
        <Text style={styles.rowTitle} testID={`${testID}-title`}>{title}</Text>
        <Text style={styles.rowSub} testID={`${testID}-subtitle`}>{subtitle}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
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
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
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
  statusText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  noteText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { marginTop: 4, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  sectionSub: { marginTop: 6, marginBottom: Spacing.base, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  optionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  optionChip: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    justifyContent: 'center',
  },
  optionChipActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  optionChipDisabled: { opacity: 0.45 },
  optionChipText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textSecondary },
  optionChipTextActive: { color: Colors.primaryDark },
  buttonGroup: { gap: 12 },
  primaryButton: {
    minHeight: 48,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  secondaryButton: {
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  secondaryButtonDisabled: { opacity: 0.5 },
  secondaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  turnOffText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.danger },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalKeyboardWrap: { width: '100%' },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: Spacing.base,
    gap: 12,
  },
  modalTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center' },
  modalSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  input: {
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.base,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  modalPrimaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPrimaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSecondaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  flexOne: { flex: 1 },
});