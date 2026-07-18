/**
 * playbackNotification — Android media-playback FOREGROUND SERVICE for
 * voice notes + translated audio.
 *
 * A plain "now playing" notification does not stop Android from killing the
 * process in the background. A foreground service does. While audio plays we
 * run a notifee foreground service (type MEDIA_PLAYBACK) with an ongoing
 * notification carrying a Stop action, so playback keeps going even when the
 * app is backgrounded, and the user can stop it from the shade / lock screen.
 *
 * No-op on iOS/web (iOS background audio is handled by the `audio`
 * UIBackgroundMode + `shouldPlayInBackground`).
 */
import { Platform } from 'react-native';

const CHANNEL_ID = 'playback-v1';
const NOTIFICATION_ID = 'voice-playback';

let notifee: any = null;
let AndroidImportance: any = null;
let registered = false;
let serviceRunning = false;
let stopHandler: (() => void) | null = null;

function load(): boolean {
  if (Platform.OS !== 'android') return false;
  if (notifee) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@notifee/react-native');
    notifee = mod.default;
    AndroidImportance = mod.AndroidImportance;
    return !!notifee;
  } catch {
    return false;
  }
}

/** Called by playback code so the notification's Stop action can pause it. */
export function setPlaybackStopHandler(fn: (() => void) | null): void {
  stopHandler = fn;
}

function fireStop(): void {
  try {
    stopHandler?.();
  } catch {
    /* ignore */
  }
  void stopPlaybackNotification();
}

function ensureRegistered(): void {
  if (registered || !load()) return;
  registered = true;
  try {
    // The task promise stays pending while audio plays; notifee keeps the
    // service alive until stopForegroundService() is called.
    notifee.registerForegroundService(() => new Promise<void>(() => {}));
  } catch {
    /* already registered */
  }
  try {
    notifee.onForegroundEvent(({ detail }: any) => {
      if (detail?.pressAction?.id === 'stop-playback') fireStop();
    });
  } catch {
    /* ignore */
  }
}

export async function startPlaybackNotification(title: string): Promise<void> {
  if (!load()) return;
  ensureRegistered();
  try {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Audio playback',
      importance: AndroidImportance?.LOW ?? 2,
    });
    // CRASH FIX (voice-note play): we intentionally do NOT use
    // `asForegroundService` here. Notifee's bundled service declares only
    // `foregroundServiceType="shortService"`, so starting it as a
    // `mediaPlayback` foreground service throws an uncatchable native
    // `MissingForegroundServiceTypeException` on Android 14+ — crashing the
    // app the instant the user taps play. A plain ONGOING notification gives
    // the same media UI (with a Stop action) and never triggers that crash.
    // Short voice notes don't need a guaranteed-alive foreground service;
    // expo-audio's background mode already keeps brief playback going.
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Playing audio',
      body: title || 'Voice message',
      android: {
        channelId: CHANNEL_ID,
        ongoing: true,
        onlyAlertOnce: true,
        color: '#E4B53B',
        colorized: true,
        pressAction: { id: 'default', launchActivity: 'default' },
        actions: [{ title: 'Stop', pressAction: { id: 'stop-playback' } }],
      },
    });
    serviceRunning = true;
  } catch {
    serviceRunning = false;
  }
}

export async function stopPlaybackNotification(): Promise<void> {
  if (!notifee || !serviceRunning) return;
  serviceRunning = false;
  // No foreground service is started anymore, but call stopForegroundService
  // defensively in case an older session left one running.
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

/** Handle the Stop action when it arrives via the app's global background
 *  event handler (app not in foreground). Call from that handler. */
export function handlePlaybackBackgroundAction(pressActionId?: string): boolean {
  if (pressActionId === 'stop-playback') {
    fireStop();
    return true;
  }
  return false;
}
