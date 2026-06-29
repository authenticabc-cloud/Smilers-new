import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { Redirect, Tabs, useRootNavigationState } from 'expo-router';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { useAuth } from '../../src/providers/AuthProvider';
import { api } from '../../src/convexApi';
import { PHONE_VERIFIED_INSTALL_KEY, readStoredString } from '../../src/lib/settingsStorage';
import { callDebug } from '../../src/lib/callDebugLog';
import { Colors, FontSize, FontWeight } from '../../src/theme';

export default function TabsLayout() {
  const rootNavigationState = useRootNavigationState();
  // iter-182: bottom inset for the OS navigation bar (small phones).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useSafeAreaInsets } = require('react-native-safe-area-context');
  const insets = useSafeAreaInsets();
  const { isLoading, isAuthenticated } = useAuth();
  const updateCurrentUser = useMutation(api.users.updateCurrentUser);
  // Reactive subscription: changes from verifyOtp/savePhoneVerified propagate instantly.
  const meQuery = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const me: any = meQuery ?? null;
  const meLoading = isAuthenticated && meQuery === undefined;
  const [installVerificationChecked, setInstallVerificationChecked] = useState(false);
  const [hasVerifiedInstall, setHasVerifiedInstall] = useState(false);
  const [syncingUser, setSyncingUser] = useState(false);
  const [bootstrapAttempted, setBootstrapAttempted] = useState(false);
  const [meGateTimedOut, setMeGateTimedOut] = useState(false);
  const [bootGateTimedOut, setBootGateTimedOut] = useState(false);

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

      const installMarker = await readStoredString(PHONE_VERIFIED_INSTALL_KEY);
      if (!cancelled) {
        setHasVerifiedInstall(installMarker === 'true');
        setInstallVerificationChecked(true);
        if (installMarker !== 'true') {
          setBootstrapAttempted(true);
        }
      }
    };

    setInstallVerificationChecked(false);
    void loadInstallVerification();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Safety timeout: if Convex me query hangs after auth/phone-verify, don't lock the user on "Opening Smilers" forever.
  useEffect(() => {
    if (!isAuthenticated || !hasVerifiedInstall) {
      setMeGateTimedOut(false);
      return;
    }
    if (me || meGateTimedOut) {
      return;
    }
    const timeoutId = setTimeout(() => {
      console.warn('tabs layout: me query gate timed out after 10s, releasing UI');
      setMeGateTimedOut(true);
    }, 10000);
    return () => clearTimeout(timeoutId);
  }, [hasVerifiedInstall, isAuthenticated, me, meGateTimedOut]);

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

  if ((meLoading || syncingUser) && !meGateTimedOut) {
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
});
