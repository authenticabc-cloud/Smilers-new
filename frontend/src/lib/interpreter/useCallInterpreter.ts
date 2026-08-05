/**
 * useCallInterpreter — per-call interpreter state backed by Convex.
 *
 * Reads every participant's interpreter row via `getForCall` and exposes
 * MY row plus setters that upsert through `setForCall`. Language values
 * are NAMES. `callId` is the shared Twilio room name (stable across all
 * participants).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../convexApi';
import { useSafeConvexSubscription } from '../../hooks/useSafeConvexQuery';
import type { LangName, VoiceMode } from './languages';
import { useInterpreterPrefs } from './prefs';

export interface InterpreterParticipant {
  userId: string;
  name: string;
  enabled: boolean;
  speakingLanguage: LangName;
  listeningLanguage: LangName;
  voiceMode?: VoiceMode;
  updatedAt?: number;
  isMe?: boolean;
}

export function useCallInterpreter(callId: string | null) {
  const { prefs, update: updatePrefs, ready: prefsReady } = useInterpreterPrefs();

  // iter-463: was `useQuery(getForCall)` — a backend Server Error from that
  // query THREW during render and bubbled to CallErrorBoundary, so the whole
  // call ended with "Call ended unexpectedly" (Android/iOS). The interpreter
  // is an OPTIONAL feature, so use the safe subscription: it catches server
  // errors and keeps `participants` as `undefined` (treated as "loading";
  // auto-enable stays off) instead of crashing the call.
  const { data: participants } = useSafeConvexSubscription<InterpreterParticipant[] | undefined>(
    api.callInterpreter.getForCall,
    callId ? { callId } : {},
    undefined,
    !!callId,
  );

  const setForCall = useMutation(api.callInterpreter.setForCall);

  const me = useMemo(
    () => (participants || []).find((p) => p.isMe) || null,
    [participants],
  );

  // Effective (optimistic) local view until the query round-trips.
  const enabled = me?.enabled ?? false;
  const speakingLanguage = (me?.speakingLanguage as LangName) ?? prefs.defaultSpeaking;
  const listeningLanguage = (me?.listeningLanguage as LangName) ?? prefs.defaultListening;
  const voiceMode = (me?.voiceMode as VoiceMode) ?? prefs.defaultMode;

  const save = useCallback(
    async (patch: {
      enabled?: boolean;
      speakingLanguage?: LangName;
      listeningLanguage?: LangName;
      voiceMode?: VoiceMode;
    }) => {
      if (!callId) return;
      try {
        await setForCall({
          callId,
          enabled: patch.enabled ?? enabled,
          speakingLanguage: patch.speakingLanguage ?? speakingLanguage,
          listeningLanguage: patch.listeningLanguage ?? listeningLanguage,
          voiceMode: patch.voiceMode ?? voiceMode,
        } as any);
      } catch {
        /* transient — the query stays authoritative */
      }
    },
    [callId, setForCall, enabled, speakingLanguage, listeningLanguage, voiceMode],
  );

  // Auto-enable once, when prefs.autoEnable and there's no row yet.
  const autoDoneRef = useRef(false);
  useEffect(() => {
    if (!callId || !prefsReady || autoDoneRef.current) return;
    if (participants === undefined) return; // still loading
    if (prefs.autoEnable && !me) {
      autoDoneRef.current = true;
      save({ enabled: true });
    }
  }, [callId, prefsReady, participants, me, prefs.autoEnable, save]);

  return {
    participants: participants || [],
    me,
    enabled,
    speakingLanguage,
    listeningLanguage,
    voiceMode,
    prefs,
    updatePrefs,
    save,
    loading: participants === undefined,
  };
}
