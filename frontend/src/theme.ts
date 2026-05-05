// Smilers theme constants — matches web app exactly
export const Colors = {
  primary: '#E4B53B',
  primaryLight: '#FEF3C7',
  primaryDark: '#C99A1F',
  headerBg: '#3A2608',
  background: '#F5EFE0',
  surface: '#FFFFFF',
  textPrimary: '#1F2937',
  textSecondary: '#6B7280',
  textMuted: '#9CA3AF',
  danger: '#EF4444',
  dangerDark: '#DC2626',
  success: '#10B981',
  aiBadge: '#A855F7',
  aiBadgeDark: '#7C3AED',
  chatOnce: '#F97316',
  chatOnceDark: '#EA580C',
  border: '#E5E7EB',
  borderLight: '#F3F4F6',
  iconBg: '#FEF3C7',
  iconColor: '#E4B53B',
  white: '#FFFFFF',
  black: '#000000',
  bubbleOut: '#FEF3C7',
  bubbleIn: '#FFFFFF',
  tickBlue: '#2563EB',
  tickYellow: '#F59E0B',
  tickGray: '#6B7280',
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const Radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  pill: 999,
};

export const FontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  xxl: 24,
  xxxl: 30,
};

export const FontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

export const Shadow = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 6,
  },
};
