import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export const PRIVACY_SETTINGS_KEY = 'smilers_privacy_settings';
export const APP_LOCK_SETTINGS_KEY = 'smilers_app_lock_settings';
export const APP_LOCK_PIN_KEY = 'smilers_app_lock_pin';
export const SCHEDULED_MESSAGES_KEY = 'smilers_scheduled_messages';
export const QUICK_TEMPLATES_KEY = 'smilers_quick_templates';
export const CHAT_APPEARANCE_KEY = 'smilers_chat_appearance';
export const PHONE_VERIFIED_INSTALL_KEY = 'smilers_phone_verified_install';

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
  autoLock: 'immediately',
  lockOnBackground: true,
};

export const DEFAULT_CHAT_APPEARANCE = {
  wallpaper: 'cream',
  outgoingColor: 'gold',
  incomingColor: 'white',
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