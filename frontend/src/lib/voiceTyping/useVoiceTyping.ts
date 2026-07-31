/**
 * useVoiceTyping — hands-free dictation for the chat composer.
 *
 * Streams the user's microphone through on-device / platform speech recognition
 * (expo-speech-recognition). Finalized sentences are pushed to `onFinalText`
 * (the caller appends them to the composer); interim text is surfaced via
 * `partial` for live feedback. If the user stops speaking for `silenceMs`
 * (default 5s), `onSilence` fires ONCE so the caller can ask "Send or keep
 * talking?".
 *
 * Native-only: no-op on web / Expo Go without the native module.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

interface Args {
  listening: boolean;
  languageCode: string;
  onFinalText: (text: string) => void;
  onSilence: () => void;
  silenceMs?: number;
}

export function useVoiceTyping({ listening, languageCode, onFinalText, onSilence, silenceMs = 5000 }: Args) {
  const [partial, setPartial] = useState('');
  const runningRef = useRef(false);
  const wantRef = useRef(false);
  const langRef = useRef(languageCode);
  const finalRef = useRef(onFinalText);
  const silenceCbRef = useRef(onSilence);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedSilenceRef = useRef(false);

  langRef.current = languageCode;
  finalRef.current = onFinalText;
  silenceCbRef.current = onSilence;

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const armTimer = useCallback(() => {
    clearTimer();
    firedSilenceRef.current = false;
    timerRef.current = setTimeout(() => {
      if (!wantRef.current || firedSilenceRef.current) return;
      firedSilenceRef.current = true;
      try {
        silenceCbRef.current();
      } catch {
        /* ignore */
      }
    }, silenceMs);
  }, [silenceMs]);

  const start = useCallback(() => {
    if (runningRef.current || Platform.OS === 'web') return;
    try {
      ExpoSpeechRecognitionModule.start({
        lang: langRef.current,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: false,
      } as any);
      runningRef.current = true;
      armTimer();
    } catch {
      runningRef.current = false;
    }
  }, [armTimer]);

  const stop = useCallback(() => {
    clearTimer();
    if (!runningRef.current) return;
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      /* ignore */
    }
    runningRef.current = false;
  }, []);

  useSpeechRecognitionEvent('result', (event: any) => {
    if (!wantRef.current) return;
    const t = String(event?.results?.[0]?.transcript || '').trim();
    if (event?.isFinal) {
      setPartial('');
      if (t) {
        try {
          finalRef.current(t);
        } catch {
          /* ignore */
        }
      }
      armTimer();
    } else {
      setPartial(t);
      armTimer();
    }
  });

  // The continuous recognizer self-stops on some devices — restart while we
  // still want to listen and haven't just hit the silence-confirm gate.
  useSpeechRecognitionEvent('end', () => {
    runningRef.current = false;
    if (wantRef.current && !firedSilenceRef.current) {
      setTimeout(() => {
        if (wantRef.current) start();
      }, 300);
    }
  });
  useSpeechRecognitionEvent('error', () => {
    runningRef.current = false;
    if (wantRef.current && !firedSilenceRef.current) {
      setTimeout(() => {
        if (wantRef.current) start();
      }, 600);
    }
  });

  useEffect(() => {
    let cancelled = false;
    if (listening && Platform.OS !== 'web') {
      wantRef.current = true;
      (async () => {
        try {
          const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
          if (cancelled || !perm?.granted) {
            wantRef.current = false;
            return;
          }
          start();
        } catch {
          wantRef.current = false;
        }
      })();
    } else {
      wantRef.current = false;
      setPartial('');
      stop();
    }
    return () => {
      cancelled = true;
      wantRef.current = false;
      stop();
    };
  }, [listening, start, stop]);

  // Restart with the new locale if the language changes mid-dictation.
  useEffect(() => {
    if (!wantRef.current) return;
    stop();
    const t = setTimeout(() => {
      if (wantRef.current) start();
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languageCode]);

  return { partial };
}

export default useVoiceTyping;
