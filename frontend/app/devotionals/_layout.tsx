/**
 * Devotionals stack layout — keeps the 3 screens (Feed / Compose /
 * Preferences) under a shared stack so back-navigation feels native.
 */
import { Stack } from 'expo-router';
import React from 'react';

export default function DevotionalsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="compose" />
      <Stack.Screen name="preferences" />
    </Stack>
  );
}
