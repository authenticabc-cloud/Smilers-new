import { Colors, FontSize, Radius } from '../theme';
import { DEFAULT_CHAT_APPEARANCE } from './settingsStorage';

type WallpaperOption = {
  key: string;
  label: string;
  color: string;
  cardColors: [string, string];
  previewColors: [string, string];
};

type BubbleOption = {
  key: string;
  label: string;
  color: string;
};

export const WALLPAPER_OPTIONS: WallpaperOption[] = [
  {
    key: 'cream',
    label: 'Default',
    color: '#F7F0E4',
    cardColors: ['#D0CCC3', '#F1ECE2'],
    previewColors: ['#FFF3D5', '#FFD9A1'],
  },
  {
    key: 'sand',
    label: 'Warm Sand',
    color: '#F6E7D1',
    cardColors: ['#F8EAD5', '#F2DDB9'],
    previewColors: ['#FFF0DF', '#F7D7A5'],
  },
  {
    key: 'ocean',
    label: 'Ocean Breeze',
    color: '#D9F1FF',
    cardColors: ['#BFE9FF', '#7BC9F7'],
    previewColors: ['#D8F5FF', '#7CCBF8'],
  },
  {
    key: 'lavender',
    label: 'Lavender Mist',
    color: '#EAD9FF',
    cardColors: ['#E7D5FF', '#CFB3FF'],
    previewColors: ['#F1E5FF', '#D3B3FF'],
  },
  {
    key: 'forest',
    label: 'Forest',
    color: '#DFF8E5',
    cardColors: ['#D4FFE1', '#A8F0BF'],
    previewColors: ['#E7FFE5', '#A5F0B4'],
  },
  {
    key: 'rose',
    label: 'Rose Blush',
    color: '#FFE1EA',
    cardColors: ['#FFD9E5', '#FFC3D4'],
    previewColors: ['#FFE7EE', '#FFC7D8'],
  },
  {
    key: 'indigo',
    label: 'Midnight Ink',
    color: '#23226A',
    cardColors: ['#2B2C79', '#19194D'],
    previewColors: ['#353888', '#181A47'],
  },
  {
    key: 'sunrise',
    label: 'Golden Glow',
    color: '#FFD58B',
    cardColors: ['#FFF2BE', '#FFB45D'],
    previewColors: ['#FFF1B6', '#FFA858'],
  },
  {
    key: 'cloud',
    label: 'Cloud Silver',
    color: '#ECF2FA',
    cardColors: ['#F3F7FC', '#DCE7F6'],
    previewColors: ['#F5F9FF', '#DCE6F4'],
  },
];

export const OUTGOING_BUBBLE_OPTIONS: BubbleOption[] = [
  { key: 'eucalyptus', label: 'Emerald', color: '#10A37F' },
  { key: 'lagoon', label: 'Lagoon', color: '#1786A6' },
  { key: 'amber', label: 'Amber', color: '#D99B2B' },
  { key: 'plum', label: 'Plum', color: '#7C5CE1' },
  { key: 'rose', label: 'Rose', color: '#E57E95' },
  { key: 'gold', label: 'Gold', color: Colors.primary },
];

export const INCOMING_BUBBLE_OPTIONS: BubbleOption[] = [
  { key: 'mist', label: 'Mint', color: '#DDF1EC' },
  { key: 'white', label: 'Pearl', color: '#FFFFFF' },
  { key: 'linen', label: 'Linen', color: '#FAEEDC' },
  { key: 'sky', label: 'Sky', color: '#DDF2FF' },
  { key: 'blush', label: 'Blush', color: '#FFE4EA' },
];

export const BUBBLE_STYLE_OPTIONS = [
  { key: 'rounded', label: 'Rounded' },
  { key: 'classic', label: 'Classic' },
  { key: 'compact', label: 'Compact' },
];

export const TEXT_SIZE_OPTIONS = [
  { key: 'sm', label: 'Small' },
  { key: 'base', label: 'Default' },
  { key: 'lg', label: 'Large' },
];

export const BUBBLE_THEME_OPTIONS = [
  {
    key: 'golden-mint',
    label: 'Golden Mint',
    wallpaper: 'sunrise',
    outgoingColor: 'eucalyptus',
    incomingColor: 'mist',
    bubbleStyle: 'rounded',
    textSize: 'lg',
  },
  {
    key: 'ocean-flow',
    label: 'Ocean Flow',
    wallpaper: 'ocean',
    outgoingColor: 'lagoon',
    incomingColor: 'sky',
    bubbleStyle: 'rounded',
    textSize: 'base',
  },
  {
    key: 'soft-rose',
    label: 'Soft Rose',
    wallpaper: 'rose',
    outgoingColor: 'rose',
    incomingColor: 'blush',
    bubbleStyle: 'classic',
    textSize: 'base',
  },
  {
    key: 'midnight-plum',
    label: 'Midnight Plum',
    wallpaper: 'indigo',
    outgoingColor: 'plum',
    incomingColor: 'linen',
    bubbleStyle: 'compact',
    textSize: 'sm',
  },
];

const LEGACY_WALLPAPER_MAP: Record<string, string> = {
  sage: 'forest',
  dusk: 'lavender',
  night: 'cloud',
};

const LEGACY_OUTGOING_MAP: Record<string, string> = {
  sage: 'eucalyptus',
  violet: 'plum',
};

export function normalizeChatAppearance(value: any) {
  const appearance = { ...DEFAULT_CHAT_APPEARANCE, ...(value || {}) };
  return {
    ...appearance,
    wallpaper: LEGACY_WALLPAPER_MAP[appearance.wallpaper] || appearance.wallpaper,
    outgoingColor: LEGACY_OUTGOING_MAP[appearance.outgoingColor] || appearance.outgoingColor,
  };
}

function findWallpaperOption(key?: string) {
  return WALLPAPER_OPTIONS.find((item) => item.key === key) || WALLPAPER_OPTIONS.find((item) => item.key === DEFAULT_CHAT_APPEARANCE.wallpaper)!;
}

export function getWallpaperColor(key?: string) {
  return findWallpaperOption(key).color;
}

export function getWallpaperCardColors(key?: string) {
  return findWallpaperOption(key).cardColors;
}

export function getWallpaperPreviewColors(key?: string) {
  return findWallpaperOption(key).previewColors;
}

export function getOutgoingBubbleColor(key?: string) {
  return OUTGOING_BUBBLE_OPTIONS.find((item) => item.key === key)?.color || Colors.primary;
}

export function getIncomingBubbleColor(key?: string) {
  return INCOMING_BUBBLE_OPTIONS.find((item) => item.key === key)?.color || Colors.white;
}

export function getBubbleRadius(key?: string) {
  if (key === 'classic') return 14;
  if (key === 'compact') return 12;
  return 18;
}

export function getBubbleTailRadius(key?: string) {
  if (key === 'compact') return 4;
  if (key === 'classic') return 6;
  return 6;
}

export function getTextSize(key?: string) {
  if (key === 'sm') return 13;
  if (key === 'lg') return 17;
  return 15;
}