/**
 * Conference Info / Lobby screen
 *
 * Shows full conference details (per Smilers web parity):
 *   - Header card: type icon + scheduled date + recurrence + description + access mode + status
 *   - Invite Code card: monospace code + copy-to-clipboard + native Share
 *   - Participants list with role chips (Chair / Clerk / Protocol / Participant)
 *   - Primary CTA: "Enter Conference Room" → /conference/[id]/room
 *   - Destructive CTA: "Delete Conference" (creator-only) → api.conferences.deleteConference
 *
 * Backed by canonical Convex contract (confirmed):
 *   - api.conferences.get({ conferenceId })  → returns conf doc + participants[]
 *   - api.conferences.deleteConference({ conferenceId })  → creator-only permanent delete
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';

import { api } from '../../../src/convexApi';
import { useSafeConvexQuery } from '../../../src/hooks/useSafeConvexQuery';
import { getDisplayInitials } from '../../../src/lib/displayName';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../../src/theme';

type Role = 'chair' | 'clerk' | 'protocol' | 'participant';
type ParticipantStatus = 'invited' | 'waiting' | 'active' | 'suspended' | 'removed' | 'left';

interface Participant {
  userId: string;
  userName?: string;
  userAvatar?: string | null;
  role: Role;
  status: ParticipantStatus;
  isMuted?: boolean;
  videoEnabled?: boolean;
  joinedAt?: string;
}

interface ConferenceDetail {
  _id: string;
  title: string;
  description?: string;
  type: 'video' | 'audio';
  creatorId: string;
  chairId: string;
  inviteCode: string;
  accessMode: 'open' | 'admission';
  status: 'scheduled' | 'started' | 'ended' | 'adjourned';
  scheduledAt: string;
  isRecurring?: boolean;
  frequency?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  startedAt?: string;
  endedAt?: string;
  participants?: Participant[];
  myUserId?: string;
}

function normalizeRole(value: any): Role {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  if (v === 'chair') return 'chair';
  if (v === 'clerk' || v === 'secretary') return 'clerk';
  if (v === 'protocol' || v === 'moderator') return 'protocol';
  return 'participant';
}

function getRoleConfig(role: Role) {
  switch (role) {
    case 'chair':
      return { label: 'Chair', icon: 'crown' as const, bg: '#FEF3C7', fg: '#92400E' };
    case 'clerk':
      return { label: 'Clerk', icon: 'pencil-outline' as const, bg: '#DBEAFE', fg: '#1E3A8A' };
    case 'protocol':
      return { label: 'Protocol', icon: 'shield-check' as const, bg: '#DCFCE7', fg: '#166534' };
    default:
      return { label: 'Participant', icon: 'account-outline' as const, bg: '#F3F4F6', fg: '#374151' };
  }
}

function formatScheduledLong(iso?: string): string {
  if (!iso) return 'Time TBD';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Time TBD';
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    return 'Time TBD';
  }
}

function formatRecurrenceLabel(isRecurring?: boolean, freq?: string | undefined): string | null {
  if (!isRecurring) return null;
  const map: Record<string, string> = {
    daily: 'Repeats Daily',
    weekly: 'Repeats Weekly',
    monthly: 'Repeats Monthly',
    yearly: 'Repeats Yearly',
  };
  return map[String(freq || '').toLowerCase()] || 'Repeats';
}

function formatAccessLabel(accessMode?: string): string {
  if (accessMode === 'admission') return 'Admission Only';
  return 'Open Access';
}

function formatStatusLabel(status?: string): string {
  switch (status) {
    case 'started':
      return 'live';
    case 'ended':
      return 'ended';
    case 'adjourned':
      return 'adjourned';
    case 'scheduled':
    default:
      return 'scheduled';
  }
}

export default function ConferenceInfoScreen() {
  const router = useRouter();
  const { conferenceId: rawId } = useLocalSearchParams<{ conferenceId?: string | string[] }>();
  const conferenceId = Array.isArray(rawId) ? rawId[0] : rawId;
  const isValid = typeof conferenceId === 'string' && conferenceId.length > 4;

  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: detail, loading } = useSafeConvexQuery<ConferenceDetail | null>(
    (api as any).conferences.get,
    { conferenceId },
    null,
    !!isValid,
  );

  const deleteConferenceM = useMutation((api as any).conferences.deleteConference);

  const participants: Participant[] = useMemo(() => {
    if (!detail?.participants) return [];
    if (!Array.isArray(detail.participants)) return [];
    return detail.participants.filter((p) => p && p.status !== 'removed');
  }, [detail?.participants]);

  // Heuristic: if backend gives us a `myUserId`, use it. Otherwise fall back to
  // the creator (best effort). The "delete" button is shown only when we
  // believe the viewer is the creator. The server enforces this anyway.
  const myUserId = (detail as any)?.myUserId || (detail as any)?.viewerUserId || null;
  const isCreator = !!myUserId && !!detail?.creatorId && String(myUserId) === String(detail.creatorId);

  const handleCopyCode = useCallback(async () => {
    if (!detail?.inviteCode) return;
    try {
      await Clipboard.setStringAsync(detail.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      Alert.alert('Copy failed', 'Could not copy invite code to clipboard.');
    }
  }, [detail?.inviteCode]);

  const handleShareCode = useCallback(async () => {
    if (!detail?.inviteCode || !detail?.title) return;
    try {
      await Share.share({
        message: `Join "${detail.title}" on Smilers — invite code: ${detail.inviteCode}`,
      });
    } catch {
      /* user cancelled */
    }
  }, [detail?.inviteCode, detail?.title]);

  const handleEnterRoom = useCallback(() => {
    if (!isValid) return;
    router.push(`/conference/${conferenceId}/room` as any);
  }, [conferenceId, isValid, router]);

  const handleDeleteConference = useCallback(() => {
    if (!isValid) return;
    Alert.alert(
      'Delete this conference?',
      'This permanently removes the conference and revokes the invite code for everyone. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteConferenceM({ conferenceId });
              router.back();
            } catch (e: any) {
              const message = String(e?.message || e || '');
              const lower = message.toLowerCase();
              if (lower.includes('forbidden') || lower.includes('not creator') || lower.includes('not authorized')) {
                Alert.alert(
                  'Not allowed',
                  'Only the conference creator can delete it. You can leave the conference instead.',
                );
              } else if (
                message.includes('CouldNotFindFunction') ||
                lower.includes('no function')
              ) {
                Alert.alert(
                  'Action unavailable',
                  'The delete endpoint isn\u2019t available on the connected backend yet. Please try again after the backend update.',
                );
              } else {
                Alert.alert('Could not delete', message || 'Something went wrong. Please try again.');
              }
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  }, [conferenceId, deleteConferenceM, isValid, router]);

  // --- Early returns ---
  if (!isValid) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.headerBackBtn}>
            <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Conference</Text>
          <View style={{ width: 36 }} />
        </View>
        <View style={styles.errorWrap}>
          <Ionicons name="alert-circle-outline" size={42} color={Colors.danger} />
          <Text style={styles.errorTitle}>Invalid conference link</Text>
          <Text style={styles.errorBody}>The conference link is malformed or has expired.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loading && !detail) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.headerBackBtn}>
            <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Conference</Text>
          <View style={{ width: 36 }} />
        </View>
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!detail) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.headerBackBtn}>
            <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Conference</Text>
          <View style={{ width: 36 }} />
        </View>
        <View style={styles.errorWrap}>
          <MaterialCommunityIcons name="video-off-outline" size={42} color={Colors.textMuted} />
          <Text style={styles.errorTitle}>Conference not found</Text>
          <Text style={styles.errorBody}>It may have been deleted or you no longer have access.</Text>
          <TouchableOpacity style={styles.errorPrimaryBtn} onPress={() => router.back()}>
            <Text style={styles.errorPrimaryBtnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const recurrenceLabel = formatRecurrenceLabel(detail.isRecurring, detail.frequency);
  const isVideo = detail.type === 'video';
  const typeLabel = isVideo ? 'Video Conference' : 'Audio Conference';
  const showDelete = isCreator || (myUserId === null && detail.status !== 'ended');

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="conference-info-screen">
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={10}
          style={styles.headerBackBtn}
          testID="conf-info-back"
        >
          <Ionicons name="arrow-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle} numberOfLines={1}>{detail.title}</Text>
          <Text style={styles.headerSubtitle}>{typeLabel}</Text>
        </View>
      </View>

      <FlatList
        data={participants}
        keyExtractor={(p) => String(p.userId)}
        contentContainerStyle={styles.scrollContent}
        ListHeaderComponent={
          <>
            {/* Schedule card */}
            <View style={styles.scheduleCard} testID="conf-info-schedule-card">
              <View style={styles.scheduleIconWrap}>
                <MaterialCommunityIcons
                  name={isVideo ? 'video-outline' : 'microphone-outline'}
                  size={28}
                  color={Colors.primary}
                />
              </View>
              <View style={styles.scheduleBody}>
                <View style={styles.scheduleDateRow}>
                  <Feather name="calendar" size={14} color={Colors.textSecondary} />
                  <Text style={styles.scheduleDateText} numberOfLines={1}>
                    {formatScheduledLong(detail.scheduledAt)}
                  </Text>
                </View>
                {recurrenceLabel ? (
                  <Text style={styles.recurrenceText}>{recurrenceLabel}</Text>
                ) : null}
                {detail.description ? (
                  <Text style={styles.descriptionText} numberOfLines={3}>{detail.description}</Text>
                ) : null}
                <View style={styles.accessRow}>
                  <Text style={styles.accessLabel}>{formatAccessLabel(detail.accessMode)}</Text>
                  <Text style={styles.accessDot}>·</Text>
                  <Text style={styles.statusLabel}>{formatStatusLabel(detail.status)}</Text>
                </View>
              </View>
            </View>

            {/* Invite Code card */}
            <View style={styles.inviteCard} testID="conf-info-invite-card">
              <Text style={styles.cardSectionTitle}>Invite Code</Text>
              <View style={styles.inviteRow}>
                <View style={styles.inviteCodePill}>
                  <Text style={styles.inviteCodeText} selectable testID="conf-info-invite-code">
                    {detail.inviteCode}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={handleCopyCode}
                  style={styles.inviteActionBtn}
                  testID="conf-info-copy-btn"
                  activeOpacity={0.7}
                >
                  {copied ? (
                    <Feather name="check" size={20} color={Colors.success} />
                  ) : (
                    <Feather name="copy" size={20} color={Colors.textPrimary} />
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleShareCode}
                  style={styles.inviteActionBtn}
                  testID="conf-info-share-btn"
                  activeOpacity={0.7}
                >
                  <Feather name="share-2" size={20} color={Colors.textPrimary} />
                </TouchableOpacity>
              </View>
              <Text style={styles.inviteHelper}>Share this code to invite participants</Text>
            </View>

            {/* Participants section title */}
            <View style={styles.participantsCardHeader}>
              <Ionicons name="people-outline" size={18} color={Colors.textSecondary} />
              <Text style={styles.cardSectionTitle}>Participants ({participants.length})</Text>
            </View>
          </>
        }
        renderItem={({ item }) => {
          const role = normalizeRole(item.role);
          const cfg = getRoleConfig(role);
          const isWaiting = item.status === 'waiting' || item.status === 'invited';
          const isSuspended = item.status === 'suspended';
          return (
            <View style={styles.participantRow} testID={`conf-info-participant-${item.userId}`}>
              <View style={styles.participantAvatar}>
                <Text style={styles.participantAvatarText}>
                  {getDisplayInitials(item.userName || 'U', 1)}
                </Text>
              </View>
              <View style={styles.participantNameWrap}>
                <Text
                  style={[styles.participantName, isSuspended ? { color: Colors.textMuted } : null]}
                  numberOfLines={1}
                >
                  {(item.userName || 'Unknown').toUpperCase()}
                </Text>
                {isWaiting ? (
                  <Text style={styles.participantStatus}>In waiting room</Text>
                ) : isSuspended ? (
                  <Text style={[styles.participantStatus, { color: Colors.danger }]}>Suspended</Text>
                ) : null}
              </View>
              <View style={[styles.participantRolePill, { backgroundColor: cfg.bg }]}>
                <Text style={[styles.participantRoleText, { color: cfg.fg }]}>{cfg.label}</Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyParticipants}>
            <Text style={styles.emptyParticipantsText}>No participants yet.</Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.footerButtons}>
            <TouchableOpacity
              style={styles.enterRoomBtn}
              onPress={handleEnterRoom}
              activeOpacity={0.85}
              testID="conf-info-enter-room-btn"
            >
              <Text style={styles.enterRoomBtnText}>Enter Conference Room</Text>
            </TouchableOpacity>
            {showDelete ? (
              <TouchableOpacity
                style={[styles.deleteBtn, deleting ? styles.deleteBtnDisabled : null]}
                onPress={handleDeleteConference}
                activeOpacity={0.85}
                disabled={deleting}
                testID="conf-info-delete-btn"
              >
                {deleting ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <>
                    <Feather name="trash-2" size={18} color={Colors.white} />
                    <Text style={styles.deleteBtnText}>Delete Conference</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    minHeight: 56,
    backgroundColor: Colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderLight,
  },
  headerBackBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTextWrap: { flex: 1 },
  headerTitle: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  headerSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },

  /* Scroll content */
  scrollContent: {
    padding: Spacing.base,
    paddingBottom: Spacing.xl,
    gap: Spacing.md,
  },

  /* Schedule card */
  scheduleCard: {
    flexDirection: 'row',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    ...Shadow.sm,
  },
  scheduleIconWrap: {
    width: 52,
    height: 52,
    borderRadius: Radius.md,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scheduleBody: { flex: 1, gap: 4 },
  scheduleDateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scheduleDateText: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  recurrenceText: {
    fontSize: FontSize.sm,
    color: '#2563EB',
    fontWeight: FontWeight.semibold,
  },
  descriptionText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
    marginTop: 4,
  },
  accessRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  accessLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  accessDot: { fontSize: FontSize.sm, color: Colors.textMuted },
  statusLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },

  /* Invite Code card */
  inviteCard: {
    padding: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    gap: Spacing.sm,
    ...Shadow.sm,
  },
  cardSectionTitle: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.bold,
  },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  inviteCodePill: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.md,
    backgroundColor: '#EFE9DC',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.md,
  },
  inviteCodeText: {
    fontSize: 20,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    letterSpacing: 3,
    fontVariant: ['tabular-nums'],
    ...(Platform.OS === 'ios'
      ? { fontFamily: 'Menlo' }
      : Platform.OS === 'android'
        ? { fontFamily: 'monospace' }
        : {}),
  },
  inviteActionBtn: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: '#EFE9DC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteHelper: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  /* Participants */
  participantsCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.xs,
    paddingTop: Spacing.sm,
  },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    marginTop: Spacing.xs,
    minHeight: 56,
  },
  participantAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  participantAvatarText: { color: '#92400E', fontWeight: FontWeight.bold, fontSize: 16 },
  participantNameWrap: { flex: 1 },
  participantName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
  },
  participantStatus: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  participantRolePill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radius.pill,
    minHeight: 26,
    justifyContent: 'center',
  },
  participantRoleText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  emptyParticipants: {
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  emptyParticipantsText: { color: Colors.textMuted, fontSize: FontSize.sm },

  /* Footer buttons */
  footerButtons: { marginTop: Spacing.lg, gap: Spacing.sm },
  enterRoomBtn: {
    minHeight: 52,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  enterRoomBtnText: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.headerBg,
  },
  deleteBtn: {
    minHeight: 52,
    borderRadius: Radius.md,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  deleteBtnDisabled: { opacity: 0.6 },
  deleteBtnText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.white },

  /* Loading / Error */
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.lg },
  errorTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  errorBody: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  errorPrimaryBtn: {
    marginTop: Spacing.md,
    minHeight: 48,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorPrimaryBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.headerBg },
});
