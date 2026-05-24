/**
 * New Broadcast — mirrors the Smilers web "New Broadcast / Add recipients" UX.
 *
 * Lets the user pick multiple contacts to broadcast a single message to.
 * On submit creates a broadcast-style conversation using
 * `api.conversations.createBroadcast` if available, or falls back to
 * `createGroup` with isBroadcast=true. Either way, the user is dropped into
 * the chat screen where they can compose the broadcast message.
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
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { getDisplayInitials, getDisplayNameFromUser } from '../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

function getContactId(item: any): string | null {
  const value = item?.userId || item?._id || item?.id;
  return value ? String(value) : null;
}

export default function BroadcastCreateScreen() {
  const router = useRouter();
  const createBroadcast = useMutation((api as any).conversations.createBroadcast);
  const createGroup = useMutation((api as any).conversations.createGroup);
  const { data: contacts, loading } = useSafeConvexQuery<any[]>(
    (api as any).contacts.getContacts,
    {},
    [],
  );

  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = Array.isArray(contacts) ? contacts : [];
    if (!q) return list;
    return list.filter((item: any) => {
      const hay = `${getDisplayNameFromUser(item)} ${item?.phone || ''} ${item?.email || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [contacts, search]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }, []);

  const handleCreate = useCallback(async () => {
    if (selectedIds.length === 0) {
      Alert.alert('Select recipients', 'Choose at least one contact to broadcast to.');
      return;
    }
    setCreating(true);
    try {
      // Prefer dedicated broadcast endpoint; fall back to group with flag.
      let created: any = null;
      try {
        created = await createBroadcast({ memberIds: selectedIds });
      } catch (e: any) {
        const message = String(e?.message || '');
        const isMissing = message.includes('CouldNotFindFunction') || message.includes('not found');
        if (!isMissing) throw e;
        // Fallback: group with isBroadcast flag (best effort)
        created = await createGroup({
          name: 'Broadcast list',
          memberIds: selectedIds,
          isBroadcast: true,
        } as any);
      }
      const conversationId =
        typeof created === 'string' ? created : created?._id || created?.conversationId || created?.id;
      if (!conversationId) throw new Error('Broadcast was created without an id.');
      router.replace(`/chat/${conversationId}` as any);
    } catch (errorValue: any) {
      Alert.alert(
        'Could not create broadcast',
        errorValue?.message || 'The backend has not enabled broadcasts yet.',
      );
    } finally {
      setCreating(false);
    }
  }, [createBroadcast, createGroup, router, selectedIds]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="broadcast-create-screen">
      {/* Dark header to match web app screenshot */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.headerBack} testID="broadcast-back">
          <Ionicons name="arrow-back" size={26} color={Colors.white} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>New Broadcast</Text>
          <Text style={styles.headerSubtitle}>Add recipients</Text>
        </View>
        {selectedIds.length > 0 ? (
          <TouchableOpacity
            onPress={handleCreate}
            disabled={creating}
            style={styles.headerCta}
            testID="broadcast-next"
          >
            {creating ? (
              <ActivityIndicator size="small" color={Colors.headerBg} />
            ) : (
              <Text style={styles.headerCtaText}>Next ({selectedIds.length})</Text>
            )}
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <Feather name="search" size={18} color={Colors.textMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search contacts"
          placeholderTextColor={Colors.textMuted}
          style={styles.searchInput}
          testID="broadcast-search-input"
        />
      </View>

      {/* Contact list */}
      {loading && filtered.length === 0 ? (
        <View style={styles.emptyWrap} testID="broadcast-loading">
          <ActivityIndicator color={Colors.primary} />
          <Text style={styles.emptyText}>Loading contacts…</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item, index) => getContactId(item) || `c-${index}`}
          renderItem={({ item }) => {
            const id = getContactId(item) || '';
            const isSel = selectedIds.includes(id);
            const name = getDisplayNameFromUser(item, 'Smilers contact');
            const subtitle = item?.status || item?.about || 'Hey there! I am using Smilers.';
            return (
              <TouchableOpacity
                style={styles.row}
                onPress={() => id && toggle(id)}
                activeOpacity={0.7}
                testID={`broadcast-row-${id || 'unknown'}`}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{getDisplayInitials(name, 1)}</Text>
                </View>
                <View style={styles.rowMid}>
                  <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>{subtitle}</Text>
                </View>
                <View style={[styles.check, isSel ? styles.checkOn : null]} testID={`broadcast-check-${id}`}>
                  {isSel ? <Feather name="check" size={16} color={Colors.white} /> : null}
                </View>
              </TouchableOpacity>
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Feather name="users" size={36} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No contacts found</Text>
              <Text style={styles.emptyText}>Add contacts first, then come back to start a broadcast.</Text>
            </View>
          }
        />
      )}

      {/* Bottom create button (visible only when 1+ selected, for one-handed reach) */}
      {selectedIds.length > 0 ? (
        <TouchableOpacity
          style={styles.bottomCta}
          onPress={handleCreate}
          disabled={creating}
          activeOpacity={0.85}
          testID="broadcast-create-btn"
        >
          {creating ? (
            <ActivityIndicator color={Colors.headerBg} />
          ) : (
            <>
              <Feather name="radio" size={20} color={Colors.headerBg} />
              <Text style={styles.bottomCtaText}>Create broadcast · {selectedIds.length} recipient{selectedIds.length === 1 ? '' : 's'}</Text>
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
  headerCta: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
  },
  headerCtaText: { color: Colors.headerBg, fontWeight: FontWeight.bold, fontSize: FontSize.sm },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: Spacing.base,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: 14,
    minHeight: 44,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },

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
