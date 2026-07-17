/**
 * voiceTranslation — translate a voice note's transcript into the RECEIVER's
 * preferred language and synthesize spoken audio for it.
 *
 * Flow (per received voice note, run once, cached on-device):
 *   1. Translate the transcript → receiver's preferred language (/api/translate,
 *      honouring the receiver's "skip / understood" languages).
 *   2. If the text comes back unchanged (the sender already spoke a language the
 *      receiver understands) → mark 'skipped' — deliver the original, no audio.
 *   3. Otherwise synthesize the translated text to mp3 (/api/tts) and cache the
 *      audio file so it can be replayed instantly.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

const TRANSLATE_ENDPOINT = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}/api/translate`;
const TTS_ENDPOINT = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}/api/tts`;

export type VoiceTranslation = {
  status: 'ready' | 'skipped';
  translatedText?: string;
  audioUri?: string;
  targetLangName?: string;
};

const memCache = new Map<string, VoiceTranslation>();
const inFlight = new Map<string, Promise<VoiceTranslation>>();

function cacheKey(storageId: string, target: string) {
  return `smilers_voicetrans_${storageId}_${target}`;
}

export async function getOrCreateVoiceTranslation(args: {
  storageId: string;
  transcript: string;
  targetLangCode: string;
  targetLangName: string;
  skipLangNames: string[];
}): Promise<VoiceTranslation> {
  const { storageId, transcript, targetLangCode, targetLangName, skipLangNames } = args;
  const text = (transcript || '').trim();
  const key = cacheKey(storageId, targetLangCode);

  if (memCache.has(key)) return memCache.get(key)!;
  if (inFlight.has(key)) return inFlight.get(key)!;
  if (!text || !targetLangName) return { status: 'skipped' };

  const run = (async (): Promise<VoiceTranslation> => {
    // Restore from persisted cache (verify the audio file still exists).
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as VoiceTranslation;
        if (parsed.status === 'skipped') return parsed;
        if (parsed.status === 'ready') {
          if (!parsed.audioUri) return parsed;
          const info = await FileSystem.getInfoAsync(parsed.audioUri);
          if (info.exists) return parsed;
        }
      }
    } catch {
      /* ignore cache miss */
    }

    // 1) Translate into the receiver's language (skip-languages respected).
    let translated = text;
    try {
      const resp = await fetch(TRANSLATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          target_language: targetLangName,
          skip_languages: skipLangNames,
        }),
      });
      if (resp.ok) {
        const j = await resp.json();
        translated = (j?.translated_text || text).trim();
      }
    } catch {
      /* network — fall back to original (skipped) */
    }

    if (!translated || translated === text) {
      const skipped: VoiceTranslation = { status: 'skipped' };
      memCache.set(key, skipped);
      AsyncStorage.setItem(key, JSON.stringify(skipped)).catch(() => {});
      return skipped;
    }

    // 2) Synthesize spoken audio for the translation.
    let audioUri: string | undefined;
    try {
      const resp = await fetch(TTS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: translated.slice(0, 4096) }),
      });
      if (resp.ok) {
        const j = await resp.json();
        const b64: string | undefined = j?.audio_base64;
        if (b64) {
          const path = `${FileSystem.cacheDirectory}vtrans_${storageId}_${targetLangCode}.mp3`;
          await FileSystem.writeAsStringAsync(path, b64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          audioUri = path;
        }
      }
    } catch {
      /* TTS optional — text translation still shown */
    }

    const result: VoiceTranslation = {
      status: 'ready',
      translatedText: translated,
      audioUri,
      targetLangName,
    };
    memCache.set(key, result);
    AsyncStorage.setItem(key, JSON.stringify(result)).catch(() => {});
    return result;
  })();

  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}
