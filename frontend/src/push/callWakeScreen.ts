/**
 * callWakeScreen — iter-175 Path B Phase 2.
 *
 * SEPARATE, ADDITIVE layer on top of the existing Emergent push pipeline.
 *
 * ⚠ HARD CONTRACT — DO NOT MODIFY THIS FILE TO REACH INTO usePushNotifications
 *    OR useEmergentPush. The user's existing push pipeline took weeks of
 *    debugging to stabilise. This file lives next to it, never touches it,
 *    and only exists to display the WhatsApp-style ring UI on top.
 *
 * What this file does:
 *   1. Initialises `react-native-callkeep` once on mount so the native
 *      CallKit (iOS) / ConnectionService (Android) bridge is live.
 *   2. Subscribes to `react-native-voip-push-notification` (iOS PushKit)
 *      and forwards VoIP payloads to CallKeep so the native incoming-call
 *      screen wakes the device.
 *   3. Exposes `presentIncomingCallWake(...)` which the existing push
 *      handler can ALSO call when it spots a `type:"call"` payload.
 *      This is the Android path — Notifee renders a full-screen-intent
 *      notification that wakes the screen even when the device is locked.
 *   4. Wires CallKeep's `answerCall` / `endCall` events back to the
 *      existing `router.push('/call/<id>')` flow and the existing
 *      `api.calls.declineCall` mutation.
 *
 * What this file does NOT do:
 *   - Send any push (server side)
 *   - Register any FCM token
 *   - Replace expo-notifications handlers
 *
 * Status of dependencies:
 *   - iOS VoIP push needs an Apple VoIP Services Certificate (separate
 *     from APNs) provisioned by the user before the iOS path lights up
 *   - Android needs the backend to forward `type:"call"` payloads that
 *     the existing push handler picks up — that already works today
 */

import { Platform } from 'react-native';
import type { Router } from 'expo-router';

type ConvexAction = (args: any) => Promise<any>;

/**
 * iter-176 native-crash hotfix.
 *
 * The wake-screen ringing layer (CallKeep + Notifee + iOS VoIP push) was added
 * in iter-175 as an additive prep layer. The Expo config plugin that injects
 * the required AndroidManifest <service> entries for `io.wazo.callkeep.
 * VoiceConnectionService` had to be removed to unblock the EAS deployment
 * (`react-native-callkeep` does not ship `app.plugin.js`). As a result,
 * calling `RNCallKeep.setup()` on Android crashes the app at launch with
 * "Smilers has stopped".
 *
 * Until the Android manifest entries and iOS VoIP cert are wired in, this
 * entire layer is force-disabled. Native modules remain autolinked into the
 * APK (harmless) — we just never touch them from JS, so the runtime path
 * that crashes never runs.
 *
 * To re-enable later, flip this flag back to `true` AND add the required
 * AndroidManifest entries (either via a working config plugin or via the
 * EAS prebuild hooks).
 */
/**
 * iter-202 ROLLBACK: re-disabled. Enabling this caused a SEVERE regression
 * — message push notifications and call ringing stopped firing entirely
 * when the app was backgrounded or killed (the user reported "we are
 * virtually back to square zero"). The most plausible cause is that
 * CallKeep's foreground service / ConnectionService registration
 * intercepts the FCM delivery path and short-circuits the Notifee
 * channel that powers normal background notifications.
 *
 * Until we have a permission-aware initialization that gates RNCallKeep
 * setup behind explicit user consent (and verifies that grants don't
 * cannibalize the existing message push), this stays off. The previous
 * build that did NOT touch wake-screen had killed-app ringing working
 * fine via the standard FCM → Notifee message channel, so we restore
 * that path.
 */
const WAKE_SCREEN_ENABLED = false;

let initialised = false;
let registeredRouter: Router | null = null;
let registeredDeclineCall: ConvexAction | null = null;
let registeredRegisterVoipToken: ConvexAction | null = null;

interface IncomingCallPayload {
  callId: string;
  callerId: string;
  callerName: string;
  callType?: 'audio' | 'video';
}

/**
 * Lazy-require — keeps web bundling clean (CallKeep/Notifee both have
 * native modules that throw if imported on web).
 */
function loadNative() {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RNCallKeep = require('react-native-callkeep').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const notifee = require('@notifee/react-native').default;
    const notifeeTypes = require('@notifee/react-native');
    return { RNCallKeep, notifee, notifeeTypes };
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[callWakeScreen] native modules not present:', errorValue?.message);
    return null;
  }
}

function loadVoipPush() {
  if (Platform.OS !== 'ios') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-voip-push-notification').default;
  } catch {
    return null;
  }
}

/**
 * Initialise CallKeep + Notifee channel + iOS PushKit. Idempotent — safe
 * to call multiple times. Called from `_layout.tsx`'s CallWakeBootstrap.
 *
 * @param router    expo-router instance to navigate to /call on answer
 * @param decline   `useMutation(api.calls.declineCall)` to drop call on end
 * @param registerVoipToken Optional Convex mutation to store the iOS VoIP
 *                          push token server-side. Path B Phase 2 needs
 *                          this — backend wires it later.
 */
export async function initCallWakeScreen(
  router: Router,
  decline: ConvexAction,
  registerVoipToken?: ConvexAction,
): Promise<void> {
  if (!WAKE_SCREEN_ENABLED) {
    // Hard-disabled until Android manifest entries / iOS VoIP cert are wired in.
    // Existing FCM push pipeline keeps working unchanged.
    return;
  }
  if (initialised) {
    registeredRouter = router;
    registeredDeclineCall = decline;
    if (registerVoipToken) registeredRegisterVoipToken = registerVoipToken;
    return;
  }

  registeredRouter = router;
  registeredDeclineCall = decline;
  if (registerVoipToken) registeredRegisterVoipToken = registerVoipToken;

  const native = loadNative();
  if (!native) return;
  const { RNCallKeep, notifee, notifeeTypes } = native;

  try {
    await RNCallKeep.setup({
      ios: {
        appName: 'Smilers',
        includesCallsInRecents: true,
        supportsVideo: true,
        // iter-175: maximumCallGroups=1, maximumCallsPerCallGroup=1 — we
        // never multi-ring; one call at a time matches WhatsApp/Telegram.
        maximumCallGroups: '1',
        maximumCallsPerCallGroup: '1',
      },
      android: {
        alertTitle: 'Permission required',
        alertDescription:
          'Smilers needs to manage your calls so we can show incoming-call screens, even when the phone is locked.',
        cancelButton: 'Cancel',
        okButton: 'Allow',
        // The foreground-service channel CallKeep needs at install time;
        // separate from `messages-v3`/`calls` channels owned by
        // usePushNotifications.ts. Keep names distinct so we never collide.
        foregroundService: {
          channelId: 'com.smilers.app.callkeep.calls',
          channelName: 'Active calls',
          notificationTitle: 'Smilers is on a call',
        },
      },
    });
    RNCallKeep.setAvailable(true);
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[callWakeScreen] RNCallKeep.setup failed:', errorValue?.message);
  }

  // Notifee channel for the full-screen incoming-call notification on Android.
  // Marked as IMPORTANCE_HIGH (max for sound + wake) + visibility PUBLIC so
  // it shows on the lock screen.
  if (Platform.OS === 'android') {
    try {
      await notifee.createChannel({
        id: 'com.smilers.app.incoming-call-wake',
        name: 'Incoming calls (wake)',
        importance: notifeeTypes.AndroidImportance.HIGH,
        visibility: notifeeTypes.AndroidVisibility.PUBLIC,
        sound: 'ringtone',
        vibration: true,
      });
    } catch {
      /* channel may already exist — ignore */
    }
  }

  // CallKeep event handlers — route into the existing call screen.
  RNCallKeep.addEventListener('answerCall', ({ callUUID }: { callUUID: string }) => {
    try {
      registeredRouter?.push(`/call/${callUUID}?type=voice` as any);
    } catch (errorValue: any) {
      // eslint-disable-next-line no-console
      console.warn('[callWakeScreen] router.push failed:', errorValue?.message);
    }
  });

  RNCallKeep.addEventListener('endCall', ({ callUUID }: { callUUID: string }) => {
    try {
      if (registeredDeclineCall) {
        // Fire-and-forget — the server may already know about the hangup.
        registeredDeclineCall({ callId: callUUID }).catch(() => {});
      }
      // Dismiss any lingering Notifee notification for this call.
      if (Platform.OS === 'android') {
        notifee.cancelNotification(`call-${callUUID}`).catch(() => {});
      }
    } catch {
      /* swallow */
    }
  });

  // iOS PushKit listener — required for VoIP push delivery.
  if (Platform.OS === 'ios') {
    const VoipPushNotification = loadVoipPush();
    if (VoipPushNotification) {
      try {
        VoipPushNotification.addEventListener('register', (token: string) => {
          if (registeredRegisterVoipToken) {
            registeredRegisterVoipToken({ token, platform: 'ios' }).catch(() => {});
          }
        });

        VoipPushNotification.addEventListener('notification', (notification: any) => {
          const callId: string = String(notification?.callId || notification?.uuid || '');
          const callerName: string = String(notification?.callerName || 'Unknown');
          const callerId: string = String(notification?.callerId || callId);
          const callType: 'audio' | 'video' = notification?.callType === 'video' ? 'video' : 'audio';
          if (!callId) return;
          // Apple HARD-requires reporting an incoming call within ~5s of
          // a VoIP push or the system kills the app. Do it synchronously.
          RNCallKeep.displayIncomingCall(callId, callerId, callerName, 'generic', callType === 'video');
        });

        VoipPushNotification.registerVoipToken();
      } catch (errorValue: any) {
        // eslint-disable-next-line no-console
        console.warn('[callWakeScreen] VoIP push setup failed:', errorValue?.message);
      }
    }
  }

  initialised = true;
}

/**
 * Present a wake-screen incoming-call UI from an incoming-call PAYLOAD.
 * This is the bridge the existing push handler should call when it sees
 * `type:"call"` — it ADDS the full-screen UI without modifying any of
 * the existing notification handling.
 *
 * The existing handler still gets to schedule its banner / sound /
 * sticky notification. We just additionally wake the screen.
 */
export async function presentIncomingCallWake(payload: IncomingCallPayload): Promise<void> {
  if (!WAKE_SCREEN_ENABLED) return;
  if (Platform.OS === 'web') return;
  if (!payload?.callId) return;
  const native = loadNative();
  if (!native) return;
  const { RNCallKeep, notifee, notifeeTypes } = native;

  try {
    if (Platform.OS === 'android') {
      // Notifee full-screen-intent — wakes the device and shows the UI
      // even on lockscreen / doze mode.
      await notifee.displayNotification({
        id: `call-${payload.callId}`,
        title: 'Incoming call',
        body: `${payload.callerName || 'Smilers user'} is calling…`,
        android: {
          channelId: 'com.smilers.app.incoming-call-wake',
          importance: notifeeTypes.AndroidImportance.HIGH,
          visibility: notifeeTypes.AndroidVisibility.PUBLIC,
          category: notifeeTypes.AndroidCategory.CALL,
          fullScreenAction: { id: 'default' },
          pressAction: { id: 'default' },
          ongoing: true,
          autoCancel: false,
          // Loop ringtone via the channel sound.
          loopSound: true,
        },
      });
      // ALSO report to ConnectionService so the lock-screen call UI works.
      try {
        RNCallKeep.displayIncomingCall(
          payload.callId,
          payload.callerId || payload.callId,
          payload.callerName || 'Unknown',
          'generic',
          payload.callType === 'video',
        );
      } catch {
        /* CallKeep may not be granted yet — Notifee is the fallback */
      }
    } else if (Platform.OS === 'ios') {
      // iOS path is normally driven by VoIP push → PushKit → CallKit
      // directly. We still expose this path so an in-app foreground call
      // can use the same surface (CallKit UI).
      try {
        RNCallKeep.displayIncomingCall(
          payload.callId,
          payload.callerId || payload.callId,
          payload.callerName || 'Unknown',
          'generic',
          payload.callType === 'video',
        );
      } catch {
        /* swallow */
      }
    }
  } catch (errorValue: any) {
    // eslint-disable-next-line no-console
    console.warn('[callWakeScreen] presentIncomingCallWake failed:', errorValue?.message);
  }
}

/**
 * End / dismiss the wake-screen UI. Safe to call even when no call is
 * active — both Notifee and CallKeep silently no-op in that case.
 */
export async function endCallWake(callId: string): Promise<void> {
  if (Platform.OS === 'web' || !callId) return;
  const native = loadNative();
  if (!native) return;
  const { RNCallKeep, notifee } = native;
  try {
    if (Platform.OS === 'android') {
      await notifee.cancelNotification(`call-${callId}`);
    }
    RNCallKeep.endCall(callId);
  } catch {
    /* swallow */
  }
}
