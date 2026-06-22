import { useEffect, useRef, useCallback } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as TaskManager from 'expo-task-manager';
import { useRouter } from 'expo-router';
import { useConvexAuth, useMutation } from 'convex/react';
import { api } from '../convexApi';
import { readStoredJson } from '../lib/settingsStorage';
import { getPushDiagnosticsState, setPushDiagnostics, setPushDiagnosticsRetryHandler } from './pushDiagnostics';
import { useAuth } from '../providers/AuthProvider';
import { isTwilioEnabled } from '../lib/twilio/twilioApi';

// Foreground display behavior — show banner + sound for incoming pushes
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

const CALL_CATEGORY = 'incoming-call';
// iter-186: category for desktop login approval pushes — gives the
// heads-up notification Approve/Deny action buttons. NOTE: the buttons
// only appear when the push carries `categoryId: "login-approval"`;
// a plain tap routes to /approve-login either way.
const LOGIN_APPROVAL_CATEGORY = 'login-approval';
const BACKGROUND_NOTIFICATION_TASK = 'smilers-background-notification-task';
const CALLS_CHANNEL = 'calls';
// iter-127: bumped channel ids again. Android caches importance per
// channel id forever (immutable post-creation). To upgrade
// HIGH → MAX (the only level that wakes the screen on Android 8+), we
// need to create FRESH channels at MAX importance. Previous ids stay
// behind harmlessly; the OS just lists them as unused.
//
// MAX importance gives us:
//   - Heads-up banner (same as HIGH)
//   - Full-screen wake on lock screen
//   - System wakes display from doze
//   - Vibration + sound
//
// HIGH only does the banner + sound. The user reported "notification
// arrives but screen doesn't wake" — that's the exact HIGH-vs-MAX
// behavioral diff documented at
// https://developer.android.com/training/notify-user/channels#importance
const MESSAGES_CHANNEL = 'messages-v3';
const DEFAULT_CHANNEL = 'default-v3';
const RINGTONE_PREFS_KEY = 'smilers_ringtone_prefs';

const backgroundNotificationKeys: Set<string> = new Set();
const runtimeScope = globalThis as any as {
  __smilersAppState?: string;
  __smilersNotificationTaskDefined?: boolean;
};

if (!runtimeScope.__smilersAppState) {
  runtimeScope.__smilersAppState = Platform.OS === 'web' ? 'active' : AppState.currentState;
}

function trimBackgroundNotificationCache() {
  if (backgroundNotificationKeys.size <= 30) {
    return;
  }
  const oldestKey = backgroundNotificationKeys.values().next().value;
  if (oldestKey) {
    backgroundNotificationKeys.delete(oldestKey);
  }
}

function safeParseJson<T>(value: string | null | undefined): T | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toNonEmptyString(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

type NotificationPayload = {
  type?: string;
  callId?: string;
  messageId?: string;
  conversationId?: string;
  displayName?: string;
  callerName?: string;
  callerDisplayName?: string;
  senderName?: string;
  title?: string;
  body?: string;
  sound?: string;
  [key: string]: unknown;
};

function normalizeNotificationPayload(rawValue: unknown): NotificationPayload {
  const baseObject = rawValue && typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : {};
  const nestedData =
    typeof baseObject.data === 'string'
      ? safeParseJson<Record<string, unknown>>(baseObject.data)
      : baseObject.data && typeof baseObject.data === 'object'
        ? (baseObject.data as Record<string, unknown>)
        : null;
  const nestedBody =
    typeof baseObject.body === 'string' ? safeParseJson<Record<string, unknown>>(baseObject.body) : null;

  return {
    ...(nestedData || {}),
    ...(nestedBody || {}),
    ...baseObject,
  };
}

function getDisplayNameFromPayload(payload: NotificationPayload, fallbackBody?: string) {
  return (
    toNonEmptyString(payload.displayName) ||
    toNonEmptyString(payload.callerDisplayName) ||
    toNonEmptyString(payload.callerName) ||
    toNonEmptyString(payload.senderName) ||
    toNonEmptyString(payload.body) ||
    toNonEmptyString(fallbackBody)
  );
}

// iter-123: REAL projectId discovered via direct Expo GraphQL API query.
// Logged in as user `abcsimplesend` (account id c5cc0608-...) and ran
// `query { meActor { accounts { appsPaginated } } }` — the account's
// `smilers` slug app has projectId `aff3eee0-0f42-475a-bd4c-a6d39d9b2f7b`,
// NOT `e43b472f-...` (which is a project owned by a DIFFERENT Expo
// account that abcsimplesend can't even read) and NOT `8b742de6-...`
// (which doesn't exist).
//
// How we got into this mess: an earlier agent put `e43b472f-...` in
// app.json (likely copy-pasted from another tutorial / repo). EAS
// Build USES `extra.eas.projectId` verbatim at build time — it does
// NOT re-resolve from owner+slug if a projectId is present. So every
// build embedded the wrong id, and the runtime push token was issued
// against that wrong project — which is why Expo's push API returned
// `InvalidCredentials`: it couldn't find FCM credentials for a project
// that doesn't belong to the user.
//
// FCM v1 service account key is uploaded to project `aff3eee0-...`
// (verified via the user's dashboard screenshots showing the upload
// at https://expo.dev/accounts/abcsimplesend/projects/smilers — which
// is the URL for project id `aff3eee0-...`). So after the next build,
// runtime projectId will be `aff3eee0-...`, Expo's push backend will
// look up FCM credentials for `aff3eee0-...`, find the uploaded
// service account, and successfully deliver to FCM.
// iter-127: EXPECTED_PROJECT_ID is no longer used because the Emergent
// push regime makes projectId matching irrelevant. The constant is
// preserved as a code-archeology marker for the iter-116..iter-125
// "projectId hunt" work. Once the legacy Expo-push pipeline is removed
// in Phase-2 migration this entire block can be deleted.
// const EXPECTED_PROJECT_ID = 'aff3eee0-0f42-475a-bd4c-a6d39d9b2f7b';

function getProjectId() {
  return (Constants.expoConfig as any)?.extra?.eas?.projectId || (Constants.easConfig as any)?.projectId || undefined;
}

/**
 * iter-116: returns a human-readable warning if the runtime projectId
 * doesn't match the project where FCM V1 credentials are uploaded.
 *
 * iter-127 UPDATE: Under the new Emergent-managed push regime, pushes
 * are routed via FastAPI → Emergent push relay → FCM/APNs. Emergent's
 * relay handles FCM credentials INTERNALLY against its own projectId
 * (`e43b472f-...`), so the historical "projectId mismatch" is no longer
 * an actionable problem — it is the expected, correct state. The legacy
 * Expo-push pipeline still fires in parallel during Phase-1 migration
 * but its delivery failures (from the projectId mismatch) no longer
 * matter once Emergent push is verified working.
 *
 * This function is kept for backward compatibility with the
 * Notifications screen but always returns an empty string under the
 * new regime. Once Phase-2 migration removes the legacy pipeline this
 * function can be deleted along with its only caller.
 */
export function describePushProjectMismatch() {
  // iter-127: Emergent-managed push makes the projectId match irrelevant.
  // Return empty so the warning banner is hidden.
  return '';
}

function getAppVersion() {
  return toNonEmptyString((Constants.expoConfig as any)?.version) || '2.0.0';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildNotificationKey(payload: NotificationPayload) {
  const type = toNonEmptyString(payload.type) || 'unknown';
  const primaryId =
    type === 'message'
      ? toNonEmptyString(payload.messageId) || [
          toNonEmptyString(payload.conversationId),
          toNonEmptyString(payload.title),
          toNonEmptyString(payload.body),
        ].filter(Boolean).join(':')
      : toNonEmptyString(payload.callId) ||
        toNonEmptyString(payload.conversationId) ||
        toNonEmptyString(payload.displayName) ||
        toNonEmptyString(payload.title);
  return `${type}:${primaryId}`;
}

function shouldScheduleLocalNotification(taskData: unknown) {
  const taskObject = taskData && typeof taskData === 'object' ? (taskData as Record<string, unknown>) : {};
  const topLevelTitle = toNonEmptyString(taskObject.title);
  const topLevelBody = toNonEmptyString(taskObject.body);
  const notificationContent =
    taskObject.notification && typeof taskObject.notification === 'object'
      ? ((taskObject.notification as any)?.request?.content as Record<string, unknown> | undefined)
      : undefined;
  const contentTitle = toNonEmptyString(notificationContent?.title);
  const contentBody = toNonEmptyString(notificationContent?.body);
  return !(topLevelTitle || topLevelBody || contentTitle || contentBody);
}

async function presentBackgroundLocalNotification(taskData: unknown) {
  if (Platform.OS === 'web') {
    return;
  }

  const taskObject = taskData && typeof taskData === 'object' ? (taskData as Record<string, unknown>) : {};
  const rawPayload =
    ((taskObject.notification as any)?.request?.content?.data as Record<string, unknown> | undefined) ||
    (taskObject.data as Record<string, unknown> | undefined) ||
    taskObject;
  const payload = normalizeNotificationPayload(rawPayload);
  const type = toNonEmptyString(payload.type);
  if (type !== 'call' && type !== 'message') {
    return;
  }

  const notificationKey = buildNotificationKey(payload);
  if (!notificationKey || backgroundNotificationKeys.has(notificationKey)) {
    return;
  }

  // iter-217: CALLS now render via the rich notifee full-screen UI
  // (looping ringtone + Answer/Decline + ongoing + missed-call). Call
  // pushes are sent DATA-ONLY on Android, so Android does NOT auto-display
  // anything and we always reach here. We must NOT also schedule the plain
  // expo notification (that was the message-tone banner that auto-collapsed
  // with no actions). The notifee path is primary; the expo sticky is a
  // fallback ONLY when the native notifee module is unavailable.
  if (type === 'call') {
    // iter-221 — Issue 6/7/8: call pushes are DATA-ONLY again, so Android
    // displays NOTHING by itself and this notifee path is the SOLE renderer
    // of the incoming-call ring. We must NOT gate it behind
    // `shouldScheduleLocalNotification` — the FCM `data` still carries a
    // `title`/`message` for routing, which made that helper return false and
    // (wrongly) bail, so the ring never fired and the wrong tone played.
    // Re-displaying is idempotent: the notifee notification id is the stable
    // `call-wake-<callId>`, and `backgroundNotificationKeys` dedupes repeats.
    backgroundNotificationKeys.add(notificationKey);
    trimBackgroundNotificationCache();

    const callId = toNonEmptyString(payload.callId) || notificationKey;
    const callerName =
      getDisplayNameFromPayload(payload) || toNonEmptyString(payload.title) || 'Smilers user';
    const callerId = toNonEmptyString(payload.callerId) || callId;
    const isVideo =
      toNonEmptyString(payload.twilio_is_video) === '1' ||
      toNonEmptyString(payload.callType) === 'video';
    const callType: 'voice' | 'video' = isVideo ? 'video' : 'voice';
    const conversationId = toNonEmptyString(payload.conversationId) || '';
    const twilioRoom = toNonEmptyString(payload.twilio_room_name) || '';
    const callerIdentity = toNonEmptyString(payload.twilio_caller_identity) || '';
    const actionUrl = toNonEmptyString(payload.action_url) || '';

    let notifeeOk = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { presentIncomingCallNotifeeWake } = require('./notifeeCallWake');
      await presentIncomingCallNotifeeWake({
        callId,
        callerId,
        callerName,
        callerIdentity,
        callType,
        conversationId,
        twilioRoom,
        actionUrl,
        isVideo,
      });
      notifeeOk = true;
    } catch (errorValue: any) {
      console.warn('[push] notifee call wake failed, falling back to expo notif:', errorValue?.message);
    }

    if (!notifeeOk) {
      // Fallback so the call still rings on a build without notifee.
      await Notifications.scheduleNotificationAsync({
        content: {
          title: toNonEmptyString(payload.title) || 'Incoming call',
          body: callerName,
          data: payload,
          sound: resolveCallChannelSound(toNonEmptyString(payload.sound) || 'ringtone'),
          categoryIdentifier: CALL_CATEGORY,
          sticky: true,
          autoDismiss: false,
          priority: Notifications.AndroidNotificationPriority.MAX,
          vibrate: [0, 600, 300, 600, 300, 600],
          interruptionLevel: 'timeSensitive',
        },
        trigger: Platform.OS === 'android' ? { channelId: CALLS_CHANNEL } : null,
      });
    }
    return;
  }

  // MESSAGE path (unchanged): skip if the OS already displayed the push
  // (notification block present), otherwise schedule the local banner.
  if (!shouldScheduleLocalNotification(taskObject)) {
    return;
  }

  backgroundNotificationKeys.add(notificationKey);
  trimBackgroundNotificationCache();

  const title = toNonEmptyString(payload.title) || 'New message';
  const body =
    getDisplayNameFromPayload(payload) || 'Open Smilers to view the message';

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: payload,
      sound: resolveMessageChannelSound('smilers_notification'),
      autoDismiss: true,
      priority: Notifications.AndroidNotificationPriority.HIGH,
      vibrate: [0, 250, 250, 250],
      interruptionLevel: 'active',
    },
    trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
  });
}

if (Platform.OS !== 'web' && !runtimeScope.__smilersNotificationTaskDefined) {
  runtimeScope.__smilersNotificationTaskDefined = true;
  TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }: any) => {
    if (error) {
      console.warn('[push] Background notification task error:', error?.message || error);
      return;
    }

    if (runtimeScope.__smilersAppState === 'active') {
      // iter-248: in the FOREGROUND, only bail for non-CALL pushes. Call pushes
      // are sent data-only, which bypasses the foreground notification listener
      // entirely, and the Convex live-query path has proven unreliable at
      // surfacing the ring — so let CALL pushes fall through to
      // presentBackgroundLocalNotification (the Notifee Answer/Decline ring is
      // idempotent by call id, so it won't double-ring with the Convex path).
      try {
        const probe = normalizeNotificationPayload(
          (data as any)?.notification?.request?.content?.data ||
            (data as any)?.data ||
            data ||
            {},
        );
        if (toNonEmptyString(probe.type) !== 'call') return;
      } catch {
        return;
      }
    }

    try {
      await presentBackgroundLocalNotification(data);
    } catch (taskError: any) {
      console.warn('[push] Background notification scheduling failed:', taskError?.message || taskError);
    }
  });
}

function resolveMessageChannelSound(notificationSoundId?: string | null) {
  switch (notificationSoundId) {
    case 'silent':
      return undefined;
    case 'smilers_notification':
    default:
      return 'message_notification';
  }
}

function resolveCallChannelSound(ringtoneId?: string | null) {
  switch (ringtoneId) {
    case 'ringtone':
      return 'ringtone';
    case 'smilers_never_cry_1':
      return 'smilers_never_cry_1';
    case 'smilers_never_cry_2':
      return 'smilers_never_cry_2';
    case 'smilers_never_cry_3':
      return 'smilers_never_cry_3';
    case 'smilers_notification':
      return 'smilers_notification';
    case 'silent':
      return undefined;
    case 'smilers_never_cry':
    default:
      return 'smilers_never_cry';
  }
}

async function setupCategoriesAndChannels(prefs?: { ringtone?: string | null; notificationSound?: string | null } | null) {
  if (Platform.OS === 'web') {
    return;
  }

  // Buttons on the lock-screen / heads-up call notification
  await Notifications.setNotificationCategoryAsync(CALL_CATEGORY, [
    {
      identifier: 'answer',
      buttonTitle: 'Answer',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'decline',
      buttonTitle: 'Decline',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]);

  // iter-186: Approve/Deny buttons on the desktop-login-approval push.
  // Approve MUST open the app (the biometric/PIN gate lives there);
  // Deny resolves silently in the background response handler.
  await Notifications.setNotificationCategoryAsync(LOGIN_APPROVAL_CATEGORY, [
    {
      identifier: 'approve',
      buttonTitle: 'Approve',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'deny',
      buttonTitle: 'Deny',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]);

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CALLS_CHANNEL, {
      name: 'Incoming Calls',
      importance: Notifications.AndroidImportance.HIGH,
      sound: resolveCallChannelSound(prefs?.ringtone),
      vibrationPattern: [0, 600, 300, 600, 300, 900],
      lightColor: '#E4B53B',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
      enableVibrate: true,
      enableLights: true,
      showBadge: false,
    });
    await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      sound: resolveMessageChannelSound(prefs?.notificationSound),
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#E4B53B',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      enableVibrate: true,
      showBadge: true,
    });
    await Notifications.setNotificationChannelAsync(DEFAULT_CHANNEL, {
      name: 'General',
      // iter-126: bumped from DEFAULT → HIGH. Dashboard-sent test
      // pushes and any server-side send that omits `channelId` route
      // through this channel. On Android 8+, DEFAULT importance shows
      // the notification silently in the tray (no banner pop, no
      // screen wake) — exactly the symptom the user reported. HIGH
      // makes the OS pop a banner + light the screen, matching the
      // 'messages' channel behavior.
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#E4B53B',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      enableVibrate: true,
      showBadge: true,
    });
  }
  // iter-182: ALSO create the tone-versioned channels (calls-v4-<sound> /
  // messages-v4-<sound>, with MAX importance for calls). The backend
  // routes FCM pushes into these once the device registers their ids —
  // this is how a tone change actually takes effect (Android channels
  // are immutable, so new sound = new channel id).
  try {
    const { applyNotificationChannelPrefs } = require('./notificationChannels');
    await applyNotificationChannelPrefs(prefs || null);
  } catch {
    /* best-effort */
  }
}

async function hasGrantedNotificationPermissions() {
  const settings = await Notifications.getPermissionsAsync();
  return (
    settings.granted ||
    settings.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    settings.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

export function usePushNotifications() {
  const router = useRouter();
  const { isAuthenticated: hasAuthSession } = useAuth();
  const { isAuthenticated: isConvexAuthenticated, isLoading: isConvexAuthLoading } = useConvexAuth();
  const registerMobileDevice = useMutation((api as any).mobilePush.registerMobileDevice);
  const registerLegacyDevice = useMutation((api as any).pushNotifications.registerMobileDevice);
  const unregisterMobileDevice = useMutation((api as any).mobilePush.unregisterMobileDevice);
  const unregisterLegacyDevice = useMutation((api as any).pushNotifications.unregisterMobileDevice);
  const declineCall = useMutation(api.calls.declineCall);
  const markDelivered = useMutation((api as any).messages.markDelivered);
  // iter-186: desktop login approval — Deny from the notification action
  // button resolves silently without opening the app.
  const denyLoginApproval = useMutation((api as any).loginApprovals.deny);
  const lastResponse = useRef<string | null>(null);
  const lastKnownPushToken = useRef<string | null>(null);
  const registrationRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canRegisterWithBackend = hasAuthSession && isConvexAuthenticated && !isConvexAuthLoading;

  const clearRegistrationRetry = useCallback(() => {
    if (registrationRetryTimer.current) {
      clearTimeout(registrationRetryTimer.current);
      registrationRetryTimer.current = null;
    }
  }, []);

  useEffect(() => {
    // Compute the displayed registration status carefully so that a
    // transient Convex auth flicker does NOT downgrade a successful
    // 'registered' state to 'waiting-auth' (which would mislead users
    // into thinking they need to retry — even though the backend still
    // has their token).
    const currentStatus = getPushDiagnosticsState().registrationStatus;
    const isTerminalSuccess = currentStatus === 'registered';
    const computedStatus = canRegisterWithBackend
      ? currentStatus
      : isTerminalSuccess
        ? 'registered'
        : 'waiting-auth';

    setPushDiagnostics({
      authSessionReady: hasAuthSession,
      convexAuthReady: isConvexAuthenticated,
      convexAuthLoading: isConvexAuthLoading,
      canRegisterWithBackend,
      isPhysicalDevice: Platform.OS === 'web' ? null : Device.isDevice,
      projectId: getProjectId() || '',
      registrationStatus: computedStatus,
    });
  }, [canRegisterWithBackend, hasAuthSession, isConvexAuthenticated, isConvexAuthLoading]);

  const registerDeviceWithBackend = useCallback(
    async (expoPushToken: string) => {
      setPushDiagnostics({
        expoPushToken,
        registrationStatus: 'registering-backend',
        lastError: '',
      });
      const payload = {
        expoPushToken,
        platform: Platform.OS as 'ios' | 'android',
        deviceName: Device.deviceName || 'Unknown device',
        appVersion: getAppVersion(),
      };

      // 🚨 IMPORTANT: wrap the Convex mutation calls in a timeout. If the
      // Convex auth handshake glitches mid-flight (e.g. token refresh,
      // intermittent network), the mutation can hang forever — the Convex
      // client just queues it. Without a timeout, the diagnostics get
      // stuck at 'registering-backend' with no error, and we lose the
      // chance to schedule a retry.
      const REGISTER_TIMEOUT_MS = 15_000;

      try {
        await withTimeout(
          registerMobileDevice(payload),
          REGISTER_TIMEOUT_MS,
          'Timed out while registering this device with the Smilers push backend (Convex auth may be unstable).',
        );
      } catch (primaryError: any) {
        await withTimeout(
          registerLegacyDevice(payload),
          REGISTER_TIMEOUT_MS,
          'Timed out while registering with the legacy push backend.',
        ).catch((legacyError: any) => {
          throw legacyError?.message ? legacyError : primaryError;
        });
      }

      setPushDiagnostics({
        expoPushToken,
        registrationStatus: 'registered',
        lastError: '',
        lastRegisteredAt: new Date().toISOString(),
      });
      console.log('[push] Registered mobile device with backend');
    },
    [registerLegacyDevice, registerMobileDevice]
  );

  const unregisterDeviceWithBackend = useCallback(
    async (expoPushToken: string) => {
      try {
        await unregisterMobileDevice({ expoPushToken });
      } catch (primaryError: any) {
        await unregisterLegacyDevice({ expoPushToken }).catch((legacyError: any) => {
          throw legacyError?.message ? legacyError : primaryError;
        });
      }

      setPushDiagnostics({
        registrationStatus: 'unregistered',
        lastError: '',
        lastUnregisteredAt: new Date().toISOString(),
      });
      console.log('[push] Unregistered mobile device from backend');
    },
    [unregisterLegacyDevice, unregisterMobileDevice]
  );

  const attemptDeviceRegistration = useCallback(async () => {
    const prefs = (await readStoredJson(RINGTONE_PREFS_KEY, null)) as any;
    await setupCategoriesAndChannels(prefs || null);

    if (!Device.isDevice) {
      setPushDiagnostics({
        isPhysicalDevice: false,
        registrationStatus: 'error',
        lastError: 'Push registration requires a physical device.',
      });
      console.log('[push] Skipping registration: not a physical device');
      return;
    }

    setPushDiagnostics({ isPhysicalDevice: true, registrationStatus: 'requesting-permission', lastError: '' });
    const alreadyGranted = await hasGrantedNotificationPermissions();
    if (!alreadyGranted) {
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
    }
    const grantedAfterRequest = await hasGrantedNotificationPermissions();
    const permissionStatus = grantedAfterRequest ? 'granted' : 'denied';
    setPushDiagnostics({ permissionStatus });
    if (!grantedAfterRequest) {
      setPushDiagnostics({
        registrationStatus: 'error',
        lastError: 'Notification permission was denied on this device.',
      });
      console.log('[push] Permission denied');
      return;
    }

    const projectId = getProjectId();
    setPushDiagnostics({ registrationStatus: 'acquiring-device-token', projectId: projectId || '' });
    if (!projectId) {
      console.warn('[push] Missing EAS projectId while requesting Expo push token');
    }

    const nativeDeviceToken = await withTimeout(
      Notifications.getDevicePushTokenAsync(),
      12000,
      Platform.OS === 'android'
        ? 'Timed out while waiting for the native Android device push token (FCM). This usually points to Firebase/FCM configuration inside the app build.'
        : 'Timed out while waiting for the native device push token.'
    );

    setPushDiagnostics({ registrationStatus: 'acquiring-expo-token' });
    const tokenResult = await withTimeout(
      Notifications.getExpoPushTokenAsync({
        ...(projectId ? { projectId } : {}),
        devicePushToken: nativeDeviceToken,
      }),
      12000,
      'Timed out while requesting the Expo push token after the native device token was acquired.'
    );
    const expoPushToken = tokenResult.data;
    if (!expoPushToken) {
      throw new Error('Expo push token request returned an empty token');
    }

    console.log('[push] Expo token acquired', {
      tokenPreview: expoPushToken.slice(0, 24),
      hasProjectId: !!projectId,
      platform: Platform.OS,
    });
    lastKnownPushToken.current = expoPushToken;
    clearRegistrationRetry();
    await registerDeviceWithBackend(expoPushToken);
  }, [clearRegistrationRetry, registerDeviceWithBackend]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      setPushDiagnosticsRetryHandler(null);
      return;
    }

    setPushDiagnosticsRetryHandler(async () => {
      clearRegistrationRetry();
      await attemptDeviceRegistration();
    });

    return () => {
      setPushDiagnosticsRetryHandler(null);
    };
  }, [attemptDeviceRegistration, clearRegistrationRetry]);

  // 1) On login: request permission, register token with backend
  useEffect(() => {
    if (Platform.OS === 'web' || !canRegisterWithBackend) {
      clearRegistrationRetry();
      return;
    }

    let cancelled = false;

    const registerCurrentDevice = async () => {
      try {
        await attemptDeviceRegistration();
      } catch (e: any) {
        const message = e?.message || 'Push registration failed.';
        setPushDiagnostics({
          registrationStatus: 'retry-scheduled',
          lastError: message,
        });
        console.warn('[push] Registration failed:', e?.message || e);
        if (!cancelled) {
          clearRegistrationRetry();
          registrationRetryTimer.current = setTimeout(() => {
            if (!cancelled) {
              void registerCurrentDevice();
            }
          }, 5000);
        }
      }
    };

    void registerCurrentDevice();

    return () => {
      cancelled = true;
      clearRegistrationRetry();
    };
  }, [canRegisterWithBackend, clearRegistrationRetry, registerDeviceWithBackend]);

  useEffect(() => {
    if (Platform.OS === 'web' || hasAuthSession) {
      return;
    }

    const expoPushToken = lastKnownPushToken.current;
    if (!expoPushToken) {
      return;
    }

    unregisterDeviceWithBackend(expoPushToken)
      .catch((errorValue: any) => {
        console.warn('[push] Unregister failed:', errorValue?.message || errorValue);
      })
      .finally(() => {
        lastKnownPushToken.current = null;
      });
  }, [hasAuthSession, unregisterDeviceWithBackend]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      runtimeScope.__smilersAppState = nextState;
      if (nextState === 'active' && canRegisterWithBackend && lastKnownPushToken.current) {
        clearRegistrationRetry();
        setPushDiagnostics({ registrationStatus: 'registering-backend', lastError: '' });
        registerDeviceWithBackend(lastKnownPushToken.current).catch((errorValue: any) => {
          setPushDiagnostics({
            registrationStatus: 'error',
            lastError: errorValue?.message || 'Active-state re-registration failed.',
          });
          console.warn('[push] Active-state re-registration failed:', errorValue?.message || errorValue);
        });
      }
    });

    return () => {
      appStateSub.remove();
    };
  }, [canRegisterWithBackend, clearRegistrationRetry, registerDeviceWithBackend]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    runtimeScope.__smilersAppState = AppState.currentState;
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    if (!canRegisterWithBackend) {
      const expoPushToken = lastKnownPushToken.current;
      setPushDiagnostics({
        expoPushToken: expoPushToken || '',
        registrationStatus: 'waiting-auth',
      });
      console.log('[push] Waiting for Convex auth before device registration', {
        hasAuthSession,
        isConvexAuthenticated,
        isConvexAuthLoading,
        hasCachedToken: !!expoPushToken,
      });
    }
  }, [canRegisterWithBackend, hasAuthSession, isConvexAuthenticated, isConvexAuthLoading]);

  // 2) Handle notification tap (background → foreground) and action buttons
  const handleResponse = useCallback(
    async (response: Notifications.NotificationResponse) => {
      // Dedupe — Expo can fire the same response twice on launch
      const id = response.notification.request.identifier;
      if (lastResponse.current === id) return;
      lastResponse.current = id;

      const data = response.notification.request.content.data || {};
      const payload = normalizeNotificationPayload(data);
      const type = toNonEmptyString(payload.type) || undefined;
      const conversationId = toNonEmptyString(payload.conversationId) || undefined;
      const callId = toNonEmptyString(payload.callId) || undefined;
      const action = response.actionIdentifier;
      const contentBody = typeof response?.notification?.request?.content?.body === 'string'
        ? response.notification.request.content.body
        : '';
      const contentTitle = typeof response?.notification?.request?.content?.title === 'string'
        ? response.notification.request.content.title
        : '';

      console.log('[push] Response:', { type, action, conversationId, callId });

      // iter-186: desktop login approval (contract section 2). Approve
      // (or a plain tap) routes to the approval screen where the
      // biometric/PIN gate lives — NEVER auto-approve from here. Deny
      // resolves in the background without opening the app.
      if (type === 'login-approval') {
        const approvalCode = toNonEmptyString(payload.loginApprovalCode);
        if (action === 'deny' && approvalCode) {
          try {
            await denyLoginApproval({ code: approvalCode, resolvedByDevice: Device.deviceName || 'Smilers phone' });
          } catch (e: any) {
            console.warn('[push] Login approval deny failed:', e?.message);
          }
          await Notifications.dismissNotificationAsync(id);
          return;
        }
        router.push(
          approvalCode
            ? (`/approve-login?code=${encodeURIComponent(approvalCode)}` as any)
            : ('/approve-login' as any),
        );
        return;
      }

      if (type === 'call' && action === 'decline') {
        // Twilio incoming-call decline → complete the room so the CALLER
        // stops ringing/waiting. Works even when the legacy Convex callId
        // is absent on the Twilio push payload.
        const declineTwilioRoom = toNonEmptyString((payload as any).twilio_room_name);
        if (declineTwilioRoom) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { endTwilioCall } = require('../lib/twilio/twilioApi');
            void endTwilioCall(declineTwilioRoom);
          } catch {}
        }
        // Legacy Convex call decline.
        if (callId) {
          try {
            await declineCall({ callId });
          } catch (e) {
            console.warn('[push] Decline failed', e);
          }
        }
        // iter-211: ALSO cancel the Notifee wake-screen ring (no-op if absent).
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { cancelIncomingCallNotifeeWake } = require('./notifeeCallWake');
          void cancelIncomingCallNotifeeWake(callId || declineTwilioRoom || '');
        } catch {}
        await Notifications.dismissNotificationAsync(id);
        return;
      }

      if (type === 'call' && conversationId) {
        const displayName = getDisplayNameFromPayload(payload, contentBody) || contentTitle.trim();
        // iter-211: stop the wake-screen ring as soon as the user
        // taps the notification to answer — the in-call screen handles
        // the rest.
        if (callId) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { cancelIncomingCallNotifeeWake } = require('./notifeeCallWake');
            void cancelIncomingCallNotifeeWake(callId);
          } catch {}
        }
        // Phase A.4: incoming Twilio call → route to the new
        // /twilio-call screen with isCaller=0. Falls back to the
        // legacy /call/<id> path only when no `twilio_room_name` is
        // present (i.e., the caller is still on the old WebRTC stack).
        const twilioRoom = toNonEmptyString((payload as any).twilio_room_name);
        if (twilioRoom && isTwilioEnabled()) {
          const twilioIsVideo = String((payload as any).twilio_is_video ?? '1') === '1' ? '1' : '0';
          const twilioCallerIdentity = toNonEmptyString((payload as any).twilio_caller_identity) || '';
          // iter-251: route to the in-app incoming-call screen (Answer/Decline)
          // FIRST instead of dropping straight into the room. The screen
          // resolves the callee's real user id and joins only on Answer.
          router.push({
            pathname: '/incoming-call',
            params: {
              room: twilioRoom,
              callerId: twilioCallerIdentity,
              callerName: displayName || 'Smilers user',
              isVideo: twilioIsVideo,
              conversationId: conversationId || '',
              callId: toNonEmptyString((payload as any).callId) || '',
            },
          } as any);
          return;
        }
        router.push(
          displayName
            ? (`/call/${conversationId}?displayName=${encodeURIComponent(displayName)}` as any)
            : (`/call/${conversationId}` as any)
        );
        return;
      }

      if (type === 'message' && conversationId) {
        router.push(`/chat/${conversationId}` as any);
        return;
      }

      // iter-197: action_url deeplink fallback (EMERGENT_PUSH_BACKEND_CONTRACT §3).
      // Backend pushes carry `action_url` (e.g. /user/<id>, /notifications,
      // /chat/<id>?focus=<msg>); when none of the typed branches above
      // matched, route it directly so taps are never dead.
      const actionUrl =
        toNonEmptyString(payload.action_url) || toNonEmptyString((payload as any).deeplink);
      if (actionUrl) {
        if (/^https?:\/\//i.test(actionUrl)) {
          await Linking.openURL(actionUrl).catch((errorValue: any) => {
            console.warn('[push] action_url openURL failed:', errorValue?.message);
          });
          return;
        }
        if (actionUrl.startsWith('/')) {
          router.push(actionUrl as any);
          return;
        }
      }
    },
    [router, declineCall, denyLoginApproval]
  );

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    TaskManager.isTaskRegisteredAsync(BACKGROUND_NOTIFICATION_TASK)
      .then((isRegistered) => {
        if (!isRegistered) {
          return Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
        }
        return null;
      })
      .catch((errorValue: any) => {
        console.warn('[push] Background task registration failed:', errorValue?.message || errorValue);
      });

    const receiveSub = Notifications.addNotificationReceivedListener((notification) => {
      const payload = normalizeNotificationPayload(notification.request.content.data || {});
      const type = toNonEmptyString(payload.type) || undefined;
      const conversationId = toNonEmptyString(payload.conversationId) || undefined;
      if (type === 'message' && conversationId) {
        markDelivered({ conversationId }).catch((errorValue: any) => {
          console.warn('[push] markDelivered failed:', errorValue?.message || errorValue);
        });
      }
      // iter-186: desktop login approval arriving while the app is OPEN —
      // contract section 2: "If the app is in the foreground, show the
      // prompt in-app". Requests expire in 2 minutes, so route straight
      // to the approval screen instead of relying on a banner tap.
      if (type === 'login-approval') {
        const approvalCode = toNonEmptyString(payload.loginApprovalCode);
        router.push(
          approvalCode
            ? (`/approve-login?code=${encodeURIComponent(approvalCode)}` as any)
            : ('/approve-login' as any),
        );
      }
      // iter-211: foreground incoming-call wake-screen.
      //
      // When a call push arrives while the app is in the foreground
      // (e.g., user is reading a chat) the OS does NOT auto-display
      // the banner — our `setNotificationHandler` returns shouldShowBanner
      // but that gives a *quiet* banner, not the full-screen ring the
      // user expects from "Incoming call". We additionally fire the
      // Notifee fullScreenAction notification here so the ring + lock-
      // screen-style UI shows over the current screen.
      if (type === 'call') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { presentIncomingCallNotifeeWake } = require('./notifeeCallWake');
          const callId = toNonEmptyString(payload.callId) || toNonEmptyString(payload.messageId);
          const isVideo =
            toNonEmptyString(payload.twilio_is_video) === '1' ||
            toNonEmptyString(payload.callType) === 'video';
          if (callId) {
            void presentIncomingCallNotifeeWake({
              callId,
              callerId: toNonEmptyString(payload.callerId) || callId,
              callerIdentity:
                toNonEmptyString(payload.twilio_caller_identity) ||
                toNonEmptyString(payload.callerId) ||
                '',
              callerName: getDisplayNameFromPayload(payload) || 'Smilers user',
              callType: isVideo ? 'video' : 'voice',
              conversationId: conversationId || '',
              twilioRoom: toNonEmptyString(payload.twilio_room_name) || '',
              actionUrl: toNonEmptyString(payload.action_url) || '',
              isVideo,
            });
          }
        } catch (errorValue: any) {
          console.warn('[push] foreground call wake-screen failed:', errorValue?.message);
        }
      }
    });

    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);

    const tokenSub = Notifications.addPushTokenListener(({ data }) => {
      if (!data || !canRegisterWithBackend || lastKnownPushToken.current === data) {
        return;
      }
      lastKnownPushToken.current = data;
      setPushDiagnostics({ expoPushToken: data, registrationStatus: 'registering-backend', lastError: '' });
      registerDeviceWithBackend(data).catch((errorValue: any) => {
        setPushDiagnostics({
          registrationStatus: 'error',
          lastError: errorValue?.message || 'Token refresh registration failed.',
        });
        console.warn('[push] Token refresh registration failed:', errorValue?.message || errorValue);
      });
    });

    // Also handle the case where the app was launched by tapping a notification
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp) handleResponse(resp);
    });

    return () => {
      receiveSub.remove();
      sub.remove();
      tokenSub.remove();
    };
  }, [canRegisterWithBackend, handleResponse, markDelivered, registerDeviceWithBackend]);
}
