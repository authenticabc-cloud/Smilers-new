import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

interface Props {
  title: string;
  description: string;
  icon?: string;
  iconLib?: 'ion' | 'mc';
}

export default function ComingSoon({
  title,
  description,
  icon = 'sparkles-outline',
  iconLib = 'ion',
}: Props) {
  const router = useRouter();
  const Icon: any = iconLib === 'mc' ? MaterialCommunityIcons : Ionicons;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="coming-soon-screen">
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.back}
          testID="coming-soon-back-button"
        >
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} testID="coming-soon-header-title">
          {title}
        </Text>
        <View style={styles.back} />
      </View>
      <View style={styles.body}>
        <View style={styles.iconCircle} testID="coming-soon-icon-circle">
          <Icon name={icon as any} size={64} color={Colors.primary} />
        </View>
        <Text style={styles.title} testID="coming-soon-title">
          {title}
        </Text>
        <Text style={styles.subtitle} testID="coming-soon-description">
          {description}
        </Text>
        <View style={styles.badge} testID="coming-soon-badge">
          <Ionicons name="time-outline" size={14} color={Colors.white} />
          <Text style={styles.badgeText}>Coming soon</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#00000022',
  },
  back: {
    width: 40,
    minHeight: 44,
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
    gap: 16,
  },
  iconCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.base,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    marginTop: Spacing.base,
  },
  badgeText: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
    fontSize: FontSize.sm,
  },
});