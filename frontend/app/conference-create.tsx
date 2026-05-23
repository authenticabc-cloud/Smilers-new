/**
 * Conference Create — mirrors the Smilers web app's "New Conference" form
 * exactly (per provided web app screenshot):
 *
 *   - Title (required)
 *   - Description (optional, multi-line)
 *   - Type segment: Video / Audio (gold-active outline style)
 *   - Schedule: optional date+time picker chip
 *   - Recurring toggle (off by default)
 *   - Access Control card: "Open (anyone with link)" / "Admission only"
 *
 * No role assignment lives in this screen — roles (Chair / Clerk / Protocol)
 * are wired in the post-create conference details / call HUD per Slice C.
 *
 * On submit calls `api.conferences.startConference`. Falls back to a clear
 * "needs latest backend update" alert when the endpoint is missing.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { writeStoredJson, readStoredJson } from '../src/lib/settingsStorage';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';

type ConferenceType = 'video' | 'audio';
type AccessControl = 'open' | 'invite';
type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

const LOCAL_CONFERENCES_KEY = 'smilers_local_conferences';

const FREQUENCY_OPTIONS: { key: Frequency; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Save scheduling metadata (description, scheduledAt, recurring, frequency)
 * locally so the user can see scheduled conferences on this device even
 * before the web team ships a backend store for those fields. Keyed by
 * conferenceId; merges with the existing list.
 */
async function persistLocalConferenceMeta(meta: {
  conferenceId: string;
  title: string;
  description?: string;
  mode: ConferenceType;
  entryMode: AccessControl;
  scheduledAt?: number | null;
  recurring?: boolean;
  frequency?: Frequency | null;
}): Promise<void> {
  try {
    const list = (await readStoredJson(LOCAL_CONFERENCES_KEY, [])) as any[];
    const next = Array.isArray(list) ? [...list] : [];
    const existingIndex = next.findIndex((c: any) => c?.conferenceId === meta.conferenceId);
    const entry = { ...meta, savedAt: Date.now() };
    if (existingIndex >= 0) {
      next[existingIndex] = entry;
    } else {
      next.push(entry);
    }
    await writeStoredJson(LOCAL_CONFERENCES_KEY, next);
  } catch {
    /* swallow */
  }
}

/**
 * Attempt the Convex mutation with the FULL payload first. If the backend
 * rejects the call (typically because its argument validator is stricter
 * than the latest spec), retry with progressively trimmed payloads down to
 * the minimum contract: { title, mode, entryMode }. This way the conference
 * still gets created even before the web team ships the Schedule/Recurring
 * support — the trimmed scheduling metadata is preserved in AsyncStorage so
 * the device still surfaces it locally.
 */
async function callStartConferenceWithFallback(
  mutationFn: (args: any) => Promise<any>,
  fullPayload: Record<string, any>,
): Promise<{ conferenceId: string; usedFallback: boolean; raw: any }> {
  // Order matters — most-feature-rich first, simplest last.
  const variants: Array<{ label: string; build: () => Record<string, any> }> = [
    { label: 'full', build: () => fullPayload },
    {
      label: 'no-recurrence',
      build: () => {
        const { recurring: _r, frequency: _f, ...rest } = fullPayload;
        return rest;
      },
    },
    {
      label: 'no-schedule',
      build: () => {
        const { recurring: _r, frequency: _f, scheduledAt: _s, ...rest } = fullPayload;
        return rest;
      },
    },
    {
      label: 'core-only',
      build: () => ({
        title: fullPayload.title,
        mode: fullPayload.mode,
        entryMode: fullPayload.entryMode,
        ...(fullPayload.groupId ? { groupId: fullPayload.groupId } : {}),
        ...(fullPayload.clerkUserId ? { clerkUserId: fullPayload.clerkUserId } : {}),
        ...(fullPayload.protocolUserId ? { protocolUserId: fullPayload.protocolUserId } : {}),
      }),
    },
  ];

  let lastError: any = null;
  let attemptIdx = 0;
  for (const variant of variants) {
    try {
      const payload = variant.build();
      const raw = await mutationFn(payload);
      const conferenceId = String(
        raw?.conferenceId || raw?._id || raw?.id || (typeof raw === 'string' ? raw : ''),
      );
      if (!conferenceId) {
        // Mutation returned but no id — treat as transient failure.
        throw new Error('Backend did not return a conferenceId.');
      }
      return { conferenceId, usedFallback: attemptIdx > 0, raw };
    } catch (errorValue: any) {
      lastError = errorValue;
      const message = String(errorValue?.message || errorValue || '');
      // If the function itself is missing, no point in retrying any variant.
      if (message.includes('CouldNotFindFunction')) {
        throw errorValue;
      }
      attemptIdx += 1;
      // Otherwise keep trying with a smaller payload.
    }
  }
  throw lastError || new Error('Could not create conference.');
}

function formatScheduleLabel(ts: number | null): string {
  if (!ts) return '';
  try {
    const date = new Date(ts);
    const dateLabel = date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    return `${dateLabel} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return new Date(ts).toString();
  }
}

function ScheduleSheet({
  visible,
  initial,
  onSave,
  onClose,
}: {
  visible: boolean;
  initial: number | null;
  onSave: (ts: number | null) => void;
  onClose: () => void;
}) {
  const startBase = initial ? new Date(initial) : new Date(Date.now() + 60 * 60 * 1000);
  const [year, setYear] = useState(String(startBase.getFullYear()));
  const [month, setMonth] = useState(String(startBase.getMonth() + 1));
  const [day, setDay] = useState(String(startBase.getDate()));
  const [hour, setHour] = useState(pad(startBase.getHours()));
  const [minute, setMinute] = useState(pad(startBase.getMinutes()));

  const onConfirm = () => {
    const candidate = new Date(
      Number(year),
      Math.max(0, Number(month) - 1),
      Number(day),
      Number(hour),
      Number(minute),
      0,
    );
    if (Number.isNaN(candidate.getTime())) {
      Alert.alert('Invalid date', 'Please double-check the date and time fields.');
      return;
    }
    onSave(candidate.getTime());
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>Pick a schedule</Text>
          <Text style={styles.modalSubtitle}>Leave empty to start the conference right away.</Text>

          <View style={styles.dateRow}>
            <DateInput label="YYYY" value={year} onChangeText={(t) => setYear(t.replace(/[^0-9]/g, '').slice(0, 4))} maxLen={4} flex={2} />
            <DateInput label="MM" value={month} onChangeText={(t) => setMonth(t.replace(/[^0-9]/g, '').slice(0, 2))} maxLen={2} flex={1} />
            <DateInput label="DD" value={day} onChangeText={(t) => setDay(t.replace(/[^0-9]/g, '').slice(0, 2))} maxLen={2} flex={1} />
          </View>

          <View style={styles.dateRow}>
            <DateInput label="HH" value={hour} onChangeText={(t) => setHour(t.replace(/[^0-9]/g, '').slice(0, 2))} maxLen={2} flex={1} />
            <Text style={styles.timeColon}>:</Text>
            <DateInput label="MM" value={minute} onChangeText={(t) => setMinute(t.replace(/[^0-9]/g, '').slice(0, 2))} maxLen={2} flex={1} />
            <View style={{ flex: 2 }} />
          </View>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            <TouchableOpacity
              style={[styles.modalGhostBtn, { flex: 1 }]}
              onPress={() => onSave(null)}
              testID="conf-schedule-clear"
            >
              <Text style={styles.modalGhostText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalPrimaryBtn, { flex: 1 }]}
              onPress={onConfirm}
              testID="conf-schedule-save"
            >
              <Text style={styles.modalPrimaryBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DateInput({
  label,
  value,
  onChangeText,
  maxLen,
  flex,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  maxLen: number;
  flex: number;
}) {
  return (
    <View style={[styles.dateInputWrap, { flex }]}>
      <Text style={styles.dateInputLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType="number-pad"
        maxLength={maxLen}
        style={styles.dateInputField}
        placeholderTextColor={Colors.textMuted}
      />
    </View>
  );
}

export default function ConferenceCreateScreen() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ConferenceType>('video');
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);
  const [recurring, setRecurring] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [accessControl, setAccessControl] = useState<AccessControl>('open');
  const [showSchedule, setShowSchedule] = useState(false);
  const [showFrequency, setShowFrequency] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const startConferenceM = useMutation((api as any).conferences.startConference);

  const canSubmit = useMemo(() => title.trim().length > 0 && !submitting, [title, submitting]);

  const handleCreate = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const fullPayload: Record<string, any> = {
        title: title.trim(),
        description: description.trim() || undefined,
        mode: type,
        entryMode: accessControl,
        scheduledAt: scheduledAt || undefined,
        recurring,
        frequency: recurring ? frequency : undefined,
      };
      const { conferenceId, usedFallback } = await callStartConferenceWithFallback(
        startConferenceM as any,
        fullPayload,
      );

      // Persist the rich metadata locally so the scheduling/recurring info
      // survives even if the deployed backend's strict validator discarded
      // those fields. The on-device conference list can render them from here.
      await persistLocalConferenceMeta({
        conferenceId,
        title: title.trim(),
        description: description.trim() || undefined,
        mode: type,
        entryMode: accessControl,
        scheduledAt: scheduledAt || null,
        recurring,
        frequency: recurring ? frequency : null,
      });

      // If a future schedule was set, take user back to the conference list
      // so the just-created conference appears there. If "now", route into
      // the call screen with the conference HUD overlay.
      if (scheduledAt && scheduledAt > Date.now() + 60_000) {
        Alert.alert(
          'Conference scheduled',
          usedFallback
            ? 'Conference created — schedule and recurrence are saved on this device. Once the web team ships the latest backend update, they will sync to all your devices.'
            : 'Your conference has been scheduled.',
        );
        router.back();
      } else {
        router.replace(`/call/${conferenceId}?type=${type === 'audio' ? 'voice' : 'video'}&conferenceMode=1` as any);
      }
    } catch (errorValue: any) {
      const message = String(errorValue?.message || errorValue || '');
      const isMissingFunction =
        message.includes('CouldNotFindFunction') ||
        message.includes('not found') ||
        message.toLowerCase().includes('no function');
      Alert.alert(
        'Could not create conference',
        isMissingFunction
          ? 'The conferencing backend endpoints haven\u2019t been deployed yet. Once the web team ships `conferences.startConference`, this flow will create the conference end-to-end. Until then, conferences cannot be created.'
          : `${message}\n\nIf this keeps happening, the backend may need a deploy.`,
      );
    } finally {
      setSubmitting(false);
    }
  }, [accessControl, canSubmit, description, frequency, recurring, router, scheduledAt, startConferenceM, title, type]);

  const scheduleLabel = formatScheduleLabel(scheduledAt);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="conference-create-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.headerBtn} testID="conf-back">
          <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New Conference</Text>
        <View style={{ width: 32 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
        {/* Title */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Title</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Weekly Team Standup"
            placeholderTextColor={Colors.textMuted}
            style={styles.textInput}
            testID="conf-title-input"
          />
        </View>

        {/* Description */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Description (optional)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What's this meeting about?"
            placeholderTextColor={Colors.textMuted}
            multiline
            numberOfLines={3}
            style={[styles.textInput, styles.textArea]}
            textAlignVertical="top"
            testID="conf-description-input"
          />
        </View>

        {/* Type */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Type</Text>
          <View style={styles.segmentRow}>
            <TypeButton
              icon="videocam-outline"
              label="Video"
              active={type === 'video'}
              onPress={() => setType('video')}
              testID="conf-type-video"
            />
            <TypeButton
              icon="mic-outline"
              label="Audio"
              active={type === 'audio'}
              onPress={() => setType('audio')}
              testID="conf-type-audio"
            />
          </View>
        </View>

        {/* Schedule */}
        <View style={styles.fieldGroup}>
          <View style={styles.iconLabelRow}>
            <Feather name="calendar" size={18} color={Colors.textPrimary} />
            <Text style={styles.label}>Schedule</Text>
          </View>
          <TouchableOpacity
            style={styles.scheduleField}
            onPress={() => setShowSchedule(true)}
            activeOpacity={0.7}
            testID="conf-schedule-trigger"
          >
            <Text style={[styles.scheduleFieldText, !scheduleLabel && styles.scheduleFieldPlaceholder]}>
              {scheduleLabel || 'Tap to pick a date and time'}
            </Text>
            <Feather name="chevron-down" size={20} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Recurring */}
        <View style={[styles.fieldGroup, styles.toggleCard]}>
          <View style={styles.iconLabelRow}>
            <MaterialCommunityIcons name="repeat" size={18} color={Colors.textPrimary} />
            <Text style={styles.label}>Recurring</Text>
          </View>
          <Switch
            value={recurring}
            onValueChange={setRecurring}
            trackColor={{ true: Colors.primary, false: '#d6cfbf' }}
            thumbColor={Platform.OS === 'android' ? '#fff' : undefined}
            ios_backgroundColor="#d6cfbf"
            testID="conf-recurring-toggle"
          />
        </View>

        {/* Frequency picker — only when recurring is on */}
        {recurring ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Frequency</Text>
            <TouchableOpacity
              style={styles.scheduleField}
              onPress={() => setShowFrequency(true)}
              activeOpacity={0.7}
              testID="conf-frequency-trigger"
            >
              <Text style={styles.scheduleFieldText}>
                {FREQUENCY_OPTIONS.find((o) => o.key === frequency)?.label || 'Weekly'}
              </Text>
              <Feather name="chevron-down" size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Access Control */}
        <View style={styles.accessCard}>
          <View style={styles.iconLabelRow}>
            <MaterialCommunityIcons name="shield-check-outline" size={18} color={Colors.textPrimary} />
            <Text style={styles.label}>Access Control</Text>
          </View>
          <View style={[styles.segmentRow, { marginTop: 4 }]}>
            <AccessButton
              label={'Open (anyone\nwith link)'}
              active={accessControl === 'open'}
              onPress={() => setAccessControl('open')}
              testID="conf-access-open"
            />
            <AccessButton
              label="Admission only"
              active={accessControl === 'invite'}
              onPress={() => setAccessControl('invite')}
              testID="conf-access-invite"
            />
          </View>
          {accessControl === 'invite' ? (
            <Text style={styles.accessHelper} testID="conf-access-helper">
              Participants will wait until admitted by the Protocol. If not admitted within 30 minutes, they are dropped.
            </Text>
          ) : null}
        </View>
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.createBtn, !canSubmit && styles.createBtnDisabled]}
            onPress={handleCreate}
            disabled={!canSubmit}
            testID="conf-create-button"
          >
            <Text style={styles.createBtnText}>
              {submitting ? 'Creating…' : 'Create Conference'}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <ScheduleSheet
        visible={showSchedule}
        initial={scheduledAt}
        onSave={(ts) => {
          setScheduledAt(ts);
          setShowSchedule(false);
        }}
        onClose={() => setShowSchedule(false)}
      />

      <Modal
        visible={showFrequency}
        transparent
        animationType="fade"
        onRequestClose={() => setShowFrequency(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setShowFrequency(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>How often?</Text>
            <Text style={styles.modalSubtitle}>
              The conference will repeat at this cadence from the scheduled date.
            </Text>
            {FREQUENCY_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={styles.modalRow}
                onPress={() => {
                  setFrequency(opt.key);
                  setShowFrequency(false);
                }}
                testID={`conf-frequency-${opt.key}`}
              >
                <Text style={styles.modalRowText}>{opt.label}</Text>
                {frequency === opt.key ? <Feather name="check" size={18} color={Colors.primary} /> : null}
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function TypeButton({
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
      style={[styles.typeBtn, active ? styles.typeBtnActive : null]}
      onPress={onPress}
      activeOpacity={0.7}
      testID={testID}
    >
      <Ionicons name={icon} size={20} color={active ? Colors.primary : Colors.textPrimary} />
      <Text style={[styles.typeBtnText, active ? styles.typeBtnTextActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

function AccessButton({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.accessBtn, active ? styles.accessBtnActive : null]}
      onPress={onPress}
      activeOpacity={0.7}
      testID={testID}
    >
      <Text style={[styles.accessBtnText, active ? styles.accessBtnTextActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
  },
  headerBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary },

  scrollContent: { padding: Spacing.base, paddingBottom: 120, gap: Spacing.lg },

  fieldGroup: { gap: 8 },
  label: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },

  iconLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  textInput: {
    minHeight: 50,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  textArea: { minHeight: 90, paddingTop: 12 },

  segmentRow: { flexDirection: 'row', gap: 10 },
  typeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
  },
  typeBtnActive: {
    borderColor: Colors.primary,
    borderWidth: 2,
    backgroundColor: '#fff7de',
  },
  typeBtnText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  typeBtnTextActive: { color: Colors.primary, fontWeight: FontWeight.bold },

  scheduleField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.md,
  },
  scheduleFieldText: { fontSize: FontSize.base, color: Colors.textPrimary, flex: 1 },
  scheduleFieldPlaceholder: { color: Colors.textMuted },

  toggleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
  },

  accessCard: {
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    gap: 10,
  },
  accessBtn: {
    flex: 1,
    minHeight: 76,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  accessBtnActive: {
    borderColor: Colors.primary,
    borderWidth: 2,
    backgroundColor: '#fff7de',
  },
  accessBtnText: { fontSize: FontSize.base, color: Colors.textPrimary, textAlign: 'center', fontWeight: FontWeight.medium },
  accessBtnTextActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  accessHelper: {
    marginTop: 4,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 18,
  },

  footer: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.base,
    backgroundColor: Colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderLight,
  },
  createBtn: {
    minHeight: 52,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createBtnDisabled: { opacity: 0.55 },
  createBtnText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.headerBg },

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
    gap: 12,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  modalGhostBtn: {
    paddingVertical: 14,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modalGhostText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  modalPrimaryBtn: {
    paddingVertical: 14,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
  },
  modalPrimaryBtnText: { fontSize: FontSize.base, color: Colors.headerBg, fontWeight: FontWeight.bold },

  dateRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  dateInputWrap: { gap: 4 },
  dateInputLabel: { fontSize: FontSize.xs, color: Colors.textMuted, fontWeight: FontWeight.medium, textTransform: 'uppercase', letterSpacing: 0.5 },
  dateInputField: {
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  timeColon: { fontSize: 24, fontWeight: FontWeight.bold, color: Colors.textPrimary, paddingBottom: 12 },
});
