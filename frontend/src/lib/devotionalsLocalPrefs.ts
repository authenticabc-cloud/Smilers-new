/**
 * Local-only preferences for the Devotional Broadcast feature.
 *
 * Why local-only?
 * The backend (`api.devotionals.getPreferences/updatePreferences`) handles
 * the FEED FILTER (all / contacts / selected) — that's a piece of data
 * other clients (web app, future tablet, etc.) should sync.
 *
 * BUT the "languages NOT to translate" preference is a per-device
 * DISPLAY choice: when a broadcast arrives in Spanish, do I want it
 * shown as-is (because I read Spanish) or auto-translated to English
 * (my preferred language). This is a personal viewing preference that
 * may differ between devices, so we keep it in AsyncStorage rather
 * than syncing through Convex.
 */

import { readStoredJson, writeStoredJson } from './settingsStorage';

// AsyncStorage key. Bumping the suffix (e.g. ...v2) is the way to do
// schema migrations if the shape ever changes.
const NO_TRANSLATE_KEY = 'smilers_devotionals_no_translate_langs_v1';

export interface DevotionalsLocalPrefs {
  /** ISO 639-1 codes of source languages we should display in original. */
  noTranslateLangs: string[];
}

const DEFAULT_PREFS: DevotionalsLocalPrefs = {
  noTranslateLangs: [],
};

export async function readNoTranslateLangs(): Promise<string[]> {
  try {
    const raw = (await readStoredJson(NO_TRANSLATE_KEY, DEFAULT_PREFS.noTranslateLangs)) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export async function writeNoTranslateLangs(langs: string[]): Promise<void> {
  const deduped = Array.from(new Set(langs.filter((lang) => typeof lang === 'string' && lang.length > 0)));
  await writeStoredJson(NO_TRANSLATE_KEY, deduped);
}

/**
 * Pure render-time decision for what text to show. Translation strategy:
 *   1. If the original/detected language is in the user's no-translate
 *      list → show the ORIGINAL text untouched.
 *   2. Else if a translation to the preferred language exists in
 *      `translations[preferredLang]` → show that.
 *   3. Else fall back to the original text.
 *
 * The function returns both the text AND a flag so the UI can show a
 * "Translated from <X>" hint when a translation was applied.
 */
export function chooseDisplayText(args: {
  originalText: string;
  detectedLanguage?: string | null;
  preferredLanguage?: string | null;
  translations?: Record<string, string> | null;
  noTranslateLangs: string[];
}): { text: string; translatedFrom: string | null } {
  const { originalText, detectedLanguage, preferredLanguage, translations, noTranslateLangs } = args;
  const detected = (detectedLanguage || '').toLowerCase();
  const preferred = (preferredLanguage || '').toLowerCase();

  // Same language already → no need to translate.
  if (detected && preferred && detected === preferred) {
    return { text: originalText, translatedFrom: null };
  }
  // Source language is on the user's no-translate list → keep original.
  if (detected && noTranslateLangs.some((entry) => entry.toLowerCase() === detected)) {
    return { text: originalText, translatedFrom: null };
  }
  // Translation is available for the preferred language.
  if (preferred && translations && typeof translations[preferred] === 'string' && translations[preferred].trim().length > 0) {
    return { text: translations[preferred], translatedFrom: detected || null };
  }
  // Default: return original (no translation available or preferences allow).
  return { text: originalText, translatedFrom: null };
}
