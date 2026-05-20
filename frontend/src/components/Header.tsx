import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Spacing } from '../theme';

interface HeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  right?: React.ReactNode;
  subtitle?: string;
  variant?: 'light' | 'dark';
}

export default function Header({ title, showBack, onBack, right, subtitle, variant = 'dark' }: HeaderProps) {
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
