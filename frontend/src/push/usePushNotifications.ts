import { useEffect, useRef, useCallback } from 'react';
import { AppState, Platform } from 'react-native';
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
const BACKGROUND_NOTIFICATION_TASK = 'smilers-background-notification-task';
const CALLS_CHANNEL = 'calls';
const MESSAGES_CHANNEL = 'messages';
const DEFAULT_CHANNEL = 'default';
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

// iter-116: Expected projectId for the Smilers Expo project (slug
// `smilers`, owner `abcsimplesend`). This matches `extra.eas.projectId`
// in app.json AND the Expo dashboard project at
// https://expo.dev/accounts/abcsimplesend/projects/smilers where the
// FCM V1 service-account key is uploaded.
//
// If the runtime projectId differs from this constant, the installed
// APK was built against a DIFFERENT Expo project and Expo's push
// servers won't find FCM credentials for it ("Unable to retrieve the
// FCM server key for the recipient's app"). The fix is always: fresh
// EAS build + uninstall old APK + install new APK.
const EXPECTED_PROJECT_ID = '8b742de6-a156-453c-8e54-16070577d2b7';

function getProjectId() {
  return (Constants.expoConfig as any)?.extra?.eas?.projectId || (Constants.easConfig as any)?.projectId || undefined;
}

/**
 * iter-116: returns a human-readable warning if the runtime projectId
 * doesn't match the project where FCM V1 credentials are uploaded.
 * Surfaced in the Push Diagnostics panel so the user can immediately
 * tell whether a "Remote self-test failed: Unable to retrieve FCM server
 * key" is a project-mismatch problem (fix = rebuild) vs. a real FCM
 * config problem.
 */
export function describePushProjectMismatch() {
  const runtimeId = getProjectId();
  if (!runtimeId) {
    return 'Runtime projectId is missing — the build is misconfigured.';
  }
  if (runtimeId === EXPECTED_PROJECT_ID) {
    return '';
  }
  return (
    `Runtime projectId is ${runtimeId} but Smilers FCM credentials are uploaded on ` +
    `Expo project ${EXPECTED_PROJECT_ID}. The currently installed APK was built ` +
    `against a different Expo project — Expo's push server cannot find FCM ` +
    `credentials for it. Fix: trigger a fresh EAS Android build (the new APK ` +
    `will embed the correct projectId), UNINSTALL the old APK from the device, ` +
    `then install the new APK. Reopening / clearing data is NOT enough — the ` +
    `projectId is baked in at build time.`
  );
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

  if (!shouldScheduleLocalNotification(taskObject)) {
    return;
  }

  backgroundNotificationKeys.add(notificationKey);
  trimBackgroundNotificationCache();

  const title =
    toNonEmptyString(payload.title) ||
    (type === 'call' ? 'Incoming call' : 'New message');
  const body =
    getDisplayNameFromPayload(payload) ||
    (type === 'call' ? 'Smilers caller' : 'Open Smilers to view the message');

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: payload,
      sound: type === 'call' ? resolveCallChannelSound(toNonEmptyString(payload.sound) || 'ringtone') : resolveMessageChannelSound('smilers_notification'),
      categoryIdentifier: type === 'call' ? CALL_CATEGORY : undefined,
      sticky: type === 'call',
      autoDismiss: type !== 'call',
      priority: type === 'call' ? Notifications.AndroidNotificationPriority.MAX : Notifications.AndroidNotificationPriority.HIGH,
      vibrate: type === 'call' ? [0, 600, 300, 600, 300, 600] : [0, 250, 250, 250],
      interruptionLevel: type === 'call' ? 'timeSensitive' : 'active',
    },
    trigger: Platform.OS === 'android' ? { channelId: type === 'call' ? CALLS_CHANNEL : MESSAGES_CHANNEL } : null,
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
      return;
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
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
      lightColor: '#E4B53B',
    });
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

      if (type === 'call' && action === 'decline' && callId) {
        try {
          await declineCall({ callId });
        } catch (e) {
          console.warn('[push] Decline failed', e);
        }
        await Notifications.dismissNotificationAsync(id);
        return;
      }

      if (type === 'call' && conversationId) {
        const displayName = getDisplayNameFromPayload(payload, contentBody) || contentTitle.trim();
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
    },
    [router, declineCall]
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
