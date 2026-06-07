// Safe wrapper around `react-native-incall-manager`.
//
// This library is the de-facto standard for handling native Android (and iOS)
// audio routing during a WebRTC call — speakerphone toggle, proximity sensor,
// Bluetooth headset takeover, ringtone playback, and screen wake-lock.
//
// On Android in particular, `expo-audio`'s `setAudioModeAsync({ shouldRouteThroughEarpiece })`
// is NOT enough by itself to switch audio between the earpiece and the
// loudspeaker once a WebRTC peer connection is up. The system audio mode has
// to be set to `MODE_IN_COMMUNICATION` AND the audio output route has to be
// updated AFTER the audio session begins — both of which InCallManager
// handles natively.
//
// All exported functions are no-ops on web and swallow every native error
// (defensive — never let a missing native module crash the call screen).

import { Platform } from 'react-native';

type StartOptions = {
  media?: 'audio' | 'video';
  auto?: boolean;
  ringback?: '' | '_BUNDLE_' | '_DTMF_' | '_DEFAULT_';
};

type Listener = (event: { device?: string; output?: string; route?: string }) => void;

type NativeInCallManager = {
  start: (opts?: StartOptions) => void;
  stop: (opts?: { busytone?: string; ringback?: string }) => void;
  setSpeakerphoneOn: (on: boolean) => void;
  setForceSpeakerphoneOn: (on: boolean | null) => void;
  setKeepScreenOn: (on: boolean) => void;
  turnScreenOn: () => void;
  turnScreenOff: () => void;
  setMicrophoneMute: (mute: boolean) => void;
  startRingback?: (type?: string) => void;
  stopRingback?: () => void;
  startRingtone?: (type?: string) => void;
  stopRingtone?: () => void;
  chooseAudioRoute?: (route: 'SPEAKER_PHONE' | 'EARPIECE' | 'WIRED_HEADSET' | 'BLUETOOTH') => void;
  setFlashOn?: (on: boolean, brightness?: number) => void;
  getIsWiredHeadsetPluggedIn?: () => Promise<{ isWiredHeadsetPluggedIn: boolean }>;
  addEventListener?: (eventName: string, listener: Listener) => any;
  removeEventListener?: (subscription: any) => void;
};

let cached: NativeInCallManager | null | undefined;

function getNative(): NativeInCallManager | null {
  if (Platform.OS === 'web') return null;
  if (cached !== undefined) return cached;
  try {
    // require lazily so web bundling never tries to resolve the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-incall-manager');
    cached = (mod?.default || mod) as NativeInCallManager;
    return cached;
  } catch (err) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[inCallManager] native module unavailable:', (err as Error)?.message);
    }
    cached = null;
    return null;
  }
}

function safeCall(fn: () => void, ctx: string) {
  try {
    fn();
  } catch (err) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(`[inCallManager] ${ctx} failed:`, (err as Error)?.message);
    }
  }
}

/**
 * Start the InCallManager audio session.
 *
 * On Android this switches the system audio mode to MODE_IN_COMMUNICATION,
 * which is required for proper speaker/earpiece routing during a WebRTC call.
 *
 * For `media:'audio'` (voice call) → audio is routed through the EARPIECE
 * For `media:'video'` (video call) → audio is routed through the SPEAKER
 *
 * The default for both modes can later be overridden via
 * `setSpeakerphoneOn(true|false)`.
 */
export function startCallAudio(media: 'audio' | 'video' = 'audio') {
  const native = getNative();
  if (!native) return;
  safeCall(() => {
    native.start({ media, auto: false });
    // Keep the screen awake during the call — InCallManager handles this
    // natively (Android: WAKE_LOCK; iOS: idle timer disable).
    native.setKeepScreenOn?.(true);
  }, 'start');
}

/**
 * Stop the InCallManager audio session and release the wake-lock.
 *
 * MUST be called when the call ends (hangup / decline / unmount) so the
 * system audio mode is restored to normal and the wake-lock is released.
 */
export function stopCallAudio() {
  const native = getNative();
  if (!native) return;
  safeCall(() => {
    native.setKeepScreenOn?.(false);
    native.stop();
  }, 'stop');
}

/**
 * Switch the loudspeaker on/off mid-call.
 *
 * On Android we use `chooseAudioRoute('SPEAKER_PHONE')` when supported
 * (4.2+) because it's more reliable than `setSpeakerphoneOn` once a
 * Bluetooth headset is connected — the latter is ignored by the audio
 * service in that scenario.
 */
export function setSpeakerOn(on: boolean) {
  const native = getNative();
  if (!native) return;
  safeCall(() => {
    if (typeof native.chooseAudioRoute === 'function') {
      native.chooseAudioRoute(on ? 'SPEAKER_PHONE' : 'EARPIECE');
    } else {
      native.setForceSpeakerphoneOn(on);
      native.setSpeakerphoneOn(on);
    }
  }, on ? 'setSpeakerOn(true)' : 'setSpeakerOn(false)');
}

/**
 * Try to route audio through a paired Bluetooth headset (if present).
 * Falls back silently to the earpiece if no Bluetooth device is available.
 *
 * iter-133: Android needs the system audio mode to be MODE_IN_COMMUNICATION
 * BEFORE Bluetooth SCO can be started, AND the SCO link itself has to be
 * explicitly initiated for bidirectional audio (otherwise the headset
 * gets A2DP — output-only, no mic, which is exactly the "I can't hear
 * and the other side can't hear me" symptom the user reported).
 *
 * The library's `chooseAudioRoute('BLUETOOTH')` is SUPPOSED to do both
 * but on some devices/Android versions it skips the SCO start when the
 * audio session isn't already in MODE_IN_COMMUNICATION. We defensively
 * call start() (which is idempotent — safe to call when session is
 * already running) before the route switch, then we re-call the route
 * after a tiny delay so the BT stack has time to bind.
 */
export function setBluetoothOn(media: 'audio' | 'video' = 'audio') {
  const native = getNative();
  if (!native) return;
  safeCall(() => {
    // 1. Ensure audio session is started — sets system audio mode to
    //    MODE_IN_COMMUNICATION which is a precondition for SCO.
    try {
      native.start({ media, auto: false });
    } catch {}
    if (typeof native.chooseAudioRoute === 'function') {
      // 2. First call — tells the audio service to prepare BT routing.
      native.chooseAudioRoute('BLUETOOTH');
      // 3. Re-issue after 250ms — workaround for Android Audio Service
      //    occasionally rejecting the first route switch because SCO
      //    isn't connected yet at that exact tick. Calling twice with
      //    a small delay is the recommended pattern (mirrors what
      //    Telegram & Signal do in their native code).
      setTimeout(() => {
        try {
          native.chooseAudioRoute?.('BLUETOOTH');
        } catch {}
      }, 250);
    } else {
      // Older react-native-incall-manager versions lacked chooseAudioRoute
      // — there's no clean BT path on those, but we at least don't crash.
      native.setForceSpeakerphoneOn(false);
      native.setSpeakerphoneOn(false);
    }
  }, 'setBluetoothOn');
}

/**
 * Route audio through the earpiece (standard phone-call mode).
 */
export function setEarpieceOn() {
  const native = getNative();
  if (!native) return;
  safeCall(() => {
    if (typeof native.chooseAudioRoute === 'function') {
      native.chooseAudioRoute('EARPIECE');
    } else {
      native.setForceSpeakerphoneOn(false);
      native.setSpeakerphoneOn(false);
    }
  }, 'setEarpieceOn');
}

/**
 * Mute / unmute the microphone at the system audio-session level.
 * This is in addition to muting the WebRTC audio track, which is what we
 * do via `CallSession.setMuted` — both layers should stay in sync.
 */
export function setMicMuted(muted: boolean) {
  const native = getNative();
  if (!native) return;
  safeCall(() => native.setMicrophoneMute(muted), 'setMicMuted');
}

/**
 * Subscribe to native audio-route change events (headset plug/unplug,
 * Bluetooth connect/disconnect, etc.). Returns an unsubscribe function.
 *
 * NOTE: `react-native-incall-manager` exposes a `WiredHeadset` event on
 * Android but the event-emitter API isn't documented in the TS types.
 * We wrap it defensively so unsupported platforms never throw.
 */
export function onAudioRouteChange(listener: Listener): () => void {
  const native = getNative();
  if (!native || typeof native.addEventListener !== 'function') {
    return () => undefined;
  }
  let sub: any = null;
  safeCall(() => {
    sub = native.addEventListener?.('WiredHeadset', listener);
  }, 'addEventListener');
  return () => {
    if (sub && typeof native.removeEventListener === 'function') {
      safeCall(() => native.removeEventListener?.(sub), 'removeEventListener');
    } else if (sub && typeof sub.remove === 'function') {
      safeCall(() => sub.remove(), 'subscription.remove');
    }
  };
}

/**
 * Quick helper: ask the OS whether a wired headset is currently plugged in.
 * Returns `false` if the native module is missing or rejects.
 */
export async function isWiredHeadsetPluggedIn(): Promise<boolean> {
  const native = getNative();
  if (!native || typeof native.getIsWiredHeadsetPluggedIn !== 'function') return false;
  try {
    const result = await native.getIsWiredHeadsetPluggedIn();
    return Boolean(result?.isWiredHeadsetPluggedIn);
  } catch {
    return false;
  }
}

export const InCallAudio = {
  start: startCallAudio,
  stop: stopCallAudio,
  setSpeakerOn,
  setEarpieceOn,
  setBluetoothOn,
  setMicMuted,
  onAudioRouteChange,
  isWiredHeadsetPluggedIn,
};
