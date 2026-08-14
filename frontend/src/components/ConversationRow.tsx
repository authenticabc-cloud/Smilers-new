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
import { formatSystemMessage, getSystemPayload } from '../lib/chat/systemMessage';
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
  /** Count of received voice notes the user hasn't played yet (backend-driven). */
  unplayedVoiceCount?: number;
  onPress: () => void;
  /** When true, typing state comes from `typingLabel` (a single list-level
   * query) instead of this row opening its own Convex subscription. */
  typingFromParent?: boolean;
  typingLabel?: string | null;
};

function ConversationRow({
  item,
  currentUserId,
  contacts,
  draft,
  unreadCount = 0,
  muted = false,
  unplayedVoiceCount = 0,
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
    const isSys = !!item?.lastSystemKind || !!item?.lastSystem || item?.lastMessageType === 'system';
    if (!isSys) return { text: '', involvesMe: false };
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
    const payload = getSystemPayload(item);
    const text = formatSystemMessage(item, { myId: currentUserId, resolveName, groupName: name });
    // Emphasise (bold + "You" pill) when the event targets ME and I didn't
    // perform it — e.g. "Kojo added you", "Kojo made you an admin".
    const involvesMe =
      !!currentUserId &&
      !!payload &&
      payload.targetIds.includes(String(currentUserId)) &&
      payload.actorId !== String(currentUserId);
    return { text, involvesMe };
  }, [item, contacts, deviceIndex, currentUserId, name]);
  const previewText = systemPreview.text || item.lastMessageText || 'Start chatting…';
  const emphasisePreview = hasUnread || systemPreview.involvesMe;
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
          <Text style={[styles.rowSubtitle, emphasisePreview && styles.rowSubtitleUnread]} numberOfLines={1}>
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
          {systemPreview.involvesMe ? (
            <View style={styles.youPill} testID={`conv-you-${item._id}`}>
              <Text style={styles.youPillText}>You</Text>
            </View>
          ) : null}
          {unplayedVoiceCount > 0 ? (
            <View style={styles.voicePill} testID={`conv-unplayed-voice-${item._id}`}>
              <Feather name="mic" size={11} color={Colors.white} />
              <Text style={styles.voicePillText}>{unplayedVoiceCount > 99 ? '99+' : unplayedVoiceCount}</Text>
            </View>
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

/**
 * Perf: memoize the row so parent (ChatsScreen) re-renders — which happen
 * frequently (unread counts, local-read overlay, drafts, presence ticks) —
 * don't re-render every mounted row. `onPress` is intentionally IGNORED in the
 * comparison: it's an inline closure recreated on every parent render, but its
 * captured values (router, me._id) are effectively stable, and any item change
 * that would affect navigation (lastMessageTime/id) already forces a re-render.
 */
function rowPropsEqual(prev: Props, next: Props): boolean {
  if (prev.unreadCount !== next.unreadCount) return false;
  if (prev.unplayedVoiceCount !== next.unplayedVoiceCount) return false;
  if (prev.muted !== next.muted) return false;
  if (prev.currentUserId !== next.currentUserId) return false;
  if (prev.contacts !== next.contacts) return false;
  if (prev.typingFromParent !== next.typingFromParent) return false;
  if ((prev.typingLabel || null) !== (next.typingLabel || null)) return false;
  const da = prev.draft;
  const db = next.draft;
  if ((da?.text || '') !== (db?.text || '') || !!da?.hasImages !== !!db?.hasImages) return false;
  const a = prev.item;
  const b = next.item;
  if (a === b) return true;
  if (String(a?._id) !== String(b?._id)) return false;
  if (a?.lastMessageTime !== b?.lastMessageTime) return false;
  if (a?.lastMessageText !== b?.lastMessageText) return false;
  if (a?.lastMessageType !== b?.lastMessageType) return false;
  if (a?.lastSystemKind !== b?.lastSystemKind) return false;
  const pa = a?.otherUser || a?.otherParticipant || a;
  const pb = b?.otherUser || b?.otherParticipant || b;
  if ((pa?.isOnline ?? pa?.online) !== (pb?.isOnline ?? pb?.online)) return false;
  if ((pa?.lastSeen ?? a?.lastSeen) !== (pb?.lastSeen ?? b?.lastSeen)) return false;
  if (
    (a?.avatar || a?.avatarUrl || a?.photo) !== (b?.avatar || b?.avatarUrl || b?.photo)
  )
    return false;
  return true;
}

export default React.memo(ConversationRow, rowPropsEqual);

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
  youPill: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  youPillText: {
    color: Colors.white,
    fontSize: 10,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.2,
  },
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
  voicePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#2f9bff',
    borderRadius: 11,
    paddingHorizontal: 7,
    height: 20,
  },
  voicePillText: { fontSize: 11, fontWeight: '700', color: Colors.white },
});
