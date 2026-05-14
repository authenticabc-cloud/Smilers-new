import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Avatar from '../../src/components/Avatar';
import Header from '../../src/components/Header';
import { api } from '../../src/convexApi';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { useAuth } from '../../src/providers/AuthProvider';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

export default function UserProfileScreen() {
  const router = useRouter();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const { isAuthenticated } = useAuth();
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const hasValidUserId = typeof userId === 'string' && userId.length > 5;
  const { data: user } = useSafeConvexQuery<any | null>(
    api.users.getUserById,
    userId ? { userId } : {},
    null,
    isAuthenticated && hasValidUserId
  );

  const openChat = async () => {
    if (!userId || !hasValidUserId) return;
    try {
      const result: any = await getOrCreateDirect({ otherUserId: userId });
      const conversationId = typeof result === 'string' ? result : result?._id || result?.conversationId;
      if (conversationId) {
        router.push(`/chat/${conversationId}` as any);
      }
    } catch {}
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="user-profile-screen">
      <Header title="Profile" showBack onBack={() => router.back()} variant="dark" />
      <View style={styles.content}>
        {!isAuthenticated || !hasValidUserId ? (
          <View style={styles.fallbackWrap} testID="user-profile-fallback">
            <Feather name={!isAuthenticated ? 'lock' : 'alert-circle'} size={42} color={Colors.textMuted} />
            <Text style={styles.fallbackTitle}>{!isAuthenticated ? 'Sign in to view profiles' : 'User not found'}</Text>
            <Text style={styles.fallbackBody}>
              {!isAuthenticated
                ? 'Open this profile after signing in to Smilers.'
                : 'This user link looks invalid or incomplete.'}
            </Text>
          </View>
        ) : (
          <>
            <Avatar name={user?.name || 'Smilers User'} uri={user?.avatarUrl} size={104} />
            <Text style={styles.name} testID="user-profile-name">{user?.name || 'Smilers User'}</Text>
            <Text style={styles.about} testID="user-profile-about">{user?.about || 'No bio yet.'}</Text>

            <View style={styles.card} testID="user-profile-details-card">
              <DetailRow icon="mail-outline" label="Email" value={user?.email || 'Hidden'} />
              <DetailRow icon="time-outline" label="Last seen" value={user?.lastSeen ? new Date(user.lastSeen).toLocaleString() : 'Recently'} />
              <DetailRow icon="shield-checkmark-outline" label="Privacy" value={user?.privacyLevel || 'Standard'} />
            </View>

            <TouchableOpacity style={styles.messageBtn} onPress={openChat} testID="user-profile-message-button">
              <Feather name="message-square" size={18} color={Colors.white} />
              <Text style={styles.messageBtnText}>Message</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function DetailRow({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailIconWrap}>
        <Ionicons name={icon} size={18} color={Colors.primary} />
      </View>
      <View style={styles.flexOne}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { flex: 1, alignItems: 'center', padding: Spacing.lg },
  fallbackWrap: { width: '100%', alignItems: 'center', paddingVertical: Spacing.xxl, gap: 10 },
  fallbackTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary, textAlign: 'center' },
  fallbackBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: Spacing.lg },
  name: { fontSize: 26, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: Spacing.lg },
  about: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm, lineHeight: 22 },
  card: {
    width: '100%',
    marginTop: Spacing.xl,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: Spacing.base,
  },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  detailIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flexOne: { flex: 1 },
  detailLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  detailValue: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary, marginTop: 2 },
  messageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: Spacing.xl,
    width: '100%',
    minHeight: 48,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
  },
  messageBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.white },
});