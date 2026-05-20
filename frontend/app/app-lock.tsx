import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
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
import {
  notifyAppLockSettingsChanged,
  triggerLockNow,
} from '../src/lib/appLockController';

const AUTO_LOCK_OPTIONS: Array<{ minutes: number; label: string }> = [
  { minutes: 1, label: '1 min' },
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
];

interface SettingsShape {
  enabled: boolean;
  biometric: boolean;
  lockOnLeaving: boolean;
  autoLockMinutes: number;
  // kept for backwards-compat persistence
  previewContent: boolean;
}

const INITIAL_SETTINGS: SettingsShape = {
  enabled: false,
  biometric: false,
  lockOnLeaving: false,
  autoLockMinutes: 15,
  previewContent: false,
};

export default function AppLockScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState<SettingsShape>(INITIAL_SETTINGS);
  const [hasPin, setHasPin] = useState(false);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinMode, setPinMode] = useState<'create' | 'change' | 'verify-old'>('create');
  const [pinInput, setPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [oldPinInput, setOldPinInput] = useState('');
  const [bioSupported, setBioSupported] = useState(false);
  const [bioLabel, setBioLabel] = useState('Fingerprint Unlock');
  const [bioSubtitle, setBioSubtitle] = useState('Use fingerprint to unlock');

  const persistSettings = useCallback(
    async (next: SettingsShape) => {
      setSettings(next);
      // Persist with all keys (including legacy ones for backwards compat)
      await writeStoredJson(APP_LOCK_SETTINGS_KEY, {
        ...DEFAULT_APP_LOCK_SETTINGS,
        enabled: next.enabled,
        biometric: next.biometric,
        lockOnLeaving: next.lockOnLeaving,
        autoLockMinutes: next.autoLockMinutes,
        previewContent: next.previewContent,
      });
      notifyAppLockSettingsChanged();
    },
    []
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const stored = await readStoredJson(APP_LOCK_SETTINGS_KEY, DEFAULT_APP_LOCK_SETTINGS);
      const merged = { ...DEFAULT_APP_LOCK_SETTINGS, ...(stored || {}) };
      const pin = await readStoredString(APP_LOCK_PIN_KEY);

      let supported = false;
      let lbl = 'Fingerprint Unlock';
      let sub = 'Use fingerprint to unlock';
      if (Platform.OS !== 'web') {
        try {
          const hw = await LocalAuthentication.hasHardwareAsync();
          const enrolled = await LocalAuthentication.isEnrolledAsync();
          supported = hw && enrolled;
          if (supported) {
            const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
            if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
              lbl = 'Face ID Unlock';
              sub = 'Use Face ID to unlock';
            } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
              lbl = 'Fingerprint Unlock';
              sub = 'Use fingerprint to unlock';
            } else {
              lbl = 'Biometric Unlock';
              sub = 'Use biometrics to unlock';
            }
          }
        } catch {
          supported = false;
        }
      }

      if (mounted) {
        setSettings({
          enabled: !!merged.enabled,
          biometric: !!merged.biometric,
          lockOnLeaving: !!merged.lockOnLeaving,
          autoLockMinutes:
            typeof merged.autoLockMinutes === 'number' ? merged.autoLockMinutes : 15,
          previewContent: !!merged.previewContent,
        });
        setHasPin(!!pin);
        setBioSupported(supported);
        setBioLabel(lbl);
        setBioSubtitle(sub);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const openPinModal = useCallback((mode: 'create' | 'change') => {
    setPinMode(mode);
    setPinInput('');
    setConfirmPinInput('');
    setOldPinInput('');
    setPinModalVisible(true);
  }, []);

  const onTogglePinLock = useCallback(
    async (value: boolean) => {
      if (value) {
        if (hasPin) {
          await persistSettings({ ...settings, enabled: true });
        } else {
          openPinModal('create');
        }
        return;
      }
      // Turning off App Lock — confirm and remove stored PIN
      Alert.alert(
        'Turn off PIN Lock?',
        'This removes the saved PIN from this device. You can set a new PIN any time.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Turn Off',
            style: 'destructive',
            onPress: async () => {
              await removeStoredValue(APP_LOCK_PIN_KEY);
              setHasPin(false);
              await persistSettings({
                ...settings,
                enabled: false,
                biometric: false,
              });
            },
          },
        ]
      );
    },
    [hasPin, openPinModal, persistSettings, settings]
  );

  const onToggleBiometric = useCallback(
    async (value: boolean) => {
      if (!value) {
        await persistSettings({ ...settings, biometric: false });
        return;
      }
      if (!bioSupported) {
        Alert.alert(
          'Not available',
          `${bioLabel.replace(' Unlock', '')} is not set up on this device. Add it in your phone’s security settings first.`
        );
        return;
      }
      if (!hasPin) {
        Alert.alert('Set a PIN first', 'Create a PIN before enabling biometric unlock.');
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Enable ${bioLabel}`,
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
      });
      if (result.success) {
        await persistSettings({ ...settings, biometric: true });
      }
    },
    [bioLabel, bioSupported, hasPin, persistSettings, settings]
  );

  const onToggleLockOnLeaving = useCallback(
    async (value: boolean) => {
      await persistSettings({ ...settings, lockOnLeaving: value });
    },
    [persistSettings, settings]
  );

  const onSelectAutoLock = useCallback(
    async (minutes: number) => {
      await persistSettings({ ...settings, autoLockMinutes: minutes });
    },
    [persistSettings, settings]
  );

  const onLockNow = useCallback(() => {
    if (!hasPin || !settings.enabled) {
      Alert.alert(
        'Enable PIN Lock first',
        'Turn on PIN Lock and set a PIN to use Lock Now.'
      );
      return;
    }
    triggerLockNow();
    // Pop back so the user is not still sitting on this screen behind the overlay
    router.back();
  }, [hasPin, router, settings.enabled]);

  const onChangePinPressed = useCallback(() => {
    if (!hasPin) {
      openPinModal('create');
    } else {
      openPinModal('change');
    }
  }, [hasPin, openPinModal]);

  const submitPinModal = useCallback(async () => {
    const newPin = pinInput.trim();
    const confirmPin = confirmPinInput.trim();

    if (!/^\d{4,6}$/.test(newPin)) {
      Alert.alert('Use 4 to 6 digits', 'Choose a numeric PIN between 4 and 6 digits.');
      return;
    }
    if (newPin !== confirmPin) {
      Alert.alert('PIN mismatch', 'Make sure both PIN entries match.');
      return;
    }

    if (pinMode === 'change') {
      const stored = await readStoredString(APP_LOCK_PIN_KEY);
      if (stored && stored !== oldPinInput.trim()) {
        Alert.alert('Wrong current PIN', 'Enter your existing PIN to change it.');
        return;
      }
    }

    await writeStoredString(APP_LOCK_PIN_KEY, newPin);
    setHasPin(true);
    setPinModalVisible(false);
    await persistSettings({
      ...settings,
      enabled: true,
    });
    Alert.alert(
      pinMode === 'change' ? 'PIN updated' : 'PIN Lock enabled',
      pinMode === 'change'
        ? 'Your PIN has been changed.'
        : 'App Lock is now active. The app will lock when you leave it.'
    );
  }, [confirmPinInput, oldPinInput, persistSettings, pinInput, pinMode, settings]);

  const autoLockChips = useMemo(() => {
    return AUTO_LOCK_OPTIONS.map((option) => {
      const selected = settings.autoLockMinutes === option.minutes;
      const disabled = !settings.enabled;
      return (
        <TouchableOpacity
          key={option.minutes}
          onPress={() => onSelectAutoLock(option.minutes)}
          disabled={disabled}
          style={[
            styles.autoLockChip,
            selected ? styles.autoLockChipActive : null,
            disabled && !selected ? styles.autoLockChipDisabled : null,
          ]}
          testID={`auto-lock-${option.minutes}`}
          activeOpacity={0.85}
        >
          <Text
            style={[
              styles.autoLockChipText,
              selected ? styles.autoLockChipTextActive : null,
            ]}
          >
            {option.label}
          </Text>
        </TouchableOpacity>
      );
    });
  }, [onSelectAutoLock, settings.autoLockMinutes, settings.enabled]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="app-lock-screen">
      <Header title="App Lock" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* PIN Lock */}
        <View style={styles.row} testID="app-lock-pin-row">
          <RowIcon name="lock" lib="feather" />
          <View style={styles.rowMid}>
            <Text style={styles.rowTitle}>PIN Lock</Text>
            <Text style={styles.rowSubtitle}>
              {settings.enabled ? 'App is protected with a PIN' : 'Tap to set up a PIN'}
            </Text>
          </View>
          <Switch
            value={settings.enabled}
            onValueChange={onTogglePinLock}
            trackColor={{ true: Colors.primary, false: '#d1d5db' }}
            thumbColor={Colors.white}
            testID="app-lock-pin-switch"
          />
        </View>

        {/* Fingerprint */}
        <View style={styles.row} testID="app-lock-biometric-row">
          <RowIcon name="fingerprint" lib="mc" />
          <View style={styles.rowMid}>
            <Text style={styles.rowTitle}>{bioLabel}</Text>
            <Text style={styles.rowSubtitle}>
              {bioSupported ? bioSubtitle : 'Not set up on this device'}
            </Text>
          </View>
          <Switch
            value={settings.biometric}
            onValueChange={onToggleBiometric}
            disabled={!bioSupported || !hasPin || !settings.enabled}
            trackColor={{ true: Colors.primary, false: '#d1d5db' }}
            thumbColor={Colors.white}
            testID="app-lock-biometric-switch"
          />
        </View>

        {/* Lock When Leaving */}
        <View style={styles.row} testID="app-lock-leaving-row">
          <RowIcon name="shield-checkmark-outline" lib="ion" />
          <View style={styles.rowMid}>
            <Text style={styles.rowTitle}>Lock When Leaving</Text>
            <Text style={styles.rowSubtitle}>Lock immediately when you switch apps</Text>
          </View>
          <Switch
            value={settings.lockOnLeaving}
            onValueChange={onToggleLockOnLeaving}
            disabled={!settings.enabled}
            trackColor={{ true: Colors.primary, false: '#d1d5db' }}
            thumbColor={Colors.white}
            testID="app-lock-leaving-switch"
          />
        </View>

        {/* Auto-Lock After */}
        <View style={styles.rowTall} testID="app-lock-auto-row">
          <View style={styles.rowTop}>
            <RowIcon name="timer-outline" lib="ion" />
            <View style={styles.rowMid}>
              <Text style={styles.rowTitle}>Auto-Lock After</Text>
              <Text style={styles.rowSubtitle}>Lock the app after inactivity</Text>
            </View>
          </View>
          <View style={styles.autoLockChipsRow}>{autoLockChips}</View>
        </View>

        {/* Spacer */}
        <View style={styles.sectionSpacer} />

        {/* Lock Now */}
        <TouchableOpacity
          style={styles.row}
          onPress={onLockNow}
          activeOpacity={0.7}
          testID="app-lock-lock-now"
        >
          <RowIcon name="shield-off" lib="feather" tint="danger" />
          <View style={styles.rowMid}>
            <Text style={styles.rowTitle}>Lock Now</Text>
            <Text style={styles.rowSubtitle}>Immediately lock the app</Text>
          </View>
        </TouchableOpacity>

        {/* Change PIN */}
        <TouchableOpacity
          style={styles.row}
          onPress={onChangePinPressed}
          activeOpacity={0.7}
          testID="app-lock-change-pin"
        >
          <RowIcon name="lock" lib="feather" />
          <View style={styles.rowMid}>
            <Text style={styles.rowTitle}>{hasPin ? 'Change PIN' : 'Set a PIN'}</Text>
            <Text style={styles.rowSubtitle}>
              {hasPin ? 'Set a new PIN code' : 'Choose a 4 to 6 digit code'}
            </Text>
          </View>
        </TouchableOpacity>

        {/* Footer text */}
        <Text style={styles.footerText}>
          App lock keeps your conversations private. When enabled, you'll need to enter your PIN or
          use biometric authentication to access Smilers after the timeout period expires or when
          switching back to the app. After 5 failed attempts, the app will be temporarily locked for
          30 seconds.
        </Text>
      </ScrollView>

      {/* PIN entry / change modal */}
      <Modal
        visible={pinModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPinModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.modalKeyboard}
          >
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {pinMode === 'change' ? 'Change PIN' : 'Create PIN'}
              </Text>
              <Text style={styles.modalSubtitle}>
                Choose a 4 to 6 digit PIN. You will be asked for it every time you open Smilers.
              </Text>
              {pinMode === 'change' ? (
                <TextInput
                  value={oldPinInput}
                  onChangeText={setOldPinInput}
                  placeholder="Current PIN"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={6}
                  style={styles.input}
                  testID="app-lock-old-pin-input"
                />
              ) : null}
              <TextInput
                value={pinInput}
                onChangeText={setPinInput}
                placeholder="New PIN"
                placeholderTextColor={Colors.textMuted}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={6}
                style={styles.input}
                testID="app-lock-new-pin-input"
              />
              <TextInput
                value={confirmPinInput}
                onChangeText={setConfirmPinInput}
                placeholder="Confirm new PIN"
                placeholderTextColor={Colors.textMuted}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={6}
                style={styles.input}
                testID="app-lock-confirm-pin-input"
              />
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={styles.modalSecondaryButton}
                  onPress={() => setPinModalVisible(false)}
                  testID="app-lock-modal-cancel"
                >
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modalPrimaryButton}
                  onPress={submitPinModal}
                  testID="app-lock-modal-save"
                >
                  <Text style={styles.modalPrimaryButtonText}>
                    {pinMode === 'change' ? 'Update PIN' : 'Save PIN'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

interface RowIconProps {
  name: string;
  lib: 'feather' | 'ion' | 'mc';
  tint?: 'primary' | 'danger';
}

function RowIcon({ name, lib, tint = 'primary' }: RowIconProps) {
  const color = tint === 'danger' ? Colors.danger : Colors.primary;
  const bg = tint === 'danger' ? 'rgba(220,38,38,0.10)' : Colors.primaryLight;
  let Icon: any;
  if (lib === 'ion') Icon = Ionicons;
  else if (lib === 'mc') Icon = MaterialCommunityIcons;
  else Icon = Feather;
  return (
    <View style={[styles.iconWrap, { backgroundColor: bg }]}>
      <Icon name={name} size={20} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollContent: { paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
    backgroundColor: Colors.surface,
  },
  rowTall: {
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
    backgroundColor: Colors.surface,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  rowMid: { flex: 1 },
  rowTitle: {
    fontSize: 15,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  rowSubtitle: {
    marginTop: 2,
    fontSize: 13,
    color: Colors.textSecondary,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoLockChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingLeft: 40 + Spacing.md, // align with text
  },
  autoLockChip: {
    minHeight: 36,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoLockChipActive: {
    backgroundColor: Colors.primary,
  },
  autoLockChipDisabled: {
    opacity: 0.45,
  },
  autoLockChipText: {
    fontSize: 13,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  autoLockChipTextActive: {
    color: Colors.white,
  },
  sectionSpacer: {
    height: Spacing.sm,
  },
  footerText: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 20,
    textAlign: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalKeyboard: { width: '100%' },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: Spacing.base,
    gap: 12,
  },
  modalTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
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
  modalPrimaryButtonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSecondaryButtonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
});
