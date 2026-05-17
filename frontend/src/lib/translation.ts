const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;
const translationCache = new Map<string, string>();

export async function translateIncomingMessageText(input: {
  text: string;
  targetLanguage: string;
  skipLanguages?: string[];
}): Promise<string> {
  const text = input.text?.trim();
  const targetLanguage = input.targetLanguage?.trim();
  const skipLanguages = Array.isArray(input.skipLanguages) ? input.skipLanguages.filter(Boolean) : [];

  if (!text || !targetLanguage || !BACKEND_URL) {
    return input.text;
  }

  const cacheKey = `${targetLanguage.toLowerCase()}::${skipLanguages.sort().join(',').toLowerCase()}::${text}`;
  const cached = translationCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        target_language: targetLanguage,
        skip_languages: skipLanguages,
      }),
    });

    if (!response.ok) {
      return input.text;
    }

    const result = await response.json();
    const translated = typeof result?.translated_text === 'string' && result.translated_text.trim().length > 0
      ? result.translated_text
      : input.text;

    translationCache.set(cacheKey, translated);
    return translated;
  } catch {
    return input.text;
  }
}
