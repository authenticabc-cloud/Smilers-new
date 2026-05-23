/**
 * Conference HUD — Slice C of the Groups spec.
 *
 * Overlays the call screen with conference role controls (Chair / Clerk /
 * Protocol / Participant), a digital clock, role-aware action rail, a
 * reactions tray (raise hand · question · motion · second motion), and an
 * audience selector for in-conference messaging (everyone / chair / secretary).
 *
 * All mutations are wrapped in safeCall so the HUD degrades gracefully when
 * the backend hasn't shipped the conference endpoints yet — buttons still
 * render so the UX can be reviewed, but a clear alert surfaces if the
 * endpoint is missing.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../theme';

export type ConferenceRole = 'chair' | 'clerk' | 'protocol' | 'participant';

interface ConferenceHUDProps {
  conferenceId: string;
  myUserId?: string | null;
  onLeave?: () => void;
  /** Toggle native screen sharing — wired from the call screen. */
  onToggleScreenShare?: () => void | Promise<void>;
  /** Whether screen-share is currently broadcasting. Drives the active state of the tool button. */
  screenSharing?: boolean;
}

const REACTIONS: { key: string; icon: any; label: string }[] = [
  { key: 'raise_hand', icon: 'hand-front-right', label: 'Raise hand' },
  { key: 'question', icon: 'help-circle-outline', label: 'Question' },
  { key: 'motion', icon: 'gavel', label: 'Motion' },
  { key: 'second_motion', icon: 'check-decagram-outline', label: 'Second' },
];

const AUDIENCE_OPTIONS: { key: 'everyone' | 'chair' | 'secretary'; label: string }[] = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'chair', label: 'Chair only' },
  { key: 'secretary', label: 'Secretary only' },
];

function useDigitalClock() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // 24h HH:MM:SS — matches the "digital clock visible to all" spec line.
  return useMemo(() => {
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }, [now]);
}

function normalizeRole(value: any): ConferenceRole {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'chair' || raw === 'host') return 'chair';
  if (raw === 'clerk' || raw === 'secretary') return 'clerk';
  if (raw === 'protocol' || raw === 'moderator') return 'protocol';
  return 'participant';
}

function RoleBadge({ role }: { role: ConferenceRole }) {
  const config = {
    chair: { label: 'Chair', icon: 'crown', bg: '#fef3c7', fg: '#92400e' },
    clerk: { label: 'Clerk', icon: 'pencil-outline', bg: '#dbeafe', fg: '#1e3a8a' },
    protocol: { label: 'Protocol', icon: 'shield-check', bg: '#dcfce7', fg: '#166534' },
    participant: { label: 'Participant', icon: 'account-outline', bg: 'rgba(255,255,255,0.18)', fg: '#fff' },
  }[role];
  return (
    <View style={[styles.roleBadge, { backgroundColor: config.bg }]} testID="conf-role-badge">
      <MaterialCommunityIcons name={config.icon as any} size={12} color={config.fg} />
      <Text style={[styles.roleBadgeText, { color: config.fg }]}>{config.label}</Text>
    </View>
  );
}

function safeCall<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  return fn().catch((errorValue: any) => {
    const message = errorValue?.message || String(errorValue || '');
    // eslint-disable-next-line no-console
    console.warn(`[conf] ${label} failed:`, message);
    Alert.alert(
      label,
      message.includes('not found') || message.includes('CouldNotFindFunction')
        ? 'This conference action needs the latest backend update — once the web team ships it, the action will start working.'
        : message,
    );
    return null;
  });
}

function AudienceSelector({
  value,
  onChange,
  visible,
  onClose,
}: {
  value: 'everyone' | 'chair' | 'secretary';
  onChange: (next: 'everyone' | 'chair' | 'secretary') => void;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>Send chat to…</Text>
          {AUDIENCE_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.key}
              style={styles.modalRow}
              onPress={() => {
                onChange(opt.key);
                onClose();
              }}
              testID={`conf-audience-${opt.key}`}
            >
              <Text style={styles.modalRowText}>{opt.label}</Text>
              {value === opt.key ? <Feather name="check" size={18} color={Colors.primary} /> : null}
            </TouchableOpacity>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function TimerSheet({
  visible,
  onClose,
  onStart,
}: {
  visible: boolean;
  onClose: () => void;
  onStart: (durationMs: number, withBell: boolean) => void;
}) {
  const [seconds, setSeconds] = useState('120');
  const [bell, setBell] = useState(true);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>Start a timer</Text>
          <Text style={styles.modalSubtitle}>
            Spec: timer is set by the Protocol — optional bell notification when it ends.
          </Text>
          <TextInput
            value={seconds}
            onChangeText={(text) => setSeconds(text.replace(/[^0-9]/g, '').slice(0, 4))}
            placeholder="120"
            placeholderTextColor={Colors.textMuted}
            keyboardType="number-pad"
            style={styles.modalInput}
            testID="conf-timer-seconds"
          />
          <TouchableOpacity
            style={styles.modalRow}
            onPress={() => setBell((b) => !b)}
            testID="conf-timer-bell-toggle"
          >
            <Feather name={bell ? 'check-square' : 'square'} size={20} color={Colors.primary} />
            <Text style={styles.modalRowText}>Ring a bell at the end</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.modalPrimaryBtn}
            onPress={() => {
              const value = Math.max(1, parseInt(seconds || '0', 10)) * 1000;
              onStart(value, bell);
            }}
            testID="conf-timer-start"
          >
            <Text style={styles.modalPrimaryBtnText}>Start</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function NoticeBoardSheet({
  visible,
  onClose,
  notice,
  onSave,
  canEdit,
}: {
  visible: boolean;
  onClose: () => void;
  notice: string;
  onSave: (next: string) => void;
  canEdit: boolean;
}) {
  const [text, setText] = useState(notice);
  useEffect(() => setText(notice), [notice]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>Notice board</Text>
          <Text style={styles.modalSubtitle}>
            {canEdit ? 'Visible to all participants. Only the Clerk can edit.' : 'Managed by the Clerk — visible to everyone.'}
          </Text>
          {canEdit ? (
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Type the notice…"
              placeholderTextColor={Colors.textMuted}
              multiline
              style={[styles.modalInput, { minHeight: 100, textAlignVertical: 'top' }]}
              testID="conf-notice-input"
            />
          ) : (
            <Text style={[styles.modalRowText, { padding: 12 }]}>{notice || 'No notice posted yet.'}</Text>
          )}
          {canEdit ? (
            <TouchableOpacity
              style={styles.modalPrimaryBtn}
              onPress={() => onSave(text.trim())}
              testID="conf-notice-save"
            >
              <Text style={styles.modalPrimaryBtnText}>Save notice</Text>
            </TouchableOpacity>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MinutesSheet({
  visible,
  onClose,
  transcript,
  onAppend,
  onExport,
}: {
  visible: boolean;
  onClose: () => void;
  transcript: string;
  onAppend: (text: string) => void;
  onExport: () => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>Minutes</Text>
          <Text style={styles.modalSubtitle}>
            Private to the Clerk. Exportable as PDF (sent to the Clerk's email).
          </Text>
          <View style={styles.minutesScroll} testID="conf-minutes-scroll">
            <Text style={styles.minutesText}>{transcript || 'No entries yet — start the live transcription or type below.'}</Text>
          </View>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Add a minute line…"
            placeholderTextColor={Colors.textMuted}
            multiline
            style={[styles.modalInput, { minHeight: 80, textAlignVertical: 'top' }]}
            testID="conf-minutes-input"
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={[styles.modalPrimaryBtn, { flex: 1 }]}
              onPress={() => {
                if (draft.trim()) {
                  onAppend(draft.trim());
                  setDraft('');
                }
              }}
              testID="conf-minutes-append"
            >
              <Text style={styles.modalPrimaryBtnText}>Add entry</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalPrimaryBtn, { flex: 1, backgroundColor: '#1e3a8a' }]}
              onPress={onExport}
              testID="conf-minutes-export"
            >
              <Text style={[styles.modalPrimaryBtnText, { color: '#fff' }]}>Export PDF</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function ConferenceHUD({ conferenceId, onLeave, onToggleScreenShare, screenSharing }: ConferenceHUDProps) {
  const clock = useDigitalClock();
  const [reactionsExpanded, setReactionsExpanded] = useState(false);
  const [audience, setAudience] = useState<'everyone' | 'chair' | 'secretary'>('everyone');
  const [showAudience, setShowAudience] = useState(false);
  const [showTimer, setShowTimer] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const [showMinutes, setShowMinutes] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // --- Backend state (graceful fallback) ---
  const { data: state } = useSafeConvexQuery<any>(
    (api as any).conferences.getConferenceState,
    { conferenceId },
    null,
    !!conferenceId,
  );

  const role = normalizeRole(state?.viewerRole);
  const isChair = role === 'chair';
  const isClerk = role === 'clerk';
  const isProtocol = role === 'protocol';
  const isMuteAllActive = !!state?.allMuted;
  const pendingUnmuteCount = Array.isArray(state?.pendingUnmuteRequests)
    ? state.pendingUnmuteRequests.length
    : Number(state?.pendingUnmuteCount || 0);
  const activeTimerEndsAt = typeof state?.timerEndsAt === 'number' ? state.timerEndsAt : null;
  const noticeText = typeof state?.notice === 'string' ? state.notice : '';
  const minutesTranscript = typeof state?.minutesTranscript === 'string'
    ? state.minutesTranscript
    : Array.isArray(state?.minutes)
      ? state.minutes.map((entry: any) => entry?.text || entry).filter(Boolean).join('\n\n')
      : '';

  // --- Mutations ---
  const muteAllM = useMutation((api as any).conferences.muteAll);
  const requestUnmuteM = useMutation((api as any).conferences.requestUnmute);
  const approveAllUnmuteM = useMutation((api as any).conferences.approveAllUnmute);
  const sendReactionM = useMutation((api as any).conferences.sendReaction);
  const setNoticeM = useMutation((api as any).conferences.setNotice);
  const appendMinutesM = useMutation((api as any).conferences.appendMinutes);
  const exportMinutesM = useMutation((api as any).conferences.exportMinutes);
  const startTimerM = useMutation((api as any).conferences.startTimer);
  const endTimerM = useMutation((api as any).conferences.endTimer);
  const endMeetingM = useMutation((api as any).conferences.endMeeting);
  const adjournM = useMutation((api as any).conferences.adjourn);

  // --- Handlers ---
  const handleToggleMuteAll = useCallback(async () => {
    await safeCall(isMuteAllActive ? 'Unmute all' : 'Mute all', async () =>
      muteAllM({ conferenceId, enabled: !isMuteAllActive }),
    );
  }, [conferenceId, isMuteAllActive, muteAllM]);

  const handleRequestUnmute = useCallback(async () => {
    await safeCall('Request unmute', async () => requestUnmuteM({ conferenceId }));
  }, [conferenceId, requestUnmuteM]);

  const handleApproveAllUnmute = useCallback(async () => {
    if (pendingUnmuteCount === 0) {
      Alert.alert('No requests', 'No participants are currently waiting to be unmuted.');
      return;
    }
    await safeCall('Approve unmute', async () => approveAllUnmuteM({ conferenceId }));
  }, [approveAllUnmuteM, conferenceId, pendingUnmuteCount]);

  const handleReaction = useCallback(async (reactionKey: string) => {
    setReactionsExpanded(false);
    await safeCall('Send reaction', async () => sendReactionM({ conferenceId, kind: reactionKey }));
  }, [conferenceId, sendReactionM]);

  const handleStartTimer = useCallback(async (durationMs: number, withBell: boolean) => {
    setShowTimer(false);
    await safeCall('Start timer', async () =>
      startTimerM({ conferenceId, durationMs, withBell }),
    );
  }, [conferenceId, startTimerM]);

  const handleEndTimer = useCallback(async () => {
    await safeCall('End timer', async () => endTimerM({ conferenceId }));
  }, [conferenceId, endTimerM]);

  const handleSaveNotice = useCallback(async (text: string) => {
    setShowNotice(false);
    await safeCall('Save notice', async () => setNoticeM({ conferenceId, text }));
  }, [conferenceId, setNoticeM]);

  const handleAppendMinutes = useCallback(async (text: string) => {
    await safeCall('Append minutes', async () => appendMinutesM({ conferenceId, text }));
  }, [appendMinutesM, conferenceId]);

  const handleExportMinutes = useCallback(async () => {
    await safeCall('Export minutes PDF', async () => exportMinutesM({ conferenceId }));
  }, [conferenceId, exportMinutesM]);

  const handleEndMeeting = useCallback(() => {
    Alert.alert('End meeting?', 'All participants will be notified and the call will close.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End',
        style: 'destructive',
        onPress: async () => {
          await safeCall('End meeting', async () => endMeetingM({ conferenceId }));
          if (onLeave) onLeave();
        },
      },
    ]);
  }, [conferenceId, endMeetingM, onLeave]);

  const handleAdjourn = useCallback(() => {
    Alert.alert('Adjourn?', 'The meeting will end and all reservations / sub-conferences will close.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Adjourn',
        style: 'destructive',
        onPress: async () => {
          await safeCall('Adjourn', async () => adjournM({ conferenceId }));
          if (onLeave) onLeave();
        },
      },
    ]);
  }, [adjournM, conferenceId, onLeave]);

  // --- Timer countdown derived value ---
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!activeTimerEndsAt) return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [activeTimerEndsAt]);
  const timerRemainingLabel = useMemo(() => {
    if (!activeTimerEndsAt) return null;
    const remaining = Math.max(0, activeTimerEndsAt - Date.now());
    const totalSec = Math.ceil(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }, [activeTimerEndsAt]);

  if (collapsed) {
    return (
      <TouchableOpacity
        style={styles.collapsedHandle}
        onPress={() => setCollapsed(false)}
        testID="conf-hud-expand"
      >
        <MaterialCommunityIcons name="podium" size={18} color={Colors.white} />
        <Text style={styles.collapsedHandleText}>Conference</Text>
      </TouchableOpacity>
    );
  }

  return (
    <>
      <View style={styles.topBar} pointerEvents="box-none" testID="conf-hud-top">
        <View style={styles.topLeft}>
          <RoleBadge role={role} />
        </View>
        <View style={styles.clockWrap} testID="conf-hud-clock">
          <Feather name="clock" size={12} color={Colors.white} />
          <Text style={styles.clockText}>{clock}</Text>
        </View>
        <TouchableOpacity
          style={styles.collapseBtn}
          onPress={() => setCollapsed(true)}
          testID="conf-hud-collapse"
        >
          <Feather name="chevron-down" size={18} color={Colors.white} />
        </TouchableOpacity>
      </View>

      {timerRemainingLabel ? (
        <View style={styles.timerBar} testID="conf-hud-timer">
          <Feather name="clock" size={14} color="#7f1d1d" />
          <Text style={styles.timerLabel}>Timer · {timerRemainingLabel}</Text>
          {(isProtocol || isChair) ? (
            <TouchableOpacity onPress={handleEndTimer} testID="conf-hud-timer-end" hitSlop={6}>
              <Feather name="x" size={16} color="#7f1d1d" />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <View style={styles.bottomBar} testID="conf-hud-bottom">
        {/* Reactions */}
        <View style={styles.reactionsWrap}>
          {reactionsExpanded ? (
            <Animated.View style={styles.reactionsRow} testID="conf-reactions-row">
              {REACTIONS.map((reaction) => (
                <TouchableOpacity
                  key={reaction.key}
                  style={styles.reactionBtn}
                  onPress={() => handleReaction(reaction.key)}
                  testID={`conf-reaction-${reaction.key}`}
                >
                  <MaterialCommunityIcons name={reaction.icon} size={22} color={Colors.textPrimary} />
                  <Text style={styles.reactionLabel}>{reaction.label}</Text>
                </TouchableOpacity>
              ))}
            </Animated.View>
          ) : null}
          <TouchableOpacity
            style={styles.fab}
            onPress={() => setReactionsExpanded((x) => !x)}
            testID="conf-reactions-toggle"
          >
            <MaterialCommunityIcons
              name={reactionsExpanded ? 'close' : 'emoticon-happy-outline'}
              size={22}
              color={Colors.textPrimary}
            />
          </TouchableOpacity>
        </View>

        {/* Role-aware tools */}
        <View style={styles.toolsRow}>
          {isChair ? (
            <>
              <ToolBtn
                icon={isMuteAllActive ? 'microphone-off' : 'microphone'}
                label={isMuteAllActive ? 'Unmute all' : 'Mute all'}
                onPress={handleToggleMuteAll}
                testID="conf-tool-mute-all"
              />
              <ToolBtn
                icon="account-check-outline"
                label={pendingUnmuteCount > 0 ? `Approve (${pendingUnmuteCount})` : 'Approvals'}
                onPress={handleApproveAllUnmute}
                badge={pendingUnmuteCount}
                testID="conf-tool-approve-unmute"
              />
              <ToolBtn icon="account-cog-outline" label="Manage" onPress={() => Alert.alert('Manage participants', 'Coming next iteration: remove / suspend / promote roles inline.')} testID="conf-tool-manage" />
              <ToolBtn icon="stop-circle-outline" label="End" danger onPress={handleEndMeeting} testID="conf-tool-end" />
              <ToolBtn icon="bell-off-outline" label="Adjourn" danger onPress={handleAdjourn} testID="conf-tool-adjourn" />
            </>
          ) : null}

          {isClerk ? (
            <>
              <ToolBtn icon="clipboard-text-outline" label="Minutes" onPress={() => setShowMinutes(true)} testID="conf-tool-minutes" />
              <ToolBtn icon="bulletin-board" label="Notice" onPress={() => setShowNotice(true)} testID="conf-tool-notice" />
              <ToolBtn
                icon="monitor-share"
                label={screenSharing ? 'Stop sharing' : 'Share screen'}
                active={!!screenSharing}
                onPress={() => {
                  if (typeof onToggleScreenShare === 'function') {
                    void onToggleScreenShare();
                  } else {
                    Alert.alert(
                      'Screen sharing',
                      'Screen share is only available from inside an active call. Start the conference call first, then tap Share screen.',
                    );
                  }
                }}
                testID="conf-tool-share"
              />
            </>
          ) : null}

          {isProtocol ? (
            <>
              <ToolBtn icon="timer-sand" label="Timer" onPress={() => setShowTimer(true)} testID="conf-tool-timer" />
              <ToolBtn icon="video-off-outline" label="Force video off" onPress={() => Alert.alert('Force video off', 'Pick a participant from the call grid; this iteration only stubs the action.')} testID="conf-tool-video-off" />
              <ToolBtn icon="account-arrow-right-outline" label="Admit" onPress={() => Alert.alert('Admit from lobby', 'Lobby panel will land alongside the participant grid in a follow-up iteration.')} testID="conf-tool-admit" />
            </>
          ) : null}

          {!isChair && !isClerk && !isProtocol ? (
            <ToolBtn
              icon={isMuteAllActive ? 'hand-front-right' : 'microphone'}
              label={isMuteAllActive ? 'Request unmute' : 'Toggle mic'}
              onPress={isMuteAllActive ? handleRequestUnmute : undefined}
              testID="conf-tool-self-mic"
            />
          ) : null}

          {/* Notice board visible to everyone (read-only when not Clerk) */}
          {!isClerk && noticeText ? (
            <ToolBtn icon="bulletin-board" label="Notice" onPress={() => setShowNotice(true)} testID="conf-tool-notice-read" />
          ) : null}

          <ToolBtn icon="email-outline" label={`To: ${audience}`} onPress={() => setShowAudience(true)} testID="conf-tool-audience" />
        </View>
      </View>

      <AudienceSelector
        visible={showAudience}
        onClose={() => setShowAudience(false)}
        value={audience}
        onChange={setAudience}
      />
      <TimerSheet
        visible={showTimer}
        onClose={() => setShowTimer(false)}
        onStart={handleStartTimer}
      />
      <NoticeBoardSheet
        visible={showNotice}
        onClose={() => setShowNotice(false)}
        notice={noticeText}
        onSave={handleSaveNotice}
        canEdit={isClerk}
      />
      <MinutesSheet
        visible={showMinutes}
        onClose={() => setShowMinutes(false)}
        transcript={minutesTranscript}
        onAppend={handleAppendMinutes}
        onExport={handleExportMinutes}
      />
    </>
  );
}

function ToolBtn({
  icon,
  label,
  onPress,
  testID,
  danger,
  badge,
  active,
}: {
  icon: any;
  label: string;
  onPress?: () => void;
  testID?: string;
  danger?: boolean;
  badge?: number;
  active?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.toolBtn,
        danger ? styles.toolBtnDanger : null,
        active ? styles.toolBtnActive : null,
        !onPress ? { opacity: 0.55 } : null,
      ]}
      onPress={onPress}
      disabled={!onPress}
      testID={testID}
      activeOpacity={0.7}
    >
      <MaterialCommunityIcons
        name={icon}
        size={20}
        color={danger ? '#fff' : active ? '#3D2A00' : Colors.textPrimary}
      />
      <Text
        style={[
          styles.toolBtnLabel,
          danger ? { color: '#fff' } : null,
          active ? { color: '#3D2A00', fontWeight: FontWeight.bold } : null,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {badge && badge > 0 ? (
        <View style={styles.toolBtnBadge}>
          <Text style={styles.toolBtnBadgeText}>{badge}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  topBar: {
    position: 'absolute',
    top: Spacing.xl,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.base,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 30,
  },
  topLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clockWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  clockText: { color: Colors.white, fontVariant: ['tabular-nums'], fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  collapseBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },

  collapsedHandle: {
    position: 'absolute',
    top: Spacing.xl,
    left: Spacing.base,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 30,
  },
  collapsedHandleText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radius.pill,
  },
  roleBadgeText: { fontSize: 11, fontWeight: FontWeight.semibold },

  timerBar: {
    position: 'absolute',
    top: Spacing.xl + 38,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: '#fee2e2',
    zIndex: 30,
  },
  timerLabel: { color: '#7f1d1d', fontWeight: FontWeight.semibold, fontSize: FontSize.sm },

  bottomBar: {
    position: 'absolute',
    bottom: 110,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.base,
    gap: 10,
    zIndex: 30,
  },
  reactionsWrap: { alignItems: 'flex-end' },
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 8,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(255,255,255,0.92)',
    marginBottom: 8,
    ...Shadow.md,
  },
  reactionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: '#f5e9d3',
  },
  reactionLabel: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  fab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.white,
    alignSelf: 'flex-end',
    ...Shadow.md,
  },

  toolsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 10,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(255,255,255,0.92)',
    ...Shadow.md,
  },
  toolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: '#fff7de',
  },
  toolBtnDanger: { backgroundColor: '#dc2626' },
  toolBtnActive: { backgroundColor: '#FACC15', borderWidth: 1, borderColor: '#3D2A00' },
  toolBtnLabel: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.semibold, maxWidth: 110 },
  toolBtnBadge: {
    marginLeft: 4,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ef4444',
  },
  toolBtnBadgeText: { color: '#fff', fontSize: 11, fontWeight: FontWeight.bold },

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
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderLight,
  },
  modalRowText: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  modalInput: {
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
  modalPrimaryBtn: {
    minHeight: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPrimaryBtnText: { fontSize: FontSize.base, color: Colors.headerBg, fontWeight: FontWeight.bold },
  minutesScroll: {
    maxHeight: 180,
    padding: 12,
    backgroundColor: '#fafaf6',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  minutesText: { fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20 },
});
