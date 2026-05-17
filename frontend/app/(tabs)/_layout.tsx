import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { Redirect, Tabs, useRootNavigationState } from 'expo-router';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { useAuth } from '../../src/providers/AuthProvider';
import { api } from '../../src/convexApi';
import { PHONE_VERIFIED_INSTALL_KEY, readStoredString } from '../../src/lib/settingsStorage';
import { usePushNotifications } from '../../src/push/usePushNotifications';
import { useIncomingCallListener } from '../../src/push/useIncomingCallListener';
import { Colors, FontSize, FontWeight } from '../../src/theme';

export default function TabsLayout() {
  const rootNavigationState = useRootNavigationState();
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

  // Wire up native push notifications (registers token + handles taps/actions)
  usePushNotifications();
  // Wire up real-time foreground incoming-call detector
  useIncomingCallListener();

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

  if (!rootNavigationState?.key || isLoading || !installVerificationChecked) {
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
          height: 68,
          paddingTop: 6,
          paddingBottom: 10,
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
