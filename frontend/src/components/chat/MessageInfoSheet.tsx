/**
 * MessageInfoSheet — WhatsApp-style "Message Info" bottom sheet.
 *
 * Shows, for one of the user's own outgoing messages:
 *   • Sent / Delivered / Read timestamps
 *   • "Read by X of Y" (BLUE) with the list of recipients who have read it
 *   • For MEDIA messages, a SEPARATE consumption row (PURPLE):
 *       "Played / Watched / Viewed / Opened by X of Y" with the recipient list
 *
 * The consumption data comes from the backend `messages.getMessageReadInfo`
 * query (extended by the web team) which returns `isMedia`, `consumptionVerb`,
 * `consumedByUsers`, `consumedCount`, `allConsumed`. The sheet degrades
 * gracefully (falls back to local `message.readBy`) if the backend hasn't
 * deployed the extended fields yet, so it never blocks on the web team.
 */
import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeConvexQuery } from '../../hooks/useSafeConvexQuery';
import { api } from '../../convexApi';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../theme';

type AnyUser = { _id?: string; name?: string; displayName?: string; fullName?: string };

interface Props {
  visible: boolean;
  message: any | null;
  recipientCount?: number;
  onClose: () => void;
}

const CONSUME_PURPLE = '#8B5CF6';

function fmt(value: any): string | null {
  if (value == null || value === '') return null;
  let ms: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) ms = value;
  else if (typeof value === 'string') {
    const p = Date.parse(value);
    if (Number.isFinite(p)) ms = p;
  } else if (value instanceof Date) ms = value.getTime();
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString();
}

function nameOf(u: AnyUser): string {
  return u?.name || u?.displayName || u?.fullName || 'Someone';
}

function mediaLabel(type?: string): string {
  switch (type) {
    case 'voice':
      return 'Voice message';
    case 'audio':
      return 'Audio';
    case 'video':
      return 'Video';
    case 'image':
      return 'Photo';
    case 'file':
    case 'document':
      return 'Document';
    default:
      return 'Message';
  }
}

export default function MessageInfoSheet({ visible, message, recipientCount, onClose }: Props) {
  const messageId = message?._id;
  const { data: info } = useSafeConvexQuery<any>(
    (api as any).messages?.getMessageReadInfo,
    messageId ? { messageId } : null,
    null,
    visible && !!messageId,
  );

  const sentAt = fmt(message?._creationTime) || fmt(message?.createdAt) || fmt(message?.sentAt);
  const deliveredAt = fmt(message?.deliveredAt) || fmt(info?.deliveredAt);
  const readAt = fmt(message?.readAt) || fmt(info?.readAt);
  const editedAt = fmt(message?.editedAt);

  // --- READ row (blue) ---------------------------------------------------
  const readUsers: AnyUser[] = useMemo(() => {
    if (Array.isArray(info?.readByUsers)) return info.readByUsers;
    if (Array.isArray(info?.readBy) && typeof info.readBy[0] === 'object') return info.readBy;
    return [];
  }, [info]);
  const readCount =
    typeof info?.readCount === 'number'
      ? info.readCount
      : readUsers.length || (Array.isArray(message?.readBy) ? message.readBy.length : 0);
  const total =
    typeof info?.totalRecipients === 'number'
      ? info.totalRecipients
      : typeof info?.total === 'number'
        ? info.total
        : typeof recipientCount === 'number'
          ? recipientCount
          : null;

  // --- CONSUMPTION row (purple) -----------------------------------------
  const isMedia = !!info?.isMedia;
  const verb: string = info?.consumptionVerb || 'Opened';
  const consumedUsers: AnyUser[] = Array.isArray(info?.consumedByUsers) ? info.consumedByUsers : [];
  const consumedCount =
    typeof info?.consumedCount === 'number' ? info.consumedCount : consumedUsers.length;

  const readSubtitle = total != null ? `Read by ${readCount} of ${total}` : `Read by ${readCount}`;
  const consumeSubtitle =
    total != null ? `${verb} by ${consumedCount} of ${total}` : `${verb} by ${consumedCount}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title}>Message Info</Text>
          <Text style={styles.mediaType}>{mediaLabel(message?.type)}</Text>

          <ScrollView style={styles.scroll} bounces={false}>
            {/* Timestamps */}
            <View style={styles.tsBlock}>
              {sentAt ? <InfoRow label="Sent" value={sentAt} /> : null}
              {deliveredAt ? <InfoRow label="Delivered" value={deliveredAt} /> : null}
              {readAt ? <InfoRow label="Read" value={readAt} /> : null}
              {editedAt ? <InfoRow label="Edited" value={editedAt} /> : null}
            </View>

            {/* Read by (blue) */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <View style={[styles.dot, { backgroundColor: Colors.tickBlue }]} />
                <Text style={styles.sectionTitle}>{readSubtitle}</Text>
              </View>
              {readUsers.length > 0 ? (
                readUsers.map((u, i) => (
                  <Text key={u?._id || i} style={styles.personRow} numberOfLines={1}>
                    {nameOf(u)}
                  </Text>
                ))
              ) : (
                <Text style={styles.emptyRow}>No one has read this message yet</Text>
              )}
            </View>

            {/* Consumption (purple) — only for media */}
            {isMedia ? (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View style={[styles.dot, { backgroundColor: CONSUME_PURPLE }]} />
                  <Text style={styles.sectionTitle}>{consumeSubtitle}</Text>
                </View>
                {consumedUsers.length > 0 ? (
                  consumedUsers.map((u, i) => (
                    <Text key={u?._id || i} style={styles.personRow} numberOfLines={1}>
                      {nameOf(u)}
                    </Text>
                  ))
                ) : (
                  <Text style={styles.emptyRow}>{`Not ${verb.toLowerCase()} by anyone yet`}</Text>
                )}
              </View>
            ) : null}
          </ScrollView>

          <Pressable style={styles.closeBtn} onPress={onClose} testID="message-info-close">
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xl,
    maxHeight: '80%',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    marginBottom: Spacing.md,
  },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold as any, color: Colors.textPrimary },
  mediaType: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, marginBottom: Spacing.md },
  scroll: { flexGrow: 0 },
  tsBlock: { marginBottom: Spacing.md },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  infoLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  infoValue: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium as any },
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    paddingTop: Spacing.md,
    marginTop: Spacing.sm,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: Spacing.sm },
  sectionTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold as any, color: Colors.textPrimary },
  personRow: { fontSize: FontSize.sm, color: Colors.textPrimary, paddingVertical: 3, paddingLeft: 18 },
  emptyRow: { fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic', paddingLeft: 18 },
  closeBtn: {
    marginTop: Spacing.lg,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  closeText: { fontSize: FontSize.base, fontWeight: FontWeight.bold as any, color: Colors.white },
});
