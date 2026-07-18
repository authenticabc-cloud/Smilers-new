/**
 * useStudyAi — Smilers Study AI (Phase 1) client bindings.
 *
 * All AI runs on Convex (web team's contract). Premium-gated: the `ask`
 * action throws a ConvexError with `data.code === 'PREMIUM_REQUIRED'` for
 * non-premium users. Photos upload to Convex File Storage first (canonical
 * `messages.generateUploadUrl` via uploadFile), then their storageIds are
 * passed to `ask`. The reply is rendered by subscribing to `getSession`.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useAction, useConvex, useMutation } from 'convex/react';
import { createAudioPlayer } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { api } from '../../convexApi';
import { useSafeConvexQuery } from '../../hooks/useSafeConvexQuery';
import { useAuth } from '../../providers/AuthProvider';
import { uploadFile } from '../uploadFile';

export type StudyMode =
  | 'hint'
  | 'guided'
  | 'explain'
  | 'check_work'
  | 'verify'
  | 'similar_practice';

export interface AskArgs {
  sessionId?: string | null;
  text?: string;
  imageStorageIds?: string[];
  mode?: StudyMode;
  educationLevel?: string;
  language?: string; // NAME, e.g. "English"
  subject?: string;
}

export function isPremiumRequiredError(err: any): boolean {
  const code = err?.data?.code || err?.data?.data?.code;
  return code === 'PREMIUM_REQUIRED' || /premium/i.test(String(err?.message || err?.data || ''));
}

/** List + management of study sessions. */
export function useStudySessions() {
  const { isAuthenticated } = useAuth();
  const { data: sessions } = useSafeConvexQuery<any[]>(
    (api as any).study?.sessions?.listSessions,
    {},
    [],
    isAuthenticated,
  );
  const createSession = useMutation((api as any).study.sessions.createSession);
  const setSessionSaved = useMutation((api as any).study.sessions.setSessionSaved);
  const renameSession = useMutation((api as any).study.sessions.renameSession);
  const deleteSession = useMutation((api as any).study.sessions.deleteSession);

  return {
    sessions: sessions || [],
    createSession,
    setSessionSaved,
    renameSession,
    deleteSession,
  };
}

/** Live view of a single session (messages/replies). */
export function useStudySession(sessionId: string | null) {
  const session = useSafeConvexQuery<any>(
    (api as any).study?.sessions?.getSession,
    sessionId ? { sessionId } : undefined,
    null,
    !!sessionId,
  );
  return { session: session.data, loading: session.loading };
}

/** The Study AI ask flow (upload images → call the gated action). */
export function useStudyAsk() {
  const convex = useConvex();
  const askAction = useAction((api as any).study.ai.ask);
  const [asking, setAsking] = useState(false);
  const [uploading, setUploading] = useState(false);

  const uploadImages = useCallback(
    async (assets: { uri: string; mime?: string }[]): Promise<string[]> => {
      if (!assets.length) return [];
      setUploading(true);
      try {
        const ids: string[] = [];
        for (const a of assets.slice(0, 5)) {
          const id = await uploadFile(convex as any, a.uri, a.mime || 'image/jpeg');
          ids.push(id);
        }
        return ids;
      } finally {
        setUploading(false);
      }
    },
    [convex],
  );

  const ask = useCallback(
    async (args: AskArgs): Promise<any> => {
      setAsking(true);
      try {
        return await askAction({
          sessionId: args.sessionId ?? undefined,
          text: args.text,
          imageStorageIds: args.imageStorageIds,
          mode: args.mode,
          educationLevel: args.educationLevel,
          language: args.language,
          subject: args.subject,
        } as any);
      } finally {
        setAsking(false);
      }
    },
    [askAction],
  );

  return useMemo(
    () => ({ ask, uploadImages, asking, uploading }),
    [ask, uploadImages, asking, uploading],
  );
}

/** Text-to-speech for Language Coach "read aloud" (Convex languageAi.speak).
 *  Returns { audioBase64, mimeType }, played locally — nothing is stored. */
export function useStudySpeak() {
  const speakAction = useAction((api as any).study.languageAi.speak);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const playerRef = useRef<any>(null);

  const stop = useCallback(() => {
    try {
      playerRef.current?.remove?.();
    } catch {}
    playerRef.current = null;
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    async (id: string, text: string, language?: string) => {
      const body = (text || '').trim();
      if (!body) return;
      stop();
      setSpeakingId(id);
      try {
        const res: any = await speakAction({ text: body.slice(0, 3000), language } as any);
        const audioBase64 = res?.audioBase64;
        const mime = res?.mimeType || 'audio/mpeg';
        if (!audioBase64 || Platform.OS === 'web') {
          setSpeakingId(null);
          return;
        }
        const ext = mime.includes('wav') ? 'wav' : 'mp3';
        const path = `${FileSystem.cacheDirectory}study_tts_${Date.now()}.${ext}`;
        await FileSystem.writeAsStringAsync(path, audioBase64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const p = createAudioPlayer({ uri: path });
        playerRef.current = p;
        p.addListener('playbackStatusUpdate', (st: any) => {
          if (st?.didJustFinish) stop();
        });
        p.play();
      } catch {
        setSpeakingId(null);
      }
    },
    [speakAction, stop],
  );

  return { speak, stop, speakingId };
}
