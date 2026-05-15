import { Colors, FontSize, Radius } from '../theme';
import { DEFAULT_CHAT_APPEARANCE } from './settingsStorage';

export const WALLPAPER_OPTIONS = [
  { key: 'cream', label: 'Cream', color: Colors.background },
  { key: 'sand', label: 'Sand', color: '#F1E5CD' },
  { key: 'sage', label: 'Sage', color: '#E6EFE5' },
  { key: 'dusk', label: 'Dusk', color: '#E8E1F7' },
  { key: 'night', label: 'Night', color: '#E3E8F0' },
];

export const OUTGOING_BUBBLE_OPTIONS = [
  { key: 'gold', label: 'Gold', color: Colors.bubbleOut },
  { key: 'sage', label: 'Sage', color: '#DCEED7' },
  { key: 'rose', label: 'Rose', color: '#F8DDE4' },
  { key: 'violet', label: 'Violet', color: '#E7D9FF' },
];

export const INCOMING_BUBBLE_OPTIONS = [
  { key: 'white', label: 'White', color: Colors.bubbleIn },
  { key: 'linen', label: 'Linen', color: '#FFF8EC' },
  { key: 'mist', label: 'Mist', color: '#EEF2F7' },
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

export function normalizeChatAppearance(value: any) {
  return { ...DEFAULT_CHAT_APPEARANCE, ...(value || {}) };
}

export function getWallpaperColor(key?: string) {
  return WALLPAPER_OPTIONS.find((item) => item.key === key)?.color || Colors.background;
}

export function getOutgoingBubbleColor(key?: string) {
  return OUTGOING_BUBBLE_OPTIONS.find((item) => item.key === key)?.color || Colors.bubbleOut;
}

export function getIncomingBubbleColor(key?: string) {
  return INCOMING_BUBBLE_OPTIONS.find((item) => item.key === key)?.color || Colors.bubbleIn;
}

export function getBubbleRadius(key?: string) {
  if (key === 'classic') return Radius.md;
  if (key === 'compact') return Radius.sm;
  return Radius.lg;
}

export function getBubbleTailRadius(key?: string) {
  if (key === 'compact') return 6;
  if (key === 'classic') return 3;
  return 4;
}

export function getTextSize(key?: string) {
  if (key === 'sm') return FontSize.sm;
  if (key === 'lg') return FontSize.lg;
  return FontSize.base;
}