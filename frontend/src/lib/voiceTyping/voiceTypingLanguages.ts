/**
 * voiceTypingLanguages — curated list of languages whose on-device / platform
 * speech recognition is accurate & reliable enough for hands-free dictation.
 *
 * We DELIBERATELY expose ONLY these; every other language is unavailable in the
 * voice-typing picker (poor/《unsupported》recognition would frustrate users).
 * Codes are BCP-47 (what expo-speech-recognition's `lang` option expects).
 */
import { NativeModules, Platform } from 'react-native';

export interface VoiceTypingLang {
  code: string; // BCP-47
  label: string;
  flag: string;
}

export const VOICE_TYPING_LANGUAGES: VoiceTypingLang[] = [
  { code: 'en-US', label: 'English (US)', flag: '🇺🇸' },
  { code: 'en-GB', label: 'English (UK)', flag: '🇬🇧' },
  { code: 'es-ES', label: 'Spanish', flag: '🇪🇸' },
  { code: 'fr-FR', label: 'French', flag: '🇫🇷' },
  { code: 'de-DE', label: 'German', flag: '🇩🇪' },
  { code: 'it-IT', label: 'Italian', flag: '🇮🇹' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', flag: '🇧🇷' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)', flag: '🇵🇹' },
  { code: 'nl-NL', label: 'Dutch', flag: '🇳🇱' },
  { code: 'ru-RU', label: 'Russian', flag: '🇷🇺' },
  { code: 'ar-SA', label: 'Arabic', flag: '🇸🇦' },
  { code: 'hi-IN', label: 'Hindi', flag: '🇮🇳' },
  { code: 'zh-CN', label: 'Chinese (Mandarin)', flag: '🇨🇳' },
  { code: 'ja-JP', label: 'Japanese', flag: '🇯🇵' },
  { code: 'ko-KR', label: 'Korean', flag: '🇰🇷' },
  { code: 'tr-TR', label: 'Turkish', flag: '🇹🇷' },
  { code: 'pl-PL', label: 'Polish', flag: '🇵🇱' },
];

export function labelForCode(code: string): string {
  if (code === AUTO_CODE) return 'Auto-detect';
  return VOICE_TYPING_LANGUAGES.find((l) => l.code === code)?.label || code;
}

export function flagForCode(code: string): string {
  if (code === AUTO_CODE) return '🌐';
  return VOICE_TYPING_LANGUAGES.find((l) => l.code === code)?.flag || '🌐';
}

/** Sentinel for automatic (Android) language detection. */
export const AUTO_CODE = 'auto';

/** All curated BCP-47 codes — used to constrain Android auto-detect/switch. */
export const ALL_VOICE_TYPING_CODES = VOICE_TYPING_LANGUAGES.map((l) => l.code);

function deviceLocale(): string {
  try {
    if (Platform.OS === 'ios') {
      const s: any = NativeModules.SettingsManager?.settings;
      return String(s?.AppleLocale || s?.AppleLanguages?.[0] || 'en-US');
    }
    return String(NativeModules.I18nManager?.localeIdentifier || 'en-US');
  } catch {
    return 'en-US';
  }
}

/**
 * Pick the best supported voice-typing code for the current device: an exact
 * locale match first, then any variant of the same base language, else English.
 */
export function defaultVoiceTypingCode(): string {
  const loc = deviceLocale().replace('_', '-');
  const base = loc.split('-')[0].toLowerCase();
  const exact = VOICE_TYPING_LANGUAGES.find((l) => l.code.toLowerCase() === loc.toLowerCase());
  if (exact) return exact.code;
  const byLang = VOICE_TYPING_LANGUAGES.find((l) => l.code.toLowerCase().startsWith(base + '-'));
  return byLang?.code || 'en-US';
}
