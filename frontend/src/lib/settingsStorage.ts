import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PRIVACY_SETTINGS_KEY = 'smilers_privacy_settings';
export const APP_LOCK_SETTINGS_KEY = 'smilers_app_lock_settings';
export const APP_LOCK_PIN_KEY = 'smilers_app_lock_pin';
export const SCHEDULED_MESSAGES_KEY = 'smilers_scheduled_messages';
export const QUICK_TEMPLATES_KEY = 'smilers_quick_templates';
export const CHAT_APPEARANCE_KEY = 'smilers_chat_appearance';
export const PHONE_VERIFIED_INSTALL_KEY = 'smilers_phone_verified_install';
// Set to 'true' once the user has completed verification on THIS install. Lives
// in AsyncStorage (wiped on uninstall on BOTH platforms), so its PRESENCE proves
// local app data survived — i.e. this launch is an in-place UPDATE, not a fresh
// install / reinstall (which wipes it). Used together with the server
// `phoneVerified` flag to skip re-verification on updates while still requiring
// it on a genuine reinstall.
export const DEVICE_PROVISIONED_KEY = 'smilers_device_provisioned_v1';

export const DEFAULT_PRIVACY_SETTINGS = {
  lastSeen: 'everyone',
  profilePhoto: 'everyone',
  about: 'everyone',
  status: 'contacts',
  groups: 'everyone',
  calls: 'everyone',
  readReceipts: true,
  typingIndicators: true,
};

export const DEFAULT_APP_LOCK_SETTINGS = {
  enabled: false,
  biometric: false,
  previewContent: false,
  /**
   * Inactivity timer (minutes) before App Lock re-engages once the app
   * is returned to from background. Accepts 1 | 5 | 15 | 30.
   */
  autoLockMinutes: 15,
  /**
   * If true, lock immediately whenever the app leaves the foreground.
   */
  lockOnLeaving: false,
  /**
   * @deprecated kept for backwards-compatibility with older installs.
   */
  autoLock: 'immediately',
  lockOnBackground: true,
};

export const DEFAULT_CHAT_APPEARANCE = {
  wallpaper: 'sunrise',
  outgoingColor: 'eucalyptus',
  incomingColor: 'mist',
  bubbleStyle: 'rounded',
  textSize: 'base',
};

function getWebStorage() {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage;
}

export async function readStoredJson(key: string, fallback: any) {
  try {
    const raw = Platform.OS === 'web' ? getWebStorage()?.getItem(key) : await SecureStore.getItemAsync(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch (errorValue) {
    console.warn('Failed to read stored json', key, errorValue);
    return fallback;
  }
}

export async function writeStoredJson(key: string, value: any) {
  try {
    const serialized = JSON.stringify(value);
    if (Platform.OS === 'web') {
      getWebStorage()?.setItem(key, serialized);
      return;
    }
    await SecureStore.setItemAsync(key, serialized);
  } catch (errorValue) {
    console.warn('Failed to write stored json', key, errorValue);
  }
}

export async function readStoredString(key: string) {
  try {
    if (Platform.OS === 'web') {
      return getWebStorage()?.getItem(key) || '';
    }
    return (await SecureStore.getItemAsync(key)) || '';
  } catch (errorValue) {
    console.warn('Failed to read stored string', key, errorValue);
    return '';
  }
}

export async function writeStoredString(key: string, value: string) {
  try {
    if (Platform.OS === 'web') {
      getWebStorage()?.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  } catch (errorValue) {
    console.warn('Failed to write stored string', key, errorValue);
  }
}

export async function removeStoredValue(key: string) {
  try {
    if (Platform.OS === 'web') {
      getWebStorage()?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  } catch (errorValue) {
    console.warn('Failed to remove stored value', key, errorValue);
  }
}

/**
 * Install-scoped marker helpers (e.g. PHONE_VERIFIED_INSTALL_KEY).
 *
 * These MUST live in storage that is CLEARED on app uninstall on BOTH platforms
 * so a reinstall forces the flow again. expo-secure-store uses the iOS Keychain,
 * which PERSISTS across uninstall — so a reinstalled iOS app would wrongly skip
 * phone verification. AsyncStorage (NSUserDefaults on iOS, cleared on uninstall)
 * gives the correct "re-verify on every fresh install" behavior. We also delete
 * any legacy Keychain copy on write so it can't act as a reinstall backdoor.
 */
export async function readInstallMarker(key: string): Promise<string> {
  try {
    if (Platform.OS === 'web') {
      return getWebStorage()?.getItem(key) || '';
    }
    return (await AsyncStorage.getItem(key)) || '';
  } catch (errorValue) {
    console.warn('Failed to read install marker', key, errorValue);
    return '';
  }
}

export async function writeInstallMarker(key: string, value: string) {
  try {
    if (Platform.OS === 'web') {
      getWebStorage()?.setItem(key, value);
      return;
    }
    await AsyncStorage.setItem(key, value);
    // Drop any legacy Keychain copy so it can't survive an uninstall.
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* ignore */
    }
  } catch (errorValue) {
    console.warn('Failed to write install marker', key, errorValue);
  }
}

/**
 * Mark this install as "provisioned" — call once we KNOW the user has completed
 * phone verification on this install (e.g. right after a successful OTP verify,
 * or on entering the authenticated app with a verified marker). Persists a flag
 * that survives in-place updates but is wiped on uninstall.
 */
export async function markDeviceProvisioned(): Promise<void> {
  await writeInstallMarker(DEVICE_PROVISIONED_KEY, 'true');
}

/**
 * Decide whether phone verification can be SKIPPED for this launch.
 *
 *  1. Primary source of truth: the local install marker (AsyncStorage) — set the
 *     last time verification completed on this install; survives in-place updates.
 *  2. Update-friendly fallback (approved behavior): if the marker is missing but
 *     the server says this account is already `phoneVerified` AND the device was
 *     previously provisioned (proving local data survived = this is an UPDATE,
 *     not a reinstall), treat as verified and re-persist the marker so the check
 *     is instant next time.
 *
 * A genuine reinstall wipes ALL AsyncStorage (marker + provisioned flag), so the
 * fallback can't fire there — verification is still required, preserving the
 * "re-verify on reinstall" behavior.
 */
export async function resolveInstallVerified(serverPhoneVerified: boolean): Promise<boolean> {
  const marker = await readInstallMarker(PHONE_VERIFIED_INSTALL_KEY);
  if (marker === 'true') return true;
  if (serverPhoneVerified) {
    const provisioned = await readInstallMarker(DEVICE_PROVISIONED_KEY);
    if (provisioned === 'true') {
      // Updating, already-verified account — don't force re-verification.
      await writeInstallMarker(PHONE_VERIFIED_INSTALL_KEY, 'true');
      return true;
    }
  }
  return false;
}