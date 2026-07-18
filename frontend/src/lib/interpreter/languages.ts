/**
 * AI Voice Interpreter — language + voice mapping.
 *
 * All values the Convex backend expects are language NAMES ("English",
 * "French"), never ISO codes. We keep a BCP-47 code alongside each name
 * purely for the on-device speech recognizer (`lang` option).
 */

export type LangName =
  | 'English'
  | 'Italian'
  | 'French'
  | 'German'
  | 'Spanish'
  | 'Portuguese'
  | 'Arabic';

export interface LangEntry {
  name: LangName;
  code: string; // BCP-47 for on-device STT
  flag: string;
}

// MVP picker scope (backend accepts more — this is just the UI list).
export const MVP_LANGUAGES: LangEntry[] = [
  { name: 'English', code: 'en-US', flag: '🇬🇧' },
  { name: 'Italian', code: 'it-IT', flag: '🇮🇹' },
  { name: 'French', code: 'fr-FR', flag: '🇫🇷' },
  { name: 'German', code: 'de-DE', flag: '🇩🇪' },
  { name: 'Spanish', code: 'es-ES', flag: '🇪🇸' },
  { name: 'Portuguese', code: 'pt-PT', flag: '🇵🇹' },
  { name: 'Arabic', code: 'ar-SA', flag: '🇸🇦' },
];

export function bcp47(name: string): string {
  return MVP_LANGUAGES.find((l) => l.name === name)?.code || 'en-US';
}

export function flagFor(name: string): string {
  return MVP_LANGUAGES.find((l) => l.name === name)?.flag || '🌐';
}

// ── Voice modes (spec modes 1–5) ────────────────────────────────────────
export type VoiceMode =
  | 'original' // 1: original voice only, no translation
  | 'subtitles' // 2: original voice + original-language subtitles
  | 'translated_subtitles' // 3: original voice + translated subtitles
  | 'voice' // 4 (recommended): translated voice only (duck original)
  | 'voice_learning'; // 5: translated voice louder, original quietly underneath

export interface VoiceModeEntry {
  mode: VoiceMode;
  label: string;
  desc: string;
  icon: string; // Feather icon
}

export const VOICE_MODES: VoiceModeEntry[] = [
  { mode: 'original', label: 'Original only', desc: 'No translation', icon: 'mic' },
  { mode: 'subtitles', label: 'Subtitles', desc: 'Original voice + subtitles', icon: 'type' },
  {
    mode: 'translated_subtitles',
    label: 'Translated subtitles',
    desc: 'Original voice + translated captions',
    icon: 'align-left',
  },
  {
    mode: 'voice',
    label: 'Translated voice',
    desc: 'Hear only the translation (recommended)',
    icon: 'volume-2',
  },
  {
    mode: 'voice_learning',
    label: 'Learning mode',
    desc: 'Translation loud, original quietly underneath',
    icon: 'headphones',
  },
];

/** Does this mode want the listener to HEAR translated audio? */
export function modePlaysVoice(mode: VoiceMode): boolean {
  return mode === 'voice' || mode === 'voice_learning';
}

/** Should the original remote audio be fully muted while the translation plays? */
export function modeDucksFully(mode: VoiceMode): boolean {
  return mode === 'voice';
}

/** Does this mode show subtitles? */
export function modeShowsSubtitles(mode: VoiceMode): boolean {
  return mode !== 'original';
}

// ── TTS voice/style prefs (local-only, shape speakTranslation args) ─────
export type VoiceGender = 'female' | 'male';
export type VoiceStyle = 'natural' | 'professional' | 'friendly';
export type TransSpeed = 'fast' | 'balanced' | 'accurate';

/** Map gender + style → an OpenAI TTS voice name for speakTranslation. */
export function ttsVoiceFor(gender: VoiceGender, style: VoiceStyle): string {
  if (gender === 'male') {
    if (style === 'professional') return 'onyx';
    if (style === 'friendly') return 'echo';
    return 'ash';
  }
  if (style === 'professional') return 'sage';
  if (style === 'friendly') return 'coral';
  return 'nova';
}

/** Style/speed → natural-language `instructions` for the speech gateway. */
export function ttsInstructionsFor(style: VoiceStyle, speed: TransSpeed): string {
  const tone =
    style === 'professional'
      ? 'Speak in a clear, professional, composed tone.'
      : style === 'friendly'
        ? 'Speak in a warm, friendly, conversational tone.'
        : 'Speak naturally, like a fluent native speaker.';
  const pace =
    speed === 'fast'
      ? 'Keep the pace brisk so translation stays close to real time.'
      : speed === 'accurate'
        ? 'Prioritise clarity and correct pronunciation.'
        : 'Use a balanced, easy-to-follow pace.';
  return `${tone} ${pace}`;
}
