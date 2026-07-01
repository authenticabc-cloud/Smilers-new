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

export interface BatchPhoneMatch {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}

/** Last 10 digits of a phone number — the backend's country-code-agnostic key. */
function last10Digits(value: string | null | undefined): string {
  return String(value || '').replace(/\D+/g, '').slice(-10);
}

/**
 * Batch reverse-lookup: given many phone numbers, return ONLY those that map
 * to a (verified) Smilers account. Powers the Device-Contacts tab so it can
 * show "Message" for registered numbers and "Invite" for the rest in one shot.
 *
 * Backend: `api.users.lookupByPhones({ phones })` returns one row per input
 * `{ input, onSmilers, userId, displayName, avatarUrl }`, matching by the
 * last-10-digits so contacts saved WITHOUT a country code still resolve
 * (see docs/WEB_AGENT_ANSWERS_iter222_phone_identity.md).
 *
 * FEATURE-FLAGGED BY DETECTION: if the backend hasn't shipped the query yet,
 * `(api as any).users?.lookupByPhones` is undefined and this resolves to an
 * EMPTY map, so callers transparently fall back to invite-only behaviour.
 *
 * Returns a Map keyed by LAST-10-DIGITS → { userId, displayName, avatarUrl }.
 */
export async function lookupUsersByPhones(
  convex: any,
  phones: Array<string | null | undefined>,
): Promise<Map<string, BatchPhoneMatch>> {
  const out = new Map<string, BatchPhoneMatch>();
  if (!convex || !Array.isArray(phones) || phones.length === 0) return out;
  const fn = (api as any).users?.lookupByPhones;

  // Dedupe by last-10 (keep a representative raw string per key), drop numbers
  // with too few digits, and cap so a huge address book can't fire dozens of
  // queries.
  const byKey = new Map<string, string>();
  for (const p of phones) {
    const raw = String(p || '').trim();
    const key = last10Digits(raw);
    if (key.length < 7) continue;
    if (!byKey.has(key)) byKey.set(key, raw);
  }
  const unique = Array.from(byKey.values()).slice(0, 1000);
  if (unique.length === 0) return out;

  if (fn) {
    const CHUNK = 200;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const batch = unique.slice(i, i + CHUNK);
      try {
        const res: any = await convex.query(fn, { phones: batch });
        if (Array.isArray(res)) {
          for (const r of res) {
            if (r && r.onSmilers && r.userId) {
              const key = last10Digits(r.input);
              if (key.length >= 7) {
                out.set(key, {
                  userId: String(r.userId),
                  displayName: typeof r.displayName === 'string' ? r.displayName : undefined,
                  avatarUrl: typeof r.avatarUrl === 'string' ? r.avatarUrl : undefined,
                });
              }
            }
          }
        }
      } catch {
        /* ignore a failed chunk — others may still resolve */
      }
    }
  }

  // iter-311 FIX: the batch `users.lookupByPhones` query was never shipped on
  // the backend, so classification always came back empty and EVERY device
  // contact — including registered users (e.g. Sarah Asare) — was wrongly
  // listed under "Invite to Smilers". The single-number `users.getByPhone`
  // query IS shipped/verified (it powers Find-by-phone), so when the batch
  // path is unavailable or matched nothing, probe each unique number with it
  // (capped + concurrency-limited) so registered contacts are correctly
  // recognised as "on Smilers".
  if (out.size === 0) {
    const single = (api as any).users?.getByPhone;
    if (single) {
      const candidates = Array.from(byKey.values()).slice(0, 300);
      const CONC = 8;
      for (let i = 0; i < candidates.length; i += CONC) {
        const slice = candidates.slice(i, i + CONC);
        const results = await Promise.all(
          slice.map(async (raw) => {
            const e164 = toE164(raw) || (raw.startsWith('+') ? raw.replace(/\s+/g, '') : null);
            if (!e164) return null;
            try {
              const r: any = await convex.query(single, { phoneE164: e164 });
              if (r && r._id) {
                return {
                  key: last10Digits(e164),
                  userId: String(r._id),
                  displayName: typeof r.displayName === 'string' ? r.displayName : undefined,
                  avatarUrl: typeof r.avatarUrl === 'string' ? r.avatarUrl : undefined,
                };
              }
            } catch {
              /* ignore a single miss */
            }
            return null;
          }),
        );
        for (const m of results) {
          if (m && m.key.length >= 7) {
            out.set(m.key, { userId: m.userId, displayName: m.displayName, avatarUrl: m.avatarUrl });
          }
        }
      }
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
