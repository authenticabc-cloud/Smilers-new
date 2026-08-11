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
// Lazily/​safely resolved: `expo-speech-recognition` calls
// requireNativeModule("ExpoSpeechRecognition") at its OWN module scope, which
// throws synchronously on any build where that native module isn't linked
// (e.g. iOS). A static top-level import runs at bundle-load and — because this
// hook is pulled in by boot-loaded chat components — fatally crashed the iOS
// JS thread on the splash screen. Wrapping the require in try/catch degrades
// voice typing to a safe no-op instead of taking the whole app down.
let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: any = (_event: string, _cb: any) => {};
let RecognizerIntentEnableLanguageSwitch: any = undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _sr = require('expo-speech-recognition');
  ExpoSpeechRecognitionModule = _sr.ExpoSpeechRecognitionModule ?? null;
  if (typeof _sr.useSpeechRecognitionEvent === 'function') {
    useSpeechRecognitionEvent = _sr.useSpeechRecognitionEvent;
  }
  RecognizerIntentEnableLanguageSwitch = _sr.RecognizerIntentEnableLanguageSwitch;
} catch {
  // Native module unavailable on this platform/build — feature no-ops.
}

interface Args {
  listening: boolean;
  languageCode: string;
  onFinalText: (text: string) => void;
  onSilence: () => void;
  silenceMs?: number;
  /** Android-only: detect & switch the spoken language automatically. */
  autoDetect?: boolean;
  /** Constrain auto-detect/switch to these BCP-47 codes. */
  allowedLanguages?: string[];
  /** Fired (Android) with the detected BCP-47 code while auto-detecting. */
  onDetectLanguage?: (code: string) => void;
  /** iOS: bias recognition toward these words (learned corrections/names). */
  contextualStrings?: string[];
}

export function useVoiceTyping({
  listening,
  languageCode,
  onFinalText,
  onSilence,
  silenceMs = 5000,
  autoDetect = false,
  allowedLanguages,
  onDetectLanguage,
  contextualStrings,
}: Args) {
  const [partial, setPartial] = useState('');
  const runningRef = useRef(false);
  const wantRef = useRef(false);
  const langRef = useRef(languageCode);
  const finalRef = useRef(onFinalText);
  const silenceCbRef = useRef(onSilence);
  const detectCbRef = useRef(onDetectLanguage);
  const autoRef = useRef(autoDetect);
  const allowedRef = useRef(allowedLanguages);
  const contextualRef = useRef(contextualStrings);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedSilenceRef = useRef(false);

  langRef.current = languageCode;
  finalRef.current = onFinalText;
  silenceCbRef.current = onSilence;
  detectCbRef.current = onDetectLanguage;
  autoRef.current = autoDetect;
  allowedRef.current = allowedLanguages;
  contextualRef.current = contextualStrings;

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
      const useAuto = autoRef.current && Platform.OS === 'android';
      const allowed = allowedRef.current && allowedRef.current.length > 0 ? allowedRef.current : undefined;
      ExpoSpeechRecognitionModule.start({
        lang: langRef.current,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: false,
        // Bias recognition toward learned corrections / names (iOS).
        ...(contextualRef.current && contextualRef.current.length
          ? { contextualStrings: contextualRef.current.slice(0, 100) }
          : {}),
        // Noise handling + Bluetooth/AirPods routing (iOS): playAndRecord with
        // the voiceChat mode enables Apple's voice-processing IO (echo + noise
        // suppression), and the Bluetooth/AirPlay options let a connected
        // headset's mic drive dictation when the phone is across the room.
        iosCategory: {
          category: 'playAndRecord',
          categoryOptions: ['allowBluetooth', 'allowBluetoothA2DP', 'allowAirPlay', 'defaultToSpeaker'],
          mode: 'voiceChat',
        },
        ...(useAuto
          ? {
              androidIntentOptions: {
                EXTRA_ENABLE_LANGUAGE_DETECTION: true,
                EXTRA_ENABLE_LANGUAGE_SWITCH: RecognizerIntentEnableLanguageSwitch.LANGUAGE_SWITCH_BALANCED,
                ...(allowed
                  ? {
                      EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES: allowed,
                      EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES: allowed,
                    }
                  : {}),
              },
            }
          : {}),
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

  // Android auto-detect: surface the language the recognizer switched to.
  useSpeechRecognitionEvent('languagedetection', (event: any) => {
    if (!wantRef.current || !autoRef.current) return;
    const code = String(event?.detectedLanguage || '').trim();
    if (code) {
      try {
        detectCbRef.current?.(code);
      } catch {
        /* ignore */
      }
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
