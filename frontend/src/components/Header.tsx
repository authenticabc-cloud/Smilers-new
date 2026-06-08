import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Spacing } from '../theme';

interface HeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  right?: React.ReactNode;
  // iter-140b: optional custom element on the LEFT side of the header,
  // mutually exclusive with `showBack`. Used by the Chats tab to show
  // the current user's profile avatar (matches the web app's layout).
  leftAction?: React.ReactNode;
  subtitle?: string;
  variant?: 'light' | 'dark';
}

export default function Header({
  title,
  showBack,
  onBack,
  right,
  leftAction,
  subtitle,
  variant = 'dark',
}: HeaderProps) {
  const isDark = variant === 'dark';
  const bg = isDark ? Colors.headerBg : Colors.surface;
  const fg = isDark ? Colors.white : Colors.textPrimary;

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <View style={styles.row}>
        {showBack ? (
          <TouchableOpacity onPress={onBack} style={styles.backBtn} testID="header-back">
            <Ionicons name="arrow-back" size={24} color={fg} />
          </TouchableOpacity>
        ) : leftAction ? (
          <View style={styles.leftAction}>{leftAction}</View>
        ) : (
          <View style={styles.sidePad} />
        )}
        <View style={styles.titleWrap}>
          <Text style={[styles.title, { color: fg }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: isDark ? Colors.primaryLight : Colors.textSecondary }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.right}>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: Spacing.base,
    paddingBottom: Spacing.md,
    paddingHorizontal: Spacing.base,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backBtn: {
    paddingRight: Spacing.md,
    paddingVertical: Spacing.xs,
  },
  sidePad: {
    width: 0,
  },
  leftAction: {
    // iter-140b: matches the standard back-button hit area so the
    // profile photo aligns with where the back chevron would otherwise
    // sit. Tap target stays inside the 44pt minimum.
    paddingRight: Spacing.md,
  },
  titleWrap: {
    flex: 1,
  },
  title: {
    fontSize: 18,
    fontWeight: FontWeight.bold,
  },
  subtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.base,
  },
});
