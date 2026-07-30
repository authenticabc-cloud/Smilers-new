/**
 * Mobile Money payment request flow (user-facing).
 * Pick plan → pick country (currency) → optional pay-from phone → see ≈ estimate
 * → confirm → createRequest (authoritative amount) → success. Also lists the
 * user's own requests with live status. Admin completes/declines manually.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useAction, useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../src/theme';
import {
  MOBILE_MONEY_COUNTRIES,
  PREMIUM_PLANS,
  currencyForCountry,
  estimateLocalAmount,
  formatLocalAmount,
} from '../src/lib/mobileMoney';
import { friendlyConvexError } from '../src/lib/friendlyError';
import { PREMIUM_PURCHASES_DISABLED_IOS } from '../src/lib/premium/iapCompliance';

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    pending: { bg: '#FFF4E5', fg: '#B26A00', label: 'Pending' },
    completed: { bg: '#E7F6EC', fg: '#1B7F3B', label: 'Completed' },
    declined: { bg: '#FDECEC', fg: Colors.danger, label: 'Declined' },
    cancelled: { bg: '#EEE', fg: Colors.textSecondary, label: 'Cancelled' },
  };
  const s = map[status] || map.cancelled;
  return (
    <View style={[styles.pill, { backgroundColor: s.bg }]}>
      <Text style={[styles.pillText, { color: s.fg }]}>{s.label}</Text>
    </View>
  );
}

export default function MobileMoneyScreen() {
  // iOS App Store compliance: Mobile Money is a premium-purchase path, which is
  // not permitted for in-app digital goods on iOS. Show a neutral notice instead
  // (Platform.OS is constant for the app's lifetime, so this early return keeps
  // hook order consistent per platform). Android/web render the full flow.
  if (PREMIUM_PURCHASES_DISABLED_IOS) {
    return (
      <View style={styles.iosBlockRoot} testID="mobile-money-ios-blocked">
        <SafeAreaView edges={['top']} style={styles.iosBlockHeader}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.iosBlockBack}>
            <Ionicons name="arrow-back" size={22} color={Colors.white} />
          </TouchableOpacity>
          <Text style={styles.iosBlockHeaderTitle}>Premium</Text>
        </SafeAreaView>
        <View style={styles.iosBlockBody}>
          <Ionicons name="information-circle-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.iosBlockText}>
            Premium purchases aren&apos;t available in the iOS app right now. If you already have
            Premium, it stays active here.
          </Text>
        </View>
      </View>
    );
  }
  const params = useLocalSearchParams<{ variantId?: string; planLabel?: string; eur?: string }>();
  const planKeys = Object.keys(PREMIUM_PLANS);
  const [variantId, setVariantId] = useState<string>(
    params.variantId && PREMIUM_PLANS[params.variantId] ? params.variantId : 'var_premium_yearly',
  );
  const [countryCode, setCountryCode] = useState('KE');
  const [phone, setPhone] = useState('');
  const [showCountry, setShowCountry] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ amount: number; currency: string; planLabel: string } | null>(null);

  const createRequest = useAction((api as any).mobileMoneyRequests?.createRequest);
  const myRequests = useQuery((api as any).mobileMoneyRequests?.getMyRequests, {}) as any[] | undefined;

  const plan = PREMIUM_PLANS[variantId];
  const currency = currencyForCountry(countryCode);
  const country = MOBILE_MONEY_COUNTRIES.find((c) => c.code === countryCode);
  const estimate = useMemo(
    () => estimateLocalAmount(plan.eur, currency),
    [plan.eur, currency],
  );

  const submit = () => {
    Alert.alert(
      'Send payment request?',
      `Plan: ${plan.label} (€${plan.eur})\nCountry: ${country?.name}\nEstimated total: ≈ ${formatLocalAmount(estimate, currency)}\n\nAn admin will contact you with mobile money details to complete the payment.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send request',
          onPress: async () => {
            setSubmitting(true);
            try {
              const res: any = await createRequest({
                variantId,
                country: countryCode,
                phone: phone.trim() ? phone.trim() : undefined,
              });
              setSuccess({
                amount: res?.amount ?? estimate,
                currency: res?.currency ?? currency,
                planLabel: plan.label,
              });
            } catch (e: any) {
              Alert.alert('Could not send request', friendlyConvexError(e, 'Please try again.'));
            } finally {
              setSubmitting(false);
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="mobile-money-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="mm-back">
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Mobile Money</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView style={styles.flexOne} behavior="padding">
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {success ? (
            <View style={styles.successCard} testID="mm-success">
              <Ionicons name="checkmark-circle" size={56} color={Colors.primary} />
              <Text style={styles.successTitle}>Request received</Text>
              <Text style={styles.successAmount}>{formatLocalAmount(success.amount, success.currency)}</Text>
              <Text style={styles.successBody}>
                Your {success.planLabel} request has been sent. An admin will message you shortly with the
                mobile money number to complete your payment. Your plan activates automatically once the
                admin confirms.
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => setSuccess(null)} testID="mm-done">
                <Text style={styles.primaryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={styles.sectionTitle}>Choose duration</Text>
              <View style={styles.planRow}>
                {planKeys.map((k) => {
                  const p = PREMIUM_PLANS[k];
                  const active = variantId === k;
                  return (
                    <TouchableOpacity
                      key={k}
                      style={[styles.planCard, active ? styles.planCardActive : null]}
                      onPress={() => setVariantId(k)}
                      testID={`mm-plan-${k}`}
                    >
                      <Text style={[styles.planName, active ? styles.planNameActive : null]}>{p.label}</Text>
                      <Text style={[styles.planPrice, active ? styles.planNameActive : null]}>€{p.eur}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.sectionTitle}>Your country</Text>
              <TouchableOpacity style={styles.pickerRow} onPress={() => setShowCountry(true)} testID="mm-country">
                <Text style={styles.pickerValue}>
                  {country ? `${country.name} (${country.currency})` : 'Select country'}
                </Text>
                <Ionicons name="chevron-down" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>

              <Text style={styles.sectionTitle}>Mobile money number (optional)</Text>
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={setPhone}
                placeholder="e.g. 0712345678"
                placeholderTextColor={Colors.textMuted}
                keyboardType="phone-pad"
                testID="mm-phone"
              />
              <Text style={styles.hint}>Helps the admin match your payment. You can leave this blank.</Text>

              <View style={styles.estimateBox}>
                <Text style={styles.estimateLabel}>Estimated total</Text>
                <Text style={styles.estimateAmount}>≈ {formatLocalAmount(estimate, currency)}</Text>
                <Text style={styles.estimateSub}>{plan.label} · €{plan.eur} · final amount confirmed on submit</Text>
              </View>

              <TouchableOpacity
                style={[styles.primaryBtn, submitting ? styles.primaryBtnDisabled : null]}
                onPress={submit}
                disabled={submitting}
                testID="mm-submit"
              >
                {submitting ? (
                  <ActivityIndicator color={Colors.white} />
                ) : (
                  <Text style={styles.primaryBtnText}>Request with mobile money</Text>
                )}
              </TouchableOpacity>
            </>
          )}

          {/* My requests */}
          {Array.isArray(myRequests) && myRequests.length > 0 ? (
            <View style={styles.myRequests}>
              <Text style={styles.sectionTitle}>Your requests</Text>
              {myRequests.map((r: any) => (
                <View key={String(r._id)} style={styles.reqRow} testID={`mm-my-${String(r._id).slice(-6)}`}>
                  <View style={styles.flexOne}>
                    <Text style={styles.reqPlan}>{r.planLabel || r.variantId}</Text>
                    <Text style={styles.reqAmount}>{formatLocalAmount(r.amount, r.currency)} · {r.country}</Text>
                  </View>
                  <StatusPill status={r.status} />
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Country picker */}
      <Modal visible={showCountry} transparent animationType="slide" onRequestClose={() => setShowCountry(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowCountry(false)}>
          <Pressable style={styles.countrySheet} onPress={() => {}}>
            <Text style={styles.countryTitle}>Select country</Text>
            <ScrollView>
              {MOBILE_MONEY_COUNTRIES.map((c) => (
                <TouchableOpacity
                  key={c.code}
                  style={styles.countryRow}
                  onPress={() => {
                    setCountryCode(c.code);
                    setShowCountry(false);
                  }}
                  testID={`mm-country-${c.code}`}
                >
                  <Text style={styles.countryName}>{c.name}</Text>
                  <Text style={styles.countryCurrency}>{c.currency}</Text>
                  {countryCode === c.code ? (
                    <Ionicons name="checkmark" size={18} color={Colors.primary} />
                  ) : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flexOne: { flex: 1 },
  iosBlockRoot: { flex: 1, backgroundColor: Colors.background },
  iosBlockHeader: {
    backgroundColor: Colors.headerBg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: 80,
  },
  iosBlockBack: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  iosBlockHeaderTitle: { fontSize: 20, fontWeight: FontWeight.bold, color: Colors.white },
  iosBlockBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  iosBlockText: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  scroll: { padding: Spacing.base, paddingBottom: 48 },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  planRow: { flexDirection: 'row', gap: 10 },
  planCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingVertical: 16,
    alignItems: 'center',
  },
  planCardActive: { borderColor: Colors.primary, backgroundColor: '#F4FBF6' },
  planName: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  planNameActive: { color: Colors.primary },
  planPrice: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: 4 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  pickerValue: { fontSize: FontSize.base, color: Colors.textPrimary },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  hint: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 6 },
  estimateBox: {
    backgroundColor: '#F4FBF6',
    borderRadius: Radius.md,
    padding: Spacing.base,
    marginTop: Spacing.lg,
    alignItems: 'center',
  },
  estimateLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  estimateAmount: { fontSize: 28, fontWeight: FontWeight.bold, color: Colors.primary, marginTop: 4 },
  estimateSub: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 4, textAlign: 'center' },
  primaryBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: Spacing.lg,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  successCard: { alignItems: 'center', paddingVertical: 24, gap: 8 },
  successTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  successAmount: { fontSize: 30, fontWeight: FontWeight.bold, color: Colors.primary },
  successBody: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', marginTop: 6, lineHeight: 22 },
  myRequests: { marginTop: Spacing.xl || 28 },
  reqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  reqPlan: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  reqAmount: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  countrySheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: Spacing.base,
    maxHeight: '70%',
  },
  countryTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginBottom: 12 },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  countryName: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  countryCurrency: { fontSize: FontSize.sm, color: Colors.textSecondary },
});
