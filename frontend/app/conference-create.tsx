/**
 * Conference Create — Slice C of the Groups spec.
 *
 * Mirrors the web app's flow: pick a parent group (optional), enter a title,
 * choose audio/video + open/invite-only, then assign the Clerk and Protocol
 * roles from the group's members. The viewer becomes the Chair automatically.
 *
 * Calls `api.conferences.startConference` with safe fallback. If the backend
 * endpoint isn't deployed yet we surface a clear alert; otherwise we route
 * straight into `/call/<conferenceId>?type=video&conferenceMode=1` so the
 * ConferenceHUD overlay appears on the call screen.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { useAuth } from '../src/providers/AuthProvider';
import { findSavedContactDisplayName } from '../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../src/theme';

interface MemberOption {
  userId: string;
  name: string;
}

type Mode = 'video' | 'audio';
type EntryMode = 'open' | 'invite';

function normalizeMembers(group: any, contacts: any[]): MemberOption[] {
  const raw =
    group?.memberRecords ||
    group?.members ||
    group?.participants ||
    [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) => {
      if (!entry) return null;
      if (typeof entry === 'string') {
        return { userId: entry, name: findSavedContactDisplayName(contacts, entry) || 'Member' } as MemberOption;
      }
      const userId = String(entry.userId || entry._id || entry.id || '');
      if (!userId) return null;
      const name =
        entry.name ||
        entry.displayName ||
        entry.fullName ||
        entry.user?.name ||
        findSavedContactDisplayName(contacts, userId) ||
        'Member';
      return { userId, name } as MemberOption;
    })
    .filter(Boolean) as MemberOption[];
}

function MemberPickerModal({
  visible,
  title,
  options,
  selectedUserId,
  excludeUserId,
  onSelect,
  onClear,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: MemberOption[];
  selectedUserId: string | null;
  excludeUserId?: string | null;
  onSelect: (option: MemberOption) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const filtered = options.filter((o) => o.userId !== excludeUserId);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>{title}</Text>
          {filtered.length === 0 ? (
            <Text style={styles.modalHint}>
              Pick a group first — the role options come from its member list.
            </Text>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.userId}
              style={{ maxHeight: 320 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalRow}
                  onPress={() => onSelect(item)}
                  testID={`conf-role-pick-${item.userId}`}
                >
                  <View style={styles.miniAvatar}>
                    <Text style={styles.miniAvatarText}>{(item.name || 'M').charAt(0).toUpperCase()}</Text>
                  </View>
                  <Text style={styles.modalRowText}>{item.name}</Text>
                  {selectedUserId === item.userId ? <Feather name="check" size={18} color={Colors.primary} /> : null}
                </TouchableOpacity>
              )}
            />
          )}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TouchableOpacity style={[styles.modalGhostBtn, { flex: 1 }]} onPress={onClear} testID="conf-role-clear">
              <Text style={styles.modalGhostText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalGhostBtn, { flex: 1 }]} onPress={onClose} testID="conf-role-close">
              <Text style={styles.modalGhostText}>Done</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function ConferenceCreateScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: groups } = useSafeConvexQuery<any[]>(api.conversations.listGroups, {}, [], isAuthenticated);
  const { data: contacts } = useSafeConvexQuery<any[]>(api.contacts.getContacts, {}, [], isAuthenticated);
  const { data: me } = useSafeConvexQuery<any>(api.users.getCurrentUser, {}, null, isAuthenticated);

  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<Mode>('video');
  const [entryMode, setEntryMode] = useState<EntryMode>('open');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [clerk, setClerk] = useState<MemberOption | null>(null);
  const [protocol, setProtocol] = useState<MemberOption | null>(null);
  const [showClerkPicker, setShowClerkPicker] = useState(false);
  const [showProtocolPicker, setShowProtocolPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const selectedGroup = useMemo(() => {
    const list = Array.isArray(groups) ? groups : [];
    return list.find((g: any) => String(g?._id || g?.id) === groupId) || null;
  }, [groupId, groups]);

  const memberOptions = useMemo(
    () => normalizeMembers(selectedGroup, Array.isArray(contacts) ? contacts : []),
    [contacts, selectedGroup],
  );

  const myUserId = me?._id ? String(me._id) : null;

  const startConferenceM = useMutation((api as any).conferences.startConference);

  const handleStart = useCallback(async () => {
    if (!title.trim()) {
      Alert.alert('Add a title', 'Please give the conference a short title before starting.');
      return;
    }
    setSubmitting(true);
    try {
      const result: any = await startConferenceM({
        title: title.trim(),
        mode,
        entryMode,
        groupId: groupId || undefined,
        clerkUserId: clerk?.userId || undefined,
        protocolUserId: protocol?.userId || undefined,
      });
      const conferenceId = String(result?.conferenceId || result?._id || result?.id || '');
      if (!conferenceId) {
        throw new Error('Backend did not return a conferenceId.');
      }
      router.replace(`/call/${conferenceId}?type=${mode === 'audio' ? 'voice' : 'video'}&conferenceMode=1` as any);
    } catch (errorValue: any) {
      const message = errorValue?.message || String(errorValue || '');
      Alert.alert(
        'Could not start conference',
        message.includes('CouldNotFindFunction') || message.includes('not found')
          ? 'The conferencing backend endpoints haven\u2019t been deployed yet. Once the web team ships `conferences.startConference`, this flow will start the meeting end-to-end.'
          : message,
      );
    } finally {
      setSubmitting(false);
    }
  }, [clerk, entryMode, groupId, mode, protocol, router, startConferenceM, title]);

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="conference-create-screen">
      <Header
        title="New conference"
        showBack
        onBack={() => router.back()}
        variant="dark"
        subtitle="Assign roles and kick off the meeting"
      />

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Title*</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Weekly board meeting"
            placeholderTextColor={Colors.textMuted}
            style={styles.textInput}
            testID="conf-title-input"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Mode</Text>
          <View style={styles.segmentRow}>
            <SegmentButton
              icon="videocam-outline"
              label="Video"
              active={mode === 'video'}
              onPress={() => setMode('video')}
              testID="conf-mode-video"
            />
            <SegmentButton
              icon="call-outline"
              label="Audio"
              active={mode === 'audio'}
              onPress={() => setMode('audio')}
              testID="conf-mode-audio"
            />
          </View>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Entry</Text>
          <Text style={styles.helperText}>
            Open conferences accept anyone with the link. Invite-only requires the Protocol to admit each participant from the lobby.
          </Text>
          <View style={styles.segmentRow}>
            <SegmentButton
              icon="lock-open-outline"
              label="Open"
              active={entryMode === 'open'}
              onPress={() => setEntryMode('open')}
              testID="conf-entry-open"
            />
            <SegmentButton
              icon="lock-closed-outline"
              label="Invite-only"
              active={entryMode === 'invite'}
              onPress={() => setEntryMode('invite')}
              testID="conf-entry-invite"
            />
          </View>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Parent group (optional)</Text>
          <Text style={styles.helperText}>
            Conferences are not tied to a group, but choosing one makes the role pickers populate with that group&apos;s members.
          </Text>
          <TouchableOpacity
            style={styles.selectorRow}
            onPress={() => setShowGroupPicker(true)}
            testID="conf-group-picker"
          >
            <MaterialCommunityIcons name="account-group-outline" size={20} color={Colors.primary} />
            <Text style={styles.selectorRowText}>{selectedGroup?.name || 'None'}</Text>
            <Feather name="chevron-right" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Roles</Text>
          <View style={styles.roleRow}>
            <MaterialCommunityIcons name="crown" size={18} color="#92400e" />
            <View style={{ flex: 1 }}>
              <Text style={styles.roleRowTitle}>Chair</Text>
              <Text style={styles.roleRowSub}>You (creator) by default</Text>
            </View>
            <Text style={styles.roleStaticValue}>You</Text>
          </View>

          <TouchableOpacity
            style={styles.roleRow}
            onPress={() => setShowClerkPicker(true)}
            testID="conf-clerk-row"
          >
            <MaterialCommunityIcons name="pencil-outline" size={18} color="#1e3a8a" />
            <View style={{ flex: 1 }}>
              <Text style={styles.roleRowTitle}>Clerk / Secretary</Text>
              <Text style={styles.roleRowSub}>Minutes, notice board, screen share</Text>
            </View>
            <Text style={styles.roleStaticValue}>{clerk?.name || 'Assign'}</Text>
            <Feather name="chevron-right" size={18} color={Colors.textMuted} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.roleRow}
            onPress={() => setShowProtocolPicker(true)}
            testID="conf-protocol-row"
          >
            <MaterialCommunityIcons name="shield-check" size={18} color="#166534" />
            <View style={{ flex: 1 }}>
              <Text style={styles.roleRowTitle}>Protocol</Text>
              <Text style={styles.roleRowSub}>Timer, force video off, admit lobby</Text>
            </View>
            <Text style={styles.roleStaticValue}>{protocol?.name || 'Assign'}</Text>
            <Feather name="chevron-right" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.infoBanner}>
          <Feather name="info" size={18} color={Colors.primary} />
          <Text style={styles.infoBannerText}>
            All participants start muted. Unmuting requires Chair approval — you can unmute in batches once the call is live.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.startBtn, (!title.trim() || submitting) && styles.startBtnDisabled]}
          onPress={handleStart}
          disabled={!title.trim() || submitting}
          testID="conf-start-button"
        >
          <Ionicons name={mode === 'audio' ? 'call-outline' : 'videocam-outline'} size={20} color={Colors.headerBg} />
          <Text style={styles.startBtnText}>{submitting ? 'Starting…' : 'Start conference'}</Text>
        </TouchableOpacity>
      </ScrollView>

      <GroupPickerModal
        visible={showGroupPicker}
        groups={Array.isArray(groups) ? groups : []}
        selectedGroupId={groupId}
        onSelect={(nextId) => {
          setGroupId(nextId);
          // Reset role picks because the member list changed.
          setClerk(null);
          setProtocol(null);
          setShowGroupPicker(false);
        }}
        onClear={() => {
          setGroupId(null);
          setClerk(null);
          setProtocol(null);
          setShowGroupPicker(false);
        }}
        onClose={() => setShowGroupPicker(false)}
      />

      <MemberPickerModal
        visible={showClerkPicker}
        title="Choose the Clerk"
        options={memberOptions}
        selectedUserId={clerk?.userId || null}
        excludeUserId={myUserId}
        onSelect={(option) => {
          setClerk(option);
          if (protocol?.userId === option.userId) setProtocol(null);
          setShowClerkPicker(false);
        }}
        onClear={() => {
          setClerk(null);
          setShowClerkPicker(false);
        }}
        onClose={() => setShowClerkPicker(false)}
      />

      <MemberPickerModal
        visible={showProtocolPicker}
        title="Choose the Protocol"
        options={memberOptions}
        selectedUserId={protocol?.userId || null}
        excludeUserId={myUserId}
        onSelect={(option) => {
          setProtocol(option);
          if (clerk?.userId === option.userId) setClerk(null);
          setShowProtocolPicker(false);
        }}
        onClear={() => {
          setProtocol(null);
          setShowProtocolPicker(false);
        }}
        onClose={() => setShowProtocolPicker(false)}
      />
    </SafeAreaView>
  );
}

function SegmentButton({
  icon,
  label,
  active,
  onPress,
  testID,
}: {
  icon: any;
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.segmentBtn, active ? styles.segmentBtnActive : null]}
      onPress={onPress}
      testID={testID}
      activeOpacity={0.7}
    >
      <Ionicons name={icon} size={18} color={active ? Colors.headerBg : Colors.textPrimary} />
      <Text style={[styles.segmentBtnText, active ? { color: Colors.headerBg } : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

function GroupPickerModal({
  visible,
  groups,
  selectedGroupId,
  onSelect,
  onClear,
  onClose,
}: {
  visible: boolean;
  groups: any[];
  selectedGroupId: string | null;
  onSelect: (groupId: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>Pick a group</Text>
          {groups.length === 0 ? (
            <Text style={styles.modalHint}>No groups yet — you can still start a conference without one.</Text>
          ) : (
            <FlatList
              data={groups}
              keyExtractor={(item: any, index) => String(item?._id || item?.id || index)}
              style={{ maxHeight: 320 }}
              renderItem={({ item }) => {
                const id = String(item?._id || item?.id || '');
                const memberCount = item?.memberCount || item?.members?.length || 0;
                return (
                  <TouchableOpacity
                    style={styles.modalRow}
                    onPress={() => onSelect(id)}
                    testID={`conf-group-pick-${id}`}
                  >
                    <View style={styles.miniAvatar}>
                      <Text style={styles.miniAvatarText}>{(item?.name || 'G').charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalRowText}>{item?.name || 'Group'}</Text>
                      <Text style={styles.modalRowSub}>{memberCount} member{memberCount === 1 ? '' : 's'}</Text>
                    </View>
                    {selectedGroupId === id ? <Feather name="check" size={18} color={Colors.primary} /> : null}
                  </TouchableOpacity>
                );
              }}
            />
          )}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TouchableOpacity style={[styles.modalGhostBtn, { flex: 1 }]} onPress={onClear} testID="conf-group-clear">
              <Text style={styles.modalGhostText}>No group</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalGhostBtn, { flex: 1 }]} onPress={onClose} testID="conf-group-close">
              <Text style={styles.modalGhostText}>Done</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollContent: { padding: Spacing.base, gap: Spacing.lg, paddingBottom: Spacing.xxl * 2 },

  fieldGroup: { gap: 8 },
  label: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  helperText: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },

  textInput: {
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },

  segmentRow: { flexDirection: 'row', gap: 8 },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  segmentBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  segmentBtnText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },

  selectorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  selectorRowText: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },

  roleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    backgroundColor: Colors.surface,
    marginBottom: 8,
  },
  roleRowTitle: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  roleRowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  roleStaticValue: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.semibold, maxWidth: 130 },

  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryLight,
  },
  infoBannerText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20 },

  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 52,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
  },
  startBtnDisabled: { opacity: 0.55 },
  startBtnText: { fontSize: FontSize.base, color: Colors.headerBg, fontWeight: FontWeight.bold },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: Colors.background,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: 10,
    ...Shadow.lg,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalHint: { fontSize: FontSize.sm, color: Colors.textSecondary, paddingVertical: 8 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderLight,
  },
  modalRowText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  modalRowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  modalGhostBtn: {
    paddingVertical: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modalGhostText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },

  miniAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniAvatarText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.bold },
});
