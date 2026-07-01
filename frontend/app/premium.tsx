/**
 * Premium subscription page — mirrors the web app's `/premium`.
 *
 * Layout:
 *   • Brown header with crown + "Premium" + back button
 *   • Status banner:
 *       - Premium Active (license) — gold pill with crown
 *       - Trial (N days remaining) — amber pill with clock-alert
 *       - Expired / No access — neutral pill prompting subscription
 *   • Three plan cards: Monthly €3 / 6 Months €15 / Yearly €24 (Best value, highlighted)
 *   • Subscribe button → checkoutPremium action → opens Hercules Commerce URL
 *     in an in-app browser, returns to the app via a deep link on success
 *   • License code redemption block
 *
 * Pricing: €3/month, €15/6 months, €24/year (from web app agent's spec).
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAction, useMutation } from 'convex/react';
import * as WebBrowser from 'expo-web-browser';
import * as ExpoLinking from 'expo-linking';
import { api } from '../src/convexApi';
import { usePremiumAccess } from '../src/hooks/usePremiumAccess';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

interface PlanOption {
  key: 'monthly' | '6months' | 'yearly';
  variantId: string;
  label: string;
  priceLabel: string;
  perMonth: string;
  savings?: string;
  highlighted?: boolean;
}

const PLANS: PlanOption[] = [
  {
    key: 'monthly',
    variantId: 'var_premium_monthly',
    label: 'Monthly',
    priceLabel: '€3',
    perMonth: '/month',
  },
  {
    key: '6months',
    variantId: 'var_premium_6months',
    label: '6 Months',
    priceLabel: '€15',
    perMonth: '/6 months',
    savings: 'Save 17%',
  },
  {
    key: 'yearly',
    variantId: 'var_premium_yearly',
    label: 'Yearly',
    priceLabel: '€24',
    perMonth: '/year',
    savings: 'Best value · Save 33%',
    highlighted: true,
  },
];

function statusLabel(status: ReturnType<typeof usePremiumAccess>): {
  text: string;
  sub: string;
  variant: 'active' | 'trial' | 'expired';
  icon: any;
} {
  if (status.hasAccess && status.reason === 'license') {
    return {
      text: 'Premium Active',
      sub:
        status.licenseType === 'lifetime'
          ? 'Lifetime license'
          : status.expiresAt
            ? `License active until ${new Date(status.expiresAt).toLocaleDateString()}`
            : 'License active',
      variant: 'active',
      icon: 'crown',
    };
  }
  if (status.hasAccess && status.reason === 'subscription') {
    return {
      text: 'Premium Active',
      sub: 'Subscription is active. Manage from your Commerce dashboard.',
      variant: 'active',
      icon: 'crown',
    };
  }
  if (status.hasAccess && status.reason === 'trial') {
    return {
      text: 'Free Trial',
      sub:
        typeof status.daysRemaining === 'number'
          ? `${status.daysRemaining} day${status.daysRemaining === 1 ? '' : 's'} remaining`
          : '30 day free trial',
      variant: 'trial',
      icon: 'clock-alert',
    };
  }
  return {
    text: 'Not subscribed',
    sub: 'Pick a plan below or redeem a code to unlock Premium.',
    variant: 'expired',
    icon: 'lock',
  };
}

export default function PremiumPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { redeem: shouldShowRedeem, success } = useLocalSearchParams<{
    redeem?: string;
    success?: string;
  }>();
  const status = usePremiumAccess();
  const [selectedKey, setSelectedKey] = useState<PlanOption['key']>('yearly');
  const [redeemCodeInput, setRedeemCodeInput] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [showRedeem, setShowRedeem] = useState(shouldShowRedeem === '1');

  // Mutations + actions — wrapped in `as any` so missing backend functions
  // don't crash the hook setup.
  const redeemLicense = useMutation((api as any).premium?.redeemLicenseCode);
  const checkoutAction = useAction(
    (api as any).premiumAction?.checkoutPremium,
  );

  useEffect(() => {
    if (success === 'true') {
      Alert.alert(
        'Premium activated',
        'Your subscription is now active. Welcome to Premium!',
        [{ text: 'OK', onPress: () => status.refresh() }],
      );
    }
  }, [success, status]);

  const selectedPlan = useMemo(
    () => PLANS.find((p) => p.key === selectedKey) || PLANS[2],
    [selectedKey],
  );

  const status_ = statusLabel(status);

  const handleSubscribe = async () => {
    setCheckingOut(true);
    try {
      // Deep links back into the app so the subscriber returns straight here
      // (mirrors the ad-clicks checkout). Hercules Commerce redirects the
      // browser to these exact URLs, which the in-app browser intercepts.
      const redirectUrl = ExpoLinking.createURL('premium-return');
      const successUrl = `${redirectUrl}?status=success`;
      const cancelUrl = `${redirectUrl}?status=cancel`;
      const result: any = await (checkoutAction as any)({
        variantId: selectedPlan.variantId,
        successUrl,
        cancelUrl,
      });
      const url =
        result?.url || result?.checkoutUrl || result?.redirectUrl || null;
      if (!url) {
        Alert.alert(
          'Couldn\u2019t open checkout',
          'The backend didn\u2019t return a Commerce checkout URL. Please try again or use a license code.',
        );
        return;
      }
      const browserResult = await WebBrowser.openAuthSessionAsync(url, redirectUrl);
      if (browserResult.type === 'success' && browserResult.url) {
        const { queryParams } = ExpoLinking.parse(browserResult.url);
        if (queryParams?.status === 'cancel') {
          // User backed out — no change, stay quiet.
        } else {
          // Activation happens server-side via Commerce; refresh to pick it up
          // (getPremiumStatus is reactive + has a subscription re-check).
          status.refresh();
          Alert.alert(
            'Premium activated',
            'Your subscription is now active. Welcome to Premium!',
          );
        }
      }
      // type 'dismiss'/'cancel' (closed the browser): leave status untouched.
    } catch (errorValue: any) {
      const message = String(errorValue?.message || errorValue || '');
      const isMissing =
        message.includes('CouldNotFindFunction') ||
        message.toLowerCase().includes('not found');
      Alert.alert(
        'Subscribe is not ready yet',
        isMissing
          ? 'The Convex `premiumAction.checkoutPremium` action hasn\u2019t been deployed yet. Once the web team ships it, this button will open the Hercules Commerce checkout for the selected plan.'
          : `Could not start checkout: ${message.slice(0, 120)}`,
      );
    } finally {
      setCheckingOut(false);
    }
  };

  const handleRedeem = async () => {
    const code = redeemCodeInput.trim().toUpperCase();
    if (!code) {
      Alert.alert('Enter a code', 'Paste your PRE-XXX-XXX code to continue.');
      return;
    }
    // If Premium is already active, the backend rejects a re-redeem with a raw
    // server error. Short-circuit with a friendly message instead.
    if (status.hasAccess) {
      Alert.alert(
        'Premium already active',
        'Your account already has Premium, so there\u2019s nothing more to redeem. Enjoy!',
      );
      setRedeemCodeInput('');
      return;
    }
    setRedeeming(true);
    try {
      const result: any = await (redeemLicense as any)({ code });
      const ok =
        result === null ||
        result === true ||
        (typeof result === 'object' && (result.success || result.redeemed || result.licenseType));
      if (ok) {
        Alert.alert('Code redeemed', 'Premium is now active on your account.');
        setRedeemCodeInput('');
        status.refresh();
      } else {
        Alert.alert(
          'Could not redeem',
          'The code could not be validated. Please check it and try again.',
        );
      }
    } catch (errorValue: any) {
      const message = String(errorValue?.message || errorValue || '');
      const lower = message.toLowerCase();
      const isMissing =
        message.includes('CouldNotFindFunction') || lower.includes('not found');
      const isAlreadyUsed =
        lower.includes('already') || lower.includes('redeemed') || lower.includes('used');
      const isInvalid = lower.includes('invalid') || lower.includes('expired');
      let friendly: string;
      if (isMissing) {
        friendly =
          'The Convex `premium.redeemLicenseCode` mutation hasn\u2019t been deployed yet. Once the web team ships it, this redemption flow will validate your code.';
      } else if (isAlreadyUsed) {
        friendly =
          'This code has already been redeemed. If your Premium is active, you\u2019re all set \u2014 no need to redeem again.';
      } else if (isInvalid) {
        friendly = 'This code is invalid or has expired. Please double-check it and try again.';
      } else {
        // Raw Convex "Server Error" (e.g. code already used) — hide the noisy
        // request-id trace behind a clean, reassuring message.
        friendly =
          'We couldn\u2019t redeem this code. It may already have been used or is no longer valid. If your Premium is already active, you\u2019re all set.';
      }
      Alert.alert('Could not redeem code', friendly);
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <View style={styles.container} testID="premium-page">
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            style={styles.headerBackBtn}
            onPress={() => router.back()}
            hitSlop={10}
            testID="premium-back"
          >
            <Feather name="arrow-left" size={22} color={Colors.white} />
          </TouchableOpacity>
          <MaterialCommunityIcons name="crown" size={26} color={Colors.white} />
          <Text style={styles.headerTitle}>Premium</Text>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom, 24) + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Status pill */}
        <View
          style={[
            styles.statusCard,
            status_.variant === 'active' ? styles.statusCardActive : null,
            status_.variant === 'trial' ? styles.statusCardTrial : null,
            status_.variant === 'expired' ? styles.statusCardExpired : null,
          ]}
          testID={`premium-status-${status_.variant}`}
        >
          <MaterialCommunityIcons
            name={status_.icon}
            size={28}
            color={
              status_.variant === 'active'
                ? '#3D2A00'
                : status_.variant === 'trial'
                  ? '#92400E'
                  : Colors.textSecondary
            }
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.statusText}>{status_.text}</Text>
            <Text style={styles.statusSub}>{status_.sub}</Text>
          </View>
        </View>

        {!status.hasAccess || status.reason === 'trial' ? (
          <>
            <Text style={styles.sectionLabel}>CHOOSE A PLAN</Text>
            <View style={styles.plansList}>
              {PLANS.map((plan) => {
                const isSelected = selectedKey === plan.key;
                return (
                  <TouchableOpacity
                    key={plan.key}
                    style={[
                      styles.planCard,
                      isSelected ? styles.planCardSelected : null,
                      plan.highlighted ? styles.planCardHighlighted : null,
                    ]}
                    onPress={() => setSelectedKey(plan.key)}
                    activeOpacity={0.85}
                    testID={`premium-plan-${plan.key}`}
                  >
                    {plan.highlighted ? (
                      <View style={styles.bestValueBadge}>
                        <Text style={styles.bestValueText}>BEST VALUE</Text>
                      </View>
                    ) : null}
                    <View style={styles.planRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.planLabel}>{plan.label}</Text>
                        {plan.savings ? (
                          <Text
                            style={[
                              styles.planSavings,
                              plan.highlighted ? styles.planSavingsHighlighted : null,
                            ]}
                          >
                            {plan.savings}
                          </Text>
                        ) : null}
                      </View>
                      <View style={styles.planPriceWrap}>
                        <Text style={styles.planPrice}>{plan.priceLabel}</Text>
                        <Text style={styles.planPerMonth}>{plan.perMonth}</Text>
                      </View>
                      <View
                        style={[
                          styles.planRadio,
                          isSelected ? styles.planRadioSelected : null,
                        ]}
                      >
                        {isSelected ? (
                          <View style={styles.planRadioDot} />
                        ) : null}
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity
              style={[styles.subscribeBtn, checkingOut ? styles.subscribeBtnLoading : null]}
              onPress={handleSubscribe}
              disabled={checkingOut}
              activeOpacity={0.85}
              testID="premium-subscribe"
            >
              {checkingOut ? (
                <ActivityIndicator color="#3D2A00" />
              ) : (
                <>
                  <MaterialCommunityIcons name="crown" size={20} color="#3D2A00" />
                  <Text style={styles.subscribeBtnText}>
                    Subscribe — {selectedPlan.priceLabel} {selectedPlan.perMonth}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </>
        ) : null}

        {/* Premium includes section (always shown) */}
        <Text style={[styles.sectionLabel, { marginTop: Spacing.xl }]}>PREMIUM INCLUDES</Text>
        <View style={styles.includesList}>
          <IncludeRow
            iconBg="#FEE2E2"
            iconColor="#DC2626"
            icon="shield"
            title="Emergency Features"
            subtitle="Panic mode, alerts, and safety tools"
          />
          <IncludeRow
            iconBg="#DBEAFE"
            iconColor="#1D4ED8"
            icon="microphone"
            title="Voice Tasks"
            subtitle="Voice commands to call contacts"
            iconLib="mc"
          />
          <IncludeRow
            iconBg="#EDE9FE"
            iconColor="#6D28D9"
            icon="chatbubbles"
            title="Chat Once"
            subtitle="Temporary anonymous conversations"
            iconLib="ion"
          />
          <IncludeRow
            iconBg="#D1FAE5"
            iconColor="#0F766E"
            icon="face-recognition"
            title="Face Verification"
            subtitle="Secure your account with a face check on new devices"
            iconLib="mc"
          />
        </View>

        {/* Redeem code block — hidden once Premium is already active, since a
            re-redeem always fails on the backend. */}
        {!status.hasAccess ? (
          <TouchableOpacity
            style={styles.redeemHeader}
            onPress={() => setShowRedeem((v) => !v)}
            activeOpacity={0.85}
            testID="premium-redeem-toggle"
          >
            <Feather name="gift" size={20} color={Colors.primary} />
            <Text style={styles.redeemHeaderText}>Have a code? Redeem here</Text>
            <Feather
              name={showRedeem ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={Colors.textSecondary}
            />
          </TouchableOpacity>
        ) : null}

        {!status.hasAccess && showRedeem ? (
          <View style={styles.redeemForm}>
            <TextInput
              style={styles.redeemInput}
              value={redeemCodeInput}
              onChangeText={setRedeemCodeInput}
              placeholder="PRE-XXX-XXX"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              testID="premium-redeem-input"
            />
            <TouchableOpacity
              style={[styles.redeemSubmit, redeeming ? styles.subscribeBtnLoading : null]}
              onPress={handleRedeem}
              disabled={redeeming}
              activeOpacity={0.85}
              testID="premium-redeem-submit"
            >
              {redeeming ? (
                <ActivityIndicator color="#3D2A00" />
              ) : (
                <Text style={styles.redeemSubmitText}>Redeem</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function IncludeRow({
  icon,
  iconBg,
  iconColor,
  title,
  subtitle,
  iconLib,
}: {
  icon: any;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
  iconLib?: 'feather' | 'mc' | 'ion';
}) {
  const renderIcon = () => {
    if (iconLib === 'mc') {
      return <MaterialCommunityIcons name={icon} size={18} color={iconColor} />;
    }
    if (iconLib === 'ion') {
      // ion icons aren't imported separately to keep the bundle lean.
      // Reuse Feather's chat icon as a close-enough surrogate.
      return <Feather name="message-circle" size={18} color={iconColor} />;
    }
    return <Feather name={icon} size={18} color={iconColor} />;
  };
  return (
    <View style={styles.includeRow}>
      <View style={[styles.includeIconWrap, { backgroundColor: iconBg }]}>
        {renderIcon()}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.includeTitle}>{title}</Text>
        <Text style={styles.includeSub}>{subtitle}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  // Header
  headerSafe: { backgroundColor: Colors.headerBg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
    minHeight: 80,
  },
  headerBackBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.white, flex: 1 },

  scrollContent: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: 12 },

  // Status
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: Radius.lg,
    borderWidth: 1,
    backgroundColor: Colors.surface,
    borderColor: '#EBE5D5',
  },
  statusCardActive: { backgroundColor: '#FBEFC9', borderColor: '#F4DC8A' },
  statusCardTrial: { backgroundColor: '#FEF3C7', borderColor: '#FCD34D' },
  statusCardExpired: { backgroundColor: '#F3F4F6', borderColor: '#D1D5DB' },
  statusText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  statusSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },

  // Section labels
  sectionLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.1,
    marginTop: Spacing.lg,
    marginBottom: 8,
  },

  // Plan cards
  plansList: { gap: 12 },
  planCard: {
    paddingHorizontal: 14,
    paddingVertical: 16,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderColor: '#EBE5D5',
    backgroundColor: Colors.surface,
    position: 'relative',
  },
  planCardSelected: { borderColor: Colors.primary, backgroundColor: '#FFF7DE' },
  planCardHighlighted: { borderColor: Colors.primary },
  bestValueBadge: {
    position: 'absolute',
    top: -10,
    right: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: Colors.primary,
    borderRadius: Radius.pill,
  },
  bestValueText: { color: '#3D2A00', fontWeight: FontWeight.bold, fontSize: 11, letterSpacing: 0.6 },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  planLabel: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  planSavings: { marginTop: 2, fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  planSavingsHighlighted: { color: '#92400E' },
  planPriceWrap: { alignItems: 'flex-end' },
  planPrice: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  planPerMonth: { fontSize: FontSize.xs, color: Colors.textSecondary },
  planRadio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  planRadioSelected: { borderColor: Colors.primary },
  planRadioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },

  // Subscribe button
  subscribeBtn: {
    marginTop: 12,
    minHeight: 56,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  subscribeBtnLoading: { opacity: 0.85 },
  subscribeBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#3D2A00' },

  // Includes
  includesList: { gap: 10 },
  includeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: '#EBE5D5',
  },
  includeIconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  includeTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  includeSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },

  // Redeem block
  redeemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 14,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#D1A800',
    backgroundColor: 'transparent',
    marginTop: Spacing.lg,
  },
  redeemHeaderText: { flex: 1, fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  redeemForm: { marginTop: 10, gap: 10 },
  redeemInput: {
    minHeight: 50,
    paddingHorizontal: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#EBE5D5',
    backgroundColor: Colors.surface,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    letterSpacing: 1.2,
  },
  redeemSubmit: {
    minHeight: 50,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  redeemSubmitText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#3D2A00' },
});
