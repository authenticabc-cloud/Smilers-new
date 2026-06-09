/**
 * /join/[code]  ▸  Join group by invite code (iter-151)
 *
 * Canonical: `api.groupAdmin.joinViaInviteLink({ inviteCode })`.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../../src/convexApi';
import ScreenErrorBoundary from '../../src/components/ScreenErrorBoundary';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

export default function JoinByCodeScreen() {
  const router = useRouter();
  return (
    <ScreenErrorBoundary screenName="join-code" onClose={() => router.replace('/(tabs)/groups' as any)}>
      <JoinInner />
    </ScreenErrorBoundary>
  );
}

function JoinInner() {
  const router = useRouter();
  const { code } = useLocalSearchParams<{ code: string }>();
  const joinM = useMutation((api as any).groupAdmin?.joinViaInviteLink);
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    if (!code || typeof joinM !== 'function') {
      setStatus('error');
      setError('Invalid invite link.');
      return;
    }
    (async () => {
      try {
        const result = await joinM({ inviteCode: String(code) });
        const newConversationId = typeof result === 'string' ? result : (result as any)?.conversationId;
        if (newConversationId) {
          setStatus('success');
          setTimeout(() => router.replace(`/chat/${newConversationId}` as any), 500);
        } else {
          setStatus('error');
          setError('Server did not return a conversation id.');
        }
      } catch (e: any) {
        const code = e?.data?.code || e?.code;
        const msg = e?.data?.message || e?.message || 'Could not join group.';
        setStatus('error');
        setError(code === 'NOT_FOUND' ? 'This invite link is no longer valid.' : code === 'CONFLICT' ? 'You are already a member of this group.' : String(msg).slice(0, 200));
      }
    })();
  }, [code, joinM, router]);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="join-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/(tabs)/groups' as any)} hitSlop={10}>
          <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Join Group</Text>
        <View style={{ width: 26 }} />
      </View>
      <View style={styles.body}>
        {status === 'pending' ? (
          <>
            <ActivityIndicator color={Colors.primary} size="large" />
            <Text style={styles.title}>Joining…</Text>
            <Text style={styles.body2}>Verifying your invite link.</Text>
          </>
        ) : status === 'success' ? (
          <>
            <View style={[styles.icon, { backgroundColor: 'rgba(34,160,107,0.18)' }]}>
              <Feather name="check" size={42} color="#22A06B" />
            </View>
            <Text style={styles.title}>Joined!</Text>
            <Text style={styles.body2}>Opening the group…</Text>
          </>
        ) : (
          <>
            <View style={[styles.icon, { backgroundColor: 'rgba(214,48,48,0.18)' }]}>
              <Feather name="alert-triangle" size={42} color="#D63030" />
            </View>
            <Text style={styles.title}>Could not join</Text>
            <Text style={styles.body2}>{error || 'Try a different link.'}</Text>
            <TouchableOpacity
              style={styles.cta}
              onPress={() => router.replace('/(tabs)/groups' as any)}
            >
              <Text style={styles.ctaText}>Back to Groups</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: { height: Platform.select({ ios: 100, default: 88 }), backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: Spacing.base, paddingBottom: Spacing.md },
  headerTitle: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl, gap: 14 },
  icon: { width: 90, height: 90, borderRadius: 45, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center', marginTop: Spacing.md },
  body2: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  cta: { marginTop: 16, height: 50, paddingHorizontal: 32, borderRadius: Radius.md, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  ctaText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
});
