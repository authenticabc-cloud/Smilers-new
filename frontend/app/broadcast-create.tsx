/**
 * Admin Broadcast — send a single announcement to many users as "Smilers".
 *
 * Backend contract (verified):
 *   api.admin.messaging.messageUsers({ userIds: Id<"users">[], text: string })
 *     → { sent: number }   (admin-only; FORBIDDEN otherwise)
 *
 * - Recipient list comes from the admin query api.admin.queries.getAllUsers
 *   (NO args). We render per-row checkboxes + a select-all control and track a
 *   Set<userId> purely client-side, then fire ONE messageUsers call.
 * - The sender is the shared "Smilers" system account; the admin identity is
 *   never exposed. Each recipient gets a read-only `isBroadcast` conversation.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';

import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { getDisplayInitials, getDisplayNameFromUser } from '../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

interface AdminUser {
  _id: string;
  name?: string;
  email?: string;
  phone?: string;
  avatar?: string;
  role?: 'admin' | 'user';
  level?: string;
  totalEngagements?: number;
}

const MAX_TEXT = 5000;

export default function BroadcastCreateScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  const { data: me, loading: meLoading } = useSafeConvexQuery<any | null>(
    api.users.getCurrentUser,
    {},
    null,
    isAuthenticated,
  );
  const isAdmin = me?.role === 'admin';

  // NO args — passing { search } fails backend arg validation.
  const { data: users, loading } = useSafeConvexQuery<AdminUser[]>(
    api.admin.queries.getAllUsers,
    {},
    [],
    isAdmin,
  );
  const messageUsers = useMutation(api.admin.messaging.messageUsers);

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const allUsers = useMemo(() => (Array.isArray(users) ? users : []), [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allUsers;
    return allUsers.filter((u) => {
      const hay = `${getDisplayNameFromUser(u)} ${u?.email || ''} ${u?.phone || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [allUsers, search]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((u) => selected.has(String(u._id)));

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      const ids = filtered.map((u) => String(u._id));
      const everySelected = ids.length > 0 && ids.every((id) => next.has(id));
      if (everySelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, [filtered]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (selected.size === 0) {
      Alert.alert('Select recipients', 'Choose at least one user to broadcast to.');
      return;
    }
    if (trimmed.length === 0) {
      Alert.alert('Write a message', 'Enter the announcement text to broadcast.');
      return;
    }
    setSending(true);
    try {
      const result = await messageUsers({
        userIds: Array.from(selected) as any,
        text: trimmed,
      });
      const sent = Number((result as any)?.sent ?? selected.size);
      Alert.alert(
        'Broadcast sent',
        `Your announcement was delivered to ${sent} ${sent === 1 ? 'user' : 'users'} as "Smilers".`,
        [{ text: 'Done', onPress: () => router.back() }],
      );
      setSelected(new Set());
      setText('');
    } catch (errorValue: any) {
      const message = String(errorValue?.message || '');
      Alert.alert(
        'Could not send broadcast',
        message.includes('FORBIDDEN')
          ? 'Only Smilers admins can send broadcasts.'
          : message || 'Please try again.',
      );
    } finally {
      setSending(false);
    }
  }, [messageUsers, router, selected, text]);

  // ── ACCESS GATE ──────────────────────────────────────
  if (!meLoading && !isAdmin) {
    return (
      <SafeAreaView style={styles.container} edges={['top']} testID="broadcast-denied">
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.headerBack}>
            <Ionicons name="arrow-back" size={26} color={Colors.white} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.headerTitle}>New Broadcast</Text>
          </View>
        </View>
        <View style={styles.emptyWrap}>
          <Ionicons name="lock-closed" size={40} color={Colors.danger} />
          <Text style={styles.emptyTitle}>Admin access required</Text>
          <Text style={styles.emptyText}>Broadcasts can only be sent by Smilers admins.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="broadcast-create-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.headerBack} testID="broadcast-back">
          <Ionicons name="arrow-back" size={26} color={Colors.white} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>New Broadcast</Text>
          <Text style={styles.headerSubtitle}>Sends as “Smilers” · {selected.size} selected</Text>
        </View>
      </View>

      {/* Message composer */}
      <View style={styles.composeWrap}>
        <TextInput
          value={text}
          onChangeText={(v) => setText(v.slice(0, MAX_TEXT))}
          placeholder="Write your announcement…"
          placeholderTextColor={Colors.textMuted}
          style={styles.composeInput}
          multiline
          testID="broadcast-text-input"
        />
        <Text style={styles.composeCount}>{text.length}/{MAX_TEXT}</Text>
      </View>

      {/* Search + select-all */}
      <View style={styles.toolRow}>
        <View style={styles.searchWrap}>
          <Feather name="search" size={18} color={Colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search users"
            placeholderTextColor={Colors.textMuted}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            testID="broadcast-search-input"
          />
        </View>
        <TouchableOpacity onPress={toggleSelectAll} style={styles.selectAllBtn} testID="broadcast-select-all">
          <Feather name={allFilteredSelected ? 'check-square' : 'square'} size={18} color={Colors.primary} />
          <Text style={styles.selectAllText}>{allFilteredSelected ? 'Clear' : 'All'}</Text>
        </TouchableOpacity>
      </View>

      {/* User list */}
      {loading && allUsers.length === 0 ? (
        <View style={styles.emptyWrap} testID="broadcast-loading">
          <ActivityIndicator color={Colors.primary} />
          <Text style={styles.emptyText}>Loading users…</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item, index) => String(item._id) || `u-${index}`}
          renderItem={({ item }) => {
            const id = String(item._id);
            const isSel = selected.has(id);
            const name = getDisplayNameFromUser(item, 'Smilers user');
            return (
              <TouchableOpacity
                style={styles.row}
                onPress={() => toggle(id)}
                activeOpacity={0.7}
                testID={`broadcast-row-${id}`}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{getDisplayInitials(name, 1)}</Text>
                </View>
                <View style={styles.rowMid}>
                  <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    Level {item.level || 'A'} · {Number(item.totalEngagements || 0)} pts
                    {item.role === 'admin' ? ' · Admin' : ''}
                  </Text>
                </View>
                <View style={[styles.check, isSel ? styles.checkOn : null]} testID={`broadcast-check-${id}`}>
                  {isSel ? <Feather name="check" size={16} color={Colors.white} /> : null}
                </View>
              </TouchableOpacity>
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Feather name="users" size={36} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No users found</Text>
              <Text style={styles.emptyText}>Try a different search term.</Text>
            </View>
          }
        />
      )}

      {/* Send button */}
      {selected.size > 0 ? (
        <TouchableOpacity
          style={styles.bottomCta}
          onPress={handleSend}
          disabled={sending}
          activeOpacity={0.85}
          testID="broadcast-send-btn"
        >
          {sending ? (
            <ActivityIndicator color={Colors.headerBg} />
          ) : (
            <>
              <Feather name="radio" size={20} color={Colors.headerBg} />
              <Text style={styles.bottomCtaText}>
                Broadcast to {selected.size} {selected.size === 1 ? 'user' : 'users'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.headerBg,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
    minHeight: 76,
  },
  headerBack: { padding: 4 },
  headerTextWrap: { flex: 1, marginLeft: 4 },
  headerTitle: { color: Colors.white, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  headerSubtitle: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.sm, marginTop: 2 },

  composeWrap: {
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
  },
  composeInput: {
    minHeight: 64,
    maxHeight: 140,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    textAlignVertical: 'top',
  },
  composeCount: { alignSelf: 'flex-end', fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 4 },

  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    minHeight: 44,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  selectAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    minHeight: 44,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primaryLight,
  },
  selectAllText: { color: Colors.primaryDark, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },

  listContent: { paddingBottom: 100 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: Spacing.base,
    gap: Spacing.md,
    backgroundColor: Colors.background,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginLeft: 80 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primary, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  rowMid: { flex: 1 },
  rowName: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },

  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingTop: 60, gap: 8, paddingHorizontal: 32 },
  emptyTitle: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  emptyText: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },

  bottomCta: {
    position: 'absolute',
    bottom: 24,
    left: Spacing.base,
    right: Spacing.base,
    minHeight: 52,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    ...Shadow.lg,
  },
  bottomCtaText: { color: Colors.headerBg, fontSize: FontSize.base, fontWeight: FontWeight.bold },
});
