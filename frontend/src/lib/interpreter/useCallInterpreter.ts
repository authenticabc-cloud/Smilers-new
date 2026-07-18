/**
 * useCallInterpreter — per-call interpreter state backed by Convex.
 *
 * Reads every participant's interpreter row via `getForCall` and exposes
 * MY row plus setters that upsert through `setForCall`. Language values
 * are NAMES. `callId` is the shared Twilio room name (stable across all
 * participants).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convexApi';
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

  const participants = useQuery(
    api.callInterpreter.getForCall,
    callId ? ({ callId } as any) : 'skip',
  ) as InterpreterParticipant[] | undefined;

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
