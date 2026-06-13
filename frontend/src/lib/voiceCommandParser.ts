/**
 * voiceCommandParser — iter-202
 *
 * 1:1 port of the canonical web pipeline (see
 * WEB_AGENT_ANSWERS_iter202_voice_CORRECTED.md). This file MUST stay
 * byte-compatible with `src/hooks/use-voice-task-listener.ts` in the
 * web codebase. Any divergence will cause native/web behavior drift.
 *
 * Key invariants:
 *   • The wake/stop word is "smiley" (NOT "stop"), matched as a
 *     whole word: `/\bsmiley\b/i`.
 *   • `stop_command` is checked FIRST, before extracting a number.
 *   • Number extraction scans from the END of the transcript backward
 *     (the number is almost always the last token).
 *   • Common speech-to-text homophones map to digits: "to"/"too" → 2,
 *     "for" → 4.
 *   • Match order: voice_note → video_message → video_call →
 *     voice_call → share_location.
 */

export type VoiceCommandType =
  | 'voice_call'
  | 'video_call'
  | 'voice_note'
  | 'video_message'
  | 'share_location'
  | 'stop_command';

export type VoiceCommand =
  | { type: 'voice_call'; position: number }
  | { type: 'video_call'; position: number }
  | { type: 'voice_note'; position: number }
  | { type: 'video_message'; position: number }
  | { type: 'share_location'; position: number }
  | { type: 'stop_command' };

const NUMBER_WORDS: Record<string, number> = {
  one: 1, '1': 1,
  two: 2, '2': 2, to: 2, too: 2,           // "to"/"too" → 2 homophones
  three: 3, '3': 3,
  four: 4, '4': 4, for: 4,                  // "for" → 4 homophone
  five: 5, '5': 5,
  six: 6, '6': 6,
  seven: 7, '7': 7,
  eight: 8, '8': 8,
  nine: 9, '9': 9,
  ten: 10, '10': 10,
};

/**
 * Scan the transcript tokens from END to START — the spoken number is
 * almost always the last meaningful word (e.g. "voice note to 2").
 * Returns null if no digit/word matches.
 */
export function extractNumber(transcript: string): number | null {
  const tokens = transcript.toLowerCase().split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const cleaned = tokens[i].replace(/[^a-z0-9]/g, '');
    if (NUMBER_WORDS[cleaned] !== undefined) return NUMBER_WORDS[cleaned];
  }
  return null;
}

/**
 * Quick check for the stop/send word ("smiley"). Used by the commander
 * to short-circuit on INTERIM transcript results — we don't wait for
 * a "final" result to act on the stop word because send latency
 * matters most for hands-free recording.
 */
export function isStopCommand(transcript: string): boolean {
  if (!transcript) return false;
  return /\bsmiley\b/i.test(transcript);
}

/**
 * Parse a transcript string into a structured VoiceCommand or null.
 * Replicates the web `parseCommand` exactly — see canonical doc.
 */
export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  if (!transcript) return null;
  const t = transcript.toLowerCase().trim();
  if (!t) return null;

  // 1) Stop/send word — checked FIRST, whole-word only.
  if (/\bsmiley\b/i.test(t)) return { type: 'stop_command' };

  // 2) Everything below needs a slot number.
  const num = extractNumber(t);
  if (!num) return null;

  // 3) Voice note / voice message  (matched BEFORE voice call so
  //    "voice note to 3" never becomes a call).
  if (
    /voice\s*(note|message)/i.test(t) ||
    /send\s*(a\s*)?voice/i.test(t) ||
    /record\s*(a\s*)?voice/i.test(t)
  ) {
    return { type: 'voice_note', position: num };
  }

  // 4) Video message (matched BEFORE "video call").
  if (
    /video\s*(message|note)/i.test(t) ||
    /send\s*(a\s*)?video/i.test(t) ||
    /record\s*(a\s*)?video/i.test(t)
  ) {
    return { type: 'video_message', position: num };
  }

  // 5) Video call.
  if (/video\s*call/i.test(t)) {
    return { type: 'video_call', position: num };
  }

  // 6) Voice call (and bare "call N").
  if (/voice\s*call/i.test(t) || /^call\s/i.test(t) || /\bcall\b/i.test(t)) {
    return { type: 'voice_call', position: num };
  }

  // 7) Share location.
  if (
    /share\s*(my\s*)?location/i.test(t) ||
    /live\s*location/i.test(t) ||
    /location/i.test(t)
  ) {
    return { type: 'share_location', position: num };
  }

  return null;
}

/**
 * Legacy export — older callers import `ParsedVoiceCommand`. We keep
 * the name pointing at the new union so existing imports compile
 * without a sweep, but the shape is now the canonical one.
 */
export type ParsedVoiceCommand = VoiceCommand;
