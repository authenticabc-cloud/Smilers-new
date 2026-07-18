/**
 * deviceNameResolver — background-safe phone → device-contact-name lookup.
 *
 * The React `deviceContactIndex` provider can't be used in headless push
 * handlers. On each successful contact refresh the provider persists a
 * snapshot to AsyncStorage (`smilers_device_contact_index_v1`); this module
 * loads that snapshot and reuses the pure `lookupDeviceContactName` matcher
 * so GROUP and DM notifications can show the sender's saved device name.
 */
import {
  lookupDeviceContactName,
  type DeviceContactIndex,
} from '../lib/deviceContactIndex';
import type { CountryCode } from 'libphonenumber-js';

const STORAGE_KEY = 'smilers_device_contact_index_v1';

let cached: DeviceContactIndex | null = null;
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        e164?: [string, string][];
        digits?: [string, string][];
        country?: string | null;
      };
      cached = {
        byE164: new Map(parsed.e164 || []),
        byDigits: new Map(parsed.digits || []),
        defaultCountry: (parsed.country as CountryCode) || null,
        lastRefreshedAt: Date.now(),
        isReady: true,
      };
    }
  } catch {
    cached = null;
  }
  loaded = true;
}

/** Resolve a raw phone (any format) to the device-saved name. '' on miss. */
export async function resolveDeviceNameByPhone(
  phone: string | null | undefined,
): Promise<string> {
  const p = (phone || '').trim();
  if (!p) return '';
  await ensureLoaded();
  if (!cached) return '';
  return lookupDeviceContactName(cached, p) || '';
}
