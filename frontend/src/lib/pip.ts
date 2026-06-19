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
    ExpoPip = require('expo-pip');
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

/** Manually request PiP now (fallback for Android < 12 on background). */
export function enterPip(opts?: { width?: number; height?: number }): void {
  try {
    ExpoPip?.enterPipMode?.(opts ?? { width: 12, height: 16 });
  } catch {}
}

/** True while the app is rendered inside the small PiP window. */
export function useIsInPip(): boolean {
  // `Platform.OS` is constant for the app lifetime, so this branch never
  // changes between renders — safe w.r.t. the rules of hooks.
  if (!isPipSupported || !ExpoPip?.useIsInPip) return false;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return !!ExpoPip.useIsInPip().isInPipMode;
}
