/**
 * Parses voice commands spoken by the user into structured actions.
 *
 * Supported phrasing examples (case-insensitive, robust to filler words):
 *   "Call 3"                       → { type: 'call', position: 3 }
 *   "Voice call 7"                 → { type: 'call', position: 7 }
 *   "Video call to 2"              → { type: 'video', position: 2 }
 *   "Voice note to 4"              → { type: 'voiceNote', position: 4 }
 *   "Send a voice note to 5"       → { type: 'voiceNote', position: 5 }
 *   "Video message to 6"           → { type: 'videoMessage', position: 6 }
 *   "Share location with 8"        → { type: 'location', position: 8 }
 *   "Share live location with 9"   → { type: 'location', position: 9 }
 *
 * Also handles number words: "Call one", "Voice note to seven", etc.
 */

export type VoiceCommandType =
  | 'call'
  | 'video'
  | 'voiceNote'
  | 'videoMessage'
  | 'location';

export interface ParsedVoiceCommand {
  type: VoiceCommandType;
  position: number;
  rawTranscript: string;
  /** True if the trigger word "Smiley" was detected as a standalone token */
  smileyTrigger?: boolean;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  '1st': 1,
  '2nd': 2,
  '3rd': 3,
  '4th': 4,
  '5th': 5,
  '6th': 6,
  '7th': 7,
  '8th': 8,
  '9th': 9,
  '10th': 10,
};

const SMILEY_PATTERNS = [
  /\bsmile+y+\b/i,        // "smiley", "smileee", "smileyyy"
  /\bsmiley+\b/i,
  /\bsmilers?\s+end\b/i,  // some users may say "Smilers end"
];

export function isSmileyTrigger(transcript: string): boolean {
  if (!transcript) return false;
  const cleaned = transcript.trim();
  for (const pattern of SMILEY_PATTERNS) {
    if (pattern.test(cleaned)) return true;
  }
  return false;
}

function extractPosition(text: string): number | null {
  // Try digit first
  const digitMatch = text.match(/\b(10|[1-9])\b/);
  if (digitMatch) return parseInt(digitMatch[1], 10);

  // Try number words
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (NUMBER_WORDS[token]) {
      return NUMBER_WORDS[token];
    }
  }
  return null;
}

/**
 * Parse the user's spoken command string into a structured action.
 * Returns null if the transcript doesn't match any known command shape.
 */
export function parseVoiceCommand(transcript: string): ParsedVoiceCommand | null {
  if (!transcript) return null;
  const lower = transcript.toLowerCase().trim();
  if (!lower) return null;

  // Smiley end-of-recording trigger
  if (isSmileyTrigger(lower)) {
    return {
      type: 'voiceNote', // type is unused for trigger
      position: 0,
      rawTranscript: transcript,
      smileyTrigger: true,
    };
  }

  // Location commands FIRST so "share live location with N" wins over "call N"
  if (/\b(share|send)\b.*\blocation\b/.test(lower) || /\blocation\b/.test(lower)) {
    const position = extractPosition(lower);
    if (position) {
      return { type: 'location', position, rawTranscript: transcript };
    }
  }

  // Video message (recording + send)
  if (/\bvideo\s+(message|note|memo)\b/.test(lower)) {
    const position = extractPosition(lower);
    if (position) {
      return { type: 'videoMessage', position, rawTranscript: transcript };
    }
  }

  // Voice note (recording + send)
  if (/\b(voice|audio)\s+(note|message|memo)\b/.test(lower) || /\bsend\s+(a\s+)?(voice|audio)\b/.test(lower)) {
    const position = extractPosition(lower);
    if (position) {
      return { type: 'voiceNote', position, rawTranscript: transcript };
    }
  }

  // Video call
  if (/\bvideo\s+call\b/.test(lower) || /\bv\.?\s*call\b/.test(lower)) {
    const position = extractPosition(lower);
    if (position) {
      return { type: 'video', position, rawTranscript: transcript };
    }
  }

  // Voice / phone call
  if (/\b(voice|phone|audio)?\s*call\b/.test(lower) || /\bcall\b/.test(lower)) {
    const position = extractPosition(lower);
    if (position) {
      return { type: 'call', position, rawTranscript: transcript };
    }
  }

  // Bare number — assume voice call as the most common intent
  const bare = extractPosition(lower);
  if (bare && lower.length < 12) {
    return { type: 'call', position: bare, rawTranscript: transcript };
  }

  return null;
}
