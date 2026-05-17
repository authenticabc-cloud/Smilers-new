import { useEffect, useRef, useCallback } from 'react';
import { Platform, Alert } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useMutation, useConvex } from 'convex/react';
import { api } from '../convexApi';
import { readStoredJson } from '../lib/settingsStorage';
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
const RINGTONE_PREFS_KEY = 'smilers_ringtone_prefs';

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
    // High-priority channel for incoming calls — full-screen heads-up + custom ringtone
    await Notifications.setNotificationChannelAsync('calls', {
      name: 'Incoming Calls',
      importance: Notifications.AndroidImportance.MAX,
      sound: resolveCallChannelSound(prefs?.ringtone),
      vibrationPattern: [0, 1000, 500, 1000, 500, 1000],
      lightColor: '#E4B53B',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
      enableVibrate: true,
    });
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      sound: resolveMessageChannelSound(prefs?.notificationSound),
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#E4B53B',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
    await Notifications.setNotificationChannelAsync('default', {
      name: 'General',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
      lightColor: '#E4B53B',
    });
  }
}

export function usePushNotifications() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const convex = useConvex();
  const registerDevice = useMutation(api.mobilePush.registerMobileDevice);
  const declineCall = useMutation(api.calls.declineCall);
  const lastResponse = useRef<string | null>(null);

  // 1) On login: request permission, register token with backend
  useEffect(() => {
    if (Platform.OS === 'web' || !isAuthenticated) return;
    let cancelled = false;

    (async () => {
      try {
        const prefs = (await readStoredJson(RINGTONE_PREFS_KEY, null)) as any;
        await setupCategoriesAndChannels(prefs || null);

        if (!Device.isDevice) {
          console.log('[push] Skipping registration: not a physical device');
          return;
        }

        const { status: existing } = await Notifications.getPermissionsAsync();
        let finalStatus = existing;
        if (existing !== 'granted') {
          const { status: requested } = await Notifications.requestPermissionsAsync({
            ios: { allowAlert: true, allowBadge: true, allowSound: true },
          });
          finalStatus = requested;
        }
        if (finalStatus !== 'granted') {
          console.log('[push] Permission denied');
          return;
        }

        // Get the Expo Push token (works for both APNs and FCM)
        const projectId =
          (Constants.expoConfig as any)?.extra?.eas?.projectId ||
          (Constants.easConfig as any)?.projectId;
        const tokenResult = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined
        );
        const expoPushToken = tokenResult.data;

        if (cancelled) return;

        // Send to backend so it can push us notifications
        await registerDevice({
          expoPushToken,
          platform: Platform.OS as 'ios' | 'android',
          deviceName: Device.deviceName || 'Unknown',
          appVersion: (Constants.expoConfig as any)?.version || '1.0.0',
        });
        console.log('[push] Registered with backend:', expoPushToken);
      } catch (e: any) {
        console.warn('[push] Registration failed:', e?.message || e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, registerDevice]);

  // 2) Handle notification tap (background → foreground) and action buttons
  const handleResponse = useCallback(
    async (response: Notifications.NotificationResponse) => {
      // Dedupe — Expo can fire the same response twice on launch
      const id = response.notification.request.identifier;
      if (lastResponse.current === id) return;
      lastResponse.current = id;

      const data = response.notification.request.content.data || {};
      const type = (data as any).type as string | undefined;
      const conversationId = (data as any).conversationId as string | undefined;
      const callId = (data as any).callId as string | undefined;
      const action = response.actionIdentifier;

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
        // Answer button OR default tap → open call screen
        router.push(`/call/${conversationId}` as any);
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

    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);

    // Also handle the case where the app was launched by tapping a notification
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp) handleResponse(resp);
    });

    return () => sub.remove();
  }, [handleResponse]);
}
