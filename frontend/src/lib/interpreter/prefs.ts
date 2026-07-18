/**
 * Interpreter local preferences — persisted on-device (AsyncStorage).
 *
 * These are settings the Convex `setForCall` contract does NOT carry
 * (voice gender/style, translation speed, and the user's DEFAULT
 * speaking/listening language + mode used to seed a fresh call).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import type { LangName, TransSpeed, VoiceGender, VoiceMode, VoiceStyle } from './languages';

const STORAGE_KEY = 'smilers_interpreter_prefs_v1';

export interface InterpreterPrefs {
  defaultSpeaking: LangName;
  defaultListening: LangName;
  defaultMode: VoiceMode;
  voiceGender: VoiceGender;
  voiceStyle: VoiceStyle;
  speed: TransSpeed;
  autoEnable: boolean; // auto-turn interpreter on when a call connects
}

export const DEFAULT_PREFS: InterpreterPrefs = {
  defaultSpeaking: 'English',
  defaultListening: 'English',
  defaultMode: 'voice',
  voiceGender: 'female',
  voiceStyle: 'natural',
  speed: 'balanced',
  autoEnable: false,
};

let cached: InterpreterPrefs | null = null;

export async function loadPrefs(): Promise<InterpreterPrefs> {
  if (cached) return cached;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cached = raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch {
    cached = { ...DEFAULT_PREFS };
  }
  return cached;
}

export async function savePrefs(next: InterpreterPrefs): Promise<void> {
  cached = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best effort */
  }
}

/** React hook wrapper around the persisted prefs. */
export function useInterpreterPrefs() {
  const [prefs, setPrefs] = useState<InterpreterPrefs>(cached || DEFAULT_PREFS);
  const [ready, setReady] = useState(!!cached);

  useEffect(() => {
    let alive = true;
    loadPrefs().then((p) => {
      if (alive) {
        setPrefs(p);
        setReady(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback((patch: Partial<InterpreterPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  return { prefs, update, ready };
}
