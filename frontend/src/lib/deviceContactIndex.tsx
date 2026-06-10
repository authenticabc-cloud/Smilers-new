/**
 * Device Contact Index
 *
 * Single source of truth for the user's phone address-book names.
 *
 * Why this exists (iter-176 / user feedback):
 *   When User A has User B's number saved in their phone as "ABC Albania",
 *   the chats list / contacts list / chat header MUST display "ABC Albania"
 *   instead of B's Smilers display name (which often defaults to the
 *   Google/Apple account name, e.g. "Smilers"). The Smilers display name
 *   should ONLY surface on the user's own Profile page.
 *
 * How it works:
 *   - On app launch we silently check if Contacts permission was already
 *     granted (we never PROMPT here — the Contacts tab still owns the
 *     permission request UX).
 *   - If granted, we read the entire address book ONCE and build an
 *     in-memory map: `E.164 phone → device-saved name`.
 *   - Any screen can call `useDeviceContactName(phoneE164)` to resolve a
 *     name. Returns `null` when no match.
 *   - When the Contacts tab refreshes (or the user pulls to refresh) the
 *     provider exposes `refresh()` which rebuilds the index.
 *
 * Notes:
 *   - Phone numbers stored on the device often have spaces / dashes / local
 *     format. We try multiple normalisation strategies before giving up:
 *       1. libphonenumber parse with the user's default country code,
 *       2. digit-only strip (last 7-15 digits match against any indexed
 *          digit-only key — handy when the OS strips the country code).
 *   - The provider is intentionally LAZY on web: contacts API doesn't exist
 *     in the browser, so `index` stays empty and resolution always falls
 *     back to the Smilers name.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';
import * as Contacts from 'expo-contacts';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export type DeviceContactIndex = {
  /** E.164 → device-saved display name (e.g. "+355689498822" -> "ABC Albania"). */
  byE164: Map<string, string>;
  /** Digit-only suffix → name. Used as a fallback when the country code
   * is missing from one side of the comparison. Keys are the last N digits. */
  byDigits: Map<string, string>;
  /** Best-effort default country code of the current user (e.g. "AL"). */
  defaultCountry: CountryCode | null;
  /** Wall-clock ms of the last successful refresh. 0 if never. */
  lastRefreshedAt: number;
  /** True iff a successful read of the address book has populated the
   * maps. False on web or when permission was never granted. */
  isReady: boolean;
};

type ContextShape = {
  index: DeviceContactIndex;
  /** Re-read the device address book. Caller controls whether to request
   * permission (`requestPermission=true`) or silently skip if denied. */
  refresh: (options?: { requestPermission?: boolean }) => Promise<void>;
};

const EMPTY_INDEX: DeviceContactIndex = {
  byE164: new Map(),
  byDigits: new Map(),
  defaultCountry: null,
  lastRefreshedAt: 0,
  isReady: false,
};

const DeviceContactCtx = createContext<ContextShape>({
  index: EMPTY_INDEX,
  refresh: async () => {},
});

function normaliseDigits(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\D+/g, '');
}

function digitSuffix(digits: string, length = 10): string {
  if (digits.length <= length) return digits;
  return digits.slice(digits.length - length);
}

/**
 * Attempt to convert a raw phone string into E.164 using a default country
 * code as the parsing hint. Returns "" if the number is unrecognisable.
 */
export function toE164(raw: string | null | undefined, defaultCountry: CountryCode | null): string {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  try {
    const parsed = parsePhoneNumberFromString(trimmed, defaultCountry || undefined);
    if (parsed && parsed.isValid()) {
      return parsed.number; // E.164, e.g. "+355689498822"
    }
  } catch {
    /* fall through */
  }
  // Last-ditch: if the raw already starts with "+" and has 7-15 digits,
  // keep it as-is. Otherwise return empty.
  if (trimmed.startsWith('+')) {
    const onlyDigits = normaliseDigits(trimmed);
    if (onlyDigits.length >= 7 && onlyDigits.length <= 15) return `+${onlyDigits}`;
  }
  return '';
}

export function DeviceContactProvider({
  children,
  myDefaultCountry,
}: {
  children: React.ReactNode;
  /** Optional country hint, normally derived from the signed-in user's
   * own phone number. Used to parse device-stored numbers that omit the
   * country code (a very common case on Android). */
  myDefaultCountry?: CountryCode | string | null;
}) {
  const [index, setIndex] = useState<DeviceContactIndex>(EMPTY_INDEX);
  const inflightRef = useRef(false);

  const defaultCountry: CountryCode | null = useMemo(() => {
    const raw = (myDefaultCountry || '').toString().toUpperCase().trim();
    return raw && raw.length === 2 ? (raw as CountryCode) : null;
  }, [myDefaultCountry]);

  const refresh = useCallback(
    async (options?: { requestPermission?: boolean }) => {
      if (Platform.OS === 'web') return;
      if (inflightRef.current) return;
      inflightRef.current = true;
      try {
        let granted = false;
        try {
          const current = await Contacts.getPermissionsAsync();
          granted = !!current.granted;
          if (!granted && options?.requestPermission && current.canAskAgain) {
            const next = await Contacts.requestPermissionsAsync();
            granted = !!next.granted;
          }
        } catch {
          granted = false;
        }
        if (!granted) {
          // Don't clobber any previous index — just bail.
          return;
        }
        const { data } = await Contacts.getContactsAsync({
          fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
          pageSize: 10000,
        });
        const byE164 = new Map<string, string>();
        const byDigits = new Map<string, string>();
        for (const raw of (data as any[]) || []) {
          // Resolve the contact's display name. Skip "null" placeholder
          // entries (an Android quirk for SIM-only rows).
          const rawName: string =
            (typeof raw?.name === 'string' && raw.name.trim() && raw.name.trim().toLowerCase() !== 'null' && raw.name.trim()) ||
            (typeof raw?.firstName === 'string' && raw.firstName.trim()) ||
            (typeof raw?.lastName === 'string' && raw.lastName.trim()) ||
            '';
          if (!rawName) continue;
          const phones: any[] = Array.isArray(raw?.phoneNumbers) ? raw.phoneNumbers : [];
          for (const phoneEntry of phones) {
            const phoneStr: string = typeof phoneEntry?.number === 'string' ? phoneEntry.number : '';
            if (!phoneStr) continue;
            const e164 = toE164(phoneStr, defaultCountry);
            if (e164 && !byE164.has(e164)) {
              byE164.set(e164, rawName);
            }
            const digits = normaliseDigits(e164 || phoneStr);
            if (digits) {
              const suffix = digitSuffix(digits, 10);
              if (suffix && !byDigits.has(suffix)) {
                byDigits.set(suffix, rawName);
              }
              // Also store full digit string for exact matches.
              if (!byDigits.has(digits)) {
                byDigits.set(digits, rawName);
              }
            }
          }
        }
        setIndex({
          byE164,
          byDigits,
          defaultCountry,
          lastRefreshedAt: Date.now(),
          isReady: true,
        });
      } catch {
        /* swallow — keep whatever we had */
      } finally {
        inflightRef.current = false;
      }
    },
    [defaultCountry],
  );

  // Silent first-load: only if permission was previously granted. Never
  // prompts. The Contacts tab handles the explicit prompt UX.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (Platform.OS === 'web') return;
      try {
        const current = await Contacts.getPermissionsAsync();
        if (cancelled) return;
        if (current.granted) {
          refresh({ requestPermission: false }).catch(() => {});
        }
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const value = useMemo<ContextShape>(() => ({ index, refresh }), [index, refresh]);

  return <DeviceContactCtx.Provider value={value}>{children}</DeviceContactCtx.Provider>;
}

/** Read-only access to the index from any screen. */
export function useDeviceContactIndex(): DeviceContactIndex {
  return useContext(DeviceContactCtx).index;
}

/** Imperative handle to refresh the address book (e.g. from Contacts tab). */
export function useDeviceContactRefresh() {
  return useContext(DeviceContactCtx).refresh;
}

/**
 * Look up a single phone (any common format) against the device index.
 * Returns null when no match.
 */
export function lookupDeviceContactName(
  index: DeviceContactIndex,
  phone: string | null | undefined,
): string | null {
  if (!index || !index.isReady) return null;
  if (!phone) return null;
  const e164 = toE164(phone, index.defaultCountry);
  if (e164 && index.byE164.has(e164)) {
    return index.byE164.get(e164) || null;
  }
  const digits = normaliseDigits(phone);
  if (!digits) return null;
  // Exact digit match (rare).
  const exact = index.byDigits.get(digits);
  if (exact) return exact;
  // Suffix match: device stored without country code OR user record has
  // country code. Compare the last 10 digits.
  const suffix = digitSuffix(digits, 10);
  if (suffix) {
    const hit = index.byDigits.get(suffix);
    if (hit) return hit;
  }
  return null;
}

/**
 * Convenience: resolve a Smilers user/conversation record to the device
 * contact name when available. Caller passes any reasonable shape; we
 * sniff out `phoneE164`, `phone`, and nested `otherUser.*` variants.
 *
 * Returns "" when no match — caller decides the fallback.
 */
export function resolveDeviceContactNameFromUser(index: DeviceContactIndex, user: any): string {
  if (!index || !index.isReady || !user) return '';
  const candidates: any[] = [
    user?.phoneE164,
    user?.phone,
    user?.otherUserPhone,
    user?.otherUser?.phoneE164,
    user?.otherUser?.phone,
    user?.user?.phoneE164,
    user?.user?.phone,
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    const name = lookupDeviceContactName(index, String(cand));
    if (name) return name;
  }
  return '';
}
