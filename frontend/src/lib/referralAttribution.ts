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
import { Platform } from 'react-native';
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
      return value.trim().slice(0, 64);
    }
  }
  return null;
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
  }, []);

  useEffect(() => {
    if (!isAuthenticated || consumingRef.current) return;
    consumingRef.current = true;
    (async () => {
      try {
        const code = await AsyncStorage.getItem(PENDING_CODE_KEY);
        if (!code) return;
        await convex.mutation((api as any).earnings.trackReferral, {
          referralCode: code,
        });
        await AsyncStorage.removeItem(PENDING_CODE_KEY);
      } catch {
        // Leave the pending code in place — retried on next app start.
        consumingRef.current = false;
      }
    })();
  }, [convex, isAuthenticated]);

  return null;
}
