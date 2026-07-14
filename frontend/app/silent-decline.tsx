/**
 * /app/silent-decline.tsx — headless in-app decline (sml-010).
 *
 * Launched by CallActionReceiver.kt when the callee taps Decline from the
 * native notification tray (background or killed app) on the LEGACY call
 * path. This mirrors how the Answer button already opens the app straight
 * to the call screen — except decline must stay silent per the client's
 * request: no call UI, no ringtone/ringback, no visible flash if we can
 * help it. It declines over the live, already-authenticated Convex
 * session — the same connection every other in-app action already uses —
 * instead of the old native-only path (a stored login token, or a push
 * relay back to the caller). That sidesteps both failure classes this
 * task's investigation traced everything back to.
 *
 * The native side still schedules the OLD path as a bounded ~3.5s backstop
 * (see CallActionReceiver.kt / SmilersCallNotificationService.kt). On
 * success here we tell native to cancel that backstop via
 * SmilersCallModule.cancelDeclineFallback(); if this screen can't confirm
 * in time (auth not ready, network blip), we simply do nothing further and
 * let the native backstop run as originally designed.
 *
 * Renders nothing — a single opaque View, no text/spinner/icons — and
 * never mounts the ringtone player or any call UI. Closes itself as soon
 * as the decline attempt (success OR failure) resolves, or after a local
 * safety timeout so it never lingers on-screen indefinitely.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Image, NativeModules, Platform, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { useConvexAuth } from 'convex/react';
import { api } from '../src/convexApi';
import { useReactiveSafeConvexQuery } from '../src/hooks/useReactiveSafeConvexQuery';
import { recordDiagnostic } from '../src/lib/diagnostics';

// Matches app.json's expo-splash-screen config exactly (backgroundColor,
// image, width) so this screen reads as "the app is briefly opening" —
// the same thing the user already sees on every cold launch — instead of
// a blank/black flash.
const SPLASH_BACKGROUND = '#FEF9F4';

// How long this screen waits for its own in-app decline to resolve before
// giving up and closing regardless — purely a UI safety net so the (already
// invisible) screen never lingers. Independent of, and shorter than, the
// native ~3.5s backstop timer, which keeps running on its own schedule.
const LOCAL_SAFETY_TIMEOUT_MS = 5000;

export default function SilentDeclineScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ callId?: string; conversationId?: string }>();
  const callId = String(params.callId || '');
  const conversationId = String(params.conversationId || '');
  const { isAuthenticated: convexReady } = useConvexAuth();
  const declineCall = useMutation((api as any).calls.declineCall);
  const handledRef = useRef(false);

  // sml-010: suppress the GLOBAL incoming-call listener (mounted in
  // _layout.tsx) from also showing its own ringing UI/ringtone for this
  // same conversation while this screen handles the decline — identical
  // mechanism to the one incoming-call.tsx already uses for its autoDecline
  // flow. Set in useLayoutEffect so it lands before that listener's own
  // effect can run.
  useLayoutEffect(() => {
    if (!conversationId) return;
    try {
      const declinedMap: Map<string, number> = ((globalThis as any).__smilersDeclinedByConv ??= new Map());
      declinedMap.set(conversationId, Date.now());
      if (callId) declinedMap.set(`callId:${callId}`, Date.now());
    } catch {}
  }, [conversationId, callId]);

  // The callId the native side passes is usually already the real Convex
  // call _id (resolvedCallId in CallActionReceiver.kt) — but fall back to
  // resolving it from the live getActiveCall query if it still looks like
  // the conversationId (unresolved) or is missing entirely, mirroring the
  // same race guard incoming-call.tsx uses for the Twilio path.
  const needsResolve = !callId || callId === conversationId;
  const { data: activeCall } = useReactiveSafeConvexQuery<any>(
    (api as any).calls.getActiveCall,
    needsResolve && conversationId ? { conversationId } : undefined,
    null,
    needsResolve && !!conversationId && convexReady,
  );
  const resolvedCallId = !needsResolve ? callId : activeCall?._id ? String(activeCall._id) : '';

  const closeScreen = () => {
    try {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch {}
  };

  // Local safety net — closes the screen regardless of outcome so it can
  // never linger, even if auth/resolution never completes. The native
  // backstop is unaffected by this and keeps running on its own timer.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!handledRef.current) {
        handledRef.current = true;
        recordDiagnostic({
          tag: 'TWILIO-CALL',
          source: 'silent-decline',
          message: `local safety timeout — closing without confirming callId=${callId || '(empty)'} conversationId=${conversationId || '(empty)'}`,
        });
        closeScreen();
      }
    }, LOCAL_SAFETY_TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (handledRef.current) return;
    if (!convexReady) return;
    if (!resolvedCallId) return;

    handledRef.current = true;
    (async () => {
      try {
        await declineCall({ callId: resolvedCallId });
        recordDiagnostic({
          tag: 'TWILIO-CALL',
          source: 'silent-decline',
          message: `declineCall ok callId=${resolvedCallId}`,
        });
        // Tell native the in-app decline confirmed — cancel its backstop.
        if (Platform.OS === 'android') {
          try {
            await NativeModules.SmilersCallModule?.cancelDeclineFallback(
              callId || '',
              conversationId || '',
            );
          } catch {}
        }
      } catch (e: any) {
        recordDiagnostic({
          tag: 'TWILIO-CALL',
          source: 'silent-decline',
          message: `declineCall failed callId=${resolvedCallId} error=${e?.message || e} — leaving native backstop to run`,
        });
        // Deliberately do NOT cancel the native backstop here — it's the
        // whole point of the backstop to catch exactly this case.
      } finally {
        closeScreen();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convexReady, resolvedCallId]);

  // No call UI, no ringtone — renders the same logo/background the user
  // already sees on every cold app launch (expo-splash-screen), centered,
  // instead of a blank/black flash. Still no call-specific UI of any kind.
  return (
    <View style={styles.container}>
      <Image
        source={require('../assets/images/splash-image.png')}
        style={styles.logo}
        resizeMode="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: SPLASH_BACKGROUND,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 200,
    height: 200,
  },
});
