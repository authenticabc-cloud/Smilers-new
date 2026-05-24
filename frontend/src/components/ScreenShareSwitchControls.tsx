/**
 * ScreenShareSwitchControls — UI for requesting/approving a screen-share role
 * swap during an active session.
 *
 * Two contexts (both wired):
 *   • Viewer side:  shows a "Request to share my screen" button.
 *   • Sharer side:  watches for a pending switch request and renders an
 *     accept/decline modal when one arrives.
 *
 * Backend (all safe-fallback so the UI never dead-ends if the endpoints
 * aren't deployed yet — see CONVEX_BACKEND_INSTRUCTIONS_SCREEN_SHARE_SWITCH.md):
 *   • api.screenSharing.requestSwitch({ sessionId })
 *   • api.screenSharing.approveSwitch({ sessionId })
 *   • api.screenSharing.declineSwitch({ sessionId })
 *   • api.screenSharing.getActiveSession({ conversationId }) returning
 *     { ..., pendingSwitchRequestBy?: Id<"users">, pendingSwitchRequesterName?: string }
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../convexApi';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../theme';

interface ScreenShareSwitchControlsProps {
  sessionId: string | null | undefined;
  conversationId?: string | null;
  /** 'viewer' = currently watching, 'sharer' = currently broadcasting */
  role: 'viewer' | 'sharer';
  /** Optional inline style override (button placement). */
  buttonStyle?: any;
}

function isMissingFunction(message: string): boolean {
  return (
    message.includes('CouldNotFindFunction') ||
    message.toLowerCase().includes('not found') ||
    message.toLowerCase().includes('no function')
  );
}

export default function ScreenShareSwitchControls({
  sessionId,
  conversationId,
  role,
  buttonStyle,
}: ScreenShareSwitchControlsProps) {
  const requestSwitchM = useMutation((api as any).screenSharing?.requestSwitch);
  const approveSwitchM = useMutation((api as any).screenSharing?.approveSwitch);
  const declineSwitchM = useMutation((api as any).screenSharing?.declineSwitch);

  // Pending switch detection for the sharer — relies on getActiveSession
  // returning `pendingSwitchRequestBy` reactively.
  const { data: activeSession } = useSafeConvexQuery<any>(
    (api as any).screenSharing?.getActiveSession,
    conversationId ? { conversationId } : 'skip',
    null,
    role === 'sharer' && !!conversationId,
  );

  const pendingRequesterName = useMemo<string | null>(() => {
    if (role !== 'sharer') return null;
    if (!activeSession?.pendingSwitchRequestBy) return null;
    return (
      activeSession?.pendingSwitchRequesterName ||
      activeSession?.pendingSwitchRequester?.name ||
      activeSession?.pendingSwitchRequester?.displayName ||
      'Someone'
    );
  }, [activeSession, role]);

  const [outboundBusy, setOutboundBusy] = useState(false);
  const [outboundSent, setOutboundSent] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState<'approve' | 'decline' | null>(null);

  // Reset the "already requested" badge if the session reverts (e.g. sharer declined).
  useEffect(() => {
    if (role === 'viewer' && !activeSession?.pendingSwitchRequestBy) {
      setOutboundSent(false);
    }
  }, [activeSession, role]);

  /* ── Viewer flow ── */
  const handleRequestSwitch = useCallback(() => {
    if (!sessionId) {
      Alert.alert('Switch request unavailable', 'No active session found.');
      return;
    }
    Alert.alert(
      'Request to share?',
      'Ask the current sharer to hand control over so you can broadcast your screen instead.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send request',
          onPress: async () => {
            setOutboundBusy(true);
            try {
              await requestSwitchM({ sessionId });
              setOutboundSent(true);
              Alert.alert('Request sent', 'Waiting for the sharer to accept your request.');
            } catch (errorValue: any) {
              const message = String(errorValue?.message || errorValue || '');
              Alert.alert(
                'Could not send request',
                isMissingFunction(message)
                  ? 'The backend hasn\u2019t deployed the switch-share mutations yet. Once shipped, this button will hand off control to you in one tap.'
                  : message.slice(0, 160) || 'Please try again.',
              );
            } finally {
              setOutboundBusy(false);
            }
          },
        },
      ],
    );
  }, [requestSwitchM, sessionId]);

  /* ── Sharer flow ── */
  const handleApprove = useCallback(async () => {
    if (!sessionId) return;
    setDecisionBusy('approve');
    try {
      await approveSwitchM({ sessionId });
    } catch (errorValue: any) {
      const message = String(errorValue?.message || errorValue || '');
      Alert.alert(
        'Could not approve switch',
        isMissingFunction(message)
          ? 'The backend hasn\u2019t deployed `approveSwitch` yet.'
          : message.slice(0, 160) || 'Please try again.',
      );
    } finally {
      setDecisionBusy(null);
    }
  }, [approveSwitchM, sessionId]);

  const handleDecline = useCallback(async () => {
    if (!sessionId) return;
    setDecisionBusy('decline');
    try {
      await declineSwitchM({ sessionId });
    } catch (errorValue: any) {
      const message = String(errorValue?.message || errorValue || '');
      Alert.alert(
        'Could not decline switch',
        isMissingFunction(message)
          ? 'The backend hasn\u2019t deployed `declineSwitch` yet.'
          : message.slice(0, 160) || 'Please try again.',
      );
    } finally {
      setDecisionBusy(null);
    }
  }, [declineSwitchM, sessionId]);

  /* ── Viewer button ── */
  if (role === 'viewer') {
    if (!sessionId) return null;
    return (
      <TouchableOpacity
        style={[styles.viewerBtn, outboundSent ? styles.viewerBtnSent : null, buttonStyle]}
        onPress={handleRequestSwitch}
        disabled={outboundBusy || outboundSent}
        activeOpacity={0.85}
        testID="screen-share-request-switch-btn"
      >
        {outboundBusy ? (
          <ActivityIndicator size="small" color={Colors.white} />
        ) : (
          <>
            <MaterialCommunityIcons
              name={outboundSent ? 'clock-outline' : 'swap-horizontal'}
              size={20}
              color={Colors.white}
            />
            <Text style={styles.viewerBtnText}>
              {outboundSent ? 'Request sent — waiting' : 'Request to share my screen'}
            </Text>
          </>
        )}
      </TouchableOpacity>
    );
  }

  /* ── Sharer modal ── */
  return (
    <Modal
      visible={!!pendingRequesterName}
      transparent
      animationType="fade"
      onRequestClose={handleDecline}
    >
      <Pressable style={styles.modalBackdrop} onPress={handleDecline}>
        <Pressable style={styles.modalCard} onPress={() => {}} testID="screen-share-switch-modal">
          <View style={styles.modalIconWrap}>
            <MaterialCommunityIcons name="swap-horizontal-bold" size={36} color={Colors.primary} />
          </View>
          <Text style={styles.modalTitle}>Hand over screen sharing?</Text>
          <Text style={styles.modalBody}>
            <Text style={styles.modalName}>{pendingRequesterName}</Text> is asking to share their screen instead of yours.
            If you accept, your broadcast will stop and theirs will start.
          </Text>

          <View style={styles.modalActionsRow}>
            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnDecline, decisionBusy ? { opacity: 0.6 } : null]}
              onPress={handleDecline}
              disabled={!!decisionBusy}
              activeOpacity={0.85}
              testID="screen-share-switch-decline"
            >
              {decisionBusy === 'decline' ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <>
                  <Feather name="x" size={18} color={Colors.white} />
                  <Text style={styles.modalBtnText}>Keep sharing</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnApprove, decisionBusy ? { opacity: 0.6 } : null]}
              onPress={handleApprove}
              disabled={!!decisionBusy}
              activeOpacity={0.85}
              testID="screen-share-switch-approve"
            >
              {decisionBusy === 'approve' ? (
                <ActivityIndicator size="small" color={Colors.headerBg} />
              ) : (
                <>
                  <Feather name="check" size={18} color={Colors.headerBg} />
                  <Text style={[styles.modalBtnText, { color: Colors.headerBg }]}>Hand over</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /* Viewer button */
  viewerBtn: {
    minHeight: 48,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(15,23,42,0.85)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: Spacing.sm,
  },
  viewerBtnSent: { backgroundColor: 'rgba(15,23,42,0.5)', borderColor: 'rgba(255,255,255,0.15)' },
  viewerBtnText: {
    color: Colors.white,
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.2,
  },

  /* Sharer modal */
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: Colors.surface,
    borderRadius: 22,
    padding: Spacing.lg,
    alignItems: 'center',
    ...Shadow.lg,
  },
  modalIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  modalTitle: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: 8,
  },
  modalBody: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.lg,
  },
  modalName: { color: Colors.textPrimary, fontWeight: FontWeight.bold },
  modalActionsRow: { flexDirection: 'row', gap: Spacing.sm, width: '100%' },
  modalBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: Radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  modalBtnDecline: { backgroundColor: Colors.danger },
  modalBtnApprove: { backgroundColor: Colors.primary },
  modalBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.white, letterSpacing: 0.2 },
});
