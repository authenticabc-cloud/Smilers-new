/**
 * phoneLookup — iter-166 Identity Rework canonical-contract helpers.
 *
 * Thin async wrappers around the verified Convex queries:
 *   api.users.getByPhone({ phoneE164 })
 *     → { _id, displayName?, avatarUrl?, lastSeen? } | null
 *   api.users.searchByPhonePrefix({ prefix, limit? })
 *     → Array<{ _id, phoneE164, displayName?, avatarUrl? }>
 *
 * Both endpoints require an authenticated viewer. `getByPhone` returns
 * null when the input cannot be normalized to E.164 or no user matches.
 * The server normalizes to E.164 anyway but we still parse client-side so
 * we can give the user immediate feedback on malformed input.
 *
 * Usage:
 *   const result = await lookupUserByPhone(convex, '+14155551234');
 *   if (result) router.push(`/chat/new?recipient=${result._id}`);
 *
 *   const matches = await searchUsersByPhonePrefix(convex, '+1415', 20);
 */

import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { api } from '../convexApi';

export interface PhoneLookupResult {
  _id: string;
  displayName?: string;
  avatarUrl?: string;
  lastSeen?: number; // ms epoch
}

export interface PhonePrefixMatch {
  _id: string;
  phoneE164: string;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * Normalize a free-form input to E.164 ("+countrycode digits"). Returns
 * null if the input can't be parsed as a valid phone number. Pure local
 * call — no network roundtrip.
 */
export function toE164(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Already E.164 looking? Quick path.
  if (/^\+\d{6,15}$/.test(trimmed.replace(/\s+/g, ''))) {
    const compact = trimmed.replace(/\s+/g, '');
    const parsed = parsePhoneNumberFromString(compact);
    return parsed && parsed.isValid() ? parsed.number : null;
  }
  const parsed = parsePhoneNumberFromString(trimmed);
  return parsed && parsed.isValid() ? parsed.number : null;
}

/**
 * Look up a single Smilers user by their E.164 phone number.
 * Returns null if the input is malformed OR no matching account exists.
 *
 * Swallows network errors with a console.warn — callers should treat any
 * non-null result as a positive match and any null result as "not found".
 */
export async function lookupUserByPhone(
  convex: any,
  phoneInput: string,
): Promise<PhoneLookupResult | null> {
  const e164 = toE164(phoneInput);
  if (!e164) return null;
  const fn = (api as any).users?.getByPhone;
  if (!fn || !convex) return null;
  try {
    const result: any = await convex.query(fn, { phoneE164: e164 });
    if (!result || typeof result !== 'object') return null;
    return {
      _id: String(result._id),
      displayName: typeof result.displayName === 'string' ? result.displayName : undefined,
      avatarUrl: typeof result.avatarUrl === 'string' ? result.avatarUrl : undefined,
      lastSeen: typeof result.lastSeen === 'number' ? result.lastSeen : undefined,
    };
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[phoneLookup] getByPhone failed:', errorValue?.message);
    return null;
  }
}

/**
 * Batch reverse-lookup: given many phone numbers, return ONLY those that map
 * to a Smilers account. Powers the Device-Contacts tab so it can show
 * "Message" for registered numbers and "Invite" for the rest in one shot.
 *
 * FEATURE-FLAGGED BY DETECTION: if the backend hasn't shipped
 * `users.getByPhones` yet, `(api as any).users?.getByPhones` is undefined and
 * this resolves to an EMPTY map — so callers transparently fall back to the
 * old invite-only behaviour. The moment the Convex backend deploys the query
 * (see /app/PHONE_IDENTITY_BACKEND_SPEC.md) this lights up automatically.
 *
 * Returns a Map keyed by E.164 → { _id, displayName }.
 */
export async function lookupUsersByPhones(
  convex: any,
  phones: Array<string | null | undefined>,
): Promise<Map<string, PhoneLookupResult>> {
  const out = new Map<string, PhoneLookupResult>();
  const fn = (api as any).users?.getByPhones;
  if (!fn || !convex || !Array.isArray(phones) || phones.length === 0) return out;

  // Normalise + dedupe to valid E.164, cap the total so a huge address book
  // can't fire dozens of queries.
  const normalized = Array.from(
    new Set(phones.map((p) => toE164(String(p || ''))).filter((v): v is string => !!v)),
  ).slice(0, 1000);
  if (normalized.length === 0) return out;

  const CHUNK = 200;
  for (let i = 0; i < normalized.length; i += CHUNK) {
    const batch = normalized.slice(i, i + CHUNK);
    try {
      const res: any = await convex.query(fn, { phoneE164List: batch });
      if (Array.isArray(res)) {
        for (const r of res) {
          if (r && r._id && typeof r.phoneE164 === 'string') {
            out.set(r.phoneE164, {
              _id: String(r._id),
              displayName: typeof r.displayName === 'string' ? r.displayName : undefined,
              avatarUrl: typeof r.avatarUrl === 'string' ? r.avatarUrl : undefined,
            });
          }
        }
      }
    } catch {
      /* ignore a failed chunk — others may still resolve */
    }
  }
  return out;
}

/**
 * Range-scan Smilers users by phone-number prefix. Prefix must start with
 * `+`; we'll fix obvious mistakes (missing `+`) before sending. The server
 * caps the response at 50 — `limit` is just a hint.
 *
 * Returns an empty array on error or invalid prefix so callers can render
 * a "no matches" state without special-casing failures.
 */
export async function searchUsersByPhonePrefix(
  convex: any,
  prefix: string,
  limit: number = 20,
): Promise<PhonePrefixMatch[]> {
  if (!prefix) return [];
  let normalized = prefix.trim();
  if (!normalized.startsWith('+')) normalized = `+${normalized}`;
  // Must contain at least one digit after the plus.
  if (!/^\+\d+$/.test(normalized.replace(/\s+/g, ''))) return [];
  const fn = (api as any).users?.searchByPhonePrefix;
  if (!fn || !convex) return [];
  try {
    const result: any = await convex.query(fn, {
      prefix: normalized.replace(/\s+/g, ''),
      limit: Math.max(1, Math.min(50, limit | 0)),
    });
    if (!Array.isArray(result)) return [];
    return result
      .filter((r: any) => r && typeof r === 'object')
      .map((r: any) => ({
        _id: String(r._id),
        phoneE164: typeof r.phoneE164 === 'string' ? r.phoneE164 : '',
        displayName: typeof r.displayName === 'string' ? r.displayName : undefined,
        avatarUrl: typeof r.avatarUrl === 'string' ? r.avatarUrl : undefined,
      }));
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[phoneLookup] searchByPhonePrefix failed:', errorValue?.message);
    return [];
  }
}
