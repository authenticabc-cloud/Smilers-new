export type DraftTextColorKey = 'black' | 'red' | 'blue' | 'green' | 'gold';

export const DRAFT_TEXT_COLORS: Array<{ key: DraftTextColorKey; label: string; hex: string }> = [
  { key: 'black', label: 'A', hex: '#1F1F1F' },
  { key: 'red', label: '●', hex: '#EF4444' },
  { key: 'blue', label: '●', hex: '#3B82F6' },
  { key: 'green', label: '●', hex: '#22C55E' },
  { key: 'gold', label: '●', hex: '#E4B53B' },
];

/**
 * Preset swatch grid for the per-selection colour picker. Hex-based so any
 * selected range can carry an exact colour via `[color=#RRGGBB]`.
 */
export const PRESET_TEXT_COLORS: string[] = [
  '#1F1F1F', '#6B7280', '#9CA3AF', '#FFFFFF',
  '#EF4444', '#F97316', '#F59E0B', '#E4B53B',
  '#EAB308', '#84CC16', '#22C55E', '#10B981',
  '#14B8A6', '#3B82F6', '#6366F1', '#8B5CF6',
  '#A855F7', '#EC4899', '#F43F5E', '#78350F',
];

export function resolveDraftColor(color?: DraftTextColorKey | string | null) {
  if (!color) return undefined;
  if (typeof color === 'string' && color.startsWith('#')) return color;
  return DRAFT_TEXT_COLORS.find((item) => item.key === color)?.hex;
}

/** Wrap the whole string with the chosen whole-message bold/colour tags. */
export function applyDraftFormatting(
  text: string,
  options: { bold?: boolean; color?: DraftTextColorKey | string | null }
) {
  let output = text;
  if (options.bold) {
    output = `[b]${output}[/b]`;
  }
  if (options.color) {
    output = `[color=${options.color}]${output}[/color]`;
  }
  return output;
}

export type InlineFormatKind = 'bold' | 'italic' | 'underline';

const INLINE_TAG: Record<InlineFormatKind, string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
};

type Selection = { start: number; end: number };

function normalizeSelection(text: string, selection?: Selection | null): Selection {
  const len = text.length;
  let start = selection?.start ?? 0;
  let end = selection?.end ?? 0;
  if (start > end) [start, end] = [end, start];
  start = Math.max(0, Math.min(start, len));
  end = Math.max(0, Math.min(end, len));
  // Empty selection => operate on the whole message.
  if (start === end) {
    start = 0;
    end = len;
  }
  return { start, end };
}

function wrapRange(text: string, selection: Selection, open: string, close: string) {
  const { start, end } = selection;
  const before = text.slice(0, start);
  const mid = text.slice(start, end);
  const after = text.slice(end);
  const newText = `${before}${open}${mid}${close}${after}`;
  const newStart = start + open.length;
  const newEnd = newStart + mid.length;
  return { text: newText, selection: { start: newStart, end: newEnd } };
}

/** Apply bold / italic / underline to the selected range (or whole message). */
export function applyInlineFormat(
  text: string,
  selection: Selection | null | undefined,
  kind: InlineFormatKind
): { text: string; selection: Selection } {
  const sel = normalizeSelection(text, selection);
  const tag = INLINE_TAG[kind];
  return wrapRange(text, sel, `[${tag}]`, `[/${tag}]`);
}

/** Apply a hex colour to the selected range (or whole message). */
export function applyInlineColor(
  text: string,
  selection: Selection | null | undefined,
  hex: string
): { text: string; selection: Selection } {
  const sel = normalizeSelection(text, selection);
  return wrapRange(text, sel, `[color=${hex}]`, `[/color]`);
}

export function stripRichTextTags(text?: string) {
  return (text || '').replace(/\[\/?(b|i|u|color(=[^\]]*)?)\]/gi, '');
}

export type RichTextSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
};

type Frame = {
  type: 'root' | 'b' | 'i' | 'u' | 'color';
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
};

export function parseRichTextSegments(text?: string): RichTextSegment[] {
  const input = text || '';
  const segments: RichTextSegment[] = [];
  const stack: Frame[] = [{ type: 'root', bold: false, italic: false, underline: false }];

  const openTag = (type: Frame['type'], patch: Partial<Frame>) => {
    const current = stack[stack.length - 1];
    stack.push({
      type,
      bold: current.bold,
      italic: current.italic,
      underline: current.underline,
      color: current.color,
      ...patch,
    });
  };
  const closeTag = (type: Frame['type']) => {
    if (stack.length <= 1) return;
    while (stack.length > 1 && stack[stack.length - 1].type !== type) stack.pop();
    if (stack.length > 1) stack.pop();
  };
  const pushText = (value: string) => {
    if (!value) return;
    const current = stack[stack.length - 1];
    segments.push({
      text: value,
      bold: current.bold,
      italic: current.italic,
      underline: current.underline,
      color: current.color,
    });
  };

  let index = 0;
  while (index < input.length) {
    if (input.startsWith('[b]', index)) { openTag('b', { bold: true }); index += 3; continue; }
    if (input.startsWith('[/b]', index)) { closeTag('b'); index += 4; continue; }
    if (input.startsWith('[i]', index)) { openTag('i', { italic: true }); index += 3; continue; }
    if (input.startsWith('[/i]', index)) { closeTag('i'); index += 4; continue; }
    if (input.startsWith('[u]', index)) { openTag('u', { underline: true }); index += 3; continue; }
    if (input.startsWith('[/u]', index)) { closeTag('u'); index += 4; continue; }

    const colorMatch = input.slice(index).match(/^\[color=(#[0-9a-fA-F]{3,8}|black|red|blue|green|gold)\]/i);
    if (colorMatch) {
      const raw = colorMatch[1];
      const hex = raw.startsWith('#') ? raw : resolveDraftColor(raw.toLowerCase() as DraftTextColorKey);
      openTag('color', { color: hex });
      index += colorMatch[0].length;
      continue;
    }
    if (input.startsWith('[/color]', index)) { closeTag('color'); index += 8; continue; }

    const nextTagIndex = input.indexOf('[', index);
    if (nextTagIndex === index) {
      // A '[' that isn't a recognized tag — emit it literally.
      pushText(input[index]);
      index += 1;
      continue;
    }
    const endIndex = nextTagIndex === -1 ? input.length : nextTagIndex;
    pushText(input.slice(index, endIndex));
    index = endIndex;
  }

  return segments.length > 0 ? segments : [{ text: stripRichTextTags(input) }];
}
