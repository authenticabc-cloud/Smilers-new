/**
 * Diary entry route.
 *
 * Tapping the "Diary" pinned row on the Chats tab lands here. The
 * screen's only job is to ensure a "self-conversation" exists on the
 * Convex backend (i.e. a direct conversation where the other
 * participant is the current user) and then redirect into the regular
 * chat screen in DIARY MODE (`?mode=diary`).
 *
 * Why a separate route instead of just opening the chat directly:
 *   - We don't know the conversationId ahead of time — it has to be
 *     created on first use.
 *   - We need to handle the "I haven't loaded `me` yet" race without
 *     mounting the heavy chat screen in a half-initialised state.
 *   - It gives the user a friendly loading state with a recognizable
 *     icon while the first-run conversation is provisioned (~200ms).
 *
 * The route is `router.replace`-d (not `push`-d) into the chat screen
 * so tapping Back from the diary chat returns the user to the Chats
 * tab, not to this loading screen.
 *
 * Backend assumption (matches web-app behaviour per user screenshots):
 *   `api.conversations.getOrCreateDirect({ otherUserId: me._id })`
 *   accepts `me._id` as the "other user" and returns the existing
 *   self-conversation if one exists, or creates a new one. If the
 *   backend doesn't support self-direct, we fall back to trying any
 *   `api.diary.getOrCreate` / `api.conversations.getOrCreateDiary`
 *   variants before surfacing an error.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import { errorToMessage } from '../src/lib/safeString';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

export default function DiaryEntryScreen() {
  const router = useRouter();
  const me = useQuery(api.users.getCurrentUser);
  const getOrCreateDirect = useMutation((api as any).conversations.getOrCreateDirect);
  const [errorText, setErrorText] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!me?._id) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    (async () => {
      // Try a few endpoints in order. Most backends will accept
      // getOrCreateDirect with the current user as otherUserId.
      const attempts: Array<{ label: string; fn: any; args: any }> = [];
      // dedicated diary endpoints (if they exist)
      const diaryNs: any = (api as any).diary;
      if (diaryNs?.getOrCreate) attempts.push({ label: 'diary.getOrCreate', fn: diaryNs.getOrCreate, args: {} });
      const convNs: any = (api as any).conversations;
      if (convNs?.getOrCreateDiary) attempts.push({ label: 'conversations.getOrCreateDiary', fn: convNs.getOrCreateDiary, args: {} });
      if (convNs?.getOrCreateSelf) attempts.push({ label: 'conversations.getOrCreateSelf', fn: convNs.getOrCreateSelf, args: {} });
      // generic direct fallback
      attempts.push({
        label: 'conversations.getOrCreateDirect(otherUserId=me)',
        fn: getOrCreateDirect,
        args: { otherUserId: me._id },
      });

      let lastError: any = null;
      for (const attempt of attempts) {
        try {
          const result: any = await (typeof attempt.fn === 'function'
            ? attempt.fn(attempt.args)
            : Promise.resolve(null));
          const convId = result?._id || result?.conversationId || result;
          if (convId && typeof convId === 'string') {
            router.replace(`/chat/${convId}?mode=diary` as any);
            return;
          }
        } catch (errorValue: any) {
          lastError = errorValue;
        }
      }
      setErrorText(errorToMessage(lastError) || 'Could not open your Diary.');
      inFlightRef.current = false;
    })();
  }, [me?._id, getOrCreateDirect, router]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="diary-loading-screen">
      <View style={styles.center}>
        <View style={styles.iconWrap}>
          <MaterialCommunityIcons name="book-account-outline" size={36} color={Colors.white} />
        </View>
        <Text style={styles.title}>Diary</Text>
        <Text style={styles.subtitle}>Your personal notes</Text>
        {errorText ? (
          <>
            <Text style={styles.errorText}>{errorText}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => {
                setErrorText(null);
                inFlightRef.current = false;
                // Force the useEffect to re-evaluate by tapping a state.
                router.replace('/diary' as any);
              }}
              testID="diary-retry-btn"
            >
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => router.back()}
              testID="diary-back-btn"
            >
              <Text style={styles.backBtnText}>Back to chats</Text>
            </TouchableOpacity>
          </>
        ) : (
          <ActivityIndicator color={Colors.diary} size="large" style={{ marginTop: Spacing.lg }} />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl, gap: Spacing.sm },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.diary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  title: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  subtitle: { fontSize: FontSize.base, color: Colors.textSecondary, marginBottom: Spacing.md },
  errorText: { fontSize: FontSize.sm, color: Colors.danger, textAlign: 'center', marginTop: Spacing.md, paddingHorizontal: Spacing.lg },
  retryBtn: {
    marginTop: Spacing.lg,
    minHeight: 48,
    paddingHorizontal: 32,
    borderRadius: Radius.pill,
    backgroundColor: Colors.diary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  backBtn: { marginTop: Spacing.sm, padding: Spacing.sm },
  backBtnText: { color: Colors.primary, fontWeight: FontWeight.semibold, fontSize: FontSize.base },
});
