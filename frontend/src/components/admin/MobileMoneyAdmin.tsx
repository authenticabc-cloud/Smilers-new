/**
 * MobileMoneyAdmin — admin surface for manual mobile-money payment requests.
 * Pending / History toggle, per-request Message / Complete / Decline actions.
 * Wires the canonical mobileMoneyRequests contract; server auto-activates the
 * plan on completeRequest.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convexApi';
import { Colors, FontSize, FontWeight, Spacing, Radius } from '../../theme';
import { formatLocalAmount } from '../../lib/mobileMoney';
import { friendlyConvexError } from '../../lib/friendlyError';

function formatDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    pending: { bg: '#FFF4E5', fg: '#B26A00', label: 'Pending' },
    completed: { bg: '#E7F6EC', fg: '#1B7F3B', label: 'Completed' },
    declined: { bg: '#FDECEC', fg: Colors.danger, label: 'Declined' },
    cancelled: { bg: '#EEE', fg: Colors.textSecondary, label: 'Cancelled' },
  };
  const s = map[status] || map.cancelled;
  return (
    <View style={[styles.pill, { backgroundColor: s.bg }]}>
      <Text style={[styles.pillText, { color: s.fg }]}>{s.label}</Text>
    </View>
  );
}

function RequestCard({
  req,
  onMessage,
  onComplete,
  onDecline,
  busy,
}: {
  req: any;
  onMessage: (req: any) => void;
  onComplete: (req: any) => void;
  onDecline: (req: any) => void;
  busy: boolean;
}) {
  const isPending = req.status === 'pending';
  return (
    <View style={styles.card} testID={`mm-request-${String(req._id).slice(-6)}`}>
      <View style={styles.cardHeader}>
        {req.userAvatar ? (
          <Image source={{ uri: req.userAvatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarInitial}>{(req.userName || '?').charAt(0).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.flexOne}>
          <Text style={styles.userName} numberOfLines={1}>{req.userName || 'Unknown user'}</Text>
          {req.userEmail ? <Text style={styles.userEmail} numberOfLines={1}>{req.userEmail}</Text> : null}
        </View>
        <StatusPill status={req.status} />
      </View>

      <View style={styles.detailRow}>
        <Text style={styles.planLabel}>{req.planLabel || req.variantId}</Text>
        <Text style={styles.amount}>{formatLocalAmount(req.amount, req.currency)}</Text>
      </View>
      <View style={styles.detailRow}>
        <Text style={styles.subMeta}>{req.country} · ≈ €{req.eurAmount}</Text>
        {req.phone ? <Text style={styles.subMeta}>Pays from: {req.phone}</Text> : null}
      </View>
      <Text style={styles.dateText}>
        {isPending ? 'Requested ' : req.status === 'completed' ? 'Completed ' : 'Closed '}
        {formatDate(isPending ? req.createdAt : req.completedAt || req.createdAt)}
      </Text>

      {isPending ? (
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.messageBtn]}
            onPress={() => onMessage(req)}
            disabled={busy}
            testID={`mm-message-${String(req._id).slice(-6)}`}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={Colors.primary} />
            <Text style={styles.messageBtnText}>Message</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.declineBtn]}
            onPress={() => onDecline(req)}
            disabled={busy}
            testID={`mm-decline-${String(req._id).slice(-6)}`}
          >
            <Ionicons name="close" size={16} color={Colors.danger} />
            <Text style={styles.declineBtnText}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.completeBtn]}
            onPress={() => onComplete(req)}
            disabled={busy}
            testID={`mm-complete-${String(req._id).slice(-6)}`}
          >
            <Ionicons name="checkmark" size={16} color={Colors.white} />
            <Text style={styles.completeBtnText}>Complete</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

export function MobileMoneyAdmin() {
  const [view, setView] = useState<'pending' | 'history'>('pending');
  const [busy, setBusy] = useState(false);
  const [msgTarget, setMsgTarget] = useState<any | null>(null);
  const [msgText, setMsgText] = useState('');
  const [sending, setSending] = useState(false);

  const pending = useQuery((api as any).mobileMoneyRequests?.listPendingRequests, {}) as any[] | undefined;
  const history = useQuery((api as any).mobileMoneyRequests?.listRequestHistory, {}) as any[] | undefined;
  const completeRequest = useMutation((api as any).mobileMoneyRequests?.completeRequest);
  const declineRequest = useMutation((api as any).mobileMoneyRequests?.declineRequest);
  const messageUsers = useMutation((api as any).admin?.messaging?.messageUsers);

  const list = view === 'pending' ? pending : history;
  const loading = list === undefined;

  const openMessage = (req: any) => {
    setMsgTarget(req);
    setMsgText(
      `Hi ${req.userName || ''}, to complete your ${req.planLabel} plan payment of ${formatLocalAmount(req.amount, req.currency)}, please send mobile money to: `,
    );
  };

  const sendMessage = async () => {
    if (!msgTarget || !msgText.trim()) return;
    setSending(true);
    try {
      await messageUsers({ userIds: [msgTarget.userId], text: msgText.trim() });
      setMsgTarget(null);
      setMsgText('');
      Alert.alert('Message sent', 'Payment instructions were sent to the user.');
    } catch (e: any) {
      Alert.alert('Could not send', friendlyConvexError(e, 'Please try again.'));
    } finally {
      setSending(false);
    }
  };

  const doComplete = (req: any) => {
    Alert.alert(
      'Complete request?',
      `This will close the request and automatically activate ${req.planLabel} for ${req.userName || 'the user'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Complete',
          onPress: async () => {
            setBusy(true);
            try {
              await completeRequest({ requestId: req._id });
            } catch (e: any) {
              Alert.alert('Could not complete', friendlyConvexError(e, 'Please try again.'));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const doDecline = (req: any) => {
    Alert.alert(
      'Decline request?',
      `This rejects the request without granting ${req.planLabel}. The user can submit a new request.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await declineRequest({ requestId: req._id });
            } catch (e: any) {
              Alert.alert('Could not decline', friendlyConvexError(e, 'Please try again.'));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const pendingCount = Array.isArray(pending) ? pending.length : 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.toggle}>
        <TouchableOpacity
          style={[styles.toggleBtn, view === 'pending' ? styles.toggleBtnActive : null]}
          onPress={() => setView('pending')}
          testID="mm-toggle-pending"
        >
          <Text style={[styles.toggleText, view === 'pending' ? styles.toggleTextActive : null]}>
            Pending{pendingCount ? ` (${pendingCount})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, view === 'history' ? styles.toggleBtnActive : null]}
          onPress={() => setView('history')}
          testID="mm-toggle-history"
        >
          <Text style={[styles.toggleText, view === 'history' ? styles.toggleTextActive : null]}>History</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={Colors.primary} style={{ marginTop: 32 }} />
      ) : !list || list.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="cash-outline" size={40} color={Colors.textMuted} />
          <Text style={styles.emptyText}>
            {view === 'pending' ? 'No pending payment requests.' : 'No past requests yet.'}
          </Text>
        </View>
      ) : (
        list.map((req: any) => (
          <RequestCard
            key={String(req._id)}
            req={req}
            busy={busy}
            onMessage={openMessage}
            onComplete={doComplete}
            onDecline={doDecline}
          />
        ))
      )}

      {/* Message-user composer */}
      <Modal visible={!!msgTarget} transparent animationType="fade" onRequestClose={() => setMsgTarget(null)}>
        <Pressable style={styles.backdrop} onPress={() => setMsgTarget(null)}>
          <Pressable style={styles.msgSheet} onPress={() => {}}>
            <Text style={styles.msgTitle}>Message {msgTarget?.userName || 'user'}</Text>
            <TextInput
              style={styles.msgInput}
              value={msgText}
              onChangeText={setMsgText}
              multiline
              placeholder="Type payment instructions…"
              placeholderTextColor={Colors.textMuted}
              testID="mm-message-input"
            />
            <View style={styles.msgActions}>
              <TouchableOpacity style={styles.msgCancel} onPress={() => setMsgTarget(null)}>
                <Text style={styles.msgCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.msgSend, (!msgText.trim() || sending) ? styles.msgSendDisabled : null]}
                onPress={sendMessage}
                disabled={!msgText.trim() || sending}
                testID="mm-message-send"
              >
                {sending ? (
                  <ActivityIndicator color={Colors.white} size="small" />
                ) : (
                  <Text style={styles.msgSendText}>Send</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: Spacing.md },
  flexOne: { flex: 1 },
  toggle: { flexDirection: 'row', backgroundColor: '#EDEDED', borderRadius: Radius.md, padding: 4, marginBottom: Spacing.md },
  toggleBtn: { flex: 1, paddingVertical: 8, borderRadius: Radius.sm, alignItems: 'center' },
  toggleBtnActive: { backgroundColor: Colors.white },
  toggleText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textSecondary },
  toggleTextActive: { color: Colors.primary },
  empty: { alignItems: 'center', paddingVertical: 48, gap: 10 },
  emptyText: { fontSize: FontSize.base, color: Colors.textMuted },
  card: {
    backgroundColor: Colors.white,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#EDEDED' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { fontSize: 18, fontWeight: FontWeight.bold, color: Colors.textSecondary },
  userName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  userEmail: { fontSize: FontSize.xs, color: Colors.textMuted },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  planLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  amount: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primary },
  subMeta: { fontSize: FontSize.xs, color: Colors.textSecondary },
  dateText: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 6 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, borderRadius: Radius.sm },
  messageBtn: { flex: 1, borderWidth: 1, borderColor: Colors.primary },
  messageBtnText: { color: Colors.primary, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
  declineBtn: { flex: 1, borderWidth: 1, borderColor: Colors.danger },
  declineBtnText: { color: Colors.danger, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
  completeBtn: { flex: 1, backgroundColor: Colors.primary },
  completeBtnText: { color: Colors.white, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
  msgSheet: { backgroundColor: Colors.white, borderRadius: Radius.md, padding: Spacing.lg },
  msgTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginBottom: 12 },
  msgInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.sm,
    padding: 12,
    minHeight: 96,
    textAlignVertical: 'top',
    color: Colors.textPrimary,
    fontSize: FontSize.base,
  },
  msgActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  msgCancel: { paddingVertical: 10, paddingHorizontal: 16 },
  msgCancelText: { color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  msgSend: { backgroundColor: Colors.primary, paddingVertical: 10, paddingHorizontal: 22, borderRadius: Radius.sm, minWidth: 84, alignItems: 'center' },
  msgSendDisabled: { opacity: 0.5 },
  msgSendText: { color: Colors.white, fontWeight: FontWeight.bold },
});
