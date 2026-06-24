import React, { useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../../src/components/Header';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { api } from '../../src/convexApi';
import { estimateClicks, formatCreditCode } from '../../src/lib/adCreditCodes';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

type AdminTab = 'review' | 'all' | 'codes';

export default function AdsReviewScreen() {
  const router = useRouter();
  const [adminTab, setAdminTab] = useState<AdminTab>('review');
  const [expandedRejectId, setExpandedRejectId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNote, setCreditNote] = useState('');
  const [lifetimeNote, setLifetimeNote] = useState('');
  const [generatingCredit, setGeneratingCredit] = useState(false);
  const [generatingLifetime, setGeneratingLifetime] = useState(false);
  const [lastGenerated, setLastGenerated] = useState<{ code: string; type: 'credit' | 'lifetime' } | null>(null);
  const { data: me } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null);
  const { data: pendingAds, refetch } = useSafeConvexQuery<any[]>(api.ads.listPending, {}, []);
  const { data: allAds, refetch: refetchAll } = useSafeConvexQuery<any[]>(api.ads.listAllAds, {}, []);
  const { data: creditCodes, refetch: refetchCodes } = useSafeConvexQuery<any[]>(api.adCreditCodes.listCodes, {}, []);
  const approve = useMutation(api.ads.approve);
  const reject = useMutation(api.ads.reject);
  const deleteAd = useMutation(api.ads.deleteAd);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const generateCreditCode = useMutation(api.adCreditCodes.generateCreditCode);
  const generateLifetimeCode = useMutation(api.adCreditCodes.generateLifetimeCode);
  const revokeCode = useMutation(api.adCreditCodes.revokeCode);

  const isAdmin = me?.role === 'admin';

  const onApprove = async (adId: string) => {
    try {
      await approve({ adId });
      await refetch();
    } catch (errorValue: any) {
      Alert.alert('Could not approve', errorValue?.message || 'Unknown error');
    }
  };

  const onReject = async (adId: string) => {
    try {
      await reject({ adId, reason: reasons[adId]?.trim() || undefined });
      setExpandedRejectId(null);
      await refetch();
    } catch (errorValue: any) {
      Alert.alert('Could not reject', errorValue?.message || 'Unknown error');
    }
  };

  const onDeleteAd = (item: any) => {
    const remainingPaid = Number(item?.remainingPaidClicks || 0);
    const refundEur = (remainingPaid * 0.04).toFixed(2);
    const refundLine =
      remainingPaid > 0
        ? `\n\n${remainingPaid} unused paid click${remainingPaid === 1 ? '' : 's'} (€${refundEur}) will be refunded to the advertiser as a credit code.`
        : '';
    Alert.alert(
      'Delete ad',
      `Delete "${item?.productName || 'this ad'}"? This cannot be undone.${refundLine}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(item._id);
            try {
              const result: any = await deleteAd({ adId: item._id });
              await Promise.all([refetchAll(), refetch()]);
              const clicks = Number(result?.refundedClicks || 0);
              const amount = Number(result?.refundedAmountEur || 0);
              Alert.alert(
                'Ad deleted',
                clicks > 0
                  ? `Refunded ${clicks} click${clicks === 1 ? '' : 's'} (€${amount.toFixed(2)}) to the advertiser.`
                  : 'The ad was deleted. No paid clicks to refund.',
              );
            } catch (errorValue: any) {
              Alert.alert('Could not delete ad', errorValue?.message || 'Unknown error');
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  };

  const onGenerateCreditCode = async () => {
    const amountEur = Number(creditAmount);
    if (!Number.isFinite(amountEur) || amountEur <= 0) {
      Alert.alert('Enter a valid amount', 'Please enter a positive EUR amount.');
      return;
    }

    setGeneratingCredit(true);
    try {
      const result: any = await generateCreditCode({ amountEur, note: creditNote.trim() || undefined });
      const code = result?.code || '';
      setLastGenerated(code ? { code, type: 'credit' } : null);
      setCreditAmount('');
      setCreditNote('');
      await refetchCodes();
    } catch (errorValue: any) {
      Alert.alert('Could not generate code', errorValue?.message || 'Unknown error');
    } finally {
      setGeneratingCredit(false);
    }
  };

  const onGenerateLifetimeCode = async () => {
    setGeneratingLifetime(true);
    try {
      const result: any = await generateLifetimeCode({ note: lifetimeNote.trim() || undefined });
      const code = result?.code || '';
      setLastGenerated(code ? { code, type: 'lifetime' } : null);
      setLifetimeNote('');
      await refetchCodes();
    } catch (errorValue: any) {
      Alert.alert('Could not generate code', errorValue?.message || 'Unknown error');
    } finally {
      setGeneratingLifetime(false);
    }
  };

  const onCopyLastCode = async () => {
    if (!lastGenerated?.code) return;
    try {
      await Clipboard.setStringAsync(lastGenerated.code);
      Alert.alert('Copied', 'The code has been copied to your clipboard.');
    } catch {
      Alert.alert('Could not copy', 'Please copy the code manually.');
    }
  };

  const onRevokeCode = async (codeId: string) => {
    try {
      await revokeCode({ codeId });
      await refetchCodes();
    } catch (errorValue: any) {
      Alert.alert('Could not revoke', errorValue?.message || 'Unknown error');
    }
  };

  const clickEstimate = estimateClicks(Number(creditAmount));

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="ads-review-screen">
      <Header title="Ads Review" showBack onBack={() => router.back()} variant="dark" />
      {!isAdmin ? (
        <View style={styles.empty} testID="ads-review-unauthorized">
          <Feather name="shield-off" size={36} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>Admin access required</Text>
        </View>
      ) : (
        <View style={styles.flexOne}>
          <View style={styles.segmentWrap} testID="ads-admin-tabs">
            <SegmentButton label="Review Ads" active={adminTab === 'review'} onPress={() => setAdminTab('review')} testID="ads-admin-review-tab" />
            <SegmentButton label="All Ads" active={adminTab === 'all'} onPress={() => setAdminTab('all')} testID="ads-admin-all-tab" />
            <SegmentButton label="Ad Codes" active={adminTab === 'codes'} onPress={() => setAdminTab('codes')} testID="ads-admin-codes-tab" />
          </View>

          {adminTab === 'review' ? (
            <FlatList
              data={pendingAds}
              keyExtractor={(item: any) => item._id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item, index }) => (
                <View style={styles.card} testID={`pending-ad-card-${index}`}>
                  {item.imageUrl ? <Image source={{ uri: item.imageUrl }} style={styles.cardImage} resizeMode="cover" /> : null}
                  <Text style={styles.cardTitle}>{item.productName}</Text>
                  <Text style={styles.cardSub}>{item.businessName} · {item.location}</Text>
                  <Text style={styles.cardText}>{item.description}</Text>
                  {item.contactInfo ? <Text style={styles.cardText}>Contact: {item.contactInfo}</Text> : null}
                  <Text style={styles.cardText}>Creator: {item.creatorName || 'Unknown'}</Text>
                  <Text style={styles.cardText}>Link: {item.externalLink}</Text>
                  <Text style={styles.cardText}>
                    Countries: {item.targetCountries?.length ? item.targetCountries.join(', ') : 'Worldwide'}
                  </Text>

                  <View style={styles.actionRow}>
                    <TouchableOpacity style={[styles.actionBtn, styles.approveBtn]} onPress={() => onApprove(item._id)} testID={`approve-ad-${item._id}`}>
                      <Text style={styles.actionText}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.rejectBtn]}
                      onPress={() => setExpandedRejectId(expandedRejectId === item._id ? null : item._id)}
                      testID={`toggle-reject-ad-${item._id}`}
                    >
                      <Text style={styles.actionText}>Reject</Text>
                    </TouchableOpacity>
                  </View>

                  {expandedRejectId === item._id ? (
                    <View style={styles.rejectWrap}>
                      <TextInput
                        value={reasons[item._id] || ''}
                        onChangeText={(value) => setReasons((current) => ({ ...current, [item._id]: value }))}
                        placeholder="Optional rejection reason"
                        placeholderTextColor={Colors.textMuted}
                        style={styles.rejectInput}
                        testID={`reject-reason-${item._id}`}
                      />
                      <TouchableOpacity style={[styles.actionBtn, styles.rejectSubmit]} onPress={() => onReject(item._id)} testID={`reject-ad-${item._id}`}>
                        <Text style={styles.actionText}>Submit rejection</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              )}
              ListEmptyComponent={
                <View style={styles.empty} testID="ads-review-empty">
                  <Feather name="check-circle" size={36} color={Colors.textMuted} />
                  <Text style={styles.emptyTitle}>No pending ads</Text>
                </View>
              }
            />
          ) : adminTab === 'all' ? (
            <FlatList
              data={allAds}
              keyExtractor={(item: any) => item._id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item, index }) => {
                const remainingPaid = Number(item.remainingPaidClicks || 0);
                const statusColor =
                  item.status === 'approved' ? '#16a34a' : item.status === 'rejected' ? '#dc2626' : '#d97706';
                return (
                  <View style={styles.card} testID={`all-ad-card-${index}`}>
                    {item.imageUrl ? <Image source={{ uri: item.imageUrl }} style={styles.cardImage} resizeMode="cover" /> : null}
                    <View style={styles.allAdHeader}>
                      <Text style={styles.cardTitle}>{item.productName}</Text>
                      <View style={[styles.statusPill, { backgroundColor: statusColor }]}>
                        <Text style={styles.statusPillText}>{String(item.status || '').toUpperCase()}</Text>
                      </View>
                    </View>
                    <Text style={styles.cardSub}>{item.businessName} · {item.location}</Text>
                    <Text style={styles.cardText}>Creator: {item.creatorName || 'Unknown'}</Text>
                    <Text style={styles.cardText}>
                      {Number(item.clickCount || 0)} clicks · €{Number(item.totalCostEur || 0).toFixed(2)} charged
                    </Text>
                    <Text style={styles.cardText}>
                      Paid clicks remaining: {remainingPaid} (refund €{(remainingPaid * 0.04).toFixed(2)})
                    </Text>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.deleteBtn, deletingId === item._id && styles.disabledBtn, { marginTop: Spacing.base }]}
                      onPress={() => onDeleteAd(item)}
                      disabled={deletingId === item._id}
                      testID={`delete-ad-${item._id}`}
                    >
                      <Feather name="trash-2" size={16} color={Colors.white} />
                      <Text style={[styles.actionText, { marginLeft: 6 }]}>
                        {deletingId === item._id ? 'Deleting…' : 'Delete & refund'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              }}
              ListEmptyComponent={
                <View style={styles.empty} testID="ads-all-empty">
                  <Feather name="inbox" size={36} color={Colors.textMuted} />
                  <Text style={styles.emptyTitle}>No ads yet</Text>
                </View>
              }
            />
          ) : (
            <ScrollView contentContainerStyle={styles.listContent} testID="ad-codes-panel">
              {lastGenerated ? (
                <View style={styles.generatedCard} testID="last-generated-code-card">
                  <Text style={styles.generatedLabel}>LAST GENERATED CODE</Text>
                  <Text style={styles.generatedCode}>{lastGenerated.code}</Text>
                  <Text style={styles.generatedMeta}>{lastGenerated.type === 'lifetime' ? 'Lifetime license' : 'Credit code'}</Text>
                  <TouchableOpacity style={styles.copyCodeBtn} onPress={onCopyLastCode} testID="copy-generated-code-button">
                    <Feather name="copy" size={16} color="#15803d" />
                    <Text style={styles.copyCodeBtnText}>Copy code</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              <View style={styles.card} testID="generate-credit-code-card">
                <Text style={styles.cardTitle}>Credit Code</Text>
                <Text style={styles.cardText}>Create a fixed EUR balance code for click credits.</Text>
                <Text style={styles.inputLabel}>EUR amount</Text>
                <TextInput
                  value={creditAmount}
                  onChangeText={setCreditAmount}
                  placeholder="25"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="decimal-pad"
                  style={styles.rejectInput}
                  testID="generate-credit-amount-input"
                />
                <Text style={styles.helperNote} testID="generate-credit-click-estimate">
                  Estimated clicks: {clickEstimate}
                </Text>
                <Text style={styles.inputLabel}>Optional note</Text>
                <TextInput
                  value={creditNote}
                  onChangeText={setCreditNote}
                  placeholder="Campaign bonus"
                  placeholderTextColor={Colors.textMuted}
                  style={styles.rejectInput}
                  testID="generate-credit-note-input"
                />
                <TouchableOpacity
                  style={[styles.actionBtn, styles.primaryActionBtn, generatingCredit && styles.disabledBtn]}
                  onPress={onGenerateCreditCode}
                  disabled={generatingCredit}
                  testID="generate-credit-code-button"
                >
                  <Text style={styles.actionText}>{generatingCredit ? 'Generating…' : 'Generate Credit Code'}</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.card} testID="generate-lifetime-code-card">
                <Text style={styles.cardTitle}>Lifetime Code</Text>
                <Text style={styles.cardText}>This grants unlimited ad clicks forever. Use carefully.</Text>
                <Text style={styles.warningNote}>Unlimited clicks override all regular credits for the account.</Text>
                <Text style={styles.inputLabel}>Optional note</Text>
                <TextInput
                  value={lifetimeNote}
                  onChangeText={setLifetimeNote}
                  placeholder="VIP partnership"
                  placeholderTextColor={Colors.textMuted}
                  style={styles.rejectInput}
                  testID="generate-lifetime-note-input"
                />
                <TouchableOpacity
                  style={[styles.actionBtn, styles.lifetimeBtn, generatingLifetime && styles.disabledBtn]}
                  onPress={onGenerateLifetimeCode}
                  disabled={generatingLifetime}
                  testID="generate-lifetime-code-button"
                >
                  <Text style={styles.actionText}>{generatingLifetime ? 'Generating…' : 'Generate Lifetime Code'}</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.codesSectionLabel}>RECENT CODES</Text>
              {Array.isArray(creditCodes) && creditCodes.length ? (
                creditCodes.slice(0, 100).map((codeItem: any, index) => (
                  <View style={styles.codeRowCard} key={codeItem._id || `${codeItem.code}-${index}`} testID={`ad-code-row-${index}`}>
                    <View style={styles.flexOne}>
                      <Text style={styles.codeRowCode}>{formatCreditCode(codeItem.code || '')}</Text>
                      <Text style={styles.codeRowMeta}>
                        {codeItem.type === 'lifetime'
                          ? 'Lifetime'
                          : `€${Number(codeItem.remainingEur ?? codeItem.amountEur ?? 0).toFixed(2)} remaining`}
                        {' · '}
                        {codeItem.status}
                      </Text>
                      {codeItem.redeemedByName ? (
                        <Text style={styles.codeRowSub}>Redeemed by {codeItem.redeemedByName}</Text>
                      ) : null}
                      {codeItem.note ? <Text style={styles.codeRowSub}>Note: {codeItem.note}</Text> : null}
                    </View>
                    <TouchableOpacity
                      style={[styles.revokeBtn, codeItem.status === 'revoked' && styles.disabledBtn]}
                      onPress={() => onRevokeCode(codeItem._id)}
                      disabled={codeItem.status === 'revoked'}
                      testID={`revoke-code-${codeItem._id}`}
                    >
                      <Text style={styles.revokeBtnText}>{codeItem.status === 'revoked' ? 'Revoked' : 'Revoke'}</Text>
                    </TouchableOpacity>
                  </View>
                ))
              ) : (
                <View style={styles.empty} testID="ad-codes-empty">
                  <Feather name="key" size={36} color={Colors.textMuted} />
                  <Text style={styles.emptyTitle}>No codes yet</Text>
                </View>
              )}
            </ScrollView>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

function SegmentButton({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.segmentButton, active ? styles.segmentButtonActive : null]}
      onPress={onPress}
      activeOpacity={0.8}
      testID={testID}
    >
      <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flexOne: { flex: 1 },
  segmentWrap: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.base, marginTop: Spacing.md },
  segmentButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  segmentButtonActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  segmentText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textPrimary },
  segmentTextActive: { color: Colors.white, fontWeight: FontWeight.bold },
  listContent: { padding: Spacing.base, paddingBottom: Spacing.xxl, gap: Spacing.base },
  card: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.base, borderWidth: 1, borderColor: Colors.borderLight },
  cardImage: { width: '100%', height: 180, borderRadius: Radius.md, marginBottom: Spacing.base },
  cardTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  cardSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  cardText: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: 8, lineHeight: 20 },
  inputLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: Spacing.base, marginBottom: 8 },
  helperNote: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 8 },
  warningNote: { fontSize: FontSize.sm, color: '#b45309', marginTop: 8 },
  actionRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.base },
  actionBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.pill },
  approveBtn: { backgroundColor: '#16a34a' },
  rejectBtn: { backgroundColor: '#dc2626' },
  rejectSubmit: { backgroundColor: Colors.primary, marginTop: Spacing.sm },
  primaryActionBtn: { backgroundColor: Colors.primary, marginTop: Spacing.base },
  lifetimeBtn: { backgroundColor: '#b45309', marginTop: Spacing.base },
  disabledBtn: { opacity: 0.6 },
  actionText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  rejectWrap: { marginTop: Spacing.base },
  rejectInput: {
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  generatedCard: { backgroundColor: '#dcfce7', borderRadius: Radius.lg, padding: Spacing.base, borderWidth: 1, borderColor: '#86efac' },
  generatedLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: '#15803d', letterSpacing: 1 },
  generatedCode: { fontSize: 28, fontWeight: FontWeight.bold, color: '#166534', marginTop: 8, fontVariant: ['tabular-nums'] },
  generatedMeta: { fontSize: FontSize.sm, color: '#166534', marginTop: 4 },
  copyCodeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: Spacing.base,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  copyCodeBtnText: { fontSize: FontSize.sm, color: '#15803d', fontWeight: FontWeight.bold },
  codesSectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    letterSpacing: 1,
    marginTop: Spacing.sm,
  },
  codeRowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  codeRowCode: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary, letterSpacing: 1.5 },
  codeRowMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  codeRowSub: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: 4 },
  revokeBtn: { minWidth: 82, minHeight: 40, borderRadius: Radius.pill, backgroundColor: '#fee2e2', alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md },
  revokeBtnText: { fontSize: FontSize.sm, color: Colors.danger, fontWeight: FontWeight.bold },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: Spacing.xxl * 2, gap: Spacing.sm },
  emptyTitle: { fontSize: FontSize.lg, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  allAdHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.pill },
  statusPillText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.white, letterSpacing: 0.5 },
  deleteBtn: { backgroundColor: '#dc2626', flexDirection: 'row' },
});