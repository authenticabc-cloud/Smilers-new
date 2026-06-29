/**
 * Continuous auto-numbering for the chat composer (web-parity, iter-293).
 *
 * When the user finishes a list line and presses Enter, the composer
 * auto-inserts the NEXT marker on the new line so they can keep building a
 * list without retyping prefixes. Supports:
 *   • Numeric:        "1. " → "2. ",  "1) " → "2) "
 *   • Lower alpha:    "a. " → "b. ",  "z) " → "aa) "
 *   • Upper alpha:    "A. " → "B. "
 *   • Lower roman:    "ii. " → "iii. "   (multi-letter only)
 *   • Upper roman:    "IV. " → "V. "     (multi-letter only)
 *   • Bullets:        "- ", "* ", "• "  → repeats the same bullet
 *
 * Rules:
 *   • Pressing Enter on a line that is ONLY a marker (no content) ENDS the
 *     list — the empty marker line is removed (matches Notes/Docs behaviour).
 *   • A SINGLE letter is always treated as ALPHA (a→b, I→J). Roman increment
 *     only applies to multi-letter roman sequences (ii, IV, …) to avoid the
 *     classic "is 'i' roman-1 or alpha-9?" ambiguity.
 *   • 100% client-side: the text sent to the backend is exactly what the user
 *     sees. No backend field, no network call.
 */

const ROMAN_CHARS = /^[ivxlcdm]+$/i;

function toRoman(num: number, upper: boolean): string {
  if (num <= 0) return upper ? 'I' : 'i';
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let n = num;
  let out = '';
  for (const [v, s] of table) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return upper ? out.toUpperCase() : out;
}

function fromRoman(s: string): number {
  const map: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const lower = s.toLowerCase();
  let total = 0;
  for (let i = 0; i < lower.length; i++) {
    const cur = map[lower[i]];
    const next = map[lower[i + 1]];
    if (next && cur < next) total -= cur;
    else total += cur;
  }
  return total;
}

function toAlpha(num: number, upper: boolean): string {
  // 1→a, 26→z, 27→aa …
  let n = num;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return upper ? out.toUpperCase() : out;
}

function fromAlpha(s: string): number {
  let n = 0;
  const lower = s.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    n = n * 26 + (lower.charCodeAt(i) - 96);
  }
  return n;
}

type Parsed =
  | { kind: 'bullet'; indent: string; bullet: string }
  | { kind: 'numeric'; indent: string; value: number; sep: string }
  | { kind: 'alpha'; indent: string; value: number; sep: string; upper: boolean }
  | { kind: 'roman'; indent: string; value: number; sep: string; upper: boolean }
  | null;

/** Parse a single line into its list marker, if any. */
export function parsePrefix(line: string): { parsed: Parsed; contentEmpty: boolean } {
  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const rest = line.slice(indent.length);

  // Bullet: -, *, •  followed by a space
  const bulletMatch = rest.match(/^([-*•])\s+(.*)$/);
  if (bulletMatch) {
    return { parsed: { kind: 'bullet', indent, bullet: bulletMatch[1] }, contentEmpty: bulletMatch[2].trim().length === 0 };
  }

  // Numeric: 1. or 1)
  const numMatch = rest.match(/^(\d+)([.)])\s+(.*)$/);
  if (numMatch) {
    return {
      parsed: { kind: 'numeric', indent, value: parseInt(numMatch[1], 10), sep: numMatch[2] },
      contentEmpty: numMatch[3].trim().length === 0,
    };
  }

  // Letter(s): a. / A) / ii. / IV)
  const letterMatch = rest.match(/^([A-Za-z]+)([.)])\s+(.*)$/);
  if (letterMatch) {
    const token = letterMatch[1];
    const sep = letterMatch[2];
    const upper = token === token.toUpperCase();
    const contentEmpty = letterMatch[3].trim().length === 0;
    // Multi-letter roman → roman; everything else (incl. single letters) → alpha.
    if (token.length > 1 && ROMAN_CHARS.test(token)) {
      return { parsed: { kind: 'roman', indent, value: fromRoman(token), sep, upper }, contentEmpty };
    }
    return { parsed: { kind: 'alpha', indent, value: fromAlpha(token), sep, upper }, contentEmpty };
  }

  return { parsed: null, contentEmpty: false };
}

/** Build the marker string for the NEXT item in the list. */
export function getNextPrefix(parsed: NonNullable<Parsed>): string {
  switch (parsed.kind) {
    case 'bullet':
      return `${parsed.indent}${parsed.bullet} `;
    case 'numeric':
      return `${parsed.indent}${parsed.value + 1}${parsed.sep} `;
    case 'alpha':
      return `${parsed.indent}${toAlpha(parsed.value + 1, parsed.upper)}${parsed.sep} `;
    case 'roman':
      return `${parsed.indent}${toRoman(parsed.value + 1, parsed.upper)}${parsed.sep} `;
  }
}

/**
 * Given the previous composer text and the new value from onChangeText,
 * returns the (possibly augmented) text. Only acts when the user pressed
 * Enter at the END of the text after a list line.
 */
export function applyAutoNumberingOnNewline(prev: string, next: string): string {
  // Only handle the "Enter appended at the end" case (deterministic without a
  // cursor position). Any other edit passes through unchanged.
  const isAppendedNewline = next.length === prev.length + 1 && next.endsWith('\n') && next.startsWith(prev);
  if (!isAppendedNewline) return next;

  const beforeNewline = next.slice(0, -1);
  const lines = beforeNewline.split('\n');
  const lastLine = lines[lines.length - 1];
  const { parsed, contentEmpty } = parsePrefix(lastLine);
  if (!parsed) return next;

  if (contentEmpty) {
    // Enter on an empty marker line → end the list: drop the empty marker.
    lines[lines.length - 1] = '';
    return lines.join('\n');
  }

  return next + getNextPrefix(parsed);
}
