/**
 * /groups-create — Two-step "New Group" flow.
 *
 * iter-151: Aligned to the canonical Convex contract from the backend
 *   (`api.conversations.createGroup({ name, memberIds, description? })`).
 *   The two-step UI matches the web app's exact flow:
 *     Step 1  ▸  Add participants  (multi-select contacts)
 *     Step 2  ▸  Group Details     (name * + description + participants)
 *
 *   Wrapped in `ScreenErrorBoundary` so any render-time crash shows the
 *   friendly fallback instead of "Smilers has stopped".
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  ScrollView,
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
import { useDeviceContactIndex, lookupDeviceContactName } from '../src/lib/deviceContactIndex';
import { getResolvedDisplayName } from '../src/lib/displayName';
import ScreenErrorBoundary from '../src/components/ScreenErrorBoundary';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type Step = 'participants' | 'details';

function getContactUserId(item: any): string | null {
  const value =
    item?.userId ||
    item?.user?._id ||
    item?.user?.userId ||
    item?.contactUserId ||
    item?.linkedUserId ||
    item?._id ||
    item?.id;
  return value ? String(value) : null;
}

function getInitials(name?: string): string {
  if (!name) return '?';
  const trimmed = String(name).trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export default function GroupsCreateScreen() {
  const router = useRouter();
  return (
    <ScreenErrorBoundary screenName="groups-create" onClose={() => router.back()}>
      <GroupsCreateScreenInner />
    </ScreenErrorBoundary>
  );
}

function GroupsCreateScreenInner() {
  const router = useRouter();
  const createGroup = useMutation((api as any).conversations?.createGroup);
  const { data: contacts, loading: contactsLoading } = useSafeConvexQuery<any[]>(
    api.contacts.getContacts,
    {},
    [],
  );
  const { data: me } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null);
  const deviceIndex = useDeviceContactIndex();

  // iter-303: device address-book name wins over the Smilers/Google name.
  const displayNameFor = useCallback(
    (obj: any): string =>
      getResolvedDisplayName(
        obj,
        deviceIndex,
        lookupDeviceContactName,
        obj?.name || obj?.displayName || obj?.email || obj?.phone || 'Contact',
      ),
    [deviceIndex],
  );

  const [step, setStep] = useState<Step>('participants');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const eligibleContacts = useMemo(() => {
    const list = Array.isArray(contacts) ? contacts : [];
    // iter-151: only contacts who are actually registered Smilers users
    // are eligible group members (mirrors trustees screen). Locally-saved
    // invite-only contacts get filtered out.
    return list.filter((c: any) => !!getContactUserId(c));
  }, [contacts]);

  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligibleContacts;
    return eligibleContacts.filter((item: any) =>
      `${displayNameFor(item)} ${item?.phone || ''} ${item?.email || ''}`.toLowerCase().includes(q),
    );
  }, [eligibleContacts, search, displayNameFor]);

  const selectedContacts = useMemo(() => {
    return selectedIds
      .map((id) => eligibleContacts.find((c) => getContactUserId(c) === id))
      .filter(Boolean) as any[];
  }, [eligibleContacts, selectedIds]);

  const toggleContact = useCallback((contactId: string) => {
    setSelectedIds((current) =>
      current.includes(contactId)
        ? current.filter((item) => item !== contactId)
        : [...current, contactId],
    );
  }, []);

  const handleNext = useCallback(() => {
    if (selectedIds.length === 0) {
      Alert.alert('Add participants', 'Pick at least one contact to continue.');
      return;
    }
    setStep('details');
  }, [selectedIds.length]);

  const handleCreate = useCallback(async () => {
    const name = groupName.trim();
    if (!name) {
      Alert.alert('Group name required', 'Enter a name for your new group.');
      return;
    }
    if (selectedIds.length === 0) {
      Alert.alert('Add participants', 'Pick at least one contact before creating.');
      return;
    }
    if (typeof createGroup !== 'function') {
      Alert.alert(
        'Cannot create group',
        'The server is missing the `conversations.createGroup` function. Please retry after the next deployment.',
      );
      return;
    }
    setCreating(true);
    try {
      // iter-151: canonical contract — `createGroup({ name, memberIds,
      // description? })`. Server accepts both `memberIds` (native) and
      // `participantIds` (web); we use the native name.
      const result = await createGroup({
        name,
        memberIds: selectedIds,
        description: description.trim() || undefined,
      } as any);
      const newConversationId = typeof result === 'string' ? result : (result as any)?.conversationId;
      if (newConversationId) {
        router.replace(`/chat/${String(newConversationId)}` as any);
      } else {
        router.back();
      }
    } catch (errorValue: any) {
      const code = errorValue?.data?.code || errorValue?.code || '';
      const message =
        errorValue?.data?.message ||
        errorValue?.message ||
        'Could not create group. Please try again.';
      Alert.alert(`Could not create group${code ? ` (${code})` : ''}`, String(message).slice(0, 240));
      setCreating(false);
    }
  }, [createGroup, description, groupName, router, selectedIds]);

  // -------------------------------------------------------------------
  //                      Step 1 — Add participants
  // -------------------------------------------------------------------
  if (step === 'participants') {
    const headerCommitDisabled = selectedIds.length === 0;
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="groups-create-step1">
        <View style={styles.headerDark} testID="groups-create-step1-header">
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="groups-create-step1-back">
            <Ionicons name="arrow-back" size={26} color={Colors.white} />
          </TouchableOpacity>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerTitle} testID="groups-create-step1-title">New Group</Text>
            <Text style={styles.headerSubtitle}>
              {selectedIds.length > 0 ? `${selectedIds.length} selected` : 'Add participants'}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleNext}
            disabled={headerCommitDisabled}
            hitSlop={10}
            testID="groups-create-step1-commit"
            style={headerCommitDisabled ? styles.headerCommitDisabled : undefined}
          >
            <Feather name="check" size={26} color={headerCommitDisabled ? 'rgba(255,255,255,0.35)' : Colors.white} />
          </TouchableOpacity>
        </View>

        {selectedContacts.length > 0 ? (
          <View style={styles.chipsRail}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsContent}>
              {selectedContacts.map((contact: any) => {
                const cid = getContactUserId(contact)!;
                return (
                  <TouchableOpacity
                    key={cid}
                    style={styles.chipWrap}
                    activeOpacity={0.7}
                    onPress={() => toggleContact(cid)}
                    testID={`groups-create-selected-chip-${cid}`}
                  >
                    <View style={styles.chipAvatar}>
                      {contact?.avatarUrl ? (
                        <Image source={{ uri: contact.avatarUrl }} style={styles.chipAvatarImg} />
                      ) : (
                        <Text style={styles.chipAvatarText}>{getInitials(displayNameFor(contact))}</Text>
                      )}
                      <View style={styles.chipRemove}>
                        <Feather name="x" size={11} color={Colors.white} />
                      </View>
                    </View>
                    <Text style={styles.chipLabel} numberOfLines={1}>
                      {displayNameFor(contact).split(' ')[0] || 'Contact'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <View style={styles.searchWrap}>
          <Feather name="search" size={18} color={Colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search contacts..."
            placeholderTextColor={Colors.textMuted}
            style={styles.searchInput}
            testID="groups-create-step1-search"
          />
        </View>

        {contactsLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={Colors.primary} size="large" />
          </View>
        ) : (
          <FlatList
            data={filteredContacts}
            keyExtractor={(item: any) => getContactUserId(item) || String(Math.random())}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Feather name="users" size={32} color={Colors.textMuted} />
                <Text style={styles.emptyTitle}>No Smilers contacts</Text>
                <Text style={styles.emptyBody}>
                  Invite friends from the Contacts tab first — once they accept they&apos;ll appear here.
                </Text>
              </View>
            }
            renderItem={({ item }: any) => {
              const cid = getContactUserId(item);
              if (!cid) return null;
              const selected = selectedIds.includes(cid);
              return (
                <TouchableOpacity
                  style={styles.row}
                  activeOpacity={0.7}
                  onPress={() => toggleContact(cid)}
                  testID={`groups-create-step1-row-${cid}`}
                >
                  <View style={styles.rowAvatar}>
                    {item?.avatarUrl ? (
                      <Image source={{ uri: item.avatarUrl }} style={styles.rowAvatarImg} />
                    ) : (
                      <Text style={styles.rowAvatarText}>{getInitials(displayNameFor(item))}</Text>
                    )}
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>{displayNameFor(item)}</Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {item?.bio || item?.statusMessage || 'Hey there! I am using Smilers.'}
                    </Text>
                  </View>
                  <View style={[styles.checkbox, selected && styles.checkboxOn]}>
                    {selected ? <Feather name="check" size={16} color={Colors.white} /> : null}
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.primaryCta, selectedIds.length === 0 && styles.primaryCtaDisabled]}
            disabled={selectedIds.length === 0}
            onPress={handleNext}
            activeOpacity={0.85}
            testID="groups-create-step1-next"
          >
            <Text style={styles.primaryCtaText}>
              {selectedIds.length === 0 ? 'Next' : `Next (${selectedIds.length} selected)`}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // -------------------------------------------------------------------
  //                      Step 2 — Group details
  // -------------------------------------------------------------------
  const meName = me?.name || me?.displayName || 'You';
  const totalParticipants = selectedContacts.length + 1; // +1 for "You"
  const canCreate = groupName.trim().length > 0 && selectedIds.length > 0 && !creating;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="groups-create-step2">
      <View style={styles.headerYellow} testID="groups-create-step2-header">
        <TouchableOpacity onPress={() => setStep('participants')} hitSlop={10} testID="groups-create-step2-back">
          <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerYellowTitle} testID="groups-create-step2-title">Group Details</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.detailsBody}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.bigAvatarWrap}>
          <View style={styles.bigAvatar}>
            <Feather name="users" size={42} color={Colors.primary} />
          </View>
        </View>

        <Text style={styles.fieldLabel}>
          Group Name <Text style={styles.fieldRequired}>*</Text>
        </Text>
        <TextInput
          value={groupName}
          onChangeText={setGroupName}
          placeholder="e.g. Family, Work Team..."
          placeholderTextColor={Colors.textMuted}
          style={styles.fieldInput}
          autoFocus
          maxLength={64}
          testID="groups-create-step2-name"
        />

        <Text style={styles.fieldLabel}>
          Description <Text style={styles.fieldOptional}>(optional)</Text>
        </Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="What's this group about?"
          placeholderTextColor={Colors.textMuted}
          style={[styles.fieldInput, styles.fieldTextarea]}
          multiline
          numberOfLines={3}
          maxLength={280}
          testID="groups-create-step2-description"
        />

        <Text style={styles.participantsHeader}>
          PARTICIPANTS ({totalParticipants})
        </Text>
        <View style={styles.participantsChips}>
          {selectedContacts.map((contact: any) => {
            const cid = getContactUserId(contact)!;
            return (
              <View key={cid} style={styles.participantChip} testID={`groups-create-step2-chip-${cid}`}>
                <View style={styles.participantChipAvatar}>
                  {contact?.avatarUrl ? (
                    <Image source={{ uri: contact.avatarUrl }} style={styles.participantChipAvatarImg} />
                  ) : (
                    <Text style={styles.participantChipAvatarText}>{getInitials(displayNameFor(contact))}</Text>
                  )}
                </View>
                <Text style={styles.participantChipLabel} numberOfLines={1}>
                  {displayNameFor(contact)}
                </Text>
              </View>
            );
          })}
          <View style={[styles.participantChip, styles.participantChipMe]}>
            <Text style={[styles.participantChipLabel, styles.participantChipMeText]}>{meName}</Text>
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.primaryCta, !canCreate && styles.primaryCtaDisabled]}
          disabled={!canCreate}
          onPress={handleCreate}
          activeOpacity={0.85}
          testID="groups-create-step2-create"
        >
          {creating ? (
            <ActivityIndicator color={Colors.textPrimary} />
          ) : (
            <Text style={styles.primaryCtaText}>Create Group</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const HEADER_HEIGHT = Platform.select({ ios: 100, default: 88 });

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },

  // ---- Step 1 header (dark brown) ----
  headerDark: {
    height: HEADER_HEIGHT,
    backgroundColor: '#2a1a05',
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.md,
    gap: Spacing.md,
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: { color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold },
  headerSubtitle: { color: 'rgba(255,255,255,0.65)', fontSize: FontSize.sm, marginTop: 2 },
  headerCommitDisabled: { opacity: 0.4 },

  // ---- Step 2 header (yellow) ----
  headerYellow: {
    height: HEADER_HEIGHT,
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.md,
  },
  headerYellowTitle: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary },

  // ---- Selected chips rail (Step 1) ----
  chipsRail: { backgroundColor: Colors.surface, paddingVertical: Spacing.md },
  chipsContent: { paddingHorizontal: Spacing.base, gap: Spacing.base },
  chipWrap: { alignItems: 'center', width: 64 },
  chipAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  chipAvatarImg: { width: 52, height: 52, borderRadius: 26 },
  chipAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: 18 },
  chipRemove: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#E53E3E',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  chipLabel: { fontSize: FontSize.xs, color: Colors.textPrimary, marginTop: 4, textAlign: 'center' },

  // ---- Search ----
  searchWrap: {
    margin: Spacing.base,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.base,
    height: 44,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  searchInput: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, paddingVertical: 0 },

  // ---- List ----
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingBottom: 120 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    gap: Spacing.md,
    backgroundColor: Colors.surface,
  },
  separator: { height: 1, backgroundColor: Colors.borderLight, marginLeft: 76 },
  rowAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowAvatarImg: { width: 48, height: 48, borderRadius: 24 },
  rowAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: 18 },
  rowBody: { flex: 1 },
  rowName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },

  empty: { paddingTop: 60, paddingHorizontal: Spacing.lg, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: Colors.textPrimary, textAlign: 'center' },
  emptyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  // ---- Step 2 body ----
  detailsBody: { padding: Spacing.base, paddingBottom: 120 },
  bigAvatarWrap: { alignItems: 'center', paddingVertical: Spacing.lg },
  bigAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldLabel: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  fieldRequired: { color: '#D63030', fontWeight: FontWeight.bold },
  fieldOptional: { color: Colors.textSecondary, fontWeight: FontWeight.regular as any, fontSize: FontSize.sm },
  fieldInput: {
    minHeight: 50,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  fieldTextarea: { minHeight: 70, textAlignVertical: 'top', borderColor: Colors.borderLight },

  participantsHeader: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    letterSpacing: 1.2,
    marginTop: Spacing.xl,
    marginBottom: Spacing.sm,
  },
  participantsChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  participantChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primaryLight,
    maxWidth: '48%',
  },
  participantChipMe: { backgroundColor: 'rgba(229,156,26,0.2)' },
  participantChipMeText: { color: Colors.primary, fontWeight: FontWeight.bold },
  participantChipAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  participantChipAvatarImg: { width: 22, height: 22, borderRadius: 11 },
  participantChipAvatarText: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: 11 },
  participantChipLabel: { fontSize: FontSize.sm, color: Colors.textPrimary, flexShrink: 1 },

  // ---- Footer ----
  footer: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.md,
    paddingBottom: Platform.select({ ios: Spacing.lg, default: Spacing.base }),
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
  },
  primaryCta: {
    height: 56,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryCtaDisabled: { backgroundColor: 'rgba(229,156,26,0.45)' },
  primaryCtaText: { color: Colors.textPrimary, fontSize: FontSize.base, fontWeight: FontWeight.bold },
});
