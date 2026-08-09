import { readStoredString, writeStoredString } from './settingsStorage';

/**
 * Per-device sub-group appearance (emoji + color) so members can spot sub groups
 * at a glance. The backend sub-groups contract has no icon/color field, so this
 * is a local customization persisted in AsyncStorage keyed by sub-group id.
 */
export type SubGroupAppearance = { emoji?: string; color?: string };

const KEY = 'smilers.subgroups.appearance.v1';

export const SUB_GROUP_EMOJIS = ['⭐', '🔥', '💼', '📌', '🎯', '👑', '🛡️', '📣', '🎓', '⚽', '🎵', '❤️'];
export const SUB_GROUP_COLORS = [
  '#E53935',
  '#FB8C00',
  '#F4B400',
  '#43A047',
  '#00ACC1',
  '#1E88E5',
  '#8E24AA',
  '#6D4C41',
];

let cache: Record<string, SubGroupAppearance> | null = null;

export async function loadAppearanceMap(): Promise<Record<string, SubGroupAppearance>> {
  if (cache) return cache;
  try {
    const raw = await readStoredString(KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
  return cache!;
}

/** Synchronous read from the in-memory cache (call loadAppearanceMap once first). */
export function getAppearance(id?: string | null): SubGroupAppearance {
  if (!id || !cache) return {};
  return cache[id] || {};
}

export async function setAppearance(id: string, appearance: SubGroupAppearance): Promise<void> {
  const map = await loadAppearanceMap();
  const clean: SubGroupAppearance = {};
  if (appearance.emoji) clean.emoji = appearance.emoji;
  if (appearance.color) clean.color = appearance.color;
  if (clean.emoji || clean.color) map[id] = clean;
  else delete map[id];
  cache = map;
  try {
    await writeStoredString(KEY, JSON.stringify(map));
  } catch {}
}
