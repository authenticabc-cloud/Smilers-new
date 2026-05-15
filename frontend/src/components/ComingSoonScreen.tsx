import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from './Header';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

type IconLib = 'ion' | 'mc';

interface ComingSoonScreenProps {
  title: string;
  tagline: string;
  description: string;
  icon: string;
  iconLib?: IconLib;
  bullets?: string[];
  testID?: string;
}

export default function ComingSoonScreen({
  title,
  tagline,
  description,
  icon,
  iconLib = 'ion',
  bullets,
  testID,
}: ComingSoonScreenProps) {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID={testID || 'coming-soon-screen'}>
      <Header title={title} showBack onBack={() => router.back()} variant="dark" />
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          {iconLib === 'mc' ? (
            <MaterialCommunityIcons name={icon as any} size={56} color={Colors.primary} />
          ) : (
            <Ionicons name={icon as any} size={56} color={Colors.primary} />
          )}
        </View>
        <Text style={styles.tagline}>{tagline}</Text>
        <Text style={styles.description}>{description}</Text>
        {bullets && bullets.length > 0 ? (
          <View style={styles.bulletList}>
            {bullets.map((b, i) => (
              <View key={i} style={styles.bulletRow}>
                <View style={styles.bulletDot} />
                <Text style={styles.bulletText}>{b}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.badge}>
          <Ionicons name="sparkles-outline" size={14} color={Colors.primaryDark} />
          <Text style={styles.badgeText}>Coming soon</Text>
        </View>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.8}>
          <Text style={styles.backBtnText}>Back to Settings</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  body: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    gap: Spacing.md,
  },
  iconWrap: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  tagline: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  description: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  bulletList: {
    alignSelf: 'stretch',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    marginTop: Spacing.sm,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  bulletDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primary,
    marginTop: 7,
  },
  bulletText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    marginTop: Spacing.sm,
  },
  badgeText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.primaryDark,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  backBtn: {
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.headerBg,
  },
  backBtnText: {
    color: Colors.white,
    fontWeight: FontWeight.semibold,
    fontSize: FontSize.base,
  },
});
