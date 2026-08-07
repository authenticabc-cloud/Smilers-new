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

import { Platform, NativeModules } from 'react-native';
import { recordDiagnostic } from '../diagnostics';

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
  playInCallSound?: (bundleName: string) => void;
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
 * Ensure the Android 12+ BLUETOOTH_CONNECT *runtime* permission is granted.
 *
 * This MUST be granted BEFORE `InCallManager.start()` runs, because the
 * native session-init starts the AppRTC BluetoothManager which can only
 * enumerate/route to a paired headset when the app already holds
 * BLUETOOTH_CONNECT. If we request it lazily (after start), the BT device
 * never lands in the available-device list, so both auto-detect AND manual
 * "Bluetooth" selection are silently ignored and audio stays on the
 * speaker/earpiece — exactly the reported bug.
 *
 * No-op (returns true) on web, iOS, and Android < 12 where the permission
 * isn't required at runtime.
 */
export async function ensureBluetoothPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PermissionsAndroid } = require('react-native');
    const perm = (PermissionsAndroid.PERMISSIONS as any).BLUETOOTH_CONNECT;
    if (!perm) return true;
    const has = await PermissionsAndroid.check(perm);
    if (has) return true;
    const result = await PermissionsAndroid.request(perm);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
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
  // iter-193/iter-2xx: Android 12+ requires the BLUETOOTH_CONNECT runtime
  // permission. We now request it BEFORE the session starts (see
  // applyAudioMode → ensureBluetoothPermission), but re-check here too in
  // case this path is hit independently.
  void (async () => {
    const granted = await ensureBluetoothPermission();
    if (!granted) {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.warn('[inCallManager] BLUETOOTH_CONNECT denied — BT routing unavailable');
      }
      return;
    }
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
        // 4. iter-193: one more late re-issue at 1.2s — SCO link setup on
        //    some headsets (especially buds with multipoint) takes ~1s;
        //    without this the route falls back to earpiece.
        setTimeout(() => {
          try {
            native.chooseAudioRoute?.('BLUETOOTH');
          } catch {}
        }, 1200);
      } else {
        // Older react-native-incall-manager versions lacked chooseAudioRoute
        // — there's no clean BT path on those, but we at least don't crash.
        native.setForceSpeakerphoneOn(false);
        native.setSpeakerphoneOn(false);
      }
    }, 'setBluetoothOn');
  })();
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

/**
 * Caller-side ringback (iter-187). Plays the bundled Smilers theme
 * (`res/raw/incallmanager_ringback.mp3`, the library's `_BUNDLE_` naming
 * convention) on Android's VOICE-CALL stream while the outgoing call is
 * ringing. This stream is NOT muted by MODE_IN_COMMUNICATION — unlike the
 * old expo-audio ringback (media stream), which went silent the moment
 * the in-call audio session started. That was the "ringback only plays
 * before permissions are granted" bug: granted permissions = instant
 * session start = media stream muted.
 */
export function startNativeRingback() {
  const native = getNative();
  if (!native || typeof native.startRingback !== 'function') return;
  safeCall(() => {
    // CRITICAL: the Stream call screen never starts an InCallManager session
    // (Stream owns its own WebRTC audio), so `startRingback` had no initialised
    // native audio manager and produced NO sound — the "caller hears nothing
    // while it says Ringing…" bug. Initialise the session first (idempotent —
    // safe to call when already running). Ringback then plays on the VOICE-CALL
    // stream, which stays audible during MODE_IN_COMMUNICATION.
    try {
      native.start({ media: 'audio', auto: false });
    } catch {}
    native.startRingback!('_BUNDLE_');
  }, 'startRingback');
}

export function stopNativeRingback() {
  const native = getNative();
  if (!native || typeof native.stopRingback !== 'function') return;
  safeCall(() => native.stopRingback!(), 'stopRingback');
}

/**
 * iter-427/428 in-call SmilerS tones — a warm "Ciaooo" at call-END and a deep
 * "Connected" at call-CONNECT, played to the LOCAL participant.
 *
 * WHY the custom native `playInCallSound` (added by scripts/patch-incallmanager.js,
 * not `stop({busytone})`): the library's built-in busytone path is gated behind
 * `audioManagerActivated`/`_audioSessionInitialized`, which is FALSE during a
 * Stream call (Stream owns the WebRTC audio session, InCallManager is never
 * started) — so `stop({busytone})` would silently no-op. `playInCallSound`
 * plays a one-shot bundled sound on the VOICE-COMMUNICATION stream (audible
 * during MODE_IN_COMMUNICATION) WITHOUT starting/tearing down InCallManager's
 * own session, so it never disturbs the live call. The native MediaPlayer/
 * AVAudioPlayer runs natively so it keeps playing after the RN call screen
 * unmounts/navigates away. Fully defensive + native-only.
 */
/**
 * Plays a short in-call tone by name from the native res/raw bundle.
 *
 * PRIMARY path (Android): the app-OWNED `SmilersCallModule.playCallTone` — this
 * lives in committed native source so it is ALWAYS compiled into the build.
 * (The older `react-native-incall-manager` node_modules patch that added
 * `playInCallSound` was NOT making it into release builds — on-device
 * diagnostics showed `nativeMethod=false` — so we no longer rely on it as the
 * primary path.) Both play on the VOICE-COMMUNICATION SIGNALLING stream so the
 * tone mixes with the live Stream/WebRTC voice session instead of being muted.
 *
 * FALLBACK: the patched InCallManager.playInCallSound (used on iOS / if present).
 */
function playInCallTone(name: string, label: string) {
  const smilers = (NativeModules as any)?.SmilersCallModule;
  const hasAppModule = typeof smilers?.playCallTone === 'function';
  const native = getNative();
  const hasPatch = !!native && typeof native.playInCallSound === 'function';
  recordDiagnostic({
    tag: 'TONE',
    message: `${label} · appModule=${hasAppModule} patchMethod=${hasPatch}`,
    source: 'inCallManager',
  });
  if (hasAppModule) {
    try {
      const r = smilers.playCallTone(name);
      if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {});
    } catch {
      /* ignore */
    }
    return;
  }
  if (hasPatch) {
    safeCall(() => native!.playInCallSound!(name), label);
  }
}

// iter-465: timestamp of the most recent call end. The in-app "new message"
// notification sound (useMessageNotificationSound) must NOT fire in the moments
// right after a call ends, because every call inserts a call-log message into
// the conversation whose arrival would otherwise play the Smilers notification
// tone on top of the "Ciao" call-ended tone — covering it. Consumers check this
// to suppress that overlap.
let __lastCallEndedAt = 0;
export function markCallEnded(): void {
  __lastCallEndedAt = Date.now();
}
export function getLastCallEndedAt(): number {
  return __lastCallEndedAt;
}

export function playCallEndTone() {
  markCallEnded();
  playInCallTone('incallmanager_busytone', 'playCallEndTone');
}

export function playCallConnectedTone() {
  playInCallTone('incallmanager_connected', 'playCallConnectedTone');
}

/**
 * iter-329 CALL WAITING tone. Plays a short WhatsApp-style DOUBLE-BEEP over
 * the ongoing call when a second call arrives. We use InCallManager's DTMF
 * ringback because it plays on Android's VOICE-CALL stream, which is NOT muted
 * by MODE_IN_COMMUNICATION (unlike expo-audio's media stream that goes silent
 * during an active call). Fully defensive + native-only (no-op on web / if the
 * module is missing). Never throws into the call screen.
 */
export function playCallWaitingTone() {
  const native = getNative();
  if (!native || typeof native.startRingback !== 'function' || typeof native.stopRingback !== 'function') {
    return;
  }
  const beep = () => {
    safeCall(() => native.startRingback!('_DTMF_'), 'cw startRingback');
    setTimeout(() => safeCall(() => native.stopRingback!(), 'cw stopRingback'), 220);
  };
  beep();
  setTimeout(beep, 420); // second beep after a short gap → "de-dum"
}


/**
 * iter-194: subscribe to Android's audio-device list changes
 * (react-native-incall-manager emits `onAudioDeviceChanged` whenever a
 * Bluetooth headset connects/disconnects or the selected route changes).
 * The payload's `availableAudioDeviceList` is a JSON-encoded string array
 * like '["SPEAKER_PHONE","EARPIECE","BLUETOOTH"]'.
 * Returns an unsubscribe function. No-ops on iOS (AVAudioSession already
 * auto-routes to Bluetooth there).
 */
export function addAudioDeviceChangedListener(
  callback: (info: { available: string[]; selected: string | null }) => void,
): () => void {
  if (Platform.OS !== 'android') return () => undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DeviceEventEmitter } = require('react-native');
    const sub = DeviceEventEmitter.addListener('onAudioDeviceChanged', (event: any) => {
      try {
        const rawList = event?.availableAudioDeviceList;
        const available: string[] = Array.isArray(rawList)
          ? rawList
          : JSON.parse(String(rawList || '[]'));
        callback({
          available,
          selected: event?.selectedAudioDevice ? String(event.selectedAudioDevice) : null,
        });
      } catch {
        callback({ available: [], selected: null });
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {}
    };
  } catch {
    return () => undefined;
  }
}

export const InCallAudio = {
  start: startCallAudio,
  stop: stopCallAudio,
  setSpeakerOn,
  setEarpieceOn,
  setBluetoothOn,
  setMicMuted,
  ensureBluetoothPermission,
  onAudioRouteChange,
  isWiredHeadsetPluggedIn,
  addAudioDeviceChangedListener,
  startRingback: startNativeRingback,
  stopRingback: stopNativeRingback,
  playCallEndTone,
  playCallConnectedTone,
  playCallWaitingTone,
};
