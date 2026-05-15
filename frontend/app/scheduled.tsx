import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';
import { SCHEDULED_MESSAGES_KEY, readStoredJson, writeStoredJson } from '../src/lib/settingsStorage';

const REPEAT_OPTIONS = [
  { key: 'once', label: 'Once' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

function createDraft() {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  return {
    id: '',
    recipient: '',
    message: '',
    date: next.toISOString().slice(0, 10),
    time: `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`,
    repeat: 'once',
    active: true,
  };
}

export default function ScheduledScreen() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [composerVisible, setComposerVisible] = useState(false);
  const [draft, setDraft] = useState(createDraft());
  const [editingId, setEditingId] = useState('');
  const [statusNote, setStatusNote] = useState('Loading your saved schedules…');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const stored = await readStoredJson(SCHEDULED_MESSAGES_KEY, []);
      if (mounted) {
        setItems(Array.isArray(stored) ? stored : []);
        setStatusNote('Saved schedules stay ready on this device');
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const activeCount = useMemo(() => items.filter((item) => item.active).length, [items]);

  const persist = async (nextItems: any[]) => {
    setItems(nextItems);
    await writeStoredJson(SCHEDULED_MESSAGES_KEY, nextItems);
    setStatusNote('Scheduled messages updated');
  };

  const openCreate = () => {
    setEditingId('');
    setDraft(createDraft());
    setComposerVisible(true);
  };

  const openEdit = (item: any) => {
    setEditingId(item.id);
    setDraft({ ...item });
    setComposerVisible(true);
  };

  const saveDraft = async () => {
    if (!draft.recipient.trim()) {
      Alert.alert('Add a chat', 'Enter the person or group you want to message later.');
      return;
    }
    if (!draft.message.trim()) {
      Alert.alert('Add a message', 'Write the message you want Smilers to keep ready.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}$/.test(draft.time)) {
      Alert.alert('Use the right format', 'Date must be YYYY-MM-DD and time must be HH:MM.');
      return;
    }
    const nextItem = {
      ...draft,
      id: editingId || `${Date.now()}`,
      recipient: draft.recipient.trim(),
      message: draft.message.trim(),
    };
    const nextItems = editingId ? items.map((item) => (item.id === editingId ? nextItem : item)) : [nextItem, ...items];
    await persist(nextItems);
    setComposerVisible(false);
  };

  const removeItem = (id: string) => {
    Alert.alert('Delete this schedule?', 'This removes it from your scheduled list.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await persist(items.filter((item) => item.id !== id));
        },
      },
    ]);
  };

  const toggleActive = async (id: string) => {
    const nextItems = items.map((item) => (item.id === id ? { ...item, active: !item.active } : item));
    await persist(nextItems);
  };

  const setQuickTime = (type: 'one-hour' | 'tomorrow' | 'tonight') => {
    const date = new Date();
    if (type === 'one-hour') {
      date.setHours(date.getHours() + 1);
    }
    if (type === 'tomorrow') {
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
    }
    if (type === 'tonight') {
      date.setHours(20, 0, 0, 0);
      if (date.getTime() < Date.now()) {
        date.setDate(date.getDate() + 1);
      }
    }
    setDraft({
      ...draft,
      date: date.toISOString().slice(0, 10),
      time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    });
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="scheduled-screen">
      <Header
        title="Scheduled Messages"
        showBack
        onBack={() => router.back()}
        variant="dark"
        subtitle="View and manage scheduled messages"
        right={
          <TouchableOpacity onPress={openCreate} style={styles.headerButton} testID="scheduled-add-button">
            <Ionicons name="add" size={24} color={Colors.white} />
          </TouchableOpacity>
        }
      />

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        testID="scheduled-list"
        ListHeaderComponent={
          <>
            <View style={styles.heroCard} testID="scheduled-hero-card">
              <View style={styles.heroIconWrap} testID="scheduled-hero-icon-wrap">
                <MaterialCommunityIcons name="clock-check-outline" size={24} color={Colors.primary} />
              </View>
              <View style={styles.flexOne}>
                <Text style={styles.heroTitle} testID="scheduled-hero-title">Keep messages ready</Text>
                <Text style={styles.heroSub} testID="scheduled-hero-subtitle">
                  Plan follow-ups, recurring reminders, and time-sensitive messages ahead of time.
                </Text>
              </View>
            </View>

            <View style={styles.statsRow} testID="scheduled-stats-row">
              <View style={styles.statCard} testID="scheduled-total-card">
                <Text style={styles.statValue} testID="scheduled-total-value">{items.length}</Text>
                <Text style={styles.statLabel} testID="scheduled-total-label">Total</Text>
              </View>
              <View style={styles.statCard} testID="scheduled-active-card">
                <Text style={styles.statValue} testID="scheduled-active-value">{activeCount}</Text>
                <Text style={styles.statLabel} testID="scheduled-active-label">Active</Text>
              </View>
            </View>

            <Text style={styles.statusNote} testID="scheduled-status-note">{statusNote}</Text>
          </>
        }
        renderItem={({ item, index }) => (
          <View style={styles.itemCard} testID={`scheduled-item-${index}`}>
            <View style={styles.itemTopRow}>
              <View style={styles.flexOne}>
                <Text style={styles.itemRecipient} testID={`scheduled-recipient-${index}`}>{item.recipient}</Text>
                <Text style={styles.itemSchedule} testID={`scheduled-time-${index}`}>
                  {item.date} at {item.time} · {item.repeat}
                </Text>
              </View>
              <View style={[styles.badge, item.active ? styles.badgeActive : styles.badgePaused]} testID={`scheduled-badge-${index}`}>
                <Text style={[styles.badgeText, item.active ? styles.badgeTextActive : styles.badgeTextPaused]}>
                  {item.active ? 'Active' : 'Paused'}
                </Text>
              </View>
            </View>

            <Text style={styles.itemMessage} numberOfLines={3} testID={`scheduled-message-${index}`}>{item.message}</Text>

            <View style={styles.itemActions} testID={`scheduled-actions-${index}`}>
              <TouchableOpacity style={styles.actionButton} onPress={() => toggleActive(item.id)} testID={`scheduled-toggle-${index}`}>
                <Ionicons name={item.active ? 'pause-outline' : 'play-outline'} size={18} color={Colors.primary} />
                <Text style={styles.actionButtonText}>{item.active ? 'Pause' : 'Resume'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton} onPress={() => openEdit(item)} testID={`scheduled-edit-${index}`}>
                <Ionicons name="create-outline" size={18} color={Colors.primary} />
                <Text style={styles.actionButtonText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.deleteButton} onPress={() => removeItem(item.id)} testID={`scheduled-delete-${index}`}>
                <Ionicons name="trash-outline" size={18} color={Colors.danger} />
                <Text style={styles.deleteButtonText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.emptyCard} testID="scheduled-empty-state">
            <MaterialCommunityIcons name="clock-outline" size={54} color={Colors.primary} />
            <Text style={styles.emptyTitle}>No scheduled messages yet</Text>
            <Text style={styles.emptySub}>Tap the + button to queue a message for later, daily, weekly, or monthly delivery.</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={openCreate} testID="scheduled-empty-create-button">
              <Text style={styles.primaryButtonText}>Create Schedule</Text>
            </TouchableOpacity>
          </View>
        }
      />

      <Modal visible={composerVisible} transparent animationType="slide" onRequestClose={() => setComposerVisible(false)}>
        <View style={styles.modalBackdrop} testID="scheduled-modal-backdrop">
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalKeyboardWrap}>
            <View style={styles.modalCard} testID="scheduled-modal">
              <Text style={styles.modalTitle} testID="scheduled-modal-title">{editingId ? 'Edit schedule' : 'New scheduled message'}</Text>
              <Text style={styles.modalSub} testID="scheduled-modal-subtitle">
                Save a message for later and keep it ready from this screen.
              </Text>

              <TextInput
                value={draft.recipient}
                onChangeText={(value) => setDraft({ ...draft, recipient: value })}
                placeholder="Person or group"
                placeholderTextColor={Colors.textMuted}
                style={styles.input}
                testID="scheduled-recipient-input"
              />
              <TextInput
                value={draft.message}
                onChangeText={(value) => setDraft({ ...draft, message: value })}
                placeholder="Message"
                placeholderTextColor={Colors.textMuted}
                multiline
                style={[styles.input, styles.messageInput]}
                testID="scheduled-message-input"
              />

              <View style={styles.quickRow} testID="scheduled-quick-row">
                <QuickTimeButton label="+1 hour" onPress={() => setQuickTime('one-hour')} testID="scheduled-quick-one-hour" />
                <QuickTimeButton label="Tonight" onPress={() => setQuickTime('tonight')} testID="scheduled-quick-tonight" />
                <QuickTimeButton label="Tomorrow 9AM" onPress={() => setQuickTime('tomorrow')} testID="scheduled-quick-tomorrow" />
              </View>

              <View style={styles.inlineInputs} testID="scheduled-datetime-row">
                <TextInput
                  value={draft.date}
                  onChangeText={(value) => setDraft({ ...draft, date: value })}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={Colors.textMuted}
                  style={[styles.input, styles.inlineInput]}
                  testID="scheduled-date-input"
                />
                <TextInput
                  value={draft.time}
                  onChangeText={(value) => setDraft({ ...draft, time: value })}
                  placeholder="HH:MM"
                  placeholderTextColor={Colors.textMuted}
                  style={[styles.input, styles.inlineInput]}
                  testID="scheduled-time-input"
                />
              </View>

              <Text style={styles.repeatTitle} testID="scheduled-repeat-title">Repeat</Text>
              <View style={styles.repeatRow} testID="scheduled-repeat-row">
                {REPEAT_OPTIONS.map((option) => {
                  const selected = draft.repeat === option.key;
                  return (
                    <TouchableOpacity
                      key={option.key}
                      style={[styles.repeatChip, selected ? styles.repeatChipActive : null]}
                      onPress={() => setDraft({ ...draft, repeat: option.key })}
                      testID={`scheduled-repeat-${option.key}`}
                    >
                      <Text style={[styles.repeatChipText, selected ? styles.repeatChipTextActive : null]}>{option.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.modalActions} testID="scheduled-modal-actions">
                <TouchableOpacity style={styles.modalSecondaryButton} onPress={() => setComposerVisible(false)} testID="scheduled-cancel-button">
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalPrimaryButton} onPress={saveDraft} testID="scheduled-save-button">
                  <Text style={styles.modalPrimaryButtonText}>{editingId ? 'Save Changes' : 'Create Schedule'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function QuickTimeButton({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <TouchableOpacity style={styles.quickButton} onPress={onPress} testID={testID}>
      <Text style={styles.quickButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  headerButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  content: { padding: Spacing.base, paddingBottom: 56, flexGrow: 1, gap: Spacing.base },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
    marginBottom: Spacing.base,
  },
  heroIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  heroSub: { marginTop: 4, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  statsRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.base },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
    alignItems: 'center',
  },
  statValue: { fontSize: FontSize.xxl, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  statLabel: { marginTop: 4, fontSize: FontSize.sm, color: Colors.textSecondary },
  statusNote: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.base },
  itemCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
    marginBottom: Spacing.base,
  },
  itemTopRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  itemRecipient: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  itemSchedule: { marginTop: 4, fontSize: FontSize.sm, color: Colors.textSecondary },
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  badgeActive: { backgroundColor: '#DCFCE7' },
  badgePaused: { backgroundColor: '#F3F4F6' },
  badgeText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  badgeTextActive: { color: '#15803D' },
  badgeTextPaused: { color: Colors.textSecondary },
  itemMessage: { marginTop: Spacing.base, fontSize: FontSize.base, color: Colors.textPrimary, lineHeight: 22 },
  itemActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: Spacing.base },
  actionButton: {
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  deleteButton: {
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deleteButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.danger },
  emptyCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginTop: 12,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  primaryButton: {
    marginTop: Spacing.sm,
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalKeyboardWrap: { width: '100%' },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: Spacing.base,
    gap: 12,
  },
  modalTitle: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center' },
  modalSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  input: {
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.base,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  messageInput: { minHeight: 96, paddingTop: 14, textAlignVertical: 'top' },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quickButton: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickButtonText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.primaryDark },
  inlineInputs: { flexDirection: 'row', gap: 12 },
  inlineInput: { flex: 1 },
  repeatTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  repeatRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  repeatChip: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    justifyContent: 'center',
  },
  repeatChipActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  repeatChipText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textSecondary },
  repeatChipTextActive: { color: Colors.primaryDark },
  modalActions: { flexDirection: 'row', gap: 12 },
  modalPrimaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPrimaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSecondaryButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  flexOne: { flex: 1 },
});