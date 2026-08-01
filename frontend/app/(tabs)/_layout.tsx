import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Redirect, Tabs, useRootNavigationState } from 'expo-router';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { useAuth } from '../../src/providers/AuthProvider';
import { api } from '../../src/convexApi';
import { resolveInstallVerified, markDeviceProvisioned } from '../../src/lib/settingsStorage';
import { useLocalReadMap } from '../../src/hooks/useLocalReadMap';
import { conversationLastActivityMs, effectiveUnread } from '../../src/lib/localReadState';
import { callDebug } from '../../src/lib/callDebugLog';
import { forceConvexReconnect } from '../../src/providers/useConvexAutoReconnect';
import { Colors, FontSize, FontWeight } from '../../src/theme';

export default function TabsLayout() {
  const rootNavigationState = useRootNavigationState();
  // iter-182: bottom inset for the OS navigation bar (small phones).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useSafeAreaInsets } = require('react-native-safe-area-context');
  const insets = useSafeAreaInsets();
  const { isLoading, isAuthenticated, sessionExpired, signOut, trySilentReauth } = useAuth();
  const updateCurrentUser = useMutation(api.users.updateCurrentUser);
  // Reactive subscription: changes from verifyOtp/savePhoneVerified propagate instantly.
  const meQuery = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const me: any = meQuery ?? null;
  const meLoading = isAuthenticated && meQuery === undefined;
  // iter-260: total unread messages → drives the in-app tab badges. The
  // unread map covers ALL conversations, so we split it into group vs direct
  // chats using the groups list, so each tab shows only its own pending count.
  const unreadCounts = useQuery(
    (api as any).messages.getUnreadCounts,
    isAuthenticated ? {} : 'skip',
  ) as Record<string, number> | undefined;
  const groupsList = useQuery(
    (api as any).conversations.listGroups,
    isAuthenticated ? {} : 'skip',
  ) as any[] | undefined;
  // iter-340: direct-chat list (deduped with the Chats screen's subscription)
  // so we can look up each conversation's last activity and honour the on-device
  // read overlay in the tab badges too.
  const convList = useQuery(
    (api as any).conversations.listConversations,
    isAuthenticated ? {} : 'skip',
  ) as any[] | undefined;
  const localRead = useLocalReadMap();
  const activityById = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of [...(Array.isArray(groupsList) ? groupsList : []), ...(Array.isArray(convList) ? convList : [])]) {
      const id = String(c?._id || c?.id || c?.conversationId || '');
      if (id) m[id] = conversationLastActivityMs(c);
    }
    return m;
  }, [groupsList, convList]);
  const groupIdSet = new Set(
    (Array.isArray(groupsList) ? groupsList : [])
      .map((g: any) => String(g?._id || g?.id || g?.conversationId || ''))
      .filter(Boolean),
  );
  let groupsUnread = 0;
  let chatsUnread = 0;
  for (const [id, c] of Object.entries(unreadCounts || {})) {
    const backend = Number(c) > 0 ? Number(c) : 0;
    // Subtract the already-read baseline so newly-arrived messages surface only
    // the genuinely-new count (not the stale bulk the backend never cleared).
    const n = effectiveUnread(localRead, String(id), activityById[String(id)] || 0, backend);
    if (groupIdSet.has(String(id))) groupsUnread += n;
    else chatsUnread += n;
  }
  const [installVerificationChecked, setInstallVerificationChecked] = useState(false);
  const [hasVerifiedInstall, setHasVerifiedInstall] = useState(false);
  const [syncingUser, setSyncingUser] = useState(false);
  const [bootstrapAttempted, setBootstrapAttempted] = useState(false);
  const [meGateTimedOut, setMeGateTimedOut] = useState(false);
  const [bootGateTimedOut, setBootGateTimedOut] = useState(false);
  // iter-300: "chats flash then Opening Smilers forever" fix.
  // Once the app has successfully reached the tabs with a resolved user at
  // least once, we must NEVER drop back to the full-screen "Opening Smilers…"
  // spinner. The trigger was: AuthProvider's background token refresh fires
  // ~2-3s after boot → setIdToken → ConvexProviderWithAuth re-auths the socket
  // → live `getCurrentUser` query transiently resets to `undefined` → the
  // meLoading gate below re-shows the spinner, and if the re-auth handshake
  // stalls it spins to eternity. With this latch, a transient me=undefined
  // after the first successful boot just keeps the already-rendered tabs on
  // screen (Convex retains the cached data; per-screen queries tolerate null),
  // exactly as the web app behaves. Terminal session expiry (sessionExpired)
  // still routes to the recovery screen — that's an actionable state, not a
  // spinner.
  const [everReady, setEverReady] = useState(false);
  const [reauthFailed, setReauthFailed] = useState(false);

  // Real-time foreground incoming-call detection is now mounted globally in
  // app/_layout.tsx (PresenceHeartbeat) so it fires on every authenticated
  // screen, not just the tabs.

  // Sync user with Convex backend on login (creates or updates user record)
  useEffect(() => {
    if (isAuthenticated) {
      updateCurrentUser({}).catch((e) => console.warn('updateCurrentUser failed:', e?.message));
    } else {
      setBootstrapAttempted(false);
    }
  }, [isAuthenticated, updateCurrentUser]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const syncPresence = () => {
      updateCurrentUser({}).catch((e) => console.warn('presence sync failed:', e?.message));
    };

    const subscription = AppState.addEventListener('change', () => {
      syncPresence();
    });
    const heartbeat = setInterval(syncPresence, 60000);

    return () => {
      subscription.remove();
      clearInterval(heartbeat);
    };
  }, [isAuthenticated, updateCurrentUser]);

  useEffect(() => {
    if (!isAuthenticated || !hasVerifiedInstall || meLoading || me || syncingUser || bootstrapAttempted) {
      return;
    }

    let cancelled = false;

    const bootstrapUser = async () => {
      setSyncingUser(true);
      try {
        await updateCurrentUser({});
        // useQuery is reactive; no need to refetch.
      } catch (errorValue: any) {
        if (!cancelled) {
          console.warn('tabs updateCurrentUser failed:', errorValue?.message || errorValue);
        }
      } finally {
        if (!cancelled) {
          setBootstrapAttempted(true);
          setSyncingUser(false);
        }
      }
    };

    void bootstrapUser();

    return () => {
      cancelled = true;
    };
  }, [bootstrapAttempted, hasVerifiedInstall, isAuthenticated, me, meLoading, syncingUser, updateCurrentUser]);

  useEffect(() => {
    let cancelled = false;

    const loadInstallVerification = async () => {
      if (!isAuthenticated) {
        if (!cancelled) {
          setHasVerifiedInstall(false);
          setInstallVerificationChecked(true);
        }
        return;
      }

      // Skip verification if this install is already verified OR (on an in-place
      // update) the account is server-verified and the device was provisioned.
      // A true reinstall wipes local data so this can't fire → still re-verifies.
      const verified = await resolveInstallVerified(Boolean(me?.phoneVerified), me?.email);
      if (cancelled) return;
      if (verified) {
        setHasVerifiedInstall(true);
        setInstallVerificationChecked(true);
        // Ensure the device is marked provisioned so a FUTURE update where the
        // install marker is missing can still skip re-verification.
        void markDeviceProvisioned();
      } else if (!meLoading) {
        // Only conclude "not verified" once the server user has resolved, so the
        // update fallback had a fair chance (avoids a phone-verify flash on
        // updates while `me` loads).
        setHasVerifiedInstall(false);
        setInstallVerificationChecked(true);
        setBootstrapAttempted(true);
      }
    };

    void loadInstallVerification();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, me, meLoading]);

  // iter-380 COLD-START STALL FIX: device logs showed `getCurrentUser` (me)
  // taking ~33s to resolve on a cold start with a stale cached id_token —
  // Convex authenticated with the expired token, queries returned empty, and
  // the token only rotated when a reconnect eventually forced it. During that
  // window the app is BLANK. AuthProvider refreshes the token silently but the
  // Convex auth memo is (intentionally) stable across rotations, so Convex is
  // never told about the fresh token → it keeps using the rejected one. A
  // single forced reconnect re-runs fetchAccessToken(force) and re-auths with
  // the fresh token (exactly what unblocked it at 33s in the logs). Kick it at
  // 9s and 16s if `me` still hasn't resolved (past the 8s boot guard in
  // forceConvexReconnect, so the hard reconnect actually runs), so the blank
  // window is seconds, not tens of seconds. Guarded to at most 2 kicks/stall.
  const meStallKicksRef = React.useRef(0);
  useEffect(() => {
    if (!isAuthenticated || !hasVerifiedInstall) return;
    if (!meLoading) {
      meStallKicksRef.current = 0;
      return;
    }
    const t1 = setTimeout(() => {
      if (meStallKicksRef.current >= 1) return;
      meStallKicksRef.current = 1;
      callDebug.push('CONVEX', 'tabs me-stall 9s → forceConvexReconnect');
      void forceConvexReconnect('tabs-me-stall-9s');
    }, 9000);
    const t2 = setTimeout(() => {
      if (meStallKicksRef.current >= 2) return;
      meStallKicksRef.current = 2;
      callDebug.push('CONVEX', 'tabs me-stall 16s → forceConvexReconnect');
      void forceConvexReconnect('tabs-me-stall-16s');
    }, 16000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isAuthenticated, hasVerifiedInstall, meLoading]);

  // iter-300: latch "we successfully booted into the tabs once". Set the
  // instant `me` resolves to a real user with the install verified — from
  // then on the spinner gate is disabled so a background-refresh re-auth
  // can't yank the user back to "Opening Smilers…".
  useEffect(() => {
    // WhatsApp-style entry: the instant we have a session + verified install,
    // the app is "ready" — do NOT wait for the `me` query. This stops the
    // "Opening Smilers…" spinner from ever gating a RETURNING user while Convex
    // (re)authenticates its socket in the background. Screens tolerate a null
    // `me` and fill in reactively when the query resolves.
    if (isAuthenticated && hasVerifiedInstall && !everReady) {
      setEverReady(true);
    }
  }, [isAuthenticated, hasVerifiedInstall, everReady]);

  // WhatsApp-style session recovery: when the OIDC token can't be refreshed
  // (`sessionExpired`), NEVER show a "Couldn't verify your session" wall.
  // Instead keep the app on screen and silently re-run the Hercules session
  // (prompt=none) in the BACKGROUND with a little backoff. Hercules keeps a
  // session alive for 30 days of activity, so this almost always succeeds with
  // zero user action; on success `sessionExpired` clears and Convex re-auths.
  useEffect(() => {
    if (!sessionExpired || !isAuthenticated) return;
    let cancelled = false;
    setReauthFailed(false);
    (async () => {
      for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
        try {
          const ok = await trySilentReauth();
          if (ok || cancelled) return;
        } catch {
          /* keep retrying */
        }
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
      // Silent renewal definitively failed (e.g. Hercules 30-day session truly
      // expired). This is the ONLY case that needs the user — surface a friendly
      // one-tap reconnect rather than trapping them on an empty screen.
      if (!cancelled) setReauthFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionExpired, isAuthenticated, trySilentReauth]);

  // Clear the reconnect prompt as soon as the session recovers.
  useEffect(() => {
    if (!sessionExpired) setReauthFailed(false);
  }, [sessionExpired]);

  // Safety timeout: if Convex me query hangs after auth/phone-verify, don't lock the user on "Opening Smilers" forever.
  useEffect(() => {
    if (!isAuthenticated || !hasVerifiedInstall) {
      setMeGateTimedOut(false);
      return;
    }
    if (me || meGateTimedOut || everReady) {
      return;
    }
    const timeoutId = setTimeout(() => {
      console.warn('tabs layout: me query gate timed out after 10s, releasing UI');
      setMeGateTimedOut(true);
    }, 10000);
    return () => clearTimeout(timeoutId);
  }, [hasVerifiedInstall, isAuthenticated, me, meGateTimedOut, everReady]);

  // iter-279: hard safety net + diagnostics for the FIRST boot gate (the only
  // one without a timeout). The "Opening Smilers…" hang users reported maps to
  // isLoading / installVerificationChecked / rootNavigationState never
  // resolving (often downstream of a Convex sync crash). Log the stuck flags
  // to the diagnostics export every 3s, and after 15s release isLoading /
  // install-check so the UI can proceed to the normal auth-determination path
  // instead of spinning forever.
  const firstGateBlocked =
    !rootNavigationState?.key || isLoading || !installVerificationChecked;
  useEffect(() => {
    if (!firstGateBlocked || bootGateTimedOut) return;
    const started = Date.now();
    const tick = setInterval(() => {
      callDebug.push(
        'BOOT',
        `gate stuck ${Math.round((Date.now() - started) / 1000)}s: nav=${!!rootNavigationState?.key} authLoading=${isLoading} installChecked=${installVerificationChecked} meLoading=${meLoading} syncing=${syncingUser} auth=${isAuthenticated}`,
      );
    }, 3000);
    const release = setTimeout(() => {
      callDebug.push('ERR', 'BOOT gate hard-timeout (15s) → releasing first gate');
      setBootGateTimedOut(true);
    }, 15000);
    return () => {
      clearInterval(tick);
      clearTimeout(release);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstGateBlocked, bootGateTimedOut]);

  // First gate: wait for nav + auth + install check — but never past the 15s
  // hard timeout above. Note: we still require rootNavigationState before
  // rendering <Tabs/>; if only nav is missing the timeout simply lets the
  // subsequent checks run (they will redirect appropriately).
  if (firstGateBlocked && !bootGateTimedOut) {
    return <AuthGateLoading label="Opening Smilers…" />;
  }

  if (!isAuthenticated) {
    return <Redirect href="/" />;
  }

  if (!hasVerifiedInstall) {
    return <Redirect href="/phone-verify" />;
  }

  // iter-362 (WhatsApp-style): the "Couldn't verify your session" wall is GONE.
  // A terminally-unrefreshable token no longer dumps the user to a sign-in wall
  // or an empty screen — the background silent-reauth effect above quietly
  // renews the Hercules session while the app stays usable. If the token is
  // truly absent (fresh install / real sign-out), `!isAuthenticated` above
  // already redirected to the one-time sign-in.

  // Last-resort reconnect: only after silent renewal has DEFINITIVELY failed and
  // we still have no user (true 30-day Hercules expiry). One friendly tap re-runs
  // the interactive sign-in — no scary "session couldn't be verified" wording.
  if (reauthFailed && !me) {
    return <ReconnectPrompt onReconnect={signOut} />;
  }

  if ((meLoading || syncingUser) && !meGateTimedOut && !everReady) {
    return <AuthGateLoading label="Opening Smilers…" />;
  }

  // If the me query resolved to null (or hung past the gate) but the user has the
  // local install verification marker, NEVER bounce back to phone-verify — that
  // would race the phone-verify "go to chats" redirect and cause a flicker/shake loop.
  // Just render the tabs; individual screens use useSafeConvexQuery and tolerate null me.
  if (!me && !meGateTimedOut && !hasVerifiedInstall) {
    return <Redirect href="/phone-verify" />;
  }

  if (me && (!me.phone || !me.phoneVerified) && !hasVerifiedInstall) {
    return <Redirect href="/phone-verify" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopWidth: 1,
          borderTopColor: Colors.border,
          // iter-182: respect the OS navigation bar (gesture pill /
          // 3-button nav). On phones with on-screen nav bars the fixed
          // 68px bar was sitting BEHIND the system bar, covering the
          // tab labels. Grow the bar by the bottom inset instead.
          height: 58 + Math.max(insets.bottom, 10),
          paddingTop: 6,
          paddingBottom: Math.max(insets.bottom, 10),
        },
        tabBarLabelStyle: {
          fontSize: FontSize.xs,
          fontWeight: FontWeight.medium,
        },
      }}
    >
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color, size }) => <Feather name="message-square" size={size} color={color} />,
          tabBarButtonTestID: 'tab-chats',
          tabBarBadge: chatsUnread > 0 ? (chatsUnread > 99 ? '99+' : chatsUnread) : undefined,
          tabBarBadgeStyle: {
            backgroundColor: Colors.tickRed,
            color: Colors.white,
            fontSize: 10,
            fontWeight: '700',
          },
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Contacts',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-circle-outline" size={size} color={color} />,
          tabBarButtonTestID: 'tab-contacts',
        }}
      />
      <Tabs.Screen
        name="ads"
        options={{
          title: 'Ads',
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="bullhorn-outline" size={size} color={color} />,
          tabBarButtonTestID: 'tab-ads',
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          title: 'Groups',
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" size={size} color={color} />,
          tabBarButtonTestID: 'tab-groups',
          tabBarBadge: groupsUnread > 0 ? (groupsUnread > 99 ? '99+' : groupsUnread) : undefined,
          tabBarBadgeStyle: {
            backgroundColor: Colors.tickRed,
            color: Colors.white,
            fontSize: 10,
            fontWeight: '700',
          },
        }}
      />
      <Tabs.Screen
        name="updates"
        options={{
          title: 'Status',
          tabBarIcon: ({ color, size }) => <Feather name="disc" size={size} color={color} />,
          tabBarButtonTestID: 'tab-status',
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Feather name="user" size={size} color={color} />,
          tabBarButtonTestID: 'tab-profile',
        }}
      />
    </Tabs>
  );
}

function AuthGateLoading({ label }) {
  return (
    <View style={styles.loadingWrap} testID="tabs-auth-loading-screen">
      <ActivityIndicator color={Colors.primary} size="large" />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  );
}

// Friendly one-tap reconnect — shown ONLY when the Hercules session truly
// expired (silent renewal exhausted). Re-runs the interactive sign-in.
function ReconnectPrompt({ onReconnect }: { onReconnect: () => Promise<void> | void }) {
  const [busy, setBusy] = React.useState(false);
  const handle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onReconnect();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.loadingWrap} testID="tabs-reconnect-screen">
      <Text style={styles.recoveryTitle}>Reconnect to Smilers</Text>
      <Text style={styles.recoveryBody}>
        You&apos;ve been away for a while. Tap below to pick up right where you left off.
      </Text>
      <TouchableOpacity
        style={[styles.recoveryBtn, busy && styles.recoveryBtnDisabled]}
        onPress={handle}
        disabled={busy}
        testID="tabs-reconnect-btn"
      >
        {busy ? (
          <ActivityIndicator color={Colors.white} />
        ) : (
          <Text style={styles.recoveryBtnText}>Reconnect</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: Colors.background,
  },
  loadingText: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },
  recoveryTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  recoveryBody: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 40,
    lineHeight: 22,
  },
  recoveryBtn: {
    marginTop: 8,
    backgroundColor: Colors.primary,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    minWidth: 200,
    alignItems: 'center',
  },
  recoveryBtnDisabled: { opacity: 0.6 },
  recoveryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.white },
});
