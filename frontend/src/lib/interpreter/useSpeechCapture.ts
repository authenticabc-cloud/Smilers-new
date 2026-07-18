/**
 * useSpeechCapture — SPEAKING side of the interpreter.
 *
 * Uses on-device speech recognition (iOS Speech / Android SpeechRecognizer
 * via expo-speech-recognition) to transcribe the user's OWN microphone.
 * Every finalized sentence is handed to `onUtterance`, which the caller
 * forwards to Convex `addUtterance`. Whisper fallback is intentionally
 * NOT used here (on-device is lower-latency + free, per the contract).
 *
 * Native-only: does nothing on web / Expo Go without the native module.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { bcp47 } from './languages';

interface Args {
  active: boolean;
  languageName: string;
  onUtterance: (text: string) => void;
}

export function useSpeechCapture({ active, languageName, onUtterance }: Args) {
  const runningRef = useRef(false);
  const shouldRunRef = useRef(false);
  const langRef = useRef(languageName);
  const utterRef = useRef(onUtterance);
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);

  langRef.current = languageName;
  utterRef.current = onUtterance;

  const startEngine = () => {
    if (runningRef.current) return;
    if (Platform.OS === 'web') return;
    try {
      ExpoSpeechRecognitionModule.start({
        lang: bcp47(langRef.current),
        interimResults: false,
        continuous: true,
        requiresOnDeviceRecognition: true,
        addsPunctuation: true,
        // keep original remote/call audio unaffected — capture mic only
      } as any);
      runningRef.current = true;
    } catch {
      runningRef.current = false;
    }
  };

  const stopEngine = () => {
    shouldRunRef.current = false;
    if (!runningRef.current) return;
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      /* ignore */
    }
    runningRef.current = false;
  };

  // Emit finalized sentences (dedupe rapid duplicates).
  useSpeechRecognitionEvent('result', (event: any) => {
    if (!shouldRunRef.current) return;
    if (!event?.isFinal) return;
    const text = String(event?.results?.[0]?.transcript || '').trim();
    if (!text || text.length < 2) return;
    const now = Date.now();
    const last = lastSentRef.current;
    if (last && last.text === text && now - last.at < 4000) return;
    lastSentRef.current = { text, at: now };
    try {
      utterRef.current(text);
    } catch {
      /* ignore */
    }
  });

  // On engine end, restart if we're still meant to be listening (continuous
  // recognition stops itself after long pauses on some devices).
  useSpeechRecognitionEvent('end', () => {
    runningRef.current = false;
    if (shouldRunRef.current) {
      setTimeout(() => {
        if (shouldRunRef.current) startEngine();
      }, 400);
    }
  });

  useSpeechRecognitionEvent('error', () => {
    runningRef.current = false;
    if (shouldRunRef.current) {
      setTimeout(() => {
        if (shouldRunRef.current) startEngine();
      }, 800);
    }
  });

  useEffect(() => {
    let cancelled = false;
    if (active && Platform.OS !== 'web') {
      (async () => {
        try {
          const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
          if (cancelled || !perm?.granted) return;
          shouldRunRef.current = true;
          startEngine();
        } catch {
          /* mic/speech permission denied — degrade silently */
        }
      })();
    } else {
      stopEngine();
    }
    return () => {
      cancelled = true;
      stopEngine();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Restart with the new locale if the speaking language changes mid-call.
  useEffect(() => {
    if (!shouldRunRef.current) return;
    stopEngine();
    shouldRunRef.current = true;
    const t = setTimeout(startEngine, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languageName]);
}
