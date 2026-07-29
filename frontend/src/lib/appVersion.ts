/**
 * appVersion.ts — "update available" detection for the in-app banner.
 *
 * On launch the app fetches GET /api/app-version (served by the FastAPI
 * backend) and compares the bundled app version against the latest published
 * one. When the bundled version is older we surface a dismissible banner that
 * deep-links to the correct store (Play Store on Android, App Store on iOS).
 *
 * The dismissal is IN-MEMORY only (session-scoped) per the product decision:
 * the banner reappears on the next launch until the user actually updates.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

// Persisted key: the latest version the user has "acknowledged" by tapping
// Update now. The banner stays hidden until a NEWER version is published.
const ACK_KEY = 'updateBanner:acknowledgedVersion';

export type AppVersionInfo = {
  latestVersion: string;
  minSupportedVersion: string;
  androidUrl: string;
  iosUrl: string;
  forceUpdate: boolean;
  releaseNotes: string;
};

/** Version bundled into THIS build (from app.json → expo.version).
 *  Returns '' when it can't be determined (e.g. web preview) so callers can
 *  choose NOT to show the update banner rather than trigger a false positive. */
export function getCurrentAppVersion(): string {
  const v =
    (Constants.expoConfig as any)?.version ||
    (Constants as any)?.nativeAppVersion ||
    (Constants.manifest2 as any)?.extra?.expoClient?.version ||
    '';
  return String(v || '');
}

/**
 * Compare two dotted version strings. Returns:
 *   -1 if a < b, 0 if equal, 1 if a > b.
 * Non-numeric / missing segments are treated as 0 so "2.2" == "2.2.0".
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export async function fetchAppVersion(signal?: AbortSignal): Promise<AppVersionInfo | null> {
  if (!BACKEND_URL) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/api/app-version`, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as AppVersionInfo;
    if (!data || typeof data.latestVersion !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

// Session-scoped dismissal so the banner returns on the next cold start.
let dismissedThisSession = false;

export type UpdateBannerState = {
  visible: boolean;
  forceUpdate: boolean;
  latestVersion: string;
  currentVersion: string;
  releaseNotes: string;
  storeUrl: string;
  dismiss: () => void;
  acknowledgeUpdate: () => void;
};

/**
 * useUpdateBanner — drives the root <UpdateBanner/>. Fetches once on mount,
 * decides whether an update banner should show, and exposes two handlers:
 *   • dismiss()          — "Later": session-scoped, reappears next cold start.
 *   • acknowledgeUpdate()— "Update now": persisted per-version, stays hidden
 *                          until a NEWER version is published.
 * Fails silent (never blocks the app) when offline.
 */
export function useUpdateBanner(): UpdateBannerState {
  const [info, setInfo] = useState<AppVersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(dismissedThisSession);
  const [ackVersion, setAckVersion] = useState<string | null>(null);
  const currentVersion = getCurrentAppVersion();

  useEffect(() => {
    const controller = new AbortController();
    void fetchAppVersion(controller.signal).then((data) => {
      if (data) setInfo(data);
    });
    AsyncStorage.getItem(ACK_KEY)
      .then((v) => setAckVersion(v))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const storeUrl =
    Platform.OS === 'ios' ? info?.iosUrl || '' : info?.androidUrl || '';
  // Only compare when we actually know THIS build's version — otherwise (e.g.
  // web preview where expoConfig.version is unavailable) never show the banner.
  const knownCurrent = !!currentVersion && currentVersion !== '0.0.0';
  const updateAvailable =
    knownCurrent && !!info && compareVersions(currentVersion, info.latestVersion) < 0;
  const forceUpdate =
    knownCurrent &&
    !!info &&
    (info.forceUpdate ||
      compareVersions(currentVersion, info.minSupportedVersion) < 0);
  // Persisted acknowledgement covers the current latest version (or newer):
  // the user already tapped "Update now" for it, so keep the banner hidden
  // until an even newer version ships.
  const acknowledgedForLatest =
    !!info && !!ackVersion && compareVersions(ackVersion, info.latestVersion) >= 0;
  // A forced update can't be dismissed/acknowledged away.
  const visible =
    updateAvailable && (forceUpdate || (!dismissed && !acknowledgedForLatest));

  const dismiss = () => {
    dismissedThisSession = true;
    setDismissed(true);
  };

  // "Update now": persist that this version was acknowledged so the banner
  // won't reappear until a newer version is published, and hide it now.
  const acknowledgeUpdate = () => {
    const v = info?.latestVersion || currentVersion;
    if (v) {
      setAckVersion(v);
      AsyncStorage.setItem(ACK_KEY, v).catch(() => {});
    }
    dismissedThisSession = true;
    setDismissed(true);
  };

  return {
    visible,
    forceUpdate,
    latestVersion: info?.latestVersion || '',
    currentVersion,
    releaseNotes: info?.releaseNotes || '',
    storeUrl,
    dismiss,
    acknowledgeUpdate,
  };
}
