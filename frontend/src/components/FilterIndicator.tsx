import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import type { StyleProp, TextStyle } from 'react-native';

/**
 * FilterIndicator — the small funnel symbol shown beside a contact's name to
 * signal a "filter" relationship (the softer alternative to blocking).
 *
 * Color rules (native-filter-users-contract), driven by api.filtering.isFiltered
 * ({ iFilteredThem, theyFilteredMe }) from the CURRENT user's perspective:
 *   - BLACK  → I filtered them and they did NOT filter me back.
 *   - RED    → they filtered me (covers the mutual case too).
 *   - hidden → no filter in either direction.
 */

// "Dark" indicator tone. A softer slate-gray (not pure black) so it stays
// legible on BOTH the light profile background and the dark chat header,
// while still reading clearly as "dark, not red".
export const FILTER_BLACK = '#6B7280';
export const FILTER_RED = '#E5342B';

export function getFilterIndicatorColor(
  iFilteredThem?: boolean,
  theyFilteredMe?: boolean,
): string | null {
  if (theyFilteredMe) return FILTER_RED; // includes mutual
  if (iFilteredThem) return FILTER_BLACK;
  return null;
}

export default function FilterIndicator({
  iFilteredThem,
  theyFilteredMe,
  size = 15,
  style,
}: {
  iFilteredThem?: boolean;
  theyFilteredMe?: boolean;
  size?: number;
  style?: StyleProp<TextStyle>;
}) {
  const color = getFilterIndicatorColor(iFilteredThem, theyFilteredMe);
  if (!color) return null;
  return <Ionicons name="funnel" size={size} color={color} style={style} testID="filter-indicator" />;
}
