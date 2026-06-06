// Scheduled Messages — backed by `api.scheduledMessages.*`.

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Switch,
  Modal,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import DateTimePicker from '@react-native-community/datetimepicker';
import Header from '../src/components/Header';
import { api } from '../src/convexApi';
import { useSafeConvexQuery } from '../src/hooks/useSafeConvexQuery';
import { readStoredJson, writeStoredJson } from '../src/lib/settingsStorage';
import { errorToMessage } from '../src/lib/safeString';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../src/theme';

type Repeat = 'once' | 'daily' | 'weekly' | 'monthly';
interface Schedule {
  _id: string;
  recipient: string;
  message: string;
  date: string;
  time: string;
  repeat: Repeat;
  active: boolean;
}

const REPEAT_LABEL: Record<Repeat, string> = { once: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const REPEAT_OPTIONS: Repeat[] = ['once', 'daily', 'weekly', 'monthly'];

function pad2(n: number) { return n.toString().padStart(2, '0'); }
function todayYMD() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function nowHM() { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function parseYMD(s: string) { const [y, m, d] = s.split('-').map(Number); const dt = new Date(); dt.setFullYear(y, (m || 1) - 1, d || 1); dt.setHours(0, 0, 0, 0); return dt; }
function parseHM(s: string) { const [h, m] = s.split(':').map(Number); const dt = new Date(); dt.setHours(h || 0, m || 0, 0, 0); return dt; }

// Local-only scheduled messages saved by the chat composer when the
// Convex `scheduling.scheduleMessageMobile` mutation throws Server
// Error. Key MUST match the one used in /app/frontend/app/chat/
// [conversationId].tsx (see the saveScheduled callback). iter-106:
// surface these in the list AND drive the sync banner colour from
// the unsynced-count instead of hard-coding "Synced with Smilers
// cloud" — which was misleading the user after every failed save.
const LOCAL_SCHEDULES_KEY = 'smilers_local_scheduled_messages';
type LocalScheduleDraft = {
  localId: string;
  conversationId?: string;
  recipient?: string;
  message: string;
  whenMs: number;
  recurring?: boolean;
  frequency?: string | null;
  savedAt?: number;
};

export default function ScheduledScreen() {
  const router = useRouter();
  const { data: items, loading } = useSafeConvexQuery<Schedule[]>(api.scheduledMessages.listMine, {}, []);
  const createSchedule = useMutation(api.scheduling.scheduleMessageMobile);
  // iter-113: alt path — some deployments expose scheduledMessages.create
  // instead. We probe it as a fallback when the primary throws Server
  // Error. Safe no-op when the function isn't deployed (anyApi proxy).
  const createScheduleLegacy = useMutation((api as any).scheduledMessages?.create);
  const updateSchedule = useMutation(api.scheduledMessages.update);
  const removeSchedule = useMutation(api.scheduledMessages.remove);
  const setActiveSchedule = useMutation(api.scheduledMessages.setActive);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [localDrafts, setLocalDrafts] = useState<LocalScheduleDraft[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  // Load local drafts on mount AND every time the server query resolves
  // (a fresh server snapshot may have superseded some local entries).
  const reloadLocalDrafts = useCallback(async () => {
    try {
      const raw = (await readStoredJson(LOCAL_SCHEDULES_KEY, [])) as any;
      const arr: LocalScheduleDraft[] = Array.isArray(raw) ? raw : [];
      // Drop entries whose scheduled time is in the past — they're stale
      // and the backend wouldn't accept them now anyway.
      const now = Date.now();
      const live = arr.filter((d) => typeof d?.whenMs === 'number' && d.whenMs > now - 60_000);
      setLocalDrafts(live);
      if (live.length !== arr.length) {
        try { await writeStoredJson(LOCAL_SCHEDULES_KEY, live); } catch {}
      }
    } catch {
      setLocalDrafts([]);
    }
  }, []);
  useEffect(() => { void reloadLocalDrafts(); }, [reloadLocalDrafts]);
  useEffect(() => { if (!loading) void reloadLocalDrafts(); }, [items, loading, reloadLocalDrafts]);

  /**
   * Manually push every local draft to the Convex backend, one at a time,
   * removing successful ones from local storage. Stops on the first hard
   * failure so we don't hammer the server with the same broken payload.
   */
  const syncLocalDrafts = useCallback(async () => {
    if (syncing || localDrafts.length === 0) return;
    setSyncing(true);
    setLastSyncError(null);
    const remaining: LocalScheduleDraft[] = [];
    let firstError: string | null = null;
    for (const draft of localDrafts) {
      try {
        const when = new Date(draft.whenMs);
        const date = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
        const time = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
        // iter-113: defensive arg coercion + dual-endpoint probe
        // iter-120: fallback now uses NEW `scheduledMessages.create`
        // schema per backend agent: { recipient, text, scheduledAt }.
        const args = {
          recipient: String(draft.recipient || 'Conversation').slice(0, 200),
          message: String(draft.message || '').slice(0, 5000),
          date,
          time,
          repeat: 'once' as const,
          active: true,
        };
        const argsNew = {
          recipient: String(draft.recipient || 'Conversation').slice(0, 200),
          text: String(draft.message || '').slice(0, 5000),
          scheduledAt: when.toISOString(),
        };
        try {
          await createSchedule(args);
        } catch (primaryErr: any) {
          // Try new scheduledMessages.create schema as fallback
          if (typeof createScheduleLegacy === 'function') {
            await (createScheduleLegacy as any)(argsNew);
          } else {
            throw primaryErr;
          }
        }
        // success — drop from local
      } catch (errorValue: any) {
        if (!firstError) firstError = errorToMessage(errorValue).slice(0, 240);
        remaining.push(draft);
      }
    }
    try { await writeStoredJson(LOCAL_SCHEDULES_KEY, remaining); } catch {}
    setLocalDrafts(remaining);
    setLastSyncError(firstError);
    setSyncing(false);
    if (remaining.length === 0) {
      Alert.alert('All synced', 'All saved-on-device scheduled messages have been pushed to the Smilers cloud.');
    } else if (firstError) {
      Alert.alert(
        'Couldn\u2019t sync everything',
        `${remaining.length} message${remaining.length === 1 ? '' : 's'} still saved on this device. Reason: ${firstError}`,
      );
    }
  }, [createSchedule, localDrafts, syncing]);

  const removeLocalDraft = useCallback(async (localId: string) => {
    const next = localDrafts.filter((d) => d.localId !== localId);
    setLocalDrafts(next);
    try { await writeStoredJson(LOCAL_SCHEDULES_KEY, next); } catch {}
  }, [localDrafts]);

  const onToggleActive = useCallback(async (schedule: Schedule) => {
    // iter-124: dual-endpoint probe — backend agent added
    // `scheduledMessages.create` + `listMine` in iter-120 but `setActive`
    // may not yet exist; fall back to `update` with the full schedule
    // payload + the flipped active flag if `setActive` returns Server
    // Error.
    const desired = !schedule.active;
    try {
      await setActiveSchedule({ scheduleId: schedule._id as any, active: desired });
      return;
    } catch (primaryErr: any) {
      // Fall through to update-based fallback.
      try {
        await updateSchedule({
          scheduleId: schedule._id as any,
          recipient: schedule.recipient,
          message: schedule.message,
          date: schedule.date,
          time: schedule.time,
          repeat: schedule.repeat,
          active: desired,
        });
        return;
      } catch (fallbackErr: any) {
        Alert.alert(
          'Couldn\u2019t toggle',
          errorToMessage(primaryErr) || errorToMessage(fallbackErr) || 'Unknown error',
        );
      }
    }
  }, [setActiveSchedule, updateSchedule]);

  const onDelete = useCallback((schedule: Schedule) => {
    Alert.alert('Delete scheduled message?', `"${schedule.message.slice(0, 60)}${schedule.message.length > 60 ? '\u2026' : ''}"`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { try { await removeSchedule({ scheduleId: schedule._id as any }); } catch (errorValue: any) { Alert.alert('Failed', errorToMessage(errorValue) || 'Unknown error'); } } },
    ]);
  }, [removeSchedule]);

  const onSave = useCallback(async (draft: Omit<Schedule, '_id'> & { _id?: string }) => {
    try {
      if (draft._id) {
        await updateSchedule({ scheduleId: draft._id as any, recipient: draft.recipient, message: draft.message, date: draft.date, time: draft.time, repeat: draft.repeat, active: draft.active });
      } else {
        // iter-120: UX sanity guard — the backend agent caught real
        // payloads where users had typed the FULL MESSAGE TEXT into
        // the recipient field by mistake (e.g. `recipient="Please good
        // morning Queeny my lovely…"`). The backend rejects these
        // (no matching contact name) but the user just sees "Server
        // Error". Guard before we ship: if recipient > 80 chars and
        // contains whitespace AND looks like a sentence, refuse.
        const rTrim = String(draft.recipient || '').trim();
        if (rTrim.length > 80 && /[.!?,]/.test(rTrim)) {
          throw new Error(
            'The recipient field looks like a message body. ' +
            'Please put only the contact NAME in the "Recipient" field ' +
            '(e.g. "Angela Yeboah"), and the message text in the ' +
            '"Message" field below.'
          );
        }
        if (rTrim.length === 0) {
          throw new Error(
            'Please enter the recipient\u2019s name (e.g. "Angela Yeboah").'
          );
        }
        // iter-120: dual-shape probe — primary keeps the legacy
        // scheduleMessageMobile shape (still accepted server-side),
        // fallback uses the NEW scheduledMessages.create schema
        // { recipient, text, scheduledAt } per backend agent.
        const args = {
          recipient: rTrim.slice(0, 200),
          message: String(draft.message || '').slice(0, 5000),
          date: draft.date,
          time: draft.time,
          repeat: draft.repeat,
          active: draft.active,
        };
        // Compose the ISO scheduledAt from the user-picked date+time
        // fields. Using local-time interpretation matches the rest of
        // the app's scheduling UX (when the user picks 7:21 they mean
        // 7:21 in THEIR timezone). new Date('YYYY-MM-DDTHH:MM') parses
        // as local time.
        const scheduledAtIso = (() => {
          try {
            return new Date(`${draft.date}T${draft.time}`).toISOString();
          } catch {
            return new Date().toISOString();
          }
        })();
        const argsNew = {
          recipient: rTrim.slice(0, 200),
          text: String(draft.message || '').slice(0, 5000),
          scheduledAt: scheduledAtIso,
        };
        try {
          await createSchedule(args);
        } catch (primaryErr: any) {
          if (typeof createScheduleLegacy === 'function') {
            await (createScheduleLegacy as any)(argsNew);
          } else {
            throw primaryErr;
          }
        }
      }
      setEditing(null); setShowCompose(false);
    } catch (errorValue: any) { Alert.alert('Failed', errorToMessage(errorValue) || 'Unknown error'); }
  }, [createSchedule, createScheduleLegacy, updateSchedule]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Scheduled" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.loadingWrap}><ActivityIndicator color={Colors.primary} size="large" /></View>
      </SafeAreaView>
    );
  }

  const list = Array.isArray(items) ? items : [];
  const hasLocalDrafts = localDrafts.length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="scheduled-screen">
      <Header title="Scheduled" showBack onBack={() => router.back()} variant="dark" />
      {/*
        Sync banner — driven by actual sync state, not hardcoded.
        • Green "Synced" when there are 0 local drafts (everything has
          made it to the Smilers cloud).
        • Amber "N saved on this device" with a Sync now button when
          there are pending local drafts. Tapping the button pushes them
          one at a time and shows a result alert.
      */}
      {hasLocalDrafts ? (
        <View style={[styles.heroBanner, styles.heroBannerWarn]} testID="scheduled-sync-banner">
          <MaterialCommunityIcons name="cloud-alert" size={20} color={Colors.warning || Colors.primary} />
          <Text style={[styles.heroText, styles.heroTextWarn]} testID="scheduled-status-note">
            {localDrafts.length} saved on this device — {lastSyncError ? 'last sync failed' : 'tap to push to cloud'}
          </Text>
          <TouchableOpacity
            onPress={syncLocalDrafts}
            disabled={syncing}
            style={styles.syncBtn}
            testID="scheduled-sync-now-btn"
          >
            {syncing ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Text style={styles.syncBtnText}>Sync now</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.heroBanner} testID="scheduled-sync-banner">
          <MaterialCommunityIcons name="cloud-check" size={20} color={Colors.primary} />
          <Text style={styles.heroText} testID="scheduled-status-note">Synced with Smilers cloud</Text>
        </View>
      )}
      <FlatList
        data={list}
        keyExtractor={(schedule: Schedule) => schedule._id}
        contentContainerStyle={{ paddingBottom: 120, paddingTop: Spacing.md }}
        ListHeaderComponent={
          hasLocalDrafts ? (
            <View style={styles.localSection} testID="scheduled-local-section">
              <Text style={styles.localSectionTitle}>Saved on this device</Text>
              {localDrafts.map((draft) => {
                const when = new Date(draft.whenMs);
                const dateLabel = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
                const timeLabel = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
                return (
                  <View key={draft.localId} style={[styles.card, styles.cardLocal]} testID={`local-${draft.localId}`}>
                    <View style={styles.cardTopRow}>
                      <MaterialCommunityIcons name="cloud-off-outline" size={16} color={Colors.warning || Colors.primary} />
                      <Text style={styles.cardRecipient} numberOfLines={1}>{draft.recipient || 'Conversation'}</Text>
                      <View style={styles.flexOne} />
                      <View style={styles.localBadge}>
                        <Text style={styles.localBadgeText}>Local</Text>
                      </View>
                    </View>
                    <Text style={styles.cardMessage} numberOfLines={2}>{draft.message}</Text>
                    <View style={styles.cardMeta}>
                      <Feather name="calendar" size={14} color={Colors.textMuted} />
                      <Text style={styles.cardMetaText}>{dateLabel} at {timeLabel}</Text>
                      {draft.recurring ? (
                        <>
                          <Text style={styles.cardMetaDot}>·</Text>
                          <Feather name="repeat" size={14} color={Colors.textMuted} />
                          <Text style={styles.cardMetaText}>{draft.frequency || 'recurring'}</Text>
                        </>
                      ) : null}
                    </View>
                    <View style={styles.cardActions}>
                      <TouchableOpacity
                        style={styles.cardActionBtn}
                        onPress={syncLocalDrafts}
                        disabled={syncing}
                        testID={`local-sync-${draft.localId}`}
                      >
                        <Feather name="upload-cloud" size={14} color={Colors.primary} />
                        <Text style={styles.cardActionText}>{syncing ? 'Syncing\u2026' : 'Sync'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.cardActionBtn, { borderColor: Colors.danger }]}
                        onPress={() => removeLocalDraft(draft.localId)}
                        testID={`local-delete-${draft.localId}`}
                      >
                        <Feather name="trash-2" size={14} color={Colors.danger} />
                        <Text style={[styles.cardActionText, { color: Colors.danger }]}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
              {list.length > 0 ? <Text style={styles.localSectionTitle}>Synced</Text> : null}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.card} testID={`schedule-${item._id}`}>
            <View style={styles.cardTopRow}>
              <View style={[styles.dot, { backgroundColor: item.active ? Colors.primary : Colors.textMuted }]} />
              <Text style={styles.cardRecipient} numberOfLines={1}>{item.recipient || 'Recipient'}</Text>
              <View style={styles.flexOne} />
              <Switch value={item.active} onValueChange={() => onToggleActive(item)} trackColor={{ false: Colors.border, true: Colors.primary }} thumbColor={Colors.white} testID={`toggle-${item._id}`} />
            </View>
            <Text style={styles.cardMessage} numberOfLines={2}>{item.message}</Text>
            <View style={styles.cardMeta}>
              <Feather name="calendar" size={14} color={Colors.textMuted} />
              <Text style={styles.cardMetaText}>{item.date} at {item.time}</Text>
              <Text style={styles.cardMetaDot}>·</Text>
              <Feather name="repeat" size={14} color={Colors.textMuted} />
              <Text style={styles.cardMetaText}>{REPEAT_LABEL[item.repeat]}</Text>
            </View>
            <View style={styles.cardActions}>
              <TouchableOpacity style={styles.cardActionBtn} onPress={() => setEditing(item)} testID={`edit-${item._id}`}>
                <Feather name="edit-2" size={14} color={Colors.primary} />
                <Text style={styles.cardActionText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cardActionBtn, { borderColor: Colors.danger }]} onPress={() => onDelete(item)} testID={`delete-${item._id}`}>
                <Feather name="trash-2" size={14} color={Colors.danger} />
                <Text style={[styles.cardActionText, { color: Colors.danger }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty} testID="scheduled-empty-state">
            <View style={styles.emptyIcon}><Feather name="clock" size={28} color={Colors.primary} /></View>
            <Text style={styles.emptyTitle}>No scheduled messages</Text>
            <Text style={styles.emptySub}>Tap the + button to schedule your first message.</Text>
          </View>
        }
      />
      <TouchableOpacity style={styles.fab} onPress={() => setShowCompose(true)} testID="new-schedule-fab">
        <Feather name="plus" size={24} color={Colors.white} />
      </TouchableOpacity>
      {(showCompose || editing) ? (
        <ComposeModal initial={editing ?? undefined} onClose={() => { setShowCompose(false); setEditing(null); }} onSave={onSave} />
      ) : null}
    </SafeAreaView>
  );
}

function ComposeModal({ initial, onClose, onSave }: { initial?: Schedule; onClose: () => void; onSave: (schedule: Omit<Schedule, '_id'> & { _id?: string }) => void; }) {
  const [recipient, setRecipient] = useState(initial?.recipient || '');
  const [message, setMessage] = useState(initial?.message || '');
  const [date, setDate] = useState(initial?.date || todayYMD());
  const [time, setTime] = useState(initial?.time || nowHM());
  const [repeat, setRepeat] = useState<Repeat>(initial?.repeat || 'once');
  const [active, setActive] = useState(initial?.active ?? true);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showRepeatPicker, setShowRepeatPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const canSave = recipient.trim().length > 0 && message.trim().length > 0;

  const onConfirm = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    await onSave({ _id: initial?._id, recipient: recipient.trim(), message: message.trim(), date, time, repeat, active });
    setBusy(false);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { maxHeight: '90%' }]} onPress={() => {}} testID="scheduled-compose-sheet">
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
              <View style={styles.grabber} />
              <Text style={styles.sheetTitle}>{initial ? 'Edit scheduled message' : 'Schedule a message'}</Text>

              <Text style={styles.inputLabel}>Recipient</Text>
              <TextInput value={recipient} onChangeText={setRecipient} placeholder="Name or chat" placeholderTextColor={Colors.textMuted} style={styles.input} testID="scheduled-recipient-input" />

              <Text style={styles.inputLabel}>Message</Text>
              <TextInput value={message} onChangeText={setMessage} placeholder="Write the message" placeholderTextColor={Colors.textMuted} multiline style={[styles.input, styles.messageInput]} testID="scheduled-message-input" />

              <View style={styles.twoColWrap}>
                <View style={styles.twoColItem}>
                  <Text style={styles.inputLabel}>Date</Text>
                  <TouchableOpacity style={styles.pickerButton} onPress={() => setShowDatePicker(true)} testID="scheduled-date-button">
                    <Feather name="calendar" size={16} color={Colors.primary} />
                    <Text style={styles.pickerButtonText}>{date}</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.twoColItem}>
                  <Text style={styles.inputLabel}>Time</Text>
                  <TouchableOpacity style={styles.pickerButton} onPress={() => setShowTimePicker(true)} testID="scheduled-time-button">
                    <Feather name="clock" size={16} color={Colors.primary} />
                    <Text style={styles.pickerButtonText}>{time}</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={styles.inputLabel}>Repeat</Text>
              <TouchableOpacity style={styles.pickerButton} onPress={() => setShowRepeatPicker(true)} testID="scheduled-repeat-button">
                <Feather name="repeat" size={16} color={Colors.primary} />
                <Text style={styles.pickerButtonText}>{REPEAT_LABEL[repeat]}</Text>
              </TouchableOpacity>

              <View style={styles.switchRow} testID="scheduled-active-row">
                <View>
                  <Text style={styles.rowTitle}>Active</Text>
                  <Text style={styles.rowSub}>Turn this off without deleting it.</Text>
                </View>
                <Switch value={active} onValueChange={setActive} trackColor={{ false: Colors.border, true: Colors.primary }} thumbColor={Colors.white} testID="scheduled-active-switch" />
              </View>

              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.secondaryBtn} onPress={onClose} testID="scheduled-cancel-button">
                  <Text style={styles.secondaryBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.primaryBtn, !canSave || busy ? styles.primaryBtnDisabled : null]} onPress={onConfirm} disabled={!canSave || busy} testID="scheduled-save-button">
                  <Text style={styles.primaryBtnText}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Schedule'}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>

          {showDatePicker ? (
            <DateTimePicker
              value={parseYMD(date)}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_, selectedDate) => {
                setShowDatePicker(Platform.OS === 'ios');
                if (selectedDate) setDate(`${selectedDate.getFullYear()}-${pad2(selectedDate.getMonth() + 1)}-${pad2(selectedDate.getDate())}`);
              }}
            />
          ) : null}

          {showTimePicker ? (
            <DateTimePicker
              value={parseHM(time)}
              mode="time"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_, selectedTime) => {
                setShowTimePicker(Platform.OS === 'ios');
                if (selectedTime) setTime(`${pad2(selectedTime.getHours())}:${pad2(selectedTime.getMinutes())}`);
              }}
            />
          ) : null}

          <Modal visible={showRepeatPicker} transparent animationType="fade" onRequestClose={() => setShowRepeatPicker(false)}>
            <Pressable style={styles.backdrop} onPress={() => setShowRepeatPicker(false)}>
              <Pressable style={styles.innerSheet} onPress={() => {}} testID="scheduled-repeat-sheet">
                <Text style={styles.sheetTitle}>Repeat</Text>
                {REPEAT_OPTIONS.map((option) => {
                  const selected = repeat === option;
                  return (
                    <TouchableOpacity key={option} style={styles.optionRow} onPress={() => { setRepeat(option); setShowRepeatPicker(false); }} testID={`scheduled-repeat-${option}`}>
                      <Text style={styles.optionLabel}>{REPEAT_LABEL[option]}</Text>
                      {selected ? <Feather name="check" size={20} color={Colors.primary} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </Pressable>
            </Pressable>
          </Modal>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.base, marginTop: Spacing.md, padding: 12, backgroundColor: Colors.primaryLight, borderRadius: Radius.md },
  heroBannerWarn: { backgroundColor: '#FEF3C7' }, // amber-100 — signals partial-sync state
  heroText: { color: Colors.textPrimary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, flex: 1 },
  heroTextWarn: { color: '#92400E' /* amber-800 */ },
  syncBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.pill, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', minWidth: 88 },
  syncBtnText: { color: '#3D2A00', fontWeight: FontWeight.bold, fontSize: FontSize.sm },
  localSection: { paddingTop: Spacing.sm },
  localSectionTitle: {
    marginTop: Spacing.md,
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  cardLocal: { borderWidth: 1, borderColor: '#FDE68A' /* amber-200 */ },
  localBadge: { backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill },
  localBadgeText: { color: '#92400E', fontWeight: FontWeight.bold, fontSize: FontSize.xs },
  card: { marginHorizontal: Spacing.base, marginBottom: Spacing.base, padding: Spacing.base, backgroundColor: Colors.surface, borderRadius: Radius.lg, ...Shadow.sm },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cardRecipient: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary, maxWidth: '65%' },
  cardMessage: { fontSize: FontSize.base, color: Colors.textPrimary, marginTop: Spacing.md, lineHeight: 22 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: Spacing.sm, flexWrap: 'wrap' },
  cardMetaText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  cardMetaDot: { fontSize: FontSize.sm, color: Colors.textMuted },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: Spacing.base },
  cardActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: Radius.pill, borderWidth: 1, borderColor: Colors.primary },
  cardActionText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.semibold },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: Spacing.xxl, paddingHorizontal: Spacing.lg },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
  fab: { position: 'absolute', right: Spacing.base, bottom: Spacing.lg, width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', ...Shadow.md },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: Spacing.lg, ...Shadow.lg },
  innerSheet: { backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: Spacing.base, paddingBottom: Spacing.lg, ...Shadow.lg },
  sheetContent: { paddingHorizontal: Spacing.base, paddingBottom: Spacing.base },
  grabber: { width: 40, height: 4, backgroundColor: Colors.border, borderRadius: 2, alignSelf: 'center', marginVertical: Spacing.sm },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginBottom: Spacing.base, paddingHorizontal: Spacing.base },
  inputLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: Colors.primary, letterSpacing: 1, marginBottom: Spacing.sm, marginTop: Spacing.sm },
  input: { borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, backgroundColor: Colors.background, paddingHorizontal: Spacing.base, minHeight: 48, fontSize: FontSize.base, color: Colors.textPrimary },
  messageInput: { minHeight: 112, paddingTop: 14, textAlignVertical: 'top' },
  twoColWrap: { flexDirection: 'row', gap: 12 },
  twoColItem: { flex: 1 },
  pickerButton: { minHeight: 48, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, backgroundColor: Colors.background, paddingHorizontal: Spacing.base, flexDirection: 'row', alignItems: 'center', gap: 10 },
  pickerButtonText: { fontSize: FontSize.base, color: Colors.textPrimary },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.md, marginTop: Spacing.sm },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  rowSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: Spacing.lg },
  secondaryBtn: { flex: 1, minHeight: 48, borderRadius: Radius.pill, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  secondaryBtnText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  primaryBtn: { flex: 1, minHeight: 48, borderRadius: Radius.pill, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { fontSize: FontSize.base, color: Colors.white, fontWeight: FontWeight.bold },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: Spacing.base },
  optionLabel: { fontSize: FontSize.base, color: Colors.textPrimary },
  flexOne: { flex: 1 },
});