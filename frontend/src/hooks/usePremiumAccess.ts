/**
 * usePremiumAccess — hook returning the current user's Premium status.
 *
 * Mirrors the web app's `usePremiumAccess()` (src/hooks/use-premium.ts).
 * Access hierarchy (checked in order on the backend):
 *   1. Active license code (lifetime or unexpired N-months)
 *   2. 30-day free trial from user._creationTime
 *   3. Hercules Commerce subscription (feat_premium)
 *
 * Falls back gracefully if `api.premium.getPremiumStatus` isn't yet
 * deployed: returns `hasAccess: true` with `reason: "trial"` so the app
 * keeps working during the rollout (preventing accidental hard-locks of
 * existing users while the web team ships the contract).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '../convexApi';
import { useSafeConvexQuery } from './useSafeConvexQuery';
import { useAuth } from '../providers/AuthProvider';

export type PremiumReason =
  | 'trial'
  | 'license'
  | 'subscription'
  | 'expired'
  | 'loading';

export interface PremiumStatus {
  hasAccess: boolean;
  reason: PremiumReason;
  trialEndsAt?: string;
  daysRemaining?: number;
  licenseType?: 'lifetime' | 'months' | string;
  expiresAt?: string | null;
  commerceCustomerId?: string;
  isLoading: boolean;
  refresh: () => void;
  /** True when the backend hasn't shipped yet and we're surface-defaulting. */
  isFallback: boolean;
}

const FREE_TRIAL_MS = 30 * 24 * 60 * 60 * 1000;

export function usePremiumAccess(): PremiumStatus {
  const { isAuthenticated } = useAuth();
  const [refreshTick, setRefreshTick] = useState(0);
  const [subscriptionFallback, setSubscriptionFallback] = useState<
    { hasAccess: boolean } | null
  >(null);

  // Primary status query — wrapped in useSafeConvexQuery so missing-function
  // errors don't crash the hook. `_v` is a render-bound key used to force a
  // refetch via the wrapper's internal mechanism (useSafeConvexQuery hashes
  // args).
  const { data: rawStatus, loading } = useSafeConvexQuery<any>(
    (api as any).premium?.getPremiumStatus,
    { _v: refreshTick },
    null,
    isAuthenticated,
  );

  // Best-effort fallback to the Commerce subscription check action when the
  // primary status reports `expired`. Mirrors the web hook's secondary check.
  const checkSubscriptionAction = useAction(
    (api as any).premiumAction?.checkPremiumSubscription,
  );
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!rawStatus) return;
    if (rawStatus.reason !== 'expired') {
      setSubscriptionFallback(null);
      return;
    }
    let mounted = true;
    (async () => {
      try {
        const res: any = await (checkSubscriptionAction as any)({});
        if (!mounted) return;
        if (res && typeof res.hasAccess === 'boolean') {
          setSubscriptionFallback({ hasAccess: !!res.hasAccess });
        }
      } catch {
        /* swallow — action probably not deployed yet */
      }
    })();
    return () => {
      mounted = false;
    };
  }, [rawStatus, isAuthenticated, checkSubscriptionAction]);

  return useMemo<PremiumStatus>(() => {
    if (!isAuthenticated) {
      return {
        hasAccess: false,
        reason: 'expired',
        isLoading: false,
        isFallback: false,
        refresh: () => setRefreshTick((t) => t + 1),
      };
    }

    // Backend not shipped → surface-default to TRIAL state so the user
    // doesn't lose access while the web team ships api.premium.*.
    // (`rawStatus` is null when the safe query swallowed CouldNotFindFunction.)
    if (rawStatus == null) {
      if (loading) {
        return {
          hasAccess: false,
          reason: 'loading',
          isLoading: true,
          isFallback: false,
          refresh: () => setRefreshTick((t) => t + 1),
        };
      }
      const trialEnd = new Date(Date.now() + FREE_TRIAL_MS).toISOString();
      return {
        hasAccess: true,
        reason: 'trial',
        trialEndsAt: trialEnd,
        daysRemaining: 30,
        isLoading: false,
        isFallback: true,
        refresh: () => setRefreshTick((t) => t + 1),
      };
    }

    const subOverride =
      rawStatus.reason === 'expired' && subscriptionFallback?.hasAccess;

    return {
      hasAccess: subOverride ? true : !!rawStatus.hasAccess,
      reason: subOverride ? 'subscription' : (rawStatus.reason as PremiumReason),
      trialEndsAt: rawStatus.trialEndsAt,
      daysRemaining:
        typeof rawStatus.daysRemaining === 'number'
          ? rawStatus.daysRemaining
          : undefined,
      licenseType: rawStatus.licenseType,
      expiresAt: rawStatus.expiresAt,
      commerceCustomerId: rawStatus.commerceCustomerId,
      isLoading: false,
      isFallback: false,
      refresh: () => setRefreshTick((t) => t + 1),
    };
  }, [isAuthenticated, rawStatus, loading, subscriptionFallback]);
}
