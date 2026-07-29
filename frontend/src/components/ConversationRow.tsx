/**
 * ConversationRow — a single direct-chat/group row in the Chats list.
 * Extracted from app/(tabs)/chats.tsx to keep that screen maintainable.
 * Resolves the display name (device contact > saved contact > Smilers name),
 * the avatar, live "typing…" state, and unread emphasis (bold name, red pill).
 */
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Avatar from './Avatar';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import {
  findSavedContactDisplayName,
  getConversationDisplayName,
  getResolvedConversationDisplayName,
  getResolvedDisplayName,
  getSavedContactRecord,
} from '../lib/displayName';
import { useDeviceContactIndex, lookupDeviceContactName } from '../lib/deviceContactIndex';
import { formatSystemMessage } from '../lib/chat/systemMessage';
import { cacheConversationName, cacheUserName } from '../push/notificationNameCache';
import { type DraftPreview } from '../lib/chatDrafts';
import { api } from '../convexApi';
import { Colors, FontSize, FontWeight, Spacing } from '../theme';

function relTime(iso?: string) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`;
    return `${Math.floor(diff / 86_400_000)}d`;
  } catch {
    return '';
  }
}

export function peerIsOnline(item: any): boolean {
  // DM-only presence (mirrors the web chat list — no dot on groups).
  const isGroup =
    item?.isGroup ||
    item?.type === 'group' ||
    (Array.isArray(item?.participants) && item.participants.length > 2);
  if (isGroup) return false;
  const peer = item?.otherUser || item?.otherParticipant || item;
  if (peer?.isOnline !== true && peer?.online !== true) return false;
  const ls = peer?.lastSeen ?? item?.lastSeen;
  const t = typeof ls === 'number' ? ls : typeof ls === 'string' ? new Date(ls).getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= 120000; // online if seen within 2 min
}

export function formatTypingLabel(rowTypingRaw: any[], currentUserId?: string): string | null {
  const list = Array.isArray(rowTypingRaw) ? rowTypingRaw : [];
  const others = list.filter((u: any) => {
    const uid = u?.userId || u?._id || u?.id;
    return !uid || !currentUserId || String(uid) !== String(currentUserId);
  });
  if (others.length === 0) return null;
  const names = others.map((u: any) => u?.name || u?.userName || u?.displayName || 'Someone');
  return names.length === 1 ? `${names[0]} is typing\u2026` : `${names.join(', ')} are typing\u2026`;
}

type Props = {
  item: any;
  currentUserId?: string;
  contacts?: any[];
  draft?: DraftPreview;
  unreadCount?: number;
  /** iter-404: show a muted-bell indicator when this conversation is muted. */
  muted?: boolean;
  onPress: () => void;
  /** When true, typing state comes from `typingLabel` (a single list-level
   * query) instead of this row opening its own Convex subscription. */
  typingFromParent?: boolean;
  typingLabel?: string | null;
};

export default function ConversationRow({
  item,
  currentUserId,
  contacts,
  draft,
  unreadCount = 0,
  muted = false,
  onPress,
  typingFromParent = false,
  typingLabel: typingLabelProp = null,
}: Props) {
  const deviceIndex = useDeviceContactIndex();
  const deviceName = getResolvedConversationDisplayName(
    item,
    currentUserId,
    deviceIndex,
    lookupDeviceContactName,
    '',
  );
  const savedContactName = deviceName || findSavedContactDisplayName(contacts, item, currentUserId);
  const name = savedContactName || getConversationDisplayName(item, currentUserId, 'Smilers user');

  // Persist the resolved 1:1 name so background push notifications can show
  // the DEVICE-CONTACT name instead of the sender's Google/account name.
  const isGroupConversation =
    item?.isGroup ||
    item?.type === 'group' ||
    (Array.isArray(item?.participants) && item.participants.length > 2);
  useEffect(() => {
    if (!isGroupConversation && item?._id && name) {
      cacheConversationName(String(item._id), name);
      const otherUserId = item?.otherUserId || item?.otherParticipant?._id || item?.otherUser?._id;
      if (otherUserId) cacheUserName(String(otherUserId), name);
    }
  }, [isGroupConversation, item?._id, name]);
  const otherUserPhoto =
    item?.avatar ||
    item?.avatarUrl ||
    item?.photo ||
    item?.profilePicture ||
    item?.otherUser?.profilePicture ||
    item?.otherUser?.avatar ||
    item?.otherParticipant?.profilePicture ||
    item?.otherParticipant?.avatar;
  const contactRecord = (contacts || []).find((c: any) => {
    const ids = [c?.userId, c?.user?._id, c?._id, c?.contactUserId].filter(Boolean);
    return (
      (item?.otherUserId && ids.includes(item.otherUserId)) ||
      (item?.otherParticipant?._id && ids.includes(item.otherParticipant._id))
    );
  });
  const photoUri: string | undefined =
    otherUserPhoto ||
    contactRecord?.profilePicture ||
    contactRecord?.user?.profilePicture ||
    contactRecord?.avatar ||
    contactRecord?.user?.avatar;
  // Live "typing…" for this row. When the parent supplies it via a single
  // list-level query (typingFromParent), skip this row's own subscription.
  const { data: rowTypingRaw } = useSafeConvexQuery<any[]>(
    (api as any).typing.getTypingUsers,
    { conversationId: item?._id },
    [],
    !!item?._id && !typingFromParent,
  );
  const typingLabel = useMemo(
    () => (typingFromParent ? typingLabelProp : formatTypingLabel(rowTypingRaw as any[], currentUserId)),
    [typingFromParent, typingLabelProp, rowTypingRaw, currentUserId],
  );
  const hasUnread = unreadCount > 0;
  // Chats-list preview for group system events ("Kojo added Ama", "You left").
  // When the backend exposes the last message's structured system payload on
  // the conversation row (`lastSystem` / `lastMessageType === 'system'`), we
  // format it here with each viewer's device-saved names. Falls back to the
  // backend's plain `lastMessageText` when no structured payload is present.
  const systemPreview = useMemo(() => {
    const sys = item?.lastSystem || item?.lastMessageSystem;
    const isSys = !!sys || item?.lastMessageType === 'system';
    if (!isSys) return '';
    const resolveName = (uid: string): string => {
      const rec = getSavedContactRecord(contacts, { userId: uid });
      if (!rec) return '';
      return (
        getResolvedDisplayName(
          rec,
          deviceIndex,
          lookupDeviceContactName,
          rec.name || rec.displayName || '',
        ) || ''
      );
    };
    return formatSystemMessage(
      { type: 'system', system: sys, senderId: sys?.actorId, text: item?.lastMessageText },
      { myId: currentUserId, resolveName, groupName: name },
    );
  }, [item, contacts, deviceIndex, currentUserId, name]);
  const previewText = systemPreview || item.lastMessageText || 'Start chatting…';
  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.7} testID={`conv-${item._id}`}>
      <Avatar name={name} size={52} uri={photoUri} online={peerIsOnline(item)} />
      <View style={styles.rowMiddle}>
        <Text style={[styles.rowTitle, hasUnread && styles.rowTitleUnread]} numberOfLines={1}>
          {name}
        </Text>
        {typingLabel ? (
          <Text style={[styles.rowSubtitle, styles.rowTyping]} numberOfLines={1}>
            {typingLabel}
          </Text>
        ) : draft ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            <Text style={styles.draftPrefix}>Draft: </Text>
            {draft.text || (draft.hasImages ? '📷 Photo' : '')}
          </Text>
        ) : (
          <Text style={[styles.rowSubtitle, hasUnread && styles.rowSubtitleUnread]} numberOfLines={1}>
            {previewText}
          </Text>
        )}
      </View>
      <View style={styles.rowRightCol}>
        <Text style={[styles.rowTime, hasUnread && styles.rowTimeUnread]}>
          {relTime(item.lastMessageTime)}
        </Text>
        <View style={styles.rowRightBadges}>
          {muted ? (
            <Feather
              name="bell-off"
              size={14}
              color={Colors.textMuted}
              style={styles.mutedBell}
              testID={`conv-muted-${item._id}`}
            />
          ) : null}
          {hasUnread ? (
            <View style={styles.unreadPill} testID={`conv-unread-${item._id}`}>
              <Text style={styles.unreadPillText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: 14,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  rowMiddle: { flex: 1, marginLeft: Spacing.md },
  rowTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  rowTitleUnread: { fontWeight: FontWeight.bold, color: Colors.textPrimary },
  rowSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary },
  rowSubtitleUnread: { color: Colors.textPrimary, fontWeight: FontWeight.medium },
  rowTyping: { color: Colors.primary, fontStyle: 'italic' },
  draftPrefix: { color: Colors.danger, fontWeight: FontWeight.semibold },
  rowRightCol: { marginLeft: Spacing.sm, alignItems: 'flex-end', justifyContent: 'center', gap: 4 },
  rowRightBadges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mutedBell: { opacity: 0.7 },
  rowTime: { fontSize: FontSize.xs, color: Colors.textMuted, marginLeft: Spacing.sm },
  rowTimeUnread: { color: Colors.tickRed, fontWeight: FontWeight.semibold, marginLeft: 0 },
  unreadPill: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: Colors.tickRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadPillText: { fontSize: 11, fontWeight: '700', color: Colors.white },
});
