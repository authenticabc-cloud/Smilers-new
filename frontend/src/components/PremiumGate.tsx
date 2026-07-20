/**
 * PremiumGate — wraps a feature route to enforce Premium access.
 *
 * Mirrors the web app's `<PremiumGate>` (src/components/premium-gate.tsx).
 * Behavior:
 *   • Loading → skeleton placeholder
 *   • Has access + ≤7 days trial → amber "Trial ends in N days" banner above children
 *   • Has access → children directly (no UI noise)
 *   • No access → fullscreen upgrade prompt with Crown icon + 3 feature
 *     bullets + "View Plans" button → /premium
 */

import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Feather,
  MaterialCommunityIcons,
  Ionicons,
} from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { usePremiumAccess } from '../hooks/usePremiumAccess';
import { PREMIUM_PURCHASES_DISABLED_IOS } from '../lib/premium/iapCompliance';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

interface PremiumGateProps {
  children: ReactNode;
  /** Friendly feature name shown in the upgrade prompt (e.g. "Voice Tasks"). */
  featureName?: string;
}

const FEATURE_BULLETS: { icon: any; lib: 'feather' | 'mc' | 'ion'; label: string }[] = [
  { icon: 'shield', lib: 'feather', label: 'Emergency Features — Panic mode, alerts, safety tools' },
  { icon: 'microphone', lib: 'mc', label: 'Voice Tasks — Voice commands to call contacts' },
  { icon: 'chatbubbles', lib: 'ion', label: 'Chat Once — Temporary anonymous conversations' },
];

function BulletIcon({ entry, color }: { entry: typeof FEATURE_BULLETS[number]; color: string }) {
  if (entry.lib === 'mc') {
    return <MaterialCommunityIcons name={entry.icon} size={18} color={color} />;
  }
  if (entry.lib === 'ion') {
    return <Ionicons name={entry.icon} size={18} color={color} />;
  }
  return <Feather name={entry.icon} size={18} color={color} />;
}

export default function PremiumGate({ children, featureName }: PremiumGateProps) {
  const router = useRouter();
  const status = usePremiumAccess();

  // Loading skeleton
  if (status.isLoading) {
    return (
      <View style={styles.loadingWrap} testID="premium-gate-loading">
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  // Premium granted — possibly with trial-ending banner.
  if (status.hasAccess) {
    const showTrialBanner =
      status.reason === 'trial' &&
      typeof status.daysRemaining === 'number' &&
      status.daysRemaining <= 7;
    if (showTrialBanner) {
      return (
        <View style={{ flex: 1 }}>
          <TrialEndingBanner
            daysRemaining={status.daysRemaining!}
            onView={() => router.push('/premium' as any)}
          />
          <View style={{ flex: 1 }}>{children}</View>
        </View>
      );
    }
    return <>{children}</>;
  }

  // No access — fullscreen upgrade prompt.
  return (
    <View style={styles.upgradeRoot} testID="premium-gate-upgrade">
      <SafeAreaView edges={['top']} style={styles.upgradeHeader}>
        <TouchableOpacity
          style={styles.upgradeBackBtn}
          onPress={() => router.back()}
          hitSlop={10}
          testID="premium-gate-back"
        >
          <Feather name="arrow-left" size={22} color={Colors.white} />
        </TouchableOpacity>
        <MaterialCommunityIcons name="crown" size={24} color={Colors.white} />
        <Text style={styles.upgradeHeaderTitle}>Premium Required</Text>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.upgradeContent}>
        <View style={styles.crownCircle}>
          <MaterialCommunityIcons name="crown" size={56} color="#3D2A00" />
        </View>

        <Text style={styles.upgradeHeading}>
          {featureName || 'This feature'} is a Premium feature
        </Text>
        <Text style={styles.upgradeBody}>
          {PREMIUM_PURCHASES_DISABLED_IOS
            ? 'This is a Premium feature. Premium purchases aren\u2019t available in the iOS app right now — if you already have Premium, it stays active here.'
            : status.reason === 'expired'
              ? 'Your trial or subscription has expired. Subscribe or redeem a license code to unlock all Premium features.'
              : 'Get access to all Premium features with a single subscription. Cancel any time.'}
        </Text>

        <View style={styles.bulletList}>
          {FEATURE_BULLETS.map((entry, idx) => (
            <View key={idx} style={styles.bulletRow}>
              <View style={styles.bulletIconWrap}>
                <BulletIcon entry={entry} color={Colors.primary} />
              </View>
              <Text style={styles.bulletText}>{entry.label}</Text>
            </View>
          ))}
        </View>

        {!PREMIUM_PURCHASES_DISABLED_IOS ? (
          <>
            <TouchableOpacity
              style={styles.upgradeCta}
              onPress={() => router.push('/premium' as any)}
              activeOpacity={0.85}
              testID="premium-gate-view-plans"
            >
              <MaterialCommunityIcons name="crown" size={20} color="#3D2A00" />
              <Text style={styles.upgradeCtaText}>View Plans</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.upgradeSecondary}
              onPress={() => router.push('/premium?redeem=1' as any)}
              activeOpacity={0.85}
            >
              <Feather name="gift" size={16} color={Colors.textSecondary} />
              <Text style={styles.upgradeSecondaryText}>Have a code? Redeem here</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function TrialEndingBanner({
  daysRemaining,
  onView,
}: {
  daysRemaining: number;
  onView: () => void;
}) {
  return (
    <View style={styles.trialBanner} testID="premium-trial-banner">
      <MaterialCommunityIcons name="clock-alert" size={18} color="#92400E" />
      <Text style={styles.trialBannerText}>
        Trial ends in {daysRemaining} day{daysRemaining === 1 ? '' : 's'}
      </Text>
      {!PREMIUM_PURCHASES_DISABLED_IOS ? (
        <TouchableOpacity style={styles.trialBannerCta} onPress={onView} activeOpacity={0.85}>
          <Text style={styles.trialBannerCtaText}>View plans</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.background },

  // Upgrade prompt
  upgradeRoot: { flex: 1, backgroundColor: Colors.background },
  upgradeHeader: {
    backgroundColor: '#3D2A00',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: 80,
  },
  upgradeBackBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  upgradeHeaderTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.white, flex: 1 },

  upgradeContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.xl,
    alignItems: 'center',
    gap: 16,
  },
  crownCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  upgradeHeading: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  upgradeBody: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 12,
  },
  bulletList: {
    width: '100%',
    gap: 14,
    marginTop: 12,
    marginBottom: 4,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#EBE5D5',
  },
  bulletIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulletText: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    lineHeight: 20,
  },
  upgradeCta: {
    marginTop: 18,
    minHeight: 54,
    width: '100%',
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  upgradeCtaText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#3D2A00' },
  upgradeSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  upgradeSecondaryText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.semibold },

  // Trial banner
  trialBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FEF3C7',
    borderBottomWidth: 1,
    borderBottomColor: '#FCD34D',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  trialBannerText: { flex: 1, fontSize: FontSize.sm, color: '#92400E', fontWeight: FontWeight.semibold },
  trialBannerCta: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#92400E',
    borderRadius: Radius.pill,
  },
  trialBannerCtaText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.xs },
});
