/**
 * deviceIdentity — a STABLE per-device identifier + a human-readable device
 * name, used by the "one active device" security feature (Bug 2b).
 *
 * The id is a random UUID persisted in the OS keychain (expo-secure-store) so
 * it stays constant for the life of the physical device across app restarts
 * AND app updates. We deliberately keep it in the keychain (not AsyncStorage)
 * because we WANT the same physical phone to keep the same device id even after
 * a reinstall — that's what lets the backend recognise "this is the same phone
 * reclaiming its session" vs. a genuinely different device.
 *
 * NOTE on lazy require: expo-secure-store's binding calls
 * requireNativeModule('ExpoSecureStore') at module scope. Importing it at the
 * top of a module that loads during bridgeless startup can race native module
 * registration (the same class of bug that caused the iOS splash hang), so we
 * require it lazily inside the functions that actually use it.
 */
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

const DEVICE_ID_KEY = 'smilers_device_id_v1';

let cachedId: string | null = null;

function newUuid(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    // Extremely defensive fallback — should never hit on device.
    return `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Returns a stable UUID identifying this physical device/install. */
export async function getDeviceId(): Promise<string> {
  if (cachedId) return cachedId;

  if (Platform.OS === 'web') {
    try {
      const ls = (globalThis as any)?.localStorage;
      let id = ls?.getItem(DEVICE_ID_KEY);
      if (!id) {
        id = newUuid();
        ls?.setItem(DEVICE_ID_KEY, id);
      }
      cachedId = id;
      return id;
    } catch {
      cachedId = cachedId || newUuid();
      return cachedId;
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SecureStore = require('expo-secure-store');
    let id = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (!id) {
      id = newUuid();
      await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
    }
    cachedId = id;
    return id;
  } catch {
    // Keychain unavailable — use an ephemeral id so the feature still works
    // within this session (it just won't persist across restarts).
    cachedId = cachedId || newUuid();
    return cachedId;
  }
}

/** A friendly name for this device, e.g. "Kojo's iPhone" or "Pixel 8". */
export function getDeviceName(): string {
  const name =
    Device.deviceName ||
    Device.modelName ||
    (Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android device' : 'This device');
  return String(name);
}

/** Platform label used for the takeover UI ("iOS" / "Android" / "Web"). */
export function getDevicePlatformLabel(): string {
  if (Platform.OS === 'ios') return 'iOS';
  if (Platform.OS === 'android') return 'Android';
  return 'Web';
}
