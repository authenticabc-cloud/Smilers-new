// Scheduled Messages — backed by `api.scheduledMessages.*`.

import React, { useState, useCallback } from 'react';
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

export default function ScheduledScreen() {
  const router = useRouter();
  const { data: items, loading } = useSafeConvexQuery<Schedule[]>(api.scheduledMessages.listMine, {}, []);
  const createSchedule = useMutation(api.scheduledMessages.create);
  const updateSchedule = useMutation(api.scheduledMessages.update);
  const removeSchedule = useMutation(api.scheduledMessages.remove);
  const setActiveSchedule = useMutation(api.scheduledMessages.setActive);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [showCompose, setShowCompose] = useState(false);

  const onToggleActive = useCallback(async (schedule: Schedule) => {
    try { await setActiveSchedule({ scheduleId: schedule._id as any, active: !schedule.active }); }
    catch (errorValue: any) { Alert.alert('Failed', errorValue?.message || 'Unknown error'); }
  }, [setActiveSchedule]);

  const onDelete = useCallback((schedule: Schedule) => {
    Alert.alert('Delete scheduled message?', `"${schedule.message.slice(0, 60)}${schedule.message.length > 60 ? '…' : ''}"`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { try { await removeSchedule({ scheduleId: schedule._id as any }); } catch (errorValue: any) { Alert.alert('Failed', errorValue?.message || 'Unknown error'); } } },
    ]);
  }, [removeSchedule]);

  const onSave = useCallback(async (draft: Omit<Schedule, '_id'> & { _id?: string }) => {
    try {
      if (draft._id) {
        await updateSchedule({ scheduleId: draft._id as any, recipient: draft.recipient, message: draft.message, date: draft.date, time: draft.time, repeat: draft.repeat, active: draft.active });
      } else {
        await createSchedule({ recipient: draft.recipient, message: draft.message, date: draft.date, time: draft.time, repeat: draft.repeat, active: draft.active });
      }
      setEditing(null); setShowCompose(false);
    } catch (errorValue: any) { Alert.alert('Failed', errorValue?.message || 'Unknown error'); }
  }, [createSchedule, updateSchedule]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Header title="Scheduled" showBack onBack={() => router.back()} variant="dark" />
        <View style={styles.loadingWrap}><ActivityIndicator color={Colors.primary} size="large" /></View>
      </SafeAreaView>
    );
  }

  const list = Array.isArray(items) ? items : [];

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="scheduled-screen">
      <Header title="Scheduled" showBack onBack={() => router.back()} variant="dark" />
      <View style={styles.heroBanner} testID="scheduled-sync-banner">
        <MaterialCommunityIcons name="cloud-check" size={20} color={Colors.primary} />
        <Text style={styles.heroText} testID="scheduled-status-note">Synced with Smilers cloud</Text>
      </View>
      <FlatList
        data={list}
        keyExtractor={(schedule: Schedule) => schedule._id}
        contentContainerStyle={{ paddingBottom: 120, paddingTop: Spacing.md }}
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
  heroText: { color: Colors.textPrimary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
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