/**
 * streamPush — Stream Video incoming-call push config using EXPO-NOTIFICATIONS
 * (deliberately NOT @react-native-firebase, so the app's existing custom FCM
 * service + notifee MESSAGE notifications stay completely intact).
 *
 * STAGED (Phase 1b): not yet imported. See /app/memory/STREAM_MIGRATION.md.
 *
 * Flow:
 *   • Android device token comes from expo-notifications getDevicePushTokenAsync()
 *     (raw FCM token) and is registered with Stream via client.addDevice(token,
 *     'firebase', 'firebase-video-production').
 *   • Stream call pushes arrive as FCM data messages. In the existing background
 *     handler we call handleStreamCallPush(data) — it bootstraps the client and
 *     lets the SDK render the native incoming-call (ConnectionService) UI.
 */
// @ts-expect-error — resolved after Phase 1b package install
import { StreamVideoRN, isFirebaseStreamVideoMessage, firebaseDataHandler } from '@stream-io/video-react-native-sdk';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { createStreamVideoClient } from './streamClient';

const ANDROID_PROVIDER = 'firebase-video-production';
const IOS_PROVIDER = 'apn-video-production'; // Phase 2

/** Register once (idempotent) so killed/background call pushes can bootstrap. */
export function setStreamPushConfig() {
  try {
    StreamVideoRN.setPushConfig({
      isExpo: true,
      ios: {
        pushProviderName: IOS_PROVIDER,
        supportsVideo: true,
        callsHistory: true,
        displayCallTimeout: 60000,
      },
      android: {
        pushProviderName: ANDROID_PROVIDER,
        incomingChannel: {
          id: 'stream_incoming_call',
          name: 'Incoming calls',
          vibration: true,
        },
        notificationTexts: {
          accepting: 'Connecting…',
          rejecting: 'Declining…',
        },
      },
      shouldRejectCallWhenBusy: true,
      createStreamVideoClient,
    });
  } catch {}
}

/** Register this device's FCM token with Stream (call after client connects). */
export async function registerStreamDevice(client: any) {
  try {
    const t = await Notifications.getDevicePushTokenAsync(); // raw FCM (android) / APNs (ios)
    const provider = Platform.OS === 'ios' ? IOS_PROVIDER : ANDROID_PROVIDER;
    await client.addDevice(t.data, 'firebase', provider);
  } catch {}
}

/**
 * Called from the app's existing FCM/background handler. Returns true if the
 * incoming data message was a Stream call push (and was handled by the SDK),
 * so the caller can `return` and NOT run its message-notification path.
 */
export async function handleStreamCallPush(data: Record<string, any>): Promise<boolean> {
  try {
    if (isFirebaseStreamVideoMessage({ data } as any)) {
      await firebaseDataHandler(data);
      return true;
    }
  } catch {}
  return false;
}
