import React, { useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../../src/components/Header';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { api } from '../../src/convexApi';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

export default function AdsReviewScreen() {
  const router = useRouter();
  const [expandedRejectId, setExpandedRejectId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const { data: me } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null);
  const { data: pendingAds, refetch } = useSafeConvexQuery<any[]>(api.ads.listPending, {}, []);
  const approve = useMutation(api.ads.approve);
  const reject = useMutation(api.ads.reject);

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

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="ads-review-screen">
      <Header title="Ads Review" showBack onBack={() => router.back()} variant="dark" />
      {!isAdmin ? (
        <View style={styles.empty} testID="ads-review-unauthorized">
          <Feather name="shield-off" size={36} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>Admin access required</Text>
        </View>
      ) : (
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
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { padding: Spacing.base, paddingBottom: Spacing.xxl, gap: Spacing.base },
  card: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.base, borderWidth: 1, borderColor: Colors.borderLight },
  cardImage: { width: '100%', height: 180, borderRadius: Radius.md, marginBottom: Spacing.base },
  cardTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  cardSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  cardText: { fontSize: FontSize.sm, color: Colors.textPrimary, marginTop: 8, lineHeight: 20 },
  actionRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.base },
  actionBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.pill },
  approveBtn: { backgroundColor: '#16a34a' },
  rejectBtn: { backgroundColor: '#dc2626' },
  rejectSubmit: { backgroundColor: Colors.primary, marginTop: Spacing.sm },
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: Spacing.xxl * 2, gap: Spacing.sm },
  emptyTitle: { fontSize: FontSize.lg, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
});