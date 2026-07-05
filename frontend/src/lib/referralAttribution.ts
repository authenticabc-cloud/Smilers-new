/**
 * referralAttribution (iter-189) — closes the referral loop for Play
 * Store installs.
 *
 * Invite links (mobile iter-186 + web equivalents) point to
 *   https://play.google.com/store/apps/details?id=com.smilers.app&referrer=ref%3D<CODE>
 * Google Play hands that `referrer` string to the app on first launch
 * via the Install Referrer API (exposed by expo-application). We:
 *   1. capture it ONCE on first launch and stash the parsed code,
 *   2. after the user signs up / signs in, call the canonical
 *      `earnings.trackReferral({ referralCode })` mutation (verified
 *      deployed; same one useEngagementTracker uses) so the inviter's
 *      earnings are credited — mirroring the web app's `?ref=CODE` flow,
 *   3. clear the pending code so it can never double-fire.
 */
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useConvex } from 'convex/react';
import { api } from '../convexApi';
import { useAuth } from '../providers/AuthProvider';

const CAPTURED_KEY = 'smilers_install_referrer_captured';
const PENDING_CODE_KEY = 'smilers_pending_referral_code';

/** Parse `ref=CODE` out of a Play install-referrer string (it may also be
 * the default `utm_source=google-play&utm_medium=organic` for organic
 * installs, or be URI-encoded one extra time). */
export function parseReferralCode(referrer?: string | null): string | null {
  if (!referrer || typeof referrer !== 'string') return null;
  let decoded = referrer;
  try {
    // Tolerate double-encoding (`ref%3DCODE`).
    if (!decoded.includes('=') && decoded.includes('%3D')) {
      decoded = decodeURIComponent(decoded);
    }
  } catch {
    /* keep raw */
  }
  for (const part of decoded.split('&')) {
    const [key, value] = part.split('=');
    if (key?.trim().toLowerCase() === 'ref' && value && value.trim()) {
      // Contract normalization: trim() then toUpperCase(). Codes are 8 chars
      // from a fixed alphabet, but we cap defensively.
      return value.trim().toUpperCase().slice(0, 64);
    }
  }
  return null;
}

/** Persist a captured referral code (normalized) for later crediting, unless
 *  one is already pending (first capture wins — one code ever per user). */
async function stashPendingCode(code: string | null): Promise<void> {
  if (!code) return;
  try {
    const existing = await AsyncStorage.getItem(PENDING_CODE_KEY);
    if (existing) return;
    await AsyncStorage.setItem(PENDING_CODE_KEY, code.trim().toUpperCase());
  } catch {
    /* best-effort */
  }
}

/** iter-332 — MANUAL entry from the Sign-In screen ("Do you have a referral
 *  code?"). Unlike install/deep-link capture, an explicit user entry OVERWRITES
 *  any pending code. Returns the normalized code (or null if empty/invalid).
 *  `ReferralAttribution` then credits it via earnings.trackReferral once the
 *  user authenticates — same path as the web app's ?ref=CODE flow. */
export async function setPendingReferralCode(raw: string): Promise<string | null> {
  const code = (raw || '').trim().toUpperCase().slice(0, 64);
  if (!code) return null;
  try {
    await AsyncStorage.setItem(PENDING_CODE_KEY, code);
  } catch {
    /* best-effort */
  }
  return code;
}

/** Read the currently-stored pending referral code (for prefill/display). */
export async function getPendingReferralCode(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PENDING_CODE_KEY);
  } catch {
    return null;
  }
}

/** Capture a `?ref=CODE` query param from the app's open/deep-link URL
 *  (mirrors the web app's `?ref=CODE` → localStorage flow). */
async function captureDeepLinkRef(url?: string | null): Promise<void> {
  try {
    const initial = url ?? (await Linking.getInitialURL());
    if (!initial) return;
    const parsed = Linking.parse(initial);
    const ref = (parsed.queryParams?.ref ?? parsed.queryParams?.referrer) as string | undefined;
    const code = parseReferralCode(ref ? `ref=${ref}` : null) || parseReferralCode(ref);
    await stashPendingCode(code);
  } catch {
    /* best-effort */
  }
}

/** Step 1 — capture the install referrer exactly once (Android only). */
async function captureInstallReferrer(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const already = await AsyncStorage.getItem(CAPTURED_KEY);
    if (already) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Application = require('expo-application');
    const referrer: string | null = await Application.getInstallReferrerAsync();
    await AsyncStorage.setItem(CAPTURED_KEY, '1');
    const code = parseReferralCode(referrer);
    if (code) {
      await AsyncStorage.setItem(PENDING_CODE_KEY, code);
    }
  } catch {
    /* best-effort — never block launch */
  }
}

/**
 * Mounted once in the root layout. Captures the referrer on launch and
 * credits the referral after the user is authenticated.
 */
export function ReferralAttribution() {
  const convex = useConvex();
  const { isAuthenticated } = useAuth();
  const consumingRef = useRef(false);

  useEffect(() => {
    void captureInstallReferrer();
    void captureDeepLinkRef();
    // Also capture `?ref=` from links opened while the app is already running.
    const sub = Linking.addEventListener('url', ({ url }) => {
      void captureDeepLinkRef(url);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    // Credit the referral. Contract status handling:
    //   • applied / already_referred / invalid_code / self_referral → DEFINITIVE
    //     → clear the stored code so it never re-fires.
    //   • not_authenticated → KEEP the code and retry later (next foreground /
    //     once the user record exists). This was the original bug — we used to
    //     clear it regardless of status.
    const consume = async () => {
      if (consumingRef.current) return;
      consumingRef.current = true;
      try {
        const code = await AsyncStorage.getItem(PENDING_CODE_KEY);
        if (!code) return;
        const result: any = await convex.mutation((api as any).earnings.trackReferral, {
          referralCode: code.trim().toUpperCase(),
        });
        const status = typeof result === 'string' ? result : result?.status;
        if (status === 'not_authenticated') {
          // Session/user record not ready yet — keep code, allow a later retry.
          consumingRef.current = false;
          return;
        }
        // Any definitive outcome (incl. unknown shapes) → clear.
        await AsyncStorage.removeItem(PENDING_CODE_KEY);
      } catch {
        // Network/transient error — leave the pending code; retried later.
        consumingRef.current = false;
      }
    };

    void consume();
    // Retry on foreground (covers "auth becomes ready shortly after launch"
    // and account-creation completing while backgrounded).
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void consume();
    });
    return () => appStateSub.remove();
  }, [convex, isAuthenticated]);

  return null;
}
