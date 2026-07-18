/**
 * useStudyAi — Smilers Study AI (Phase 1) client bindings.
 *
 * All AI runs on Convex (web team's contract). Premium-gated: the `ask`
 * action throws a ConvexError with `data.code === 'PREMIUM_REQUIRED'` for
 * non-premium users. Photos upload to Convex File Storage first (canonical
 * `messages.generateUploadUrl` via uploadFile), then their storageIds are
 * passed to `ask`. The reply is rendered by subscribing to `getSession`.
 */
import { useCallback, useMemo, useState } from 'react';
import { useAction, useConvex, useMutation } from 'convex/react';
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
