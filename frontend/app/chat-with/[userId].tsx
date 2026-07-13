/**
 * Deep-link entry `smilers://chat-with/<USER_CONVEX_ID>` → redirects to the
 * personal chat link resolver `/u/<id>` which handles preview + open-chat.
 */
import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function ChatWithRedirect() {
  const { userId } = useLocalSearchParams<{ userId?: string }>();
  if (!userId || typeof userId !== 'string') {
    return <Redirect href="/(tabs)/chats" />;
  }
  return <Redirect href={`/u/${userId}`} />;
}
