/**
 * pip.ts — thin, platform-safe wrapper around `expo-pip` (Android-only).
 *
 * `expo-pip` ships a native module that only exists on Android and only in a
 * real dev/production build (NOT Expo Go, NOT web). Importing it elsewhere can
 * throw, so we require it lazily and guard every call. On iOS/web every export
 * is a harmless no-op and `useIsInPip()` always returns `false`.
 *
 * Used by the Twilio call screen so that when the user swipes the app away
 * mid-video-call, the call collapses into a small Picture-in-Picture window
 * (the remote video keeps flowing for BOTH parties) instead of tearing down.
 */
import { Platform } from 'react-native';

let ExpoPip: any = null;
if (Platform.OS === 'android') {
  try {
    // expo-pip exports a DEFAULT class whose methods (enterPipMode,
    // setPictureInPictureParams, useIsInPip…) are STATIC. require() returns
    // the module namespace `{ default: ExpoPip, …types }`, so we must unwrap
    // `.default` — otherwise every call below was `undefined?.()` and the
    // "Pop out" button silently did nothing.
    const mod = require('expo-pip');
    ExpoPip = mod?.default || mod;
  } catch {
    ExpoPip = null;
  }
}

export const isPipSupported = Platform.OS === 'android' && !!ExpoPip;

/**
 * Enable/disable Android 12+ auto-enter: the system slides the app into PiP
 * automatically the moment the user navigates Home / swipes the app away.
 * `aspectRatio` keeps the PiP window matched to the video tile.
 */
export function setPipParams(opts: {
  autoEnterEnabled?: boolean;
  width?: number;
  height?: number;
}): void {
  try {
    ExpoPip?.setPictureInPictureParams?.(opts);
  } catch {}
}

/** Manually request PiP now. Returns a diagnostic result so callers can
 *  surface WHY it failed instead of silently doing nothing. */
export function enterPip(opts?: { width?: number; height?: number }): {
  ok: boolean;
  reason?: string;
} {
  if (Platform.OS !== 'android') return { ok: false, reason: 'not-android' };
  if (!ExpoPip) return { ok: false, reason: 'expo-pip JS module not loaded' };
  // getMaxNumPictureInPictureActions() returns null when the NATIVE module
  // isn't linked into the build (config plugin missing / Expo Go), which is
  // the usual reason "nothing happens".
  let nativeLinked = true;
  try {
    nativeLinked = ExpoPip.getMaxNumPictureInPictureActions?.() != null;
  } catch {
    nativeLinked = false;
  }
  if (typeof ExpoPip.enterPipMode !== 'function') {
    return { ok: false, reason: 'enterPipMode missing on module' };
  }
  try {
    ExpoPip.enterPipMode(opts ?? { width: 12, height: 16 });
    return { ok: true, reason: nativeLinked ? undefined : 'native-module-not-linked' };
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/** True while the app is rendered inside the small PiP window. */
export function useIsInPip(): boolean {
  // `Platform.OS` is constant for the app lifetime, so this branch never
  // changes between renders — safe w.r.t. the rules of hooks.
  if (!isPipSupported || !ExpoPip?.useIsInPip) return false;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return !!ExpoPip.useIsInPip().isInPipMode;
}
