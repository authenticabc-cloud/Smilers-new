/**
 * Ad-clicks mobile money payment request (user-facing).
 * Mirrors the premium mobile-money flow but grants paid ad clicks (€0.04 each)
 * to a specific ad. Pick country → optional pay-from phone → ≈ estimate →
 * confirm → adClickRequests.createRequest → success. Admin completes manually.
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
  AD_CLICK_PRICE_EUR,
  currencyForCountry,
  estimateAdClicksAmount,
  formatLocalAmount,
} from '../src/lib/mobileMoney';
import { friendlyConvexError } from '../src/lib/friendlyError';

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

export default function AdClicksPaymentScreen() {
  const params = useLocalSearchParams<{ adId?: string; adTitle?: string; clicks?: string }>();
  const adId = String(params.adId || '');
  const adTitle = params.adTitle ? String(params.adTitle) : 'your ad';
  const clicks = Math.max(1, parseInt(String(params.clicks || '50'), 10) || 50);

  const [countryCode, setCountryCode] = useState('KE');
  const [phone, setPhone] = useState('');
  const [showCountry, setShowCountry] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ amount: number; currency: string } | null>(null);

  const createRequest = useAction((api as any).adClickRequests?.createRequest);
  const myRequests = useQuery((api as any).adClickRequests?.getMyRequests, {}) as any[] | undefined;

  const currency = currencyForCountry(countryCode);
  const country = MOBILE_MONEY_COUNTRIES.find((c) => c.code === countryCode);
  const estimate = useMemo(() => estimateAdClicksAmount(clicks, currency), [clicks, currency]);
  const eur = (clicks * AD_CLICK_PRICE_EUR).toFixed(2);

  const submit = () => {
    if (!adId) {
      Alert.alert('Missing ad', 'Please start from your ad again.');
      return;
    }
    Alert.alert(
      'Send payment request?',
      `Ad: ${adTitle}\nClicks: ${clicks} (€${eur})\nCountry: ${country?.name}\nEstimated total: ≈ ${formatLocalAmount(estimate, currency)}\n\nAn admin will contact you with mobile money details. Your clicks are credited automatically once confirmed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send request',
          onPress: async () => {
            setSubmitting(true);
            try {
              const res: any = await createRequest({
                adId,
                clicks,
                country: countryCode,
                phone: phone.trim() ? phone.trim() : undefined,
              });
              setSuccess({ amount: res?.amount ?? estimate, currency: res?.currency ?? currency });
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
    <SafeAreaView style={styles.container} edges={['top']} testID="ad-clicks-payment-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="admm-back">
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Buy clicks · Mobile Money</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView style={styles.flexOne} behavior="padding">
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {success ? (
            <View style={styles.successCard} testID="admm-success">
              <Ionicons name="checkmark-circle" size={56} color={Colors.primary} />
              <Text style={styles.successTitle}>Request received</Text>
              <Text style={styles.successAmount}>{formatLocalAmount(success.amount, success.currency)}</Text>
              <Text style={styles.successBody}>
                Your request for {clicks} clicks on “{adTitle}” has been sent. An admin will message you
                shortly with the mobile money number. The clicks are credited to your ad automatically once
                the admin confirms.
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()} testID="admm-done">
                <Text style={styles.primaryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle} numberOfLines={2}>{adTitle}</Text>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{clicks} clicks × €{AD_CLICK_PRICE_EUR.toFixed(2)}</Text>
                  <Text style={styles.summaryEur}>€{eur}</Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Your country</Text>
              <TouchableOpacity style={styles.pickerRow} onPress={() => setShowCountry(true)} testID="admm-country">
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
                testID="admm-phone"
              />
              <Text style={styles.hint}>Helps the admin match your payment. You can leave this blank.</Text>

              <View style={styles.estimateBox}>
                <Text style={styles.estimateLabel}>Estimated total</Text>
                <Text style={styles.estimateAmount}>≈ {formatLocalAmount(estimate, currency)}</Text>
                <Text style={styles.estimateSub}>{clicks} clicks · €{eur} · final amount confirmed on submit</Text>
              </View>

              <TouchableOpacity
                style={[styles.primaryBtn, submitting ? styles.primaryBtnDisabled : null]}
                onPress={submit}
                disabled={submitting}
                testID="admm-submit"
              >
                {submitting ? (
                  <ActivityIndicator color={Colors.white} />
                ) : (
                  <Text style={styles.primaryBtnText}>Request with mobile money</Text>
                )}
              </TouchableOpacity>
            </>
          )}

          {Array.isArray(myRequests) && myRequests.length > 0 ? (
            <View style={styles.myRequests}>
              <Text style={styles.sectionTitle}>Your ad-click requests</Text>
              {myRequests.map((r: any) => (
                <View key={String(r._id)} style={styles.reqRow} testID={`admm-my-${String(r._id).slice(-6)}`}>
                  <View style={styles.flexOne}>
                    <Text style={styles.reqPlan} numberOfLines={1}>{r.adTitle || r.ad?.productName || 'Ad'}</Text>
                    <Text style={styles.reqAmount}>
                      {r.clicks ?? r.quantity} clicks · {formatLocalAmount(r.amount, r.currency)} · {r.country}
                    </Text>
                  </View>
                  <StatusPill status={r.status} />
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

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
                  testID={`admm-country-${c.code}`}
                >
                  <Text style={styles.countryName}>{c.name}</Text>
                  <Text style={styles.countryCurrency}>{c.currency}</Text>
                  {countryCode === c.code ? <Ionicons name="checkmark" size={18} color={Colors.primary} /> : null}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  scroll: { padding: Spacing.base, paddingBottom: 48 },
  summaryCard: { backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.base, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border },
  summaryTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  summaryLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  summaryEur: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary, marginTop: Spacing.lg, marginBottom: Spacing.sm },
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
  estimateBox: { backgroundColor: '#F4FBF6', borderRadius: Radius.md, padding: Spacing.base, marginTop: Spacing.lg, alignItems: 'center' },
  estimateLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  estimateAmount: { fontSize: 28, fontWeight: FontWeight.bold, color: Colors.primary, marginTop: 4 },
  estimateSub: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 4, textAlign: 'center' },
  primaryBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 16, alignItems: 'center', marginTop: Spacing.lg },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  successCard: { alignItems: 'center', paddingVertical: 24, gap: 8 },
  successTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  successAmount: { fontSize: 30, fontWeight: FontWeight.bold, color: Colors.primary },
  successBody: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', marginTop: 6, lineHeight: 22 },
  myRequests: { marginTop: Spacing.xl },
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
  countrySheet: { backgroundColor: Colors.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.base, maxHeight: '70%' },
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
