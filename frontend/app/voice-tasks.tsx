import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import { Feather, Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useConvex, useQuery } from 'convex/react';
import { api } from '../src/convexApi';
import { useAuth } from '../src/providers/AuthProvider';
import {
  readStoredJson,
  writeStoredJson,
} from '../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

const POSITIONS: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const VOICE_TASKS_STORAGE_KEY = 'smilers_voice_task_contacts_v1';
const TRIGGER_WORD = 'Smiley';

interface VoiceTaskAssignment {
  position: number;
  contactId: string;
  name: string;
  avatar?: string | null;
  phone?: string | null;
  /** Convex row id (Id<"voiceTaskContacts">) — required for remove
   *  and reorder mutations. Canonical web shape: `_id`. */
  entryId?: string | null;
}

type AssignmentMap = Record<number, VoiceTaskAssignment>;

/**
 * iter-137: locked to the canonical Convex paths confirmed by the web
 * team. The previous fallback probe arrays have been removed — only
 * `api.voiceTaskContacts.getMyVoiceTaskContacts` is used.
 */
async function loadFromConvex(convex: any): Promise<AssignmentMap | null> {
  const fn = (api as any).voiceTaskContacts?.getMyVoiceTaskContacts;
  if (!fn) return null;
  try {
    const result = await convex.query(fn, {});
    if (!Array.isArray(result)) return null;
    const map: AssignmentMap = {};
    for (const item of result) {
      const position = Number(item?.position);
      if (!position || position < 1 || position > 10) continue;
      map[position] = {
        position,
        contactId: String(item?.contactId || item?.userId || ''),
        name: String(item?.name || 'Contact'),
        avatar: item?.avatar || null,
        phone: item?.phone || null,
        entryId: String(item?._id || ''),
      };
    }
    return map;
  } catch (errorValue: any) {
    console.warn('[voice-tasks] getMyVoiceTaskContacts failed:', errorValue?.message);
    return null;
  }
}

/**
 * iter-137: canonical Convex mutations. `addVoiceTaskContact` takes
 * `{ contactId, position }`; `removeVoiceTaskContact` takes
 * `{ entryId }` (Id<"voiceTaskContacts">, NOT the user id).
 */
async function saveToConvex(
  convex: any,
  position: number,
  contact: VoiceTaskAssignment | null,
  existingEntryId: string | null,
): Promise<boolean> {
  const ns: any = (api as any).voiceTaskContacts;
  if (!ns) return false;
  try {
    if (contact) {
      // Remove any existing row at this slot first (Convex enforces
      // 1 entry per position).
      if (existingEntryId && ns.removeVoiceTaskContact) {
        try {
          await convex.mutation(ns.removeVoiceTaskContact, { entryId: existingEntryId });
        } catch (errorValue: any) {
          // Non-fatal — server may already have GC'd a stale row.
          console.warn('[voice-tasks] remove-before-add failed:', errorValue?.message);
        }
      }
      if (!ns.addVoiceTaskContact) return false;
      await convex.mutation(ns.addVoiceTaskContact, {
        contactId: contact.contactId,
        position,
      });
      return true;
    }
    // Unassign — needs the row id.
    if (!existingEntryId) return true; // nothing to remove
    if (!ns.removeVoiceTaskContact) return false;
    await convex.mutation(ns.removeVoiceTaskContact, { entryId: existingEntryId });
    return true;
  } catch (errorValue: any) {
    console.warn('[voice-tasks] saveToConvex failed:', errorValue?.message);
    return false;
  }
}

import PremiumGate from '../src/components/PremiumGate';

function VoiceTasksScreen() {
  const router = useRouter();
  const convex = useConvex();
  const { isAuthenticated } = useAuth();

  const contacts = useQuery(
    api.contacts.getContacts,
    isAuthenticated ? {} : 'skip'
  ) as any[] | undefined;

  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [loaded, setLoaded] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<number | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pendingPos, setPendingPos] = useState<number | null>(null);

  // Initial load — try Convex first, fall back to local persisted copy.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    (async () => {
      const fromConvex = await loadFromConvex(convex);
      if (cancelled) return;
      if (fromConvex && Object.keys(fromConvex).length > 0) {
        setAssignments(fromConvex);
        setLoaded(true);
        return;
      }
      const local = (await readStoredJson(VOICE_TASKS_STORAGE_KEY, null)) as AssignmentMap | null;
      if (cancelled) return;
      setAssignments(local || {});
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, isAuthenticated]);

  const persistAll = useCallback(async (next: AssignmentMap) => {
    setAssignments(next);
    try {
      await writeStoredJson(VOICE_TASKS_STORAGE_KEY, next);
    } catch (errorValue) {
      // ignore — we already updated UI state
    }
  }, []);

  const openPicker = useCallback((position: number) => {
    setPickerPosition(position);
    setPickerQuery('');
    setPickerVisible(true);
  }, []);

  const closePicker = useCallback(() => {
    setPickerVisible(false);
    setPickerPosition(null);
    setPickerQuery('');
  }, []);

  const handleAssign = useCallback(
    async (position: number, contact: any) => {
      if (!contact) return;
      const next: VoiceTaskAssignment = {
        position,
        contactId: String(contact._id || contact.id || ''),
        name: contact.name || contact.displayName || contact.email || contact.phone || 'Contact',
        avatar: contact.avatar || null,
        phone: contact.phone || null,
      };
      setPendingPos(position);
      const merged: AssignmentMap = { ...assignments, [position]: next };
      await persistAll(merged);
      // iter-137: pass the existing entryId at this slot (if any) so
      // the canonical mutation can remove-before-add to honor the
      // backend's 1-per-position constraint.
      const existingEntryId = assignments[position]?.entryId || null;
      await saveToConvex(convex, position, next, existingEntryId);
      setPendingPos(null);
      closePicker();
    },
    [assignments, closePicker, convex, persistAll]
  );

  const handleUnassign = useCallback(
    async (position: number) => {
      const merged = { ...assignments };
      delete merged[position];
      setPendingPos(position);
      await persistAll(merged);
      // iter-137: removal requires the Convex row id (entryId).
      const existingEntryId = assignments[position]?.entryId || null;
      await saveToConvex(convex, position, null, existingEntryId);
      setPendingPos(null);
    },
    [assignments, convex, persistAll]
  );

  const handleAddPress = useCallback(() => {
    const firstEmpty = POSITIONS.find((p) => !assignments[p]);
    if (firstEmpty) {
      openPicker(firstEmpty);
    } else {
      Alert.alert('All slots used', 'All 10 positions are already assigned. Tap a row to change or remove it.');
    }
  }, [assignments, openPicker]);

  const filteredContacts = useMemo(() => {
    const list = Array.isArray(contacts) ? contacts : [];
    const trimmed = pickerQuery.trim().toLowerCase();
    if (!trimmed) return list;
    return list.filter((c: any) => {
      const name = String(c?.name || c?.displayName || '').toLowerCase();
      const phone = String(c?.phone || '').toLowerCase();
      const email = String(c?.email || '').toLowerCase();
      return name.includes(trimmed) || phone.includes(trimmed) || email.includes(trimmed);
    });
  }, [contacts, pickerQuery]);

  return (
    <View style={styles.container} testID="voice-tasks-screen">
      {/* Yellow gold header per web app */}
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.headerIconBtn}
            testID="voice-tasks-back"
          >
            <Ionicons name="arrow-back" size={24} color={Colors.headerBg} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Voice Tasks</Text>
            <Text style={styles.headerSubtitle}>Assign contacts for hands-free commands</Text>
          </View>
          <TouchableOpacity
            onPress={handleAddPress}
            hitSlop={12}
            style={styles.headerIconBtn}
            testID="voice-tasks-add"
          >
            <Ionicons name="add" size={28} color={Colors.headerBg} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.scrollContent} testID="voice-tasks-scroll">
        {/* Instructions block (off-white card) */}
        <View style={styles.instructionsBlock}>
          <Text style={styles.instructionsText}>
            Assign up to 10 contacts to numbers 1-10. Use voice commands like:{' '}
            <Text style={styles.instructionsBold}>{'"Call 1"'}</Text>,{' '}
            <Text style={styles.instructionsBold}>{'"Video call 3"'}</Text>,{' '}
            <Text style={styles.instructionsBold}>{'"Voice note to 2"'}</Text>, or{' '}
            <Text style={styles.instructionsBold}>{'"Share location with 5"'}</Text>. Say{' '}
            <Text style={styles.instructionsTrigger}>{`"${TRIGGER_WORD}"`}</Text> to end and send
            voice/video messages.
          </Text>
        </View>

        {/* Position rows */}
        {!loaded ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : (
          POSITIONS.map((position) => {
            const a = assignments[position];
            const initial = a ? (a.name.charAt(0) || '?').toUpperCase() : '+';
            return (
              <Pressable
                key={position}
                onPress={() => openPicker(position)}
                onLongPress={() => {
                  if (a) {
                    Alert.alert(
                      `Position ${position}`,
                      `Remove ${a.name}?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Remove',
                          style: 'destructive',
                          onPress: () => handleUnassign(position),
                        },
                      ]
                    );
                  }
                }}
                android_ripple={{ color: Colors.borderLight }}
                style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                testID={`voice-tasks-row-${position}`}
              >
                <View style={styles.positionCircle}>
                  <Text style={styles.positionNumber}>{position}</Text>
                </View>
                {a ? (
                  <View style={styles.contactAvatarFilled}>
                    <Text style={styles.contactAvatarInitial}>{initial}</Text>
                  </View>
                ) : (
                  <View style={styles.contactAvatarEmpty}>
                    <Ionicons name="add" size={18} color={Colors.textMuted} />
                  </View>
                )}
                <View style={styles.rowMid}>
                  <Text
                    style={a ? styles.rowAssignedName : styles.rowPlaceholderText}
                    numberOfLines={1}
                  >
                    {a ? a.name : `Tap to assign position #${position}`}
                  </Text>
                  {a?.phone ? (
                    <Text style={styles.rowAssignedPhone} numberOfLines={1}>
                      {a.phone}
                    </Text>
                  ) : null}
                </View>
                {pendingPos === position ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : a ? (
                  <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
                ) : null}
              </Pressable>
            );
          })
        )}
      </ScrollView>

      {/* Contact picker modal */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="fade"
        onRequestClose={closePicker}
      >
        <Pressable style={styles.modalBackdrop} onPress={closePicker}>
          <Pressable
            style={styles.modalCard}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <View style={styles.modalTitleRow}>
                <Feather name="hash" size={18} color={Colors.textPrimary} />
                <Text style={styles.modalTitle}>Assign to position {pickerPosition ?? ''}</Text>
              </View>
              <TouchableOpacity
                onPress={closePicker}
                hitSlop={12}
                testID="voice-tasks-picker-close"
              >
                <Ionicons name="close" size={24} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={styles.searchRow}>
              <Feather name="search" size={16} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={pickerQuery}
                onChangeText={setPickerQuery}
                placeholder="Search contacts"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                autoCapitalize="none"
                testID="voice-tasks-search"
              />
              {pickerQuery.length > 0 ? (
                <TouchableOpacity onPress={() => setPickerQuery('')} hitSlop={8}>
                  <Feather name="x" size={16} color={Colors.textMuted} />
                </TouchableOpacity>
              ) : null}
            </View>

            <FlatList
              data={filteredContacts}
              keyExtractor={(item) => String(item._id || item.id || item.tokenIdentifier || Math.random())}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Ionicons name="people-outline" size={28} color={Colors.textMuted} />
                  <Text style={styles.emptyTitle}>
                    {contacts === undefined ? 'Loading contacts…' : 'No contacts found'}
                  </Text>
                  {contacts !== undefined && contacts.length === 0 ? (
                    <Text style={styles.emptySub}>Add contacts in Smilers first.</Text>
                  ) : null}
                </View>
              }
              renderItem={({ item }) => {
                const name = item.name || item.displayName || 'Unknown';
                const subtitle = item.phone || item.email || '';
                const init = (name.charAt(0) || '?').toUpperCase();
                return (
                  <TouchableOpacity
                    style={styles.contactRow}
                    onPress={() => handleAssign(pickerPosition!, item)}
                    testID={`voice-tasks-contact-${String(item._id)}`}
                  >
                    <View style={styles.contactAvatarSmall}>
                      <Text style={styles.contactAvatarSmallText}>{init}</Text>
                    </View>
                    <View style={styles.flexOne}>
                      <Text style={styles.contactName} numberOfLines={1}>
                        {name}
                      </Text>
                      {subtitle ? (
                        <Text style={styles.contactSubtitle} numberOfLines={1}>
                          {subtitle}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              }}
              ItemSeparatorComponent={() => <View style={styles.contactDivider} />}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  // Yellow header
  headerSafe: { backgroundColor: Colors.primary },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    minHeight: 76,
    backgroundColor: Colors.primary,
  },
  headerIconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    paddingHorizontal: Spacing.sm,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
  headerSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.headerBg,
    opacity: 0.8,
    marginTop: 2,
  },

  scrollContent: {
    paddingBottom: 48,
  },

  // Instructions block
  instructionsBlock: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.lg,
    backgroundColor: Colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
  },
  instructionsText: {
    fontSize: 14,
    lineHeight: 22,
    color: Colors.textSecondary,
  },
  instructionsBold: {
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  instructionsTrigger: {
    fontWeight: FontWeight.bold,
    color: Colors.primary,
  },

  // Row list
  loadingRow: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
  },
  rowPressed: {
    backgroundColor: Colors.borderLight,
  },
  positionCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  positionNumber: {
    fontSize: 16,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  contactAvatarEmpty: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: Colors.textMuted,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  contactAvatarFilled: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactAvatarInitial: {
    fontSize: 15,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
  rowMid: { flex: 1 },
  rowPlaceholderText: {
    fontSize: 15,
    color: Colors.textSecondary,
  },
  rowAssignedName: {
    fontSize: 15,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  rowAssignedPhone: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingTop: Spacing.lg,
    maxHeight: '75%',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.base,
  },
  modalTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    paddingVertical: 0,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
  },
  contactAvatarSmall: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactAvatarSmallText: {
    fontSize: 16,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
  contactName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  contactSubtitle: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  contactDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.borderLight,
    marginLeft: Spacing.lg + 40 + Spacing.md,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 8,
  },
  emptyTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  emptySub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  flexOne: { flex: 1 },
});

export default function GatedVoiceTasksScreen() {
  return (
    <PremiumGate featureName="Voice Tasks">
      <VoiceTasksScreen />
    </PremiumGate>
  );
}
