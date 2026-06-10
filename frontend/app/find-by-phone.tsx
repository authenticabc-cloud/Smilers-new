/**
 * Find by Phone — iter-166 Identity Rework consumer.
 *
 * Lets a signed-in user paste or type an E.164 phone number to find a
 * Smilers user and start a 1:1 conversation. Powered by the verified
 * canonical contracts via `lookupUserByPhone` / `searchUsersByPhonePrefix`.
 *
 * Behaviour:
 *   - User types a number. We attempt an exact `getByPhone` lookup the
 *     moment the input parses as a valid E.164. If it doesn't match, we
 *     fall back to a prefix-search (`searchByPhonePrefix`) for nearby
 *     numbers — useful when the user is typing the +1415 leading digits
 *     and wants a directory-style suggest list.
 *   - Tapping a result calls `conversations.getOrCreateDirect({ otherUserId })`
 *     and navigates to `/chat/<conversationId>`.
 *   - Debounced 300ms to avoid flooding the server while typing.
 *
 * Out of scope (left for future iters):
 *   - Sending a contact request (uses existing `contacts.sendRequestByPhone`)
 *   - Country-picker dropdown — user enters full E.164 here. The Contacts
 *     screen still does country-aware normalization for device imports.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useConvex, useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import Header from '../src/components/Header';
import {
  lookupUserByPhone,
  searchUsersByPhonePrefix,
  toE164,
  type PhoneLookupResult,
  type PhonePrefixMatch,
} from '../src/lib/phoneLookup';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

interface Suggestion extends PhonePrefixMatch {
  /** True when this came from an exact `getByPhone` match. */
  isExactMatch?: boolean;
}

export default function FindByPhoneScreen() {
  const router = useRouter();
  const convex = useConvex();
  const { isAuthenticated } = useAuth();

  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);

  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  // 300 ms debounce. Resets on every keystroke so we never fire more
  // than one query per pause.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local normalisation — surfaces a green checkmark next to the input
  // when the typed number parses cleanly to E.164, even before the
  // server has confirmed a match.
  const parsedE164 = useMemo(() => toE164(input), [input]);

  const runSearch = useCallback(async () => {
    if (!isAuthenticated) {
      setSuggestions([]);
      return;
    }
    const trimmed = input.trim();
    if (!trimmed) {
      setSuggestions([]);
      return;
    }
    setSearching(true);
    try {
      // Attempt exact lookup first when the input is a valid E.164.
      if (parsedE164) {
        const hit = await lookupUserByPhone(convex, parsedE164);
        if (hit) {
          setSuggestions([
            {
              _id: hit._id,
              phoneE164: parsedE164,
              displayName: hit.displayName,
              avatarUrl: hit.avatarUrl,
              isExactMatch: true,
            },
          ]);
          return;
        }
      }
      // Fall back to prefix search. The helper handles missing-`+`.
      const list = await searchUsersByPhonePrefix(convex, trimmed, 20);
      setSuggestions(list);
    } finally {
      setSearching(false);
    }
  }, [convex, input, isAuthenticated, parsedE164]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runSearch, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [runSearch]);

  const openChat = useCallback(
    async (userId: string) => {
      if (!userId) return;
      setOpening(userId);
      try {
        const conversation: any = await getOrCreateDirect({ otherUserId: userId });
        const conversationId =
          typeof conversation === 'string'
            ? conversation
            : conversation?._id || conversation?.conversationId;
        if (conversationId) {
          router.replace(`/chat/${conversationId}` as any);
        } else {
          Alert.alert('Could not start chat', 'Server did not return a conversation id.');
        }
      } catch (errorValue: any) {
        Alert.alert('Could not start chat', errorValue?.message || 'Please try again later.');
      } finally {
        setOpening(null);
      }
    },
    [getOrCreateDirect, router],
  );

  const renderItem = useCallback(
    ({ item }: { item: Suggestion }) => {
      const name = item.displayName?.trim() || 'Smilers user';
      const init = (name.charAt(0) || '?').toUpperCase();
      const isOpening = opening === item._id;
      return (
        <TouchableOpacity
          style={styles.row}
          onPress={() => openChat(item._id)}
          disabled={isOpening}
          testID={`find-phone-result-${item._id}`}
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarInit}>{init}</Text>
          </View>
          <View style={styles.rowMid}>
            <Text style={styles.rowName} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.rowPhone} numberOfLines={1}>
              {item.phoneE164}
            </Text>
          </View>
          {item.isExactMatch ? (
            <View style={styles.exactBadge}>
              <Feather name="check" size={12} color={Colors.white} />
            </View>
          ) : null}
          {isOpening ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : (
            <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
          )}
        </TouchableOpacity>
      );
    },
    [opening, openChat],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="find-by-phone-screen">
      <Header title="Find by phone" showBack onBack={() => router.back()} variant="dark" />
      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <View style={styles.inputRow}>
            <Feather name="phone" size={18} color={Colors.textMuted} />
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="+1 415 555 1234"
              placeholderTextColor={Colors.textMuted}
              keyboardType="phone-pad"
              autoFocus
              autoCorrect={false}
              testID="find-phone-input"
            />
            {parsedE164 ? (
              <Feather name="check-circle" size={18} color={Colors.success} />
            ) : input.length > 0 ? (
              <TouchableOpacity onPress={() => setInput('')} hitSlop={8} testID="find-phone-clear">
                <Feather name="x" size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>

          <Text style={styles.hint}>
            Enter the full international number to look up an existing Smilers user. Type just a
            country code (e.g. +44) to browse nearby numbers in your network.
          </Text>

          {searching ? (
            <View style={styles.searching}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : null}

          <FlatList
            data={suggestions}
            keyExtractor={(item) => String(item._id)}
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={
              suggestions.length === 0 ? styles.emptyContent : styles.listContent
            }
            ListEmptyComponent={
              !searching && input.length > 0 ? (
                <View style={styles.empty}>
                  <Ionicons name="search" size={28} color={Colors.textMuted} />
                  <Text style={styles.emptyTitle}>
                    {parsedE164
                      ? 'No Smilers account with that number'
                      : 'Keep typing to search'}
                  </Text>
                  <Text style={styles.emptySub}>
                    {parsedE164
                      ? 'Invite them to Smilers from the Contacts tab.'
                      : 'Numbers must start with the + country code.'}
                  </Text>
                </View>
              ) : null
            }
            ItemSeparatorComponent={() => <View style={styles.divider} />}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flexOne: { flex: 1 },
  body: { flex: 1, paddingHorizontal: Spacing.base, paddingTop: Spacing.md },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  input: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  hint: {
    marginTop: Spacing.sm,
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  searching: { paddingTop: 12, alignItems: 'center' },
  listContent: { paddingTop: Spacing.md, paddingBottom: 48 },
  emptyContent: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInit: {
    fontSize: 17,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
  rowMid: { flex: 1 },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowPhone: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  exactBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.borderLight,
    marginLeft: 44 + 12,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingTop: 60,
    gap: 8,
  },
  emptyTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  emptySub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
});
