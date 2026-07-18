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
  Inter_300Light,
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
import DriveModeController from '../src/components/DriveModeController';
import IncomingScreenShareModal from '../src/components/IncomingScreenShareModal';
import CallHost from '../src/components/call/CallHost';
import CallReturnBanner from '../src/components/call/CallReturnBanner';
import ResumeLastRoute from '../src/components/ResumeLastRoute';
import UpdateBanner from '../src/components/UpdateBanner';import { recordTouchActivity } from '../src/lib/touchActivity';
import { applyInterFontPatch } from '../src/lib/fontPatch';
import { loadNoiseCancellationPref } from '../src/lib/webrtc/audioConstraints';
import {
  installGlobalDiagnostics,
  flushDiagnostics,
  sendDiagnosticHeartbeat,
  recordDiagnostic,
  recordBootDiagnostic,
  probeBackendHealth,
} from '../src/lib/diagnostics';
import { Colors } from '../src/theme';
import { DeviceContactProvider } from '../src/lib/deviceContactIndex';
import { AppShareIntentProvider, useAppShareIntent } from '../src/lib/shareIntentContext';
import { ReferralAttribution } from '../src/lib/referralAttribution';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { api } from '../src/convexApi';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

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

// Ensure the message channel always exists before any FCM message push
// arrives — same reasoning as the 'default' channel above. Without this,
// messages delivered before the first app open (React never mounted) fall
// back to the 'default' channel and play the wrong sound.
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('messages-v4-message_notification', {
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'message_notification',
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#E4B53B',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
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

// iter-D1: One-shot BOOT fingerprint — captures the EXACT backend URL,
// app version, versionCode, platform burned into THIS apk. If a
// `/api/register-push` 404 ever surfaces again, one grep on
// `[DIAG][BOOT][api]` tells us if the device is talking to the right
// backend at all.
recordBootDiagnostic();

// iter-D1: One-shot health probe against `/api/__health` on the backend
// the APK was built against. Fire-and-forget — records whether the
// device can reach OUR backend AND whether critical routes
// (register-push, notify-event, diagnostic-logs) exist at that moment.
// This is the definitive "right backend / right routes" signal.
try {
  void probeBackendHealth();
} catch {}

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

/**
 * iter-169 WEB_PARITY_POLISH_CONTRACT — Presence heartbeat.
 *
 * Mounted ONCE inside ConvexClientProvider + AuthProvider so the
 * heartbeat fires `setOnlineStatus(true)` every 60s while the user
 * is authenticated and the app is foregrounded. The backend marks a
 * user offline if `lastSeen > 2 min`, so 60s gives us a safety
 * margin. See `src/hooks/usePresenceHeartbeat.ts` for details.
 */
function PresenceHeartbeat() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { usePresenceHeartbeat } = require('../src/hooks/usePresenceHeartbeat');
  usePresenceHeartbeat();
  // iter-247: mount the incoming-call listener GLOBALLY (was only in the tabs
  // layout, so a foreground call never rang while the callee was inside a chat
  // or any non-tab screen — "nothing arrives when on the app"). This sits
  // inside ConvexClientProvider + AuthProvider, so the Convex live query is
  // available on every authenticated screen.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useIncomingCallListener } = require('../src/push/useIncomingCallListener');
  useIncomingCallListener();

  // GLOBAL "delivered" (GREEN dot) marker — exact port of the web app's global
  // delivery component. Subscribes to getUnreadCounts and marks a conversation
  // delivered whenever its unread count increases (new incoming message),
  // regardless of the current screen. This is what makes the sender see
  // yellow(sent) → green(delivered) → blue(read), matching web.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useDeliveryReceipts } = require('../src/hooks/useDeliveryReceipts');
  useDeliveryReceipts();

  // iter-248 (CRITICAL): wire the notifee call-navigator BRIDGE. The Answer
  // handlers in notifeeCallWake.ts call `callNavigator(route)` to open
  // /twilio-call WITH the call's room + identity — but callNavigator was never
  // registered, so the route was silently stashed in pendingCallRoute and
  // never consumed. Result: tapping the incoming-call notification opened the
  // app with NO identity → token fetch short-circuited → "Access token is
  // required" / wrong identity → "duplicate identity". Register the navigator
  // here (global, inside Convex+Auth providers) and drain any pending/cold-
  // start answer route.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useRouter } = require('expo-router');
  const router = useRouter();
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      setCallNavigator,
      consumePendingCallRoute,
      handleNotifeeInitialCallNotification,
    } = require('../src/push/notifeeCallWake');
    setCallNavigator((url: string) => router.push(url as any));
    const pending = consumePendingCallRoute();
    if (pending) router.push(pending as any);
    handleNotifeeInitialCallNotification();
    return () => setCallNavigator(null);
  }, [router]);

  return null;
}

/**
 * iter-176: Device-contact bridge.
 *
 * Resolves the signed-in user's default country code (from their own
 * E.164 phone) and feeds it to `DeviceContactProvider`. The provider
 * uses the country hint to parse device-address-book phone numbers that
 * were saved in local format (very common on Android).
 *
 * Why a bridge: the country code only becomes known after Convex's
 * `users.getCurrentUser` resolves, which requires being inside
 * `ConvexClientProvider`. Splitting this responsibility keeps the
 * provider itself convex-free and easy to test.
 */
function DeviceContactBridge({ children }: { children: React.ReactNode }) {
  const meQuery = useSafeConvexQuery<any>(
    (api as any)?.users?.getCurrentUser,
    {},
    null,
    true,
  );
  const me: any = (meQuery as any)?.data;
  const country: CountryCode | null = React.useMemo(() => {
    const phone = me?.phoneE164 || me?.phone || '';
    if (!phone) return null;
    try {
      const parsed = parsePhoneNumberFromString(String(phone));
      return (parsed?.country as CountryCode) || null;
    } catch {
      return null;
    }
  }, [me?.phoneE164, me?.phone]);

  return <DeviceContactProvider myDefaultCountry={country}>{children}</DeviceContactProvider>;
}

/**
 * iter-175 Path B Phase 2 — CallKeep + Notifee + iOS VoIP push bootstrap.
 *
 * IMPORTANT: this is PURELY ADDITIVE. It runs alongside the existing
 * `usePushNotifications` and `useEmergentPush` hooks; it never touches
 * their state, channels, or registration logic. If this fails to load
 * (native module missing on web), the rest of the app continues working.
 */
function CallWakeBootstrap() {
  // iter-176 native-crash hotfix: the wake-screen ringing layer
  // (CallKeep + Notifee + iOS VoIP push) is force-disabled until the
  // Android Manifest entries for io.wazo.callkeep.VoiceConnectionService
  // are properly wired in. Without those entries `RNCallKeep.setup()`
  // crashes the Android app at launch ("Smilers has stopped"). The
  // existing FCM push pipeline continues working unchanged.
  //
  // To re-enable: restore the hook-driven body below (move out of the
  // commented block) AND flip `WAKE_SCREEN_ENABLED` in
  // `src/push/callWakeScreen.ts` AND add the required manifest entries.
  return null;
}

/* eslint-disable */
// @ts-nocheck — preserved original implementation for future re-enable.
// Intentionally guarded behind `false &&` so the bundler keeps it cold-
// referenced but Metro/JS engine never evaluates the require()s on a
// release device. Do NOT remove without restoring the manifest entries.
function _CallWakeBootstrapImpl_DO_NOT_USE() {
  if (Platform.OS === 'web') return null;
  const { useEffect } = require('react');
  const { useRouter } = require('expo-router');
  const { useMutation } = require('convex/react');
  const { api } = require('../src/convexApi');
  const { initCallWakeScreen } = require('../src/push/callWakeScreen');

  const router = useRouter();
  const decline = useMutation((api as any).calls?.declineCall) as any;
  const registerVoipToken = useMutation((api as any).calls?.registerVoipToken) as any;

  useEffect(() => {
    initCallWakeScreen(router, decline, registerVoipToken).catch(() => {});
  }, [decline, registerVoipToken, router]);

  return null;
}
/* eslint-enable */

/**
 * iter-170 OS Share Sheet receiver.
 *
 * Listens globally for an incoming share intent (text/URL/image/video/file
 * delivered by the iOS share extension or Android ACTION_SEND intent
 * filter). When a payload arrives we route the user to /share-receiver
 * which renders the recipient picker.
 *
 * Web preview / Expo Go: `useShareIntent` is a no-op there, so the hook
 * safely renders nothing.
 */
function ShareIntentRouter() {
  // iter-170: skip the native hook entirely on web — `useShareIntent`
  // crashes when the native module isn't present. We still mount this
  // component globally; it just becomes a no-op on web preview.
  if (Platform.OS === 'web') {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useRouter, usePathname } = require('expo-router');

  // Platform.OS is process-constant, so the early return above is
  // render-stable and these hooks always run in the same order.
  /* eslint-disable react-hooks/rules-of-hooks */
  const router = useRouter();
  const pathname = usePathname();
  // iter-177 ROOT-CAUSE FIX for "Nothing shared yet": read the SHARED
  // share-intent state from AppShareIntentProvider instead of creating a
  // second private `useShareIntent()` instance. Previously this router's
  // instance consumed the one-shot native payload, so the /share-receiver
  // screen's own instance always came up empty.
  const { hasShareIntent, shareIntent } = useAppShareIntent();

  React.useEffect(() => {
    if (!hasShareIntent) return;
    // iter-176: only navigate when there's an ACTUAL payload. The
    // expo-share-intent native module can briefly report
    // `hasShareIntent=true` on cold-start even for a normal launcher
    // intent (especially when duplicate SEND filters live on the MAIN
    // activity). Without this guard the user gets stranded on the
    // "Nothing shared yet" screen after a normal tap on the app icon.
    const hasText = !!(shareIntent && (shareIntent as any).text);
    const hasUrl = !!(shareIntent && (shareIntent as any).webUrl);
    const hasFiles = Array.isArray((shareIntent as any)?.files)
      && (shareIntent as any).files.length > 0;
    if (!hasText && !hasUrl && !hasFiles) return;
    // Don't re-route if we're already on the receiver screen.
    if (pathname === '/share-receiver') return;
    router.push('/share-receiver' as any);
  }, [hasShareIntent, pathname, router, shareIntent]);
  /* eslint-enable react-hooks/rules-of-hooks */

  return null;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_300Light,
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
        // Restore the user's saved noise-cancellation preference so
        // getVoiceAudioConstraints() reflects it before the first call.
        await loadNoiseCancellationPref();
      } catch {}
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
            <AppShareIntentProvider>
            <DeviceContactBridge>
            <ReferralAttribution />
            <GlobalNotificationSound />
            <GlobalNotificationServices />
            <PresenceHeartbeat />
            <ShareIntentRouter />
            <ResumeLastRoute />
            <CallWakeBootstrap />
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
              <Stack.Screen name="incoming-call" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
              <Stack.Screen name="twilio-call" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
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
              <Stack.Screen name="u/[userId]" />
              <Stack.Screen name="chat-with/[userId]" />
              <Stack.Screen name="status-compose" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
              <Stack.Screen name="status-view/[userId]" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
              <Stack.Screen name="contact-qr" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
              <Stack.Screen name="screen-share" />
              <Stack.Screen name="find-by-phone" />
              <Stack.Screen name="share-receiver" />
              <Stack.Screen name="study/index" />
              <Stack.Screen name="study/session" />
            </Stack>
            <VoiceCommandLauncher />
            <DriveModeController />
            <IncomingScreenShareModal />
            <CallHost />
            <CallReturnBanner />
            <UpdateBanner />
              </View>
            </AppLockGate>
            </DeviceContactBridge>
            </AppShareIntentProvider>
          </ConvexClientProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
