/**
 * spokenToEmoji — turns spoken emoji phrases in a dictated transcript into the
 * actual emoji, so hands-free messages can be expressive.
 *
 * Two safe strategies (English) to avoid false positives:
 *  1. Unambiguous MULTI-WORD phrases (e.g. "smiley face" → 🙂) that rarely occur
 *     unintentionally in normal speech.
 *  2. An explicit "emoji <word>" trigger (e.g. "emoji fire" → 🔥) for common
 *     single words that WOULD be risky to auto-convert on their own.
 */

// Multi-word phrases → emoji (converted directly).
const PHRASES: Record<string, string> = {
  'smiley face': '🙂',
  'smiling face': '😊',
  'grinning face': '😀',
  'laughing face': '😂',
  'crying laughing': '😂',
  'tears of joy': '😂',
  'loudly crying': '😭',
  'crying face': '😢',
  'sad face': '😢',
  'angry face': '😠',
  'winking face': '😉',
  'kissing face': '😘',
  'cool face': '😎',
  'rolling eyes': '🙄',
  'thumbs up': '👍',
  'thumbs down': '👎',
  'ok hand': '👌',
  'okay hand': '👌',
  'red heart': '❤️',
  'broken heart': '💔',
  'blue heart': '💙',
  'praying hands': '🙏',
  'folded hands': '🙏',
  'waving hand': '👋',
  'clapping hands': '👏',
  'raising hands': '🙌',
  'flexed biceps': '💪',
  'party popper': '🎉',
  'check mark': '✅',
  'hundred points': '💯',
  'fire emoji': '🔥',
  'heart emoji': '❤️',
  'rocket ship': '🚀',
  'star emoji': '⭐',
  'poop emoji': '💩',
  'wave emoji': '👋',
};

// Single words, only converted after the explicit "emoji" trigger word.
const SINGLE: Record<string, string> = {
  heart: '❤️',
  fire: '🔥',
  rocket: '🚀',
  star: '⭐',
  poop: '💩',
  wink: '😉',
  smiley: '🙂',
  laugh: '😂',
  wave: '👋',
  clap: '👏',
  kiss: '😘',
  hundred: '💯',
  thumbsup: '👍',
  check: '✅',
  party: '🎉',
  cool: '😎',
};

const PHRASES_SORTED = Object.keys(PHRASES).sort((a, b) => b.length - a.length);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function spokenToEmoji(input: string): string {
  if (!input) return input;
  let out = input;

  // 1. "emoji <word>" explicit trigger.
  out = out.replace(/\bemoji[,\s]+([a-z]+)\b/gi, (m, w) => {
    const e = SINGLE[String(w).toLowerCase()];
    return e ? e : m;
  });

  // 2. Unambiguous multi-word phrases (longest first).
  for (const phrase of PHRASES_SORTED) {
    const re = new RegExp('\\b' + escapeRe(phrase).replace(/\s+/g, '\\s+') + '\\b', 'gi');
    out = out.replace(re, PHRASES[phrase]);
  }

  return out;
}

export default spokenToEmoji;
