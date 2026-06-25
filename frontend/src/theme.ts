// Smilers theme constants — matches web app exactly.
//
// iter-169 WEB_PARITY_POLISH_CONTRACT — exact-value updates:
//   • App body  : oklch(0.96 0.012 90) ≈ #F4F1E8   (was #F5EFE0)
//   • Card/list : #FCFBF7                          (was #FFFFFF)
//   • Wallpaper : #F5F1E7                          (conversation message area)
//   • Header dark: oklch(0.35 0.08 85) ≈ #4A3917   (was #3A2608)
//   • Online dot: #22C55E (14px in chat list, smaller in chat header)
export const Colors = {
  primary: '#E4B53B',
  primaryLight: '#FEF3C7',
  primaryDark: '#C99A1F',
  // iter-169: brown header darkened from #3A2608 to web-canonical #4A3917
  // (oklch(0.35 0.08 85) on the web app). Keep `headerBgDeep` for the rare
  // accent that wants the original ink-dark tone (e.g. devotion screen).
  headerBg: '#4A3917',
  headerBgDeep: '#3A2608',
  // iter-169: app body switched to the canonical #F4F1E8.
  background: '#F4F1E8',
  // iter-169: list/settings "card" surface is the slightly-lighter #FCFBF7.
  // Most screens previously used `surface: '#FFFFFF'` which was too white;
  // this matches the web app's `--card` token.
  surface: '#FCFBF7',
  // iter-169: chat message-area wallpaper (the canvas behind bubbles).
  chatWallpaper: '#F5F1E7',
  textPrimary: '#1F2937',
  textSecondary: '#6B7280',
  textMuted: '#9CA3AF',
  danger: '#EF4444',
  dangerDark: '#DC2626',
  // iter-169: presence dot — canonical green per web parity contract.
  success: '#22C55E',
  // Warning (amber) — used by sync banners, "Saved on this device" badges, etc.
  warning: '#F59E0B',
  warningLight: '#FEF3C7',
  warningDark: '#92400E',
  // Diary tile (iter-109 — "personal notes" pinned conversation between
  // Smilers AI and Devotion). Indigo/blue palette per web app design.
  diary: '#3B82F6',
  diaryDark: '#2563EB',
  diaryLight: '#DBEAFE',
  diaryBadge: '#EEF2FF', // lavender-50, matches the "You" badge background
  diaryBadgeText: '#4338CA', // indigo-700, matches the "You" badge text
  aiBadge: '#A855F7',
  aiBadgeDark: '#7C3AED',
  chatOnce: '#F97316',
  chatOnceDark: '#EA580C',
  // Devotional broadcast — teal/sage to match web app design (iter-102).
  devotion: '#14B8A6',
  devotionDark: '#0D9488',
  // Devotion screen brown gradient header (iter-102 web parity).
  devotionHeaderTop: '#3D2A0F',
  devotionHeaderBottom: '#2A1B07',
  border: '#E5E7EB',
  borderLight: '#F3F4F6',
  iconBg: '#FEF3C7',
  iconColor: '#E4B53B',
  white: '#FFFFFF',
  black: '#000000',
  bubbleOut: '#FEF3C7',
  bubbleIn: '#FFFFFF',
  tickBlue: '#3b82f6',
  tickYellow: '#eab308',
  tickGreen: '#22c55e',
  tickRed: '#ef4444',
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

/**
 * iter-169 WEB_PARITY_POLISH_CONTRACT — Inter font family.
 *
 * The web app uses Inter exclusively (no Roboto/SF fallback). We load
 * Inter_300_Light, Inter_400_Regular, Inter_500_Medium, Inter_600_SemiBold,
 * and Inter_700_Bold via `@expo-google-fonts/inter` in the root layout's
 * `useFonts()` call.
 *
 * Usage:
 *   <Text style={{ fontFamily: FontFamily.regular }} />
 *   <Text style={{ fontFamily: FontFamily.semibold }} />  // titles
 *   <Text style={{ fontFamily: FontFamily.bold }} />      // strong emphasis
 *
 * Why per-weight family names instead of `fontWeight`?
 *   On Android, `fontWeight: '600'` on a custom-loaded font silently falls
 *   back to the system regular face — the only reliable way to render
 *   weight 600 is to load and reference the matching family ("Inter_600SemiBold").
 *   This pattern matches the official Expo Google Fonts guide.
 */
export const FontFamily = {
  light: 'Inter_300Light',
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
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
