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

// ---------------------------------------------------------------------------
// iter-294: full WhatsApp/Docs-grade behaviour — mid-list Enter + renumbering.
// ---------------------------------------------------------------------------

type OrderedLine = {
  indent: string;
  kind: 'numeric' | 'alpha' | 'roman';
  value: number;
  sep: string;
  upper: boolean;
  content: string;
};

/** Parse an ORDERED list line (numeric/alpha/roman) into its parts, else null. */
function parseOrderedLine(line: string): OrderedLine | null {
  const indent = (line.match(/^(\s*)/) || ['', ''])[1];
  const rest = line.slice(indent.length);

  const numMatch = rest.match(/^(\d+)([.)])\s+(.*)$/);
  if (numMatch) {
    return { indent, kind: 'numeric', value: parseInt(numMatch[1], 10), sep: numMatch[2], upper: false, content: numMatch[3] };
  }
  const letterMatch = rest.match(/^([A-Za-z]+)([.)])\s+(.*)$/);
  if (letterMatch) {
    const token = letterMatch[1];
    const upper = token === token.toUpperCase();
    if (token.length > 1 && ROMAN_CHARS.test(token)) {
      return { indent, kind: 'roman', value: fromRoman(token), sep: letterMatch[2], upper, content: letterMatch[3] };
    }
    return { indent, kind: 'alpha', value: fromAlpha(token), sep: letterMatch[2], upper, content: letterMatch[3] };
  }
  return null;
}

function markerFor(o: OrderedLine, value: number): string {
  const v =
    o.kind === 'numeric' ? String(value) : o.kind === 'alpha' ? toAlpha(value, o.upper) : toRoman(value, o.upper);
  return `${o.indent}${v}${o.sep} `;
}

/**
 * Re-sequence every contiguous block of ordered list items so deletions and
 * insertions keep continuous numbering (1,2,3…). A block is a run of adjacent
 * lines that are ordered items of the SAME kind + separator + indent + case.
 * The block keeps its FIRST item's starting value; subsequent items follow.
 * Bullets and non-list lines are left untouched and break a run.
 */
export function renumberOrderedLists(text: string): string {
  const lines = text.split('\n');
  let runStartValue = 0;
  let runOffset = 0;
  let prev: OrderedLine | null = null;

  for (let i = 0; i < lines.length; i++) {
    const o = parseOrderedLine(lines[i]);
    const sameRun =
      o && prev && o.kind === prev.kind && o.sep === prev.sep && o.indent === prev.indent && o.upper === prev.upper;
    if (o && sameRun) {
      runOffset += 1;
      const expected = runStartValue + runOffset;
      if (expected !== o.value) lines[i] = markerFor(o, expected) + o.content;
      prev = { ...o, value: expected };
    } else if (o) {
      // start of a new run — keep its own starting value
      runStartValue = o.value;
      runOffset = 0;
      prev = o;
    } else {
      prev = null;
    }
  }
  return lines.join('\n');
}

/**
 * Cursor-aware composer change handler. Handles:
 *   • Enter ANYWHERE (not just end) after a list line → insert the next marker
 *     at the cursor and place the caret after it.
 *   • Enter on an empty marker line → end the list (remove the marker).
 *   • Any structural change (line added/removed) → renumber ordered blocks so
 *     numbering stays continuous after inserts/deletes.
 * Returns the final text and, when we moved the caret, the new selection.
 *
 * Within-line edits (no change in line count) pass through untouched so the
 * user can freely type/edit — including numbers — without being fought.
 */
export function processComposerChange(
  prev: string,
  next: string,
  prevCursor: number,
): { text: string; selection?: { start: number; end: number } } {
  const prevLineCount = prev.split('\n').length;
  const nextLineCount = next.split('\n').length;

  // Detect a single newline inserted at the cursor (Enter key).
  const insertedNewline =
    next.length === prev.length + 1 &&
    nextLineCount === prevLineCount + 1 &&
    prevCursor >= 0 &&
    prevCursor <= prev.length &&
    next.slice(0, prevCursor) === prev.slice(0, prevCursor) &&
    next[prevCursor] === '\n' &&
    next.slice(prevCursor + 1) === prev.slice(prevCursor);

  if (insertedNewline) {
    const caret = prevCursor; // position of the new '\n'
    // The line that was just split: from its start up to the caret.
    const lineStart = next.lastIndexOf('\n', caret - 1) + 1;
    const currentLine = next.slice(lineStart, caret);
    const { parsed, contentEmpty } = parsePrefix(currentLine);

    if (parsed && contentEmpty) {
      // Enter on an empty marker → end the list: strip the marker, keep newline.
      const text = next.slice(0, lineStart) + next.slice(caret);
      const pos = lineStart;
      return { text: renumberKeepingCaret(text, pos) };
    }
    if (parsed) {
      const marker = getNextPrefix(parsed);
      const withMarker = next.slice(0, caret + 1) + marker + next.slice(caret + 1);
      const caretAfter = caret + 1 + marker.length;
      return renumberKeepingCaret(withMarker, caretAfter);
    }
    return { text: next };
  }

  // Structural change without our newline handling (e.g. a line/item deleted,
  // lines merged) → renumber so the ordered list stays continuous.
  if (nextLineCount !== prevLineCount) {
    return renumberKeepingCaret(next, Math.min(prevCursor, next.length));
  }

  // Plain within-line edit — leave it alone.
  return { text: next };
}

/** Renumber while keeping the caret on the same line/column. */
function renumberKeepingCaret(text: string, caret: number): { text: string; selection: { start: number; end: number } } {
  // Capture caret's line index + column within its line.
  const before = text.slice(0, caret);
  const lineIndex = before.split('\n').length - 1;
  const col = caret - (before.lastIndexOf('\n') + 1);

  const renumbered = renumberOrderedLists(text);
  const newLines = renumbered.split('\n');
  // Recompute absolute caret: sum of preceding line lengths (+newlines) + col,
  // clamped to the (possibly resized) target line length.
  let pos = 0;
  for (let i = 0; i < lineIndex && i < newLines.length; i++) pos += newLines[i].length + 1;
  const targetLineLen = newLines[Math.min(lineIndex, newLines.length - 1)]?.length ?? 0;
  pos += Math.min(col, targetLineLen);
  const clamped = Math.max(0, Math.min(pos, renumbered.length));
  return { text: renumbered, selection: { start: clamped, end: clamped } };
}


/**
 * One-tap list toggle for a composer toolbar button. Applies (or removes) a
 * numbered or bulleted list across the lines spanned by the current selection
 * (or the caret's line when there's no selection). Toggling is smart: if every
 * affected non-empty line is already the requested list type, it strips the
 * markers; otherwise it applies them (replacing any existing list marker).
 * Returns the new text and a selection covering the affected block.
 */
export function toggleListFormat(
  text: string,
  selection: { start: number; end: number } | undefined,
  kind: 'numeric' | 'bullet',
): { text: string; selection: { start: number; end: number } } {
  const selStart = selection ? Math.min(selection.start, selection.end) : text.length;
  const selEnd = selection ? Math.max(selection.start, selection.end) : selStart;

  const blockStart = text.lastIndexOf('\n', selStart - 1) + 1;
  const nlAfter = text.indexOf('\n', selEnd);
  const blockEnd = nlAfter === -1 ? text.length : nlAfter;

  const block = text.slice(blockStart, blockEnd);
  const lines = block.split('\n');

  const stripMarker = (line: string): string => {
    const indent = (line.match(/^(\s*)/) || ['', ''])[1];
    const rest = line.slice(indent.length);
    const m = rest.match(/^(?:\d+[.)]|[A-Za-z]+[.)]|[-*•])\s+(.*)$/);
    return m ? indent + m[1] : line;
  };
  const hasKind = (line: string): boolean => {
    const rest = line.replace(/^\s*/, '');
    return kind === 'bullet' ? /^[-*•]\s+/.test(rest) : /^\d+[.)]\s+/.test(rest);
  };

  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const allAlready = nonEmpty.length > 0 && nonEmpty.every(hasKind);

  let counter = 0;
  const newLines = lines.map((line) => {
    if (line.trim().length === 0) return line; // leave blank lines as-is
    const bare = stripMarker(line);
    if (allAlready) return bare; // toggle OFF
    if (kind === 'bullet') return `- ${bare}`;
    counter += 1;
    return `${counter}. ${bare}`;
  });

  const newBlock = newLines.join('\n');
  const newText = text.slice(0, blockStart) + newBlock + text.slice(blockEnd);
  return { text: newText, selection: { start: blockStart, end: blockStart + newBlock.length } };
}

/**
 * Returns the list type of the line the caret sits on — used to highlight the
 * matching composer toolbar button. 'ordered' covers numeric/alpha/roman.
 */
export function currentLineListKind(text: string, cursor: number): 'ordered' | 'bullet' | null {
  const c = Math.max(0, Math.min(cursor, text.length));
  const lineStart = text.lastIndexOf('\n', c - 1) + 1;
  let lineEnd = text.indexOf('\n', c);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const rest = line.replace(/^\s*/, '');
  if (/^[-*•]\s+/.test(rest)) return 'bullet';
  if (/^(?:\d+|[A-Za-z]+)[.)]\s+/.test(rest)) return 'ordered';
  return null;
}
