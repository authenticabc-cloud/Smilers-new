import React, { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as SplashScreen from 'expo-splash-screen';
import { sentry } from '../src/lib/sentry';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { AuthProvider } from '../src/providers/AuthProvider';
import { ConvexClientProvider } from '../src/providers/ConvexClientProvider';
import { useMessageNotificationSound } from '../src/lib/notification/useMessageNotificationSound';
import { usePushNotifications } from '../src/push/usePushNotifications';
import { useEmergentPush } from '../src/push/useEmergentPush';
import AppLockGate from '../src/components/AppLockGate';
import VoiceCommandLauncher from '../src/components/VoiceCommandLauncher';
import IncomingScreenShareModal from '../src/components/IncomingScreenShareModal';
import { recordTouchActivity } from '../src/lib/touchActivity';
import { applyInterFontPatch } from '../src/lib/fontPatch';
import {
  installGlobalDiagnostics,
  flushDiagnostics,
  sendDiagnosticHeartbeat,
  recordDiagnostic,
} from '../src/lib/diagnostics';
import { Colors } from '../src/theme';

// ⚡ Per the Emergent push playbook, the Android 'default' channel MUST
// be created at MODULE SCOPE (before any component mounts) so it exists
// before any incoming push fires. Without this, the first push after a
// fresh install can race the channel creation and land silently.
// We DO NOT replace the channels created inside usePushNotifications
// (messages-v2 / calls / default-v3); those are kept for legacy/Convex
// notifications. The 'default' channel is the catch-all the Emergent
// relay's notification payloads land in when no explicit channelId is
// provided.
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('default', {
    name: 'Default',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#E4B53B',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    enableVibrate: true,
    showBadge: true,
  }).catch(() => {});
}

// ⚡ Initialize Sentry as early as possible — this MUST happen at the very
// top of the JS bundle (before any other code runs) so it can install its
// native crash handlers in time to capture errors during the rest of the
// JS module-load phase. On Android, Sentry's native NDK integration is
// what allows us to see crashes inside C/C++ libraries like
// `react-native-webrtc` (which would otherwise just show "Smilers has
// stopped" with no recoverable trace).
//
// The DSN is read from EXPO_PUBLIC_SENTRY_DSN baked into the bundle at
// build time. If the env var is missing (e.g. local dev with no .env),
// Sentry.init is a no-op — it won't throw.
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (SENTRY_DSN) {
  try {
    sentry.init({
      dsn: SENTRY_DSN,
      // Production builds have minified JS; we'd need source maps uploaded
      // (auth-token-gated) to get readable JS stack traces. The native
      // stack trace is what matters for the current WebRTC crash anyway.
      debug: false,
      // Capture all events. We have low volume — no sampling needed.
      tracesSampleRate: 0.0,
      // Avoid sending PII automatically; we set user manually from AuthProvider.
      sendDefaultPii: false,
      // Surface native (NDK) crashes — this is what we actually need.
      enableNative: true,
      enableNativeCrashHandling: true,
      enableNativeNagger: false,
      enableAutoSessionTracking: true,
      // Tag the release with the bundled app version so we can correlate
      // crashes with specific build numbers.
      release: `smilers-mobile@${process.env.EXPO_PUBLIC_APP_VERSION || '2.1.x'}`,
    });
  } catch (errorValue: any) {
    // sentry.init can throw in rare configurations (e.g. invalid DSN
    // format). Swallow so the app still boots — diagnostics module below
    // still works.
    try {
      // eslint-disable-next-line no-console
      console.warn('Sentry.init failed:', errorValue?.message);
    } catch {}
  }
}

// ⚡ Install the global JS error handler + console.error tee + unhandled
// promise rejection listener BEFORE anything else runs. This way, any
// crash during module load, font loading, provider mount, etc. is
// captured and persisted to AsyncStorage — and flushed to the backend on
// the NEXT app launch. Without this, production-APK crashes are
// completely invisible to us.
installGlobalDiagnostics();
recordDiagnostic({ tag: 'BOOT', source: '_layout', message: 'root layout module evaluated' });

// ⚡ Fire a heartbeat ping IMMEDIATELY at module-evaluation time. This
// does NOT wait for React to mount, AsyncStorage writes to finish, or
// providers to render — it just POSTs `{ events: [{tag:'HB', …}] }` to
// /api/diagnostic-logs as soon as the JS bundle starts executing. If we
// see ANY 'HB' tagged entry in the backend supervisor logs, we know the
// diagnostics module is alive in the APK. If we DON'T see one even after
// the user reopens the app, something is preventing the network call
// itself (wrong URL, no internet permission, certificate pinning, etc.).
try {
  void sendDiagnosticHeartbeat();
} catch {}

// Apply the global Inter font patch eagerly (before any <Text> renders) so the
// very first paint already uses Inter weights once the .ttf files are loaded.
applyInterFontPatch();

// Keep the native splash visible until our Inter weights finish loading — this
// avoids a flash of the system font before Inter kicks in.
SplashScreen.preventAutoHideAsync().catch(() => {});

function GlobalNotificationSound() {
  useMessageNotificationSound();
  return null;
}

function GlobalNotificationServices() {
  usePushNotifications();
  // ⚡ Emergent-managed push registration runs alongside the legacy
  // Convex push pipeline. They use different transports (native FCM/APNs
  // direct via Emergent relay vs Expo wrapper via Convex). Once the
  // backend agent disables the Convex pipeline, this hook becomes the
  // sole registration path.
  useEmergentPush();
  return null;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  // ⚡ On app boot, flush any diagnostic events that were captured during
  // a previous session (e.g. a crash). The events are persisted to
  // AsyncStorage by `installGlobalDiagnostics()` and `callDebug.push()`,
  // so even an app that died mid-render still has its trail of crumbs
  // recoverable on the next launch. Fire-and-forget — we never block UI.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const flushed = await flushDiagnostics();
        if (!cancelled && flushed > 0) {
          // eslint-disable-next-line no-console
          console.log(`[diagnostics] flushed ${flushed} pending event(s) to backend`);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // On native we wait for Inter weights to load (the patched Text would
  // otherwise reference a font that doesn't exist yet, causing a fallback
  // flash). On web/preview the splash isn't shown and the system fallback
  // renders fine while fonts download, so don't block.
  if (!fontsLoaded && !fontError && Platform.OS !== 'web') {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <ConvexClientProvider>
            <GlobalNotificationSound />
            <GlobalNotificationServices />
            <StatusBar style="light" backgroundColor={Colors.headerBg} />
            <AppLockGate>
              <View
                style={{ flex: 1 }}
                onStartShouldSetResponderCapture={() => {
                  // Detect any touch anywhere on screen so floating UI like the
                  // Voice Command FAB can pop back in. We never actually claim
                  // the responder, so child touch handlers still work normally.
                  recordTouchActivity();
                  return false;
                }}
              >
                <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="phone-verify" />
              <Stack.Screen name="auth-callback" />
              <Stack.Screen name="auth-webview" options={{ presentation: 'modal' }} />
              <Stack.Screen name="chat/[conversationId]" />
              <Stack.Screen name="call/[conversationId]" options={{ presentation: 'modal' }} />
              <Stack.Screen name="conference/[conferenceId]/index" />
              <Stack.Screen name="conference/[conferenceId]/room" options={{ presentation: 'modal' }} />
              <Stack.Screen name="groups-create" />
              <Stack.Screen name="broadcast-create" />
              <Stack.Screen name="community-create" />
              <Stack.Screen name="conference-create" />
              <Stack.Screen name="ads/create" />
              <Stack.Screen name="ads/review" />
              <Stack.Screen name="settings" />
              <Stack.Screen name="emergency" />
              <Stack.Screen name="ai-chat" />
              <Stack.Screen name="blocked" />
              <Stack.Screen name="notifications" />
              <Stack.Screen name="message-language" />
              <Stack.Screen name="earnings" />
              <Stack.Screen name="privacy" />
              <Stack.Screen name="app-lock" />
              <Stack.Screen name="face-id" />
              <Stack.Screen name="chat-appearance" />
              <Stack.Screen name="templates" />
              <Stack.Screen name="scheduled" />
              <Stack.Screen name="chat-once" />
              <Stack.Screen name="search" />
              <Stack.Screen name="starred" />
              <Stack.Screen name="archived" />
              <Stack.Screen name="encryption" />
              <Stack.Screen name="wallet" />
              <Stack.Screen name="send-money" />
              <Stack.Screen name="user/[userId]" />
              <Stack.Screen name="status-compose" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
              <Stack.Screen name="status-view/[userId]" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
              <Stack.Screen name="contact-qr" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
              <Stack.Screen name="screen-share" />
              <Stack.Screen name="find-by-phone" />
            </Stack>
            <VoiceCommandLauncher />
            <IncomingScreenShareModal />
              </View>
            </AppLockGate>
          </ConvexClientProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
