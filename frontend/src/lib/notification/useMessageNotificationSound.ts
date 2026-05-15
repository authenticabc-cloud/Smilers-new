import { useEffect, useRef } from 'react';
import { Platform, AppState } from 'react-native';
import { Audio } from 'expo-av';
import { useQuery } from 'convex/react';
import { usePathname } from 'expo-router';
import { api } from '../../convexApi';
import { useAuth } from '../../providers/AuthProvider';

/**
 * useMessageNotificationSound
 *
 * Plays the bundled "beep + Smilers" notification sound whenever a new message
 * arrives via Convex realtime, while the app is in the foreground.
 *
 * - Skips the conversation the user is currently viewing
 * - Skips the very first snapshot (so we don't play on app start)
 * - Skips when the app is backgrounded (OS push notification handles that case)
 * - No-op on web
 */
export function useMessageNotificationSound() {
  const { isAuthenticated } = useAuth();
  const pathname = usePathname();
  // Only subscribe once authenticated
  const conversations = useQuery(
    api.conversations.listConversations,
    isAuthenticated ? {} : ('skip' as any)
  );

  const lastSeenMapRef = useRef<Map<string, number>>(new Map());
  const initializedRef = useRef(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const playingRef = useRef(false);

  // Preload the sound once
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: false,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        }).catch(() => {});
        const { sound } = await Audio.Sound.createAsync(
          require('../../../assets/sounds/message_notification.mp3'),
          { volume: 1.0 }
        );
        if (cancelled) {
          await sound.unloadAsync().catch(() => {});
          return;
        }
        soundRef.current = sound;
      } catch (e: any) {
        console.warn('[msg-sound] preload failed:', e?.message);
      }
    })();
    return () => {
      cancelled = true;
      const s = soundRef.current;
      soundRef.current = null;
      if (s) void s.unloadAsync().catch(() => {});
    };
  }, []);

  const playSound = async () => {
    if (Platform.OS === 'web') return;
    if (playingRef.current) return;
    const s = soundRef.current;
    if (!s) return;
    try {
      playingRef.current = true;
      await s.setPositionAsync(0).catch(() => {});
      await s.playAsync().catch(() => {});
      // Reset after the clip length (~2.3s) so rapid arrivals re-trigger
      setTimeout(() => {
        playingRef.current = false;
      }, 2500);
    } catch {
      playingRef.current = false;
    }
  };

  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!Array.isArray(conversations)) return;

    const map = lastSeenMapRef.current;

    // First snapshot — just record the baseline, don't play
    if (!initializedRef.current) {
      for (const c of conversations as any[]) {
        const t = c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : 0;
        map.set(c._id, t);
      }
      initializedRef.current = true;
      return;
    }

    // Don't play if app is backgrounded — OS push handles that
    if (AppState.currentState !== 'active') {
      for (const c of conversations as any[]) {
        const t = c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : 0;
        map.set(c._id, t);
      }
      return;
    }

    let shouldPlay = false;
    for (const c of conversations as any[]) {
      const t = c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : 0;
      const prev = map.get(c._id) ?? 0;
      if (t > prev) {
        // Don't play for the conversation user is currently in
        const inThisChat = pathname?.includes(`/chat/${c._id}`);
        // Don't play if the latest message is from the current user
        const lastFromMe = c.lastMessageFromMe === true;
        if (!inThisChat && !lastFromMe) {
          shouldPlay = true;
        }
        map.set(c._id, t);
      }
    }
    if (shouldPlay) void playSound();
  }, [conversations, pathname]);
}
