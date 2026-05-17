import { useEffect, useRef } from 'react';
import { Platform, AppState } from 'react-native';
import { Audio } from 'expo-av';
import { useQuery } from 'convex/react';
import { usePathname } from 'expo-router';
import { api } from '../../convexApi';
import { readStoredJson } from '../settingsStorage';
import { getRingSource, type RingId } from '../ringtone/ringCatalog';
import { useAuth } from '../../providers/AuthProvider';

/**
 * useMessageNotificationSound
 *
 * Plays the bundled two-part message notification sound whenever a new message
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
  const playingRef = useRef(false);

  const playClip = async (source: number) => {
    const { sound } = await Audio.Sound.createAsync(source as any, { volume: 1.0 });
    try {
      await new Promise<void>((resolve, reject) => {
        sound.setOnPlaybackStatusUpdate((status) => {
          if (!status.isLoaded) {
            reject(new Error('unloaded sound'));
            return;
          }
          if (status.didJustFinish) {
            resolve();
          }
        });
        sound.playAsync().catch(reject);
      });
    } finally {
      await sound.unloadAsync().catch(() => {});
    }
  };

  const playSound = async () => {
    if (Platform.OS === 'web') return;
    if (playingRef.current) return;
    try {
      playingRef.current = true;
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      }).catch(() => {});
      const stored = (await readStoredJson('smilers_ringtone_prefs', null)) as { notificationSound?: RingId } | null;
      const followup = getRingSource(stored?.notificationSound || 'smilers_notification');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      await playClip(require('../../../assets/sounds/message_notification_beep.mp3'));
      if (followup) {
        await playClip(followup);
      }
    } catch (errorValue: any) {
      console.warn('[msg-sound] play failed:', errorValue?.message);
    } finally {
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
