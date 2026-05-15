import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Redirect, Tabs, useRootNavigationState } from 'expo-router';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { useAuth } from '../../src/providers/AuthProvider';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { PHONE_VERIFIED_INSTALL_KEY, readStoredString } from '../../src/lib/settingsStorage';
import { usePushNotifications } from '../../src/push/usePushNotifications';
import { useIncomingCallListener } from '../../src/push/useIncomingCallListener';
import { Colors, FontSize, FontWeight } from '../../src/theme';

export default function TabsLayout() {
  const rootNavigationState = useRootNavigationState();
  const { isLoading, isAuthenticated } = useAuth();
  const updateCurrentUser = useMutation(api.users.updateCurrentUser);
  const { data: me, loading: meLoading, refetch: refetchMe } = useSafeConvexQuery(api.users.getCurrentUser, {}, null, isAuthenticated);
  const [installVerificationChecked, setInstallVerificationChecked] = useState(false);
  const [hasVerifiedInstall, setHasVerifiedInstall] = useState(false);
  const [syncingUser, setSyncingUser] = useState(false);
  const [bootstrapAttempted, setBootstrapAttempted] = useState(false);

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
    if (!isAuthenticated || !hasVerifiedInstall || meLoading || me || syncingUser || bootstrapAttempted) {
      return;
    }

    let cancelled = false;

    const bootstrapUser = async () => {
      setSyncingUser(true);
      try {
        await updateCurrentUser({});
        await refetchMe();
      } catch (errorValue) {
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
  }, [bootstrapAttempted, hasVerifiedInstall, isAuthenticated, me, meLoading, refetchMe, syncingUser, updateCurrentUser]);

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

  if (!rootNavigationState?.key || isLoading || !installVerificationChecked) {
    return <AuthGateLoading label="Opening Smilers…" />;
  }

  if (!isAuthenticated) {
    return <Redirect href="/" />;
  }

  if (!hasVerifiedInstall) {
    return <Redirect href="/phone-verify" />;
  }

  if (meLoading || syncingUser) {
    return <AuthGateLoading label="Opening Smilers…" />;
  }

  if (!me) {
    return <Redirect href="/phone-verify" />;
  }

  if (!me.phone || !me.phoneVerified) {
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
