const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;
import { fetchWithRetryAfter } from './fetchWithRetryAfter';
const translationCache = new Map<string, string>();

export interface TranslationResult {
  ok: boolean;
  translatedText: string;
}

export async function translateIncomingMessageText(input: {
  text: string;
  targetLanguage: string;
  skipLanguages?: string[];
}): Promise<TranslationResult> {
  const text = input.text?.trim();
  const targetLanguage = input.targetLanguage?.trim();
  const skipLanguages = Array.isArray(input.skipLanguages) ? input.skipLanguages.filter(Boolean) : [];

  if (!text || !targetLanguage) {
    return { ok: false, translatedText: input.text };
  }

  if (!BACKEND_URL) {
    console.warn('[translation] Missing EXPO_PUBLIC_BACKEND_URL, skipping translation');
    return { ok: false, translatedText: input.text };
  }

  const cacheKey = `${targetLanguage.toLowerCase()}::${skipLanguages.sort().join(',').toLowerCase()}::${text}`;
  const cached = translationCache.get(cacheKey);
  if (cached) {
    return { ok: true, translatedText: cached };
  }

  try {
    const response = await fetchWithRetryAfter(`${BACKEND_URL}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        target_language: targetLanguage,
        skip_languages: skipLanguages,
      }),
    });

    if (!response.ok) {
      console.warn('[translation] non-200 response', response.status);
      return { ok: false, translatedText: input.text };
    }

    const result = await response.json();
    const translated = typeof result?.translated_text === 'string' && result.translated_text.trim().length > 0
      ? result.translated_text
      : input.text;

    translationCache.set(cacheKey, translated);
    return { ok: true, translatedText: translated };
  } catch (errorValue) {
    console.warn('[translation] request failed', errorValue);
    return { ok: false, translatedText: input.text };
  }
}
