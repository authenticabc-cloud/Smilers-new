/**
 * Schedule Message bottom sheet — mirrors the Smilers web app's Schedule
 * Message dialog exactly (per provided web screenshots).
 *
 * Layout:
 *   • Clock icon + "Schedule Message" title
 *   • Tab pills: "Quick pick" (default, gold) / "Custom time"
 *   • Quick pick: 5 stacked options (In 30 minutes / In 1 hour / In 3 hours /
 *     Tomorrow morning (9 AM) / Tomorrow evening (6 PM)) with computed
 *     date+time on the right.
 *   • Custom time: Date dropdown + Time dropdown + big gold "Schedule" button.
 *   • Recurring message checkbox at the bottom.
 *   • When checked: "Repeat frequency" pill row (Hourly / Daily (default) /
 *     Weekly / Monthly / Yearly).
 *   • Cancel button at bottom.
 *
 * On confirm, the sheet returns the chosen {whenMs, recurring, frequency}
 * shape. The parent (chat screen) handles the actual scheduling mutation.
 */

import React, { useMemo, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import DateTimePicker, {
  DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface ScheduleSelection {
  /** Absolute datetime to send the message, in ms-since-epoch. */
  whenMs: number;
  /** Whether the message should repeat after the first send. */
  recurring: boolean;
  /** Repeat frequency — undefined when recurring=false. */
  frequency?: ScheduleFrequency;
}

interface ScheduleMessageSheetProps {
  visible: boolean;
  onCancel: () => void;
  onConfirm: (selection: ScheduleSelection) => void;
}

type Tab = 'quick' | 'custom';

const FREQUENCY_OPTIONS: { key: ScheduleFrequency; label: string }[] = [
  { key: 'hourly', label: 'Hourly' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatQuickPickLabel(ts: number): string {
  const date = new Date(ts);
  const month = date.toLocaleDateString(undefined, { month: 'short' });
  const hour12 = ((date.getHours() + 11) % 12) + 1;
  const ampm = date.getHours() >= 12 ? 'PM' : 'AM';
  return `${month} ${date.getDate()}, ${hour12}:${pad(date.getMinutes())} ${ampm}`;
}

function formatDateForDisplay(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function formatTimeForDisplay(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface QuickPickItem {
  key: string;
  title: string;
  whenMs: number;
}

function buildQuickPickItems(): QuickPickItem[] {
  const now = Date.now();
  const today = new Date();
  const tomorrowMorning = new Date(today);
  tomorrowMorning.setDate(today.getDate() + 1);
  tomorrowMorning.setHours(9, 0, 0, 0);
  const tomorrowEvening = new Date(today);
  tomorrowEvening.setDate(today.getDate() + 1);
  tomorrowEvening.setHours(18, 0, 0, 0);
  return [
    { key: '30m', title: 'In 30 minutes', whenMs: now + 30 * 60 * 1000 },
    { key: '1h', title: 'In 1 hour', whenMs: now + 60 * 60 * 1000 },
    { key: '3h', title: 'In 3 hours', whenMs: now + 3 * 60 * 60 * 1000 },
    { key: 'tom-am', title: 'Tomorrow morning (9 AM)', whenMs: tomorrowMorning.getTime() },
    { key: 'tom-pm', title: 'Tomorrow evening (6 PM)', whenMs: tomorrowEvening.getTime() },
  ];
}

export default function ScheduleMessageSheet({
  visible,
  onCancel,
  onConfirm,
}: ScheduleMessageSheetProps) {
  const [tab, setTab] = useState<Tab>('quick');
  const [recurring, setRecurring] = useState(false);
  const [frequency, setFrequency] = useState<ScheduleFrequency>('daily');

  // Custom-time tab state — defaults to "now + 1 hour" so users can tweak.
  const [customDate, setCustomDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(d.getHours() + 1, d.getMinutes(), 0, 0);
    return d;
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  // Recompute quick-pick items whenever the sheet becomes visible so the
  // suggested times are always fresh.
  const quickItems = useMemo(buildQuickPickItems, [visible]);

  const reset = () => {
    setTab('quick');
    setRecurring(false);
    setFrequency('daily');
    const d = new Date();
    d.setHours(d.getHours() + 1, d.getMinutes(), 0, 0);
    setCustomDate(d);
    setShowDatePicker(false);
    setShowTimePicker(false);
  };

  const handleQuickPick = (item: QuickPickItem) => {
    onConfirm({
      whenMs: item.whenMs,
      recurring,
      frequency: recurring ? frequency : undefined,
    });
    reset();
  };

  const handleCustomConfirm = () => {
    onConfirm({
      whenMs: customDate.getTime(),
      recurring,
      frequency: recurring ? frequency : undefined,
    });
    reset();
  };

  const handleClose = () => {
    reset();
    onCancel();
  };

  const onDateChange = (event: DateTimePickerEvent, selected?: Date) => {
    setShowDatePicker(Platform.OS === 'ios');
    if (selected) {
      const merged = new Date(customDate);
      merged.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
      setCustomDate(merged);
    }
  };

  const onTimeChange = (event: DateTimePickerEvent, selected?: Date) => {
    setShowTimePicker(Platform.OS === 'ios');
    if (selected) {
      const merged = new Date(customDate);
      merged.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      setCustomDate(merged);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <Pressable
          style={styles.sheet}
          onPress={() => {}}
          testID="schedule-message-sheet"
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.sheetContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.grabber} />

            <View style={styles.header}>
              <Feather name="clock" size={22} color={Colors.primary} />
              <Text style={styles.title}>Schedule Message</Text>
            </View>

            {/* Tab pills */}
            <View style={styles.tabRow}>
              <TouchableOpacity
                style={[styles.tabPill, tab === 'quick' ? styles.tabPillActive : null]}
                onPress={() => setTab('quick')}
                activeOpacity={0.85}
                testID="schedule-tab-quick"
              >
                <Text
                  style={[
                    styles.tabPillText,
                    tab === 'quick' ? styles.tabPillTextActive : null,
                  ]}
                >
                  Quick pick
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tabPill, tab === 'custom' ? styles.tabPillActive : null]}
                onPress={() => setTab('custom')}
                activeOpacity={0.85}
                testID="schedule-tab-custom"
              >
                <Text
                  style={[
                    styles.tabPillText,
                    tab === 'custom' ? styles.tabPillTextActive : null,
                  ]}
                >
                  Custom time
                </Text>
              </TouchableOpacity>
            </View>

            {/* Quick pick list */}
            {tab === 'quick' ? (
              <View style={styles.quickList}>
                {quickItems.map((item) => (
                  <TouchableOpacity
                    key={item.key}
                    style={styles.quickItem}
                    onPress={() => handleQuickPick(item)}
                    activeOpacity={0.85}
                    testID={`schedule-quick-${item.key}`}
                  >
                    <Text style={styles.quickItemTitle}>{item.title}</Text>
                    <Text style={styles.quickItemTime}>
                      {formatQuickPickLabel(item.whenMs)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            {/* Custom-time tab */}
            {tab === 'custom' ? (
              <View style={styles.customWrap}>
                <Text style={styles.customLabel}>Date</Text>
                <TouchableOpacity
                  style={styles.customField}
                  onPress={() => setShowDatePicker(true)}
                  activeOpacity={0.85}
                  testID="schedule-custom-date"
                >
                  <Text style={styles.customFieldText}>
                    {formatDateForDisplay(customDate)}
                  </Text>
                  <Feather name="chevron-down" size={18} color={Colors.textSecondary} />
                </TouchableOpacity>

                <Text style={[styles.customLabel, { marginTop: Spacing.base }]}>
                  Time
                </Text>
                <TouchableOpacity
                  style={styles.customField}
                  onPress={() => setShowTimePicker(true)}
                  activeOpacity={0.85}
                  testID="schedule-custom-time"
                >
                  <Text style={styles.customFieldText}>
                    {formatTimeForDisplay(customDate)}
                  </Text>
                  <Feather name="chevron-down" size={18} color={Colors.textSecondary} />
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.scheduleBtn,
                    customDate.getTime() <= Date.now() ? styles.scheduleBtnDisabled : null,
                  ]}
                  onPress={handleCustomConfirm}
                  activeOpacity={0.85}
                  disabled={customDate.getTime() <= Date.now()}
                  testID="schedule-custom-confirm"
                >
                  <Text style={styles.scheduleBtnText}>Schedule</Text>
                </TouchableOpacity>

                {showDatePicker ? (
                  <DateTimePicker
                    value={customDate}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    minimumDate={new Date()}
                    onChange={onDateChange}
                  />
                ) : null}

                {showTimePicker ? (
                  <DateTimePicker
                    value={customDate}
                    mode="time"
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={onTimeChange}
                  />
                ) : null}
              </View>
            ) : null}

            {/* Recurring checkbox */}
            <TouchableOpacity
              style={styles.recurringRow}
              onPress={() => setRecurring((current) => !current)}
              activeOpacity={0.85}
              testID="schedule-recurring-toggle"
            >
              <View
                style={[
                  styles.checkbox,
                  recurring ? styles.checkboxChecked : null,
                ]}
              >
                {recurring ? (
                  <Feather name="check" size={14} color={Colors.white} />
                ) : null}
              </View>
              <Text style={styles.recurringLabel}>Recurring message</Text>
            </TouchableOpacity>

            {recurring ? (
              <View style={styles.frequencyWrap} testID="schedule-frequency-row">
                <Text style={styles.frequencyHelper}>Repeat frequency:</Text>
                <View style={styles.frequencyPills}>
                  {FREQUENCY_OPTIONS.map((opt) => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        styles.frequencyPill,
                        frequency === opt.key ? styles.frequencyPillActive : null,
                      ]}
                      onPress={() => setFrequency(opt.key)}
                      activeOpacity={0.85}
                      testID={`schedule-frequency-${opt.key}`}
                    >
                      <Text
                        style={[
                          styles.frequencyPillText,
                          frequency === opt.key ? styles.frequencyPillTextActive : null,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ) : null}

            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={handleClose}
              activeOpacity={0.85}
              testID="schedule-cancel"
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: Spacing.lg,
    maxHeight: '92%',
  },
  sheetContent: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
  },
  grabber: {
    width: 40,
    height: 4,
    backgroundColor: '#E5E0CC',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: Spacing.md,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: Spacing.lg,
  },
  title: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },

  // Tab pills
  tabRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  tabPill: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: Radius.pill,
    backgroundColor: '#EFE7D6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabPillActive: {
    backgroundColor: Colors.primary,
  },
  tabPillText: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
  tabPillTextActive: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
  },

  // Quick list
  quickList: { gap: 12 },
  quickItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#EFE7D6',
    borderRadius: Radius.md,
  },
  quickItemTitle: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
  quickItemTime: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Custom time
  customWrap: { gap: 0 },
  customLabel: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  customField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#EFE7D6',
    borderRadius: Radius.md,
  },
  customFieldText: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
  scheduleBtn: {
    marginTop: Spacing.lg,
    minHeight: 52,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scheduleBtnDisabled: { opacity: 0.55 },
  scheduleBtnText: {
    fontSize: FontSize.base,
    color: Colors.white,
    fontWeight: FontWeight.bold,
  },

  // Recurring
  recurringRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: Spacing.xl,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#9CA3AF',
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  recurringLabel: {
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
  frequencyWrap: { marginTop: Spacing.md },
  frequencyHelper: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 10,
  },
  frequencyPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  frequencyPill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radius.md,
    backgroundColor: '#EFE7D6',
  },
  frequencyPillActive: {
    backgroundColor: Colors.primary,
  },
  frequencyPillText: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.semibold,
  },
  frequencyPillTextActive: {
    color: Colors.white,
    fontWeight: FontWeight.bold,
  },

  cancelBtn: {
    marginTop: Spacing.xl,
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  cancelBtnText: {
    fontSize: FontSize.lg,
    color: Colors.textSecondary,
    fontWeight: FontWeight.semibold,
  },
});
