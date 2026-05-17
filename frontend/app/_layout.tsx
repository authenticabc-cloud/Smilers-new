import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider } from '../src/providers/AuthProvider';
import { ConvexClientProvider } from '../src/providers/ConvexClientProvider';
import { useMessageNotificationSound } from '../src/lib/notification/useMessageNotificationSound';
import { Colors } from '../src/theme';

function GlobalNotificationSound() {
  useMessageNotificationSound();
  return null;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <ConvexClientProvider>
            <GlobalNotificationSound />
            <StatusBar style="light" backgroundColor={Colors.headerBg} />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="phone-verify" />
              <Stack.Screen name="auth-callback" />
              <Stack.Screen name="auth-webview" options={{ presentation: 'modal' }} />
              <Stack.Screen name="chat/[conversationId]" />
              <Stack.Screen name="call/[conversationId]" options={{ presentation: 'modal' }} />
              <Stack.Screen name="groups-create" />
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
            </Stack>
          </ConvexClientProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
