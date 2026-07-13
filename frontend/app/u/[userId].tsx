/**
 * Personal chat link resolver — `/u/<USER_CONVEX_ID>`.
 *
 * Opened from a shared link (https://smilers.online/u/<id>) or the deep link
 * `smilers://chat-with/<id>` (which redirects here). Shows a safe PUBLIC
 * preview of the person (name/avatar/about, no phone/email) via
 * `api.users.getPublicChatLinkPreview`, then a "Message" button that:
 *   - signed in  → getOrCreateDirect → open the conversation
 *   - signed out → stash the target, go to sign-in, resume automatically
 *   - self       → gently blocked ("this is your own link")
 *
 * With `?auto=1` (set when resuming after sign-in) it opens the chat
 * automatically without a second tap.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../src/convexApi';
import { useAuth } from '../../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { stashPendingChatWith } from '../../src/lib/pendingChatLink';
import { getDisplayInitials } from '../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

interface ChatLinkPreview {
  _id: string;
  name?: string;
  avatar?: string;
  about?: string;
}

export default function PersonalChatLinkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ userId?: string; auto?: string }>();
  const userId = typeof params.userId === 'string' ? params.userId : '';
  const auto = params.auto === '1';
  const { isAuthenticated, isLoading } = useAuth();

  const { data: preview, loading: previewLoading } = useSafeConvexQuery<ChatLinkPreview | null>(
    api.users.getPublicChatLinkPreview,
    userId ? { userId } : {},
    null,
    !!userId,
  );

  // Own id (only meaningful when signed in) so we can block self-links.
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip') as any;

  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const [busy, setBusy] = useState(false);
  const autoRanRef = useRef(false);

  const isSelf = !!(me && userId && String(me._id) === String(userId));

  const handleMessage = useCallback(async () => {
    if (!userId) return;
    if (me && String(me._id) === String(userId)) {
      Alert.alert('This is your link', 'This is your own personal chat link — share it with friends so they can message you.');
      return;
    }
    if (!isAuthenticated) {
      await stashPendingChatWith(userId);
      router.replace('/');
      return;
    }
    setBusy(true);
    try {
      const result: any = await getOrCreateDirect({ otherUserId: userId });
      const convId =
        typeof result === 'string' ? result : result?._id || result?.conversationId;
      if (convId) {
        router.replace(`/chat/${convId}` as any);
      } else {
        Alert.alert('Could not open chat', 'Please try again.');
      }
    } catch (e: any) {
      const msg = String(e?.message || '');
      Alert.alert(
        'Could not open chat',
        msg.includes('Phone verification')
          ? 'Please verify your phone number first, then try again.'
          : msg || 'Please try again later.',
      );
    } finally {
      setBusy(false);
    }
  }, [getOrCreateDirect, isAuthenticated, me, router, userId]);

  // Auto-open after a resume (post sign-in) — once everything's ready.
  useEffect(() => {
    if (!auto || autoRanRef.current) return;
    if (isLoading || !isAuthenticated) return;
    if (previewLoading || me === undefined) return; // still loading
    if (isSelf) return;
    autoRanRef.current = true;
    void handleMessage();
  }, [auto, handleMessage, isAuthenticated, isLoading, isSelf, me, previewLoading]);

  const name = preview?.name?.trim() || 'Smilers user';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="chat-link-screen">
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as any))}
          hitSlop={12}
          testID="chat-link-back"
        >
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Start a chat</Text>
        <View style={styles.headerSpacer} />
      </View>

      {!userId ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={40} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>Invalid link</Text>
          <Text style={styles.emptyBody}>This chat link is missing a user.</Text>
        </View>
      ) : previewLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : !preview ? (
        <View style={styles.center}>
          <Feather name="user-x" size={40} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>User not available</Text>
          <Text style={styles.emptyBody}>This link doesn’t point to a valid Smilers user.</Text>
        </View>
      ) : (
        <View style={styles.body}>
          <View style={styles.avatarWrap}>
            {preview.avatar ? (
              <Image source={{ uri: preview.avatar }} style={styles.avatarImg} />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarInitials}>{getDisplayInitials(name, 2)}</Text>
              </View>
            )}
          </View>
          <Text style={styles.name} numberOfLines={1}>{name}</Text>
          {preview.about ? (
            <Text style={styles.about} numberOfLines={3}>{preview.about}</Text>
          ) : null}

          {isSelf ? (
            <Text style={styles.selfNote}>This is your own chat link.</Text>
          ) : (
            <TouchableOpacity
              style={styles.messageBtn}
              onPress={handleMessage}
              disabled={busy}
              activeOpacity={0.85}
              testID="chat-link-message-btn"
            >
              {busy ? (
                <ActivityIndicator color={Colors.headerBg} />
              ) : (
                <>
                  <Feather name="message-circle" size={20} color={Colors.headerBg} />
                  <Text style={styles.messageBtnText}>Message {name.split(' ')[0]}</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {!isAuthenticated ? (
            <Text style={styles.hint}>You’ll sign in first, then jump straight into the chat.</Text>
          ) : null}
        </View>
      )}
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
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  headerSpacer: { width: 26 },
  body: { flex: 1, alignItems: 'center', paddingHorizontal: Spacing.lg, paddingTop: 48, gap: Spacing.md },
  avatarWrap: { marginBottom: Spacing.sm },
  avatarImg: { width: 120, height: 120, borderRadius: 60, backgroundColor: Colors.primaryLight },
  avatarFallback: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: { color: Colors.primary, fontSize: 40, fontWeight: FontWeight.bold },
  name: { fontSize: FontSize.xxl, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center' },
  about: { fontSize: FontSize.base, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  selfNote: { marginTop: Spacing.lg, fontSize: FontSize.base, color: Colors.textSecondary },
  messageBtn: {
    marginTop: Spacing.lg,
    minHeight: 52,
    minWidth: 220,
    paddingHorizontal: 28,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    ...Shadow.lg,
  },
  messageBtnText: { color: Colors.headerBg, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  hint: { marginTop: Spacing.sm, fontSize: FontSize.sm, color: Colors.textMuted, textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
});
