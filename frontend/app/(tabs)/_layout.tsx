import React, { useEffect } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { useAuth } from '../../src/providers/AuthProvider';
import { api } from '../../src/convexApi';
import { usePushNotifications } from '../../src/push/usePushNotifications';
import { useIncomingCallListener } from '../../src/push/useIncomingCallListener';
import { Colors, FontSize, FontWeight } from '../../src/theme';

export default function TabsLayout() {
  const router = useRouter();
  const { isLoading, isAuthenticated } = useAuth();
  const updateCurrentUser = useMutation(api.users.updateCurrentUser);

  // Wire up native push notifications (registers token + handles taps/actions)
  usePushNotifications();
  // Wire up real-time foreground incoming-call detector
  useIncomingCallListener();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/');
    }
  }, [isLoading, isAuthenticated, router]);

  // Sync user with Convex backend on login (creates or updates user record)
  useEffect(() => {
    if (isAuthenticated) {
      updateCurrentUser({}).catch((e: any) => console.warn('updateCurrentUser failed:', e?.message));
    }
  }, [isAuthenticated, updateCurrentUser]);

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
          tabBarTestID: 'tab-chats',
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Contacts',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-circle-outline" size={size} color={color} />,
          tabBarTestID: 'tab-contacts',
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          title: 'Groups',
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" size={size} color={color} />,
          tabBarTestID: 'tab-groups',
        }}
      />
      <Tabs.Screen
        name="status"
        options={{
          title: 'Status',
          tabBarIcon: ({ color, size }) => <Feather name="disc" size={size} color={color} />,
          tabBarTestID: 'tab-status',
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Feather name="user" size={size} color={color} />,
          tabBarTestID: 'tab-profile',
        }}
      />
    </Tabs>
  );
}
