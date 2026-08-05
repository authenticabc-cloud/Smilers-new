/**
 * useTranslatedPlayback — LISTENING side of the interpreter.
 *
 * Subscribes to reactive `getSubtitles` and, for each NEW line spoken by
 * SOMEONE ELSE, synthesizes the translation in MY listening language via
 * `speakTranslation` (managed AI gateway) and plays it LOCALLY on this
 * device. While the translated voice plays we duck/mute the original
 * remote audio (`onDuck`) per the selected mode. Lines are played
 * strictly in order so translations never overlap.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useAction } from 'convex/react';
import { createAudioPlayer, type AudioPlayer, type AudioSource } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { api } from '../../convexApi';
import { useSafeConvexSubscription } from '../../hooks/useSafeConvexQuery';
import {
  modeDucksFully,
  modePlaysVoice,
  ttsInstructionsFor,
  ttsVoiceFor,
  type VoiceGender,
  type VoiceMode,
  type VoiceStyle,
  type TransSpeed,
} from './languages';

export interface SubtitleLine {
  _id: string;
  speakerId: string;
  speakerName: string;
  sourceLanguage: string;
  originalText: string;
  translations: Record<string, string>;
  createdAt: number;
  isMe?: boolean;
}

interface Args {
  callId: string | null;
  listeningLanguage: string;
  voiceMode: VoiceMode;
  playbackEnabled: boolean;
  prefs: { voiceGender: VoiceGender; voiceStyle: VoiceStyle; speed: TransSpeed };
  onDuck: (ducked: boolean) => void;
}

export function useCallSubtitles(callId: string | null): SubtitleLine[] {
  // iter-463: safe subscription (was raw useQuery) so a backend Server Error
  // in getSubtitles can't throw into render and end the call.
  const { data: rows } = useSafeConvexSubscription<SubtitleLine[]>(
    api.callInterpreter.getSubtitles,
    callId ? { callId } : {},
    [],
    !!callId,
  );
  return rows || [];
}

export function useTranslatedPlayback({
  callId,
  listeningLanguage,
  voiceMode,
  playbackEnabled,
  prefs,
  onDuck,
}: Args) {
  const speak = useAction(api.callInterpreterAction.speakTranslation);
  const subtitles = useCallSubtitles(callId);

  const queueRef = useRef<SubtitleLine[]>([]);
  const processingRef = useRef(false);
  const seenRef = useRef<Set<string>>(new Set());
  const initialisedRef = useRef(false);
  const playerRef = useRef<AudioPlayer | null>(null);
  const onDuckRef = useRef(onDuck);
  const prefsRef = useRef(prefs);
  const langRef = useRef(listeningLanguage);
  onDuckRef.current = onDuck;
  prefsRef.current = prefs;
  langRef.current = listeningLanguage;

  const playOne = useCallback(
    async (line: SubtitleLine) => {
      const text = (line.translations?.[langRef.current] || '').trim();
      if (!text) return;
      let audioBase64 = '';
      let mime = 'audio/mpeg';
      try {
        const res = (await speak({
          text: text.slice(0, 4000),
          voice: ttsVoiceFor(prefsRef.current.voiceGender, prefsRef.current.voiceStyle),
          instructions: ttsInstructionsFor(prefsRef.current.voiceStyle, prefsRef.current.speed),
        } as any)) as { audioBase64?: string; mimeType?: string };
        audioBase64 = res?.audioBase64 || '';
        mime = res?.mimeType || 'audio/mpeg';
      } catch {
        return; // gateway failure — skip this line silently
      }
      if (!audioBase64 || Platform.OS === 'web') return;

      const ext = mime.includes('wav') ? 'wav' : 'mp3';
      const path = `${FileSystem.cacheDirectory}interp_${line._id}.${ext}`;
      try {
        await FileSystem.writeAsStringAsync(path, audioBase64, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } catch {
        return;
      }

      // Duck original remote audio while the translation speaks.
      const duckFully = modeDucksFully(voiceMode);
      onDuckRef.current(duckFully);
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try {
            playerRef.current?.remove();
          } catch {}
          playerRef.current = null;
          onDuckRef.current(false);
          resolve();
        };
        try {
          const p = createAudioPlayer({ uri: path } as AudioSource);
          playerRef.current = p;
          // Learning mode: play translation a touch louder than the ducked-down original.
          try {
            p.volume = 1.0;
          } catch {}
          p.addListener('playbackStatusUpdate', (st: any) => {
            if (st?.didJustFinish) finish();
          });
          p.play();
          // Safety timeout so a stuck player never blocks the queue forever.
          setTimeout(finish, 20000);
        } catch {
          finish();
        }
      });
      FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
    },
    [speak, voiceMode],
  );

  const drain = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        await playOne(next);
      }
    } finally {
      processingRef.current = false;
    }
  }, [playOne]);

  useEffect(() => {
    if (!playbackEnabled || !modePlaysVoice(voiceMode)) return;
    // On first pass mark everything already-present as seen so we don't
    // replay history — only speak lines that arrive from now on.
    if (!initialisedRef.current) {
      subtitles.forEach((l) => seenRef.current.add(l._id));
      initialisedRef.current = true;
      return;
    }
    const fresh = subtitles.filter((l) => !seenRef.current.has(l._id) && !l.isMe);
    if (fresh.length === 0) return;
    fresh.forEach((l) => seenRef.current.add(l._id));
    // Oldest-first so conversation order is preserved.
    fresh
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((l) => queueRef.current.push(l));
    drain();
  }, [subtitles, playbackEnabled, voiceMode, drain]);

  // Reset when playback turns off or the call changes.
  useEffect(() => {
    if (!playbackEnabled) {
      queueRef.current = [];
      initialisedRef.current = false;
      seenRef.current.clear();
      try {
        playerRef.current?.remove();
      } catch {}
      playerRef.current = null;
      onDuckRef.current(false);
    }
  }, [playbackEnabled, callId]);

  useEffect(
    () => () => {
      try {
        playerRef.current?.remove();
      } catch {}
      playerRef.current = null;
    },
    [],
  );
}
