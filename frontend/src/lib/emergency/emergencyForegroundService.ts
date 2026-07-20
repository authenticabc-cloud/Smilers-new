/**
 * emergencyForegroundService
 *
 * Runs a notifee foreground service while an emergency alert is active, so the
 * OS keeps the JS process alive to keep broadcasting live location + audio even
 * when the app is backgrounded or the screen is locked.
 *
 * CRITICAL (Android 14+): a foreground service may only be started with types
 * that are (a) declared in the merged manifest — see
 * plugins/withNotifeeForegroundServiceType.js (mediaPlayback|microphone|location)
 * — and (b) backed by the matching runtime permission. Starting with an
 * undeclared type throws the UNCATCHABLE MissingForegroundServiceTypeException;
 * starting a microphone/location FGS without RECORD_AUDIO / ACCESS_FINE_LOCATION
 * throws a SecurityException. We therefore only request the subset of types
 * whose permission is granted, and never start the service with an empty set.
 *
 * No-op on iOS/web (iOS keeps audio alive via the `audio` UIBackgroundMode).
 */
import { Platform } from 'react-native';

const CHANNEL_ID = 'emergency-fgs-v1';
const NOTIFICATION_ID = 'emergency-capture';

let notifee: any = null;
let AndroidImportance: any = null;
let AndroidForegroundServiceType: any = null;
let registered = false;
let running = false;
let currentAlertId: string | null = null;

function load(): boolean {
  if (Platform.OS !== 'android') return false;
  if (notifee) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@notifee/react-native');
    notifee = mod.default;
    AndroidImportance = mod.AndroidImportance;
    AndroidForegroundServiceType = mod.AndroidForegroundServiceType;
    return !!notifee;
  } catch {
    return false;
  }
}

function ensureRegistered(): void {
  if (registered || !load()) return;
  registered = true;
  try {
    // The task promise stays pending; notifee keeps the service alive until
    // stopForegroundService() is called.
    notifee.registerForegroundService(() => new Promise<void>(() => {}));
  } catch {
    /* already registered elsewhere (e.g. playback) — the shared runner is fine */
  }
}

/**
 * Start the emergency foreground service.
 * @param opts.mic  RECORD_AUDIO granted → include the microphone type.
 * @param opts.location  ACCESS_FINE_LOCATION granted → include the location type.
 * @returns true if the service was started.
 */
export async function startEmergencyForegroundService(opts: {
  mic: boolean;
  location: boolean;
  alertId?: string;
}): Promise<boolean> {
  if (!load()) return false;
  currentAlertId = opts.alertId ?? currentAlertId;
  if (running) return true;

  const types: any[] = [];
  if (opts.mic && AndroidForegroundServiceType?.FOREGROUND_SERVICE_TYPE_MICROPHONE != null) {
    types.push(AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE);
  }
  if (opts.location && AndroidForegroundServiceType?.FOREGROUND_SERVICE_TYPE_LOCATION != null) {
    types.push(AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_LOCATION);
  }
  // Never start a typed FGS with no granted type — that would crash.
  if (types.length === 0) return false;

  ensureRegistered();
  try {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Emergency alert',
      importance: AndroidImportance?.LOW ?? 2,
    });
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Emergency active',
      body: 'Sharing your live location and audio with your trustees',
      data: { type: 'emergency-fgs', alertId: currentAlertId || '' },
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        foregroundServiceTypes: types,
        ongoing: true,
        onlyAlertOnce: true,
        colorized: true,
        color: '#EF4444',
        pressAction: { id: 'default', launchActivity: 'default' },
        actions: [
          {
            title: 'Stop sharing',
            pressAction: { id: 'emergency-stop' },
          },
        ],
      },
    });
    running = true;
    return true;
  } catch {
    running = false;
    return false;
  }
}

export async function stopEmergencyForegroundService(): Promise<void> {
  if (!notifee || !running) return;
  running = false;
  try {
    await notifee.stopForegroundService();
  } catch {
    /* ignore */
  }
  try {
    await notifee.cancelNotification(NOTIFICATION_ID);
  } catch {
    /* ignore */
  }
}

/**
 * "Stop sharing" action from the ongoing emergency notification. Resolves the
 * active alert server-side (so the viewer flips to "Resolved" and capture
 * stops) and tears down the foreground service — all WITHOUT reopening the app.
 * Works from both the notifee background and foreground event handlers.
 */
export async function stopEmergencySharing(alertId?: string): Promise<void> {
  const targetAlertId = alertId || currentAlertId || '';
  // Resolve the alert via an authed HTTP client (no React hooks in the handler).
  if (targetAlertId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const SecureStore = require('expo-secure-store');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ConvexHttpClient } = require('convex/browser');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { anyApi } = require('convex/server');
      const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
      if (convexUrl) {
        const client = new ConvexHttpClient(convexUrl);
        const token = await SecureStore.getItemAsync('smilers_id_token');
        if (token) {
          client.setAuth(token);
          await client.mutation(anyApi.emergencyAlerts.resolveAlert, { alertId: targetAlertId });
        }
      }
    } catch (e: any) {
      console.warn('[emergency] stopEmergencySharing resolveAlert failed:', e?.message || e);
    }
  }
  currentAlertId = null;
  await stopEmergencyForegroundService();
}
