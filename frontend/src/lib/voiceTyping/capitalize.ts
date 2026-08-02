/**
 * On-device, network-free live capitalization for Voice Typing.
 *
 * Mirrors the web Study tool's client rules:
 *  - capitalize the first letter of the text
 *  - capitalize the first letter after a sentence end (. ! ?)
 *  - capitalize the first letter after a line break / new paragraph
 *  - upper-case the standalone pronoun "I" (plus I'm / I'll / I've / I'd)
 *
 * This is intentionally cheap (pure regex) so it can run on every dictated
 * chunk without latency. Deeper proper-noun / grammar fixes are handled by the
 * backend polish action, not here.
 */
export function liveCapitalize(input: string): string {
  if (!input) return input;
  let t = input;

  // First alphabetic character of the whole string.
  t = t.replace(/^(\s*)([a-z])/, (_m, ws: string, ch: string) => ws + ch.toUpperCase());

  // First letter after sentence-ending punctuation (allowing a closing quote
  // or bracket) followed by whitespace.
  t = t.replace(
    /([.!?]+["')\]]?\s+)([a-z])/g,
    (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
  );

  // First letter after a line break / new paragraph.
  t = t.replace(/(\n\s*)([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());

  // Standalone pronoun "I" and its common contractions.
  t = t.replace(/\bi'(m|ll|ve|d|s)\b/gi, (_m, suf: string) => "I'" + suf.toLowerCase());
  t = t.replace(/\bi\b/g, 'I');

  return t;
}

/** Apply the CAPS-lock display/output rule to a natural-cased string. */
export function applyCaps(text: string, allCaps: boolean): string {
  if (!text) return text;
  return allCaps ? text.toUpperCase() : text;
}
