/**
 * Voice Typing history — persisted on-device so every dictated note is saved
 * and remains copyable across app restarts (per product spec).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'voice_typing_history_v1';

export type VoiceNote = {
  id: string;
  text: string;
  createdAt: number;
};

export async function loadVoiceNotes(): Promise<VoiceNote[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n) => n && typeof n.text === 'string' && n.id);
  } catch {
    return [];
  }
}

async function persist(notes: VoiceNote[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(notes.slice(0, 200)));
  } catch {
    /* best effort */
  }
}

export async function saveVoiceNote(text: string): Promise<VoiceNote[]> {
  const trimmed = text.trim();
  const existing = await loadVoiceNotes();
  if (!trimmed) return existing;
  const note: VoiceNote = {
    id: `vn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: trimmed,
    createdAt: Date.now(),
  };
  const next = [note, ...existing];
  await persist(next);
  return next;
}

export async function deleteVoiceNote(id: string): Promise<VoiceNote[]> {
  const existing = await loadVoiceNotes();
  const next = existing.filter((n) => n.id !== id);
  await persist(next);
  return next;
}
