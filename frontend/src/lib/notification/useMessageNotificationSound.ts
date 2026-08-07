import { useEffect, useRef } from 'react';
import { Platform, AppState } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioSource } from 'expo-audio';
import { useQuery } from 'convex/react';
import { usePathname } from 'expo-router';
import { api } from '../../convexApi';
import { readStoredJson } from '../settingsStorage';
import { getRingSource, type RingId } from '../ringtone/ringCatalog';
import { getLastCallEndedAt } from '../webrtc/inCallManager';
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

  const playClip = async (source: number | AudioSource) => {
    // expo-audio replaces expo-av's Audio.Sound API. Create a one-shot
    // player, await playback end via `playbackStatusUpdate`, then remove().
    const player = createAudioPlayer(source as AudioSource);
    try {
      try {
        player.volume = 1.0;
      } catch {}
      await new Promise<void>((resolve, reject) => {
        const handle = (player as any).addListener?.('playbackStatusUpdate', (status: any) => {
          if (!status?.isLoaded && status?.isLoaded !== undefined) {
            // didJustFinish lives at status.didJustFinish in expo-audio
          }
          if (status?.didJustFinish || status?.playbackState === 'ended') {
            try { handle?.remove?.(); } catch {}
            resolve();
          }
        });
        try {
          player.play();
        } catch (errorValue: any) {
          try { handle?.remove?.(); } catch {}
          reject(errorValue);
        }
        // Safety net — most ringtones are < 5 s; resolve regardless after 8 s
        // so we don't leak a Promise if the listener API differs.
        setTimeout(() => {
          try { handle?.remove?.(); } catch {}
          resolve();
        }, 8000);
      });
    } finally {
      try {
        player.pause();
      } catch {}
      try {
        player.remove();
      } catch {}
    }
  };

  const playSound = async () => {
    if (Platform.OS === 'web') return;
    if (playingRef.current) return;
    try {
      playingRef.current = true;
      // expo-audio API: playsInSilentMode / allowsRecording / shouldPlayInBackground /
      // interruptionMode / shouldRouteThroughEarpiece — see /call/[id].tsx for the matching call.
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        shouldPlayInBackground: false,
        interruptionMode: 'duckOthers',
        shouldRouteThroughEarpiece: false,
      }).catch(() => {});
      const stored = (await readStoredJson('smilers_ringtone_prefs', null)) as { notificationSound?: RingId } | null;
      const selectedTone = stored?.notificationSound || 'smilers_notification';
      if (selectedTone === 'silent') {
        return;
      }
      const followup = getRingSource(selectedTone);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      await playClip(require('../../../assets/sounds/message_notification_beep.mp3'));
      if (followup) {
        await playClip(followup as AudioSource);
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
    if (shouldPlay) {
      // iter-465: a call just ended → the incoming update is the call-log
      // message. Suppress the notification tone so it doesn't cover the "Ciao"
      // call-ended tone. (Baseline map is already updated above, so we won't
      // play it late either.)
      if (Date.now() - getLastCallEndedAt() < 6000) return;
      void playSound();
    }
  }, [conversations, pathname]);
}
