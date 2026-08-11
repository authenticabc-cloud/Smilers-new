/**
 * Voice-typing personal correction dictionary.
 *
 * When the user edits a wrongly-transcribed word, we remember the mapping
 * (misheard → intended) so the SAME mistake is auto-fixed on future dictations
 * without needing to edit again. Persisted per-device in AsyncStorage; applied
 * to every finalized speech chunk before it lands in the composer.
 *
 * Deliberately conservative: only whole-word, single-token substitutions are
 * learned/applied (keeps common words safe from accidental global rewrites).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'smilers_voice_corrections.v1';
const MAX_ENTRIES = 500;

// lowercased misheard word → intended word (original casing kept for output)
let map: Record<string, string> = {};
let loaded = false;

function stripEdges(w: string): { lead: string; core: string; trail: string } {
  const m = w.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  if (!m) return { lead: '', core: w, trail: '' };
  return { lead: m[1] || '', core: m[2] || '', trail: m[3] || '' };
}

function matchCase(sample: string, target: string): string {
  if (!sample) return target;
  if (sample === sample.toUpperCase() && sample.length > 1) return target.toUpperCase();
  if (sample[0] === sample[0].toUpperCase()) return target.charAt(0).toUpperCase() + target.slice(1);
  return target;
}

export async function loadCorrections(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) map = JSON.parse(raw) || {};
  } catch {
    map = {};
  }
}

async function persist(): Promise<void> {
  try {
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      // drop oldest-ish (first inserted) beyond the cap
      map = Object.fromEntries(keys.slice(keys.length - MAX_ENTRIES).map((k) => [k, map[k]]));
    }
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Apply learned corrections to a finalized transcript chunk. */
export function applyCorrections(text: string): string {
  if (!text || !Object.keys(map).length) return text;
  return text
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok) || !tok) return tok;
      const { lead, core, trail } = stripEdges(tok);
      if (!core) return tok;
      const fix = map[core.toLowerCase()];
      if (!fix) return tok;
      return lead + matchCase(core, fix) + trail;
    })
    .join('');
}

/** Learn a single misheard→intended mapping. */
export async function learnCorrection(wrong: string, correct: string): Promise<void> {
  const w = stripEdges(wrong).core.toLowerCase();
  const c = stripEdges(correct).core;
  if (!w || !c || w === c.toLowerCase()) return;
  map[w] = c;
  await persist();
}

/**
 * Diff a pre-edit vs edited transcript and learn whole-word substitutions.
 * Only learns when the two have the SAME word count (unambiguous 1:1 changes),
 * which reliably captures the common "one/few words wrong" correction.
 */
export async function learnFromDiff(before: string, after: string): Promise<number> {
  const a = (before || '').trim().split(/\s+/).filter(Boolean);
  const b = (after || '').trim().split(/\s+/).filter(Boolean);
  if (!a.length || a.length !== b.length) return 0;
  let learned = 0;
  for (let i = 0; i < a.length; i++) {
    const wc = stripEdges(a[i]).core.toLowerCase();
    const cc = stripEdges(b[i]).core;
    if (wc && cc && wc !== cc.toLowerCase()) {
      map[wc] = cc;
      learned += 1;
    }
  }
  if (learned) await persist();
  return learned;
}
