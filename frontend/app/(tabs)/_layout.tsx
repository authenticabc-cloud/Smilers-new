import React, { useEffect } from 'react';
import { Redirect, Tabs, useRootNavigationState } from 'expo-router';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { useAuth } from '../../src/providers/AuthProvider';
import { api } from '../../src/convexApi';
import { usePushNotifications } from '../../src/push/usePushNotifications';
import { useIncomingCallListener } from '../../src/push/useIncomingCallListener';
import { Colors, FontSize, FontWeight } from '../../src/theme';

export default function TabsLayout() {
  const rootNavigationState = useRootNavigationState();
  const { isLoading, isAuthenticated } = useAuth();
  const updateCurrentUser = useMutation(api.users.updateCurrentUser);
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');

  // Wire up native push notifications (registers token + handles taps/actions)
  usePushNotifications();
  // Wire up real-time foreground incoming-call detector
  useIncomingCallListener();

  // Sync user with Convex backend on login (creates or updates user record)
  useEffect(() => {
    if (isAuthenticated) {
      updateCurrentUser({}).catch((e: any) => console.warn('updateCurrentUser failed:', e?.message));
    }
  }, [isAuthenticated, updateCurrentUser]);

  if (!rootNavigationState?.key || isLoading) {
    return null;
  }

  if (!isAuthenticated) {
    return <Redirect href="/" />;
  }

  if (me && (!me.phone || !me.phoneVerified)) {
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
