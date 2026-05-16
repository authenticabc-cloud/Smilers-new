export type DraftTextColorKey = 'black' | 'red' | 'blue' | 'green' | 'gold';

export const DRAFT_TEXT_COLORS: Array<{ key: DraftTextColorKey; label: string; hex: string }> = [
  { key: 'black', label: 'A', hex: '#1F1F1F' },
  { key: 'red', label: '●', hex: '#EF4444' },
  { key: 'blue', label: '●', hex: '#3B82F6' },
  { key: 'green', label: '●', hex: '#22C55E' },
  { key: 'gold', label: '●', hex: '#E4B53B' },
];

export function resolveDraftColor(color?: DraftTextColorKey | null) {
  return DRAFT_TEXT_COLORS.find((item) => item.key === color)?.hex;
}

export function applyDraftFormatting(
  text: string,
  options: { bold?: boolean; color?: DraftTextColorKey | null }
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

export function stripRichTextTags(text?: string) {
  return (text || '').replace(/\[\/?.*?\]/g, (match) => {
    if (/^\[(\/)?(b|color=.*|color)\]$/i.test(match)) {
      return '';
    }
    return match;
  });
}

export function parseRichTextSegments(text?: string) {
  const input = text || '';
  const segments: Array<{ text: string; bold?: boolean; color?: string }> = [];
  const stack: Array<{ type: 'root' | 'b' | 'color'; bold: boolean; color?: string }> = [
    { type: 'root', bold: false },
  ];

  let index = 0;
  while (index < input.length) {
    if (input.startsWith('[b]', index)) {
      const current = stack[stack.length - 1];
      stack.push({ type: 'b', bold: true, color: current.color });
      index += 3;
      continue;
    }
    if (input.startsWith('[/b]', index)) {
      if (stack.length > 1) {
        while (stack.length > 1 && stack[stack.length - 1].type !== 'b') {
          stack.pop();
        }
        if (stack.length > 1) stack.pop();
      }
      index += 4;
      continue;
    }
    const colorMatch = input.slice(index).match(/^\[color=(black|red|blue|green|gold)\]/i);
    if (colorMatch) {
      const current = stack[stack.length - 1];
      stack.push({ type: 'color', bold: current.bold, color: resolveDraftColor(colorMatch[1].toLowerCase() as DraftTextColorKey) });
      index += colorMatch[0].length;
      continue;
    }
    if (input.startsWith('[/color]', index)) {
      if (stack.length > 1) {
        while (stack.length > 1 && stack[stack.length - 1].type !== 'color') {
          stack.pop();
        }
        if (stack.length > 1) stack.pop();
      }
      index += 8;
      continue;
    }

    const nextTagIndex = input.indexOf('[', index);
    const endIndex = nextTagIndex === -1 ? input.length : nextTagIndex;
    const value = input.slice(index, endIndex);
    if (value) {
      const current = stack[stack.length - 1];
      segments.push({ text: value, bold: current.bold, color: current.color });
    }
    index = endIndex === index ? index + 1 : endIndex;
  }

  return segments.length > 0 ? segments : [{ text: stripRichTextTags(input) }];
}