import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CallPill } from './CallPill';
import { SwipeToReply } from './SwipeToReply';
import MediaBubble from '../MediaBubble';
import { startCall } from '../../lib/twilio/startCall';
import { formatChatDayChip, isSameCalendarDay } from '../../lib/chatFormat';
import { formatSystemMessage, getSystemPayload } from '../../lib/chat/systemMessage';
import { styles } from './chatScreenStyles';

/**
 * ChatMessageRow — the FlatList row renderer extracted verbatim from
 * ChatScreen. Renders either a call-log pill or a swipe-to-reply message
 * bubble. All values it previously closed over are now explicit props so the
 * behaviour is identical; only the location changed.
 */
export type ChatMessageRowProps = {
  item: any;
  index: number;
  timeline: any[];
  recordingByCallId: Map<string, any>;
  setActiveRecording: (rec: any) => void;
  router: any;
  me: any;
  effectiveMe: any;
  callCalleeId: string | null | undefined;
  conversationId: string | string[] | undefined;
  title: string;
  viewerSuspension: any;
  isBroadcastReadOnly: boolean;
  multiSelectIds: string[] | null;
  isConversationAvailable: boolean;
  setReplyTo: (item: any) => void;
  messageInputRef: React.RefObject<any>;
  msgById: Map<string, any>;
  jumpToMessage: (id: string) => void;
  jumpHighlightId: string | null;
  handleReceiveOnceTombstone: (item: any) => void;
  chatAppearance: any;
  e2eeStatus: any;
  isGroupChat: boolean;
  resolveSenderName: (senderId: string, senderName?: string) => string | undefined;
  onToggleMultiSelect: (id: string) => void;
  flushOutbox: () => void | Promise<void>;
  onLongPressMessage: (item: any) => void;
  searchTermNorm: string;
  activeMatchTimelineIdx: number;
  onToggleMyReaction: (messageId: string, emoji: string) => void;
};

function ChatMessageRowBase({
  item,
  index,
  timeline,
  recordingByCallId,
  setActiveRecording,
  router,
  me,
  effectiveMe,
  callCalleeId,
  conversationId,
  title,
  viewerSuspension,
  isBroadcastReadOnly,
  multiSelectIds,
  isConversationAvailable,
  setReplyTo,
  messageInputRef,
  msgById,
  jumpToMessage,
  jumpHighlightId,
  handleReceiveOnceTombstone,
  chatAppearance,
  e2eeStatus,
  isGroupChat,
  resolveSenderName,
  onToggleMultiSelect,
  flushOutbox,
  onLongPressMessage,
  searchTermNorm,
  activeMatchTimelineIdx,
  onToggleMyReaction,
}: ChatMessageRowProps) {
  const previous = index > 0 ? timeline[index - 1] : null;
  const showDayChip = !previous || !isSameCalendarDay(item?._creationTime, previous?._creationTime);
  // Backend-emitted group system events ("X added Y", "X left", renamed, etc.).
  if (getSystemPayload(item)) {
    const text = formatSystemMessage(item, {
      myId: effectiveMe?._id ? String(effectiveMe._id) : me?._id ? String(me._id) : null,
      resolveName: (id: string) => resolveSenderName(id),
      groupName: title,
    });
    if (!text) return null;
    return (
      <>
        {showDayChip ? (
          <View style={styles.dayChipWrap} testID={`chat-day-chip-${item._id}`}>
            <Text style={styles.dayChipText}>{formatChatDayChip(item?._creationTime)}</Text>
          </View>
        ) : null}
        <View style={styles.systemPillWrap} testID={`chat-system-${item._id}`}>
          <Text style={styles.systemPillText}>{text}</Text>
        </View>
      </>
    );
  }
  // "Group created" system message (WhatsApp-style) — always the first row of
  // a group timeline when the full history is loaded. Shows a centered pill.
  if (item?.__kind === 'groupCreated') {
    return (
      <>
        {showDayChip ? (
          <View style={styles.dayChipWrap} testID={`chat-day-chip-${item._id}`}>
            <Text style={styles.dayChipText}>{formatChatDayChip(item?._creationTime)}</Text>
          </View>
        ) : null}
        <View style={styles.systemPillWrap} testID="chat-group-created">
          <Text style={styles.systemPillText}>
            {item.creatorName
              ? `${item.creatorName} created the group${item.groupName ? ` "${item.groupName}"` : ''}`
              : 'This group was created'}
          </Text>
        </View>
      </>
    );
  }
  // Call-log pill branch (iter 156, web parity).
  if (item?.__kind === 'call') {
    return (
      <>
        {showDayChip ? (
          <View style={styles.dayChipWrap} testID={`chat-day-chip-${item._id}`}>
            <Text style={styles.dayChipText}>{formatChatDayChip(item?._creationTime)}</Text>
          </View>
        ) : null}
        <CallPill
          item={item}
          hasRecording={item.wasRecorded && recordingByCallId.has(item._callId)}
          onPress={() => {
            const rec = recordingByCallId.get(item._callId);
            if (rec && rec.url) {
              setActiveRecording({
                url: String(rec.url),
                durationSeconds: Number(rec.durationSeconds || item.durationSeconds || 0),
                callType: item.callType,
                outcome: item.outcome,
              });
            }
          }}
          onCallBack={(callType) => {
            // iter-231/232: route call-backs through the same
            // Twilio path as the header call buttons, using the
            // canonical callee resolver (was reading only
            // otherUser.userId → empty → legacy WebRTC fallback).
            startCall({
              router,
              callerIdentity: String(me?._id || ''),
              callerDisplayName: String((me as any)?.name || (me as any)?.displayName || ''),
              calleeIdentities: callCalleeId ? [callCalleeId] : [],
              conversationId: String(conversationId || ''),
              isVideo: callType === 'video',
              displayName: title,
            });
          }}
          testID={`chat-call-pill-${item._id}`}
        />
      </>
    );
  }
  // Share Once invite — a tap-to-view card that opens the author's post.
  // Wrapped with the SAME message affordances as a normal bubble: swipe-to-reply,
  // long-press context menu (copy/forward/react/…), multi-select, and reaction chips.
  if (item?.type === 'shareOnceInvite' && item?.shareOnceToken) {
    const ct = String(item.shareOnceContentType || 'text');
    const icon =
      ct === 'photo' ? 'image' : ct === 'video' ? 'videocam' : ct === 'audio' || ct === 'voice' ? 'musical-notes' : ct === 'file' ? 'document' : ct === 'contact' ? 'person' : 'share-social';
    const isSelected = multiSelectIds ? multiSelectIds.includes(String(item._id)) : false;
    // Aggregate reactions the same way MediaBubble does.
    const reactionMap = new Map<string, { emoji: string; count: number; mine: boolean }>();
    (Array.isArray(item.reactions) ? item.reactions : []).forEach((r: any) => {
      const cur = reactionMap.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
      cur.count += 1;
      if (effectiveMe?._id && r.userId === effectiveMe._id) cur.mine = true;
      reactionMap.set(r.emoji, cur);
    });
    const reactionSummary = Array.from(reactionMap.values());
    return (
      <>
        {showDayChip ? (
          <View style={styles.dayChipWrap} testID={`chat-day-chip-${item._id}`}>
            <Text style={styles.dayChipText}>{formatChatDayChip(item?._creationTime)}</Text>
          </View>
        ) : null}
        <SwipeToReply
          enabled={!viewerSuspension && !isBroadcastReadOnly && !multiSelectIds && !item.deletedAt && !item.__outbox && isConversationAvailable}
          onReply={() => {
            setReplyTo(item);
            messageInputRef.current?.focus();
          }}
        >
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              if (multiSelectIds) {
                onToggleMultiSelect(String(item._id));
                return;
              }
              router.push(`/share-once/view?t=${encodeURIComponent(String(item.shareOnceToken))}` as any);
            }}
            onLongPress={
              viewerSuspension || isBroadcastReadOnly
                ? undefined
                : () => {
                    if (multiSelectIds) {
                      onToggleMultiSelect(String(item._id));
                      return;
                    }
                    onLongPressMessage(item);
                  }
            }
            style={[styles.shareOnceCard, isSelected ? { borderColor: '#E9B53B', backgroundColor: 'rgba(233,181,59,0.12)' } : null]}
            testID={`share-once-invite-${item._id}`}
          >
            <View style={styles.shareOnceIcon}>
              <Ionicons name={icon as any} size={22} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.shareOnceTitle} numberOfLines={2}>
                {item.text || 'Shared a message with you — tap to view'}
              </Text>
              <Text style={styles.shareOnceHint}>Tap to view</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9aa0a6" />
          </TouchableOpacity>
          {reactionSummary.length > 0 ? (
            <View style={styles.shareOnceReactionsRow}>
              {reactionSummary.map((r) => (
                <TouchableOpacity
                  key={r.emoji}
                  style={[styles.shareOnceReactionChip, r.mine ? styles.shareOnceReactionChipMine : null]}
                  onPress={() => onToggleMyReaction(item._id, r.emoji)}
                  testID={`share-once-react-${r.emoji}`}
                >
                  <Text style={styles.shareOnceReactionEmoji}>{r.emoji}</Text>
                  {r.count > 1 ? <Text style={styles.shareOnceReactionCount}>{r.count}</Text> : null}
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </SwipeToReply>
      </>
    );
  }
  return (
    <>
      {showDayChip ? (
        <View style={styles.dayChipWrap} testID={`chat-day-chip-${item._id}`}>
          <Text style={styles.dayChipText}>{formatChatDayChip(item?._creationTime)}</Text>
        </View>
      ) : null}
      <SwipeToReply
        // iter-185 WhatsApp-style swipe-to-reply. Disabled in
        // multi-select mode (pan conflicts with tap-to-toggle),
        // for suspended viewers, and on deleted messages.
        enabled={!viewerSuspension && !isBroadcastReadOnly && !multiSelectIds && !item.deletedAt && !item.__outbox && isConversationAvailable}
        onReply={() => {
          setReplyTo(item);
          messageInputRef.current?.focus();
        }}
      >
        {(() => {
          // Backend field name normalisation (iter-101):
          // Smilers Convex stores the parent reference under
          // `replyToId` per the public spec, but the mobile
          // client historically wrote `replyToMessageId`.
          // Look up by either to be robust against both
          // historical AND fresh messages.
          const parentId = item.replyToId || item.replyToMessageId;
          const parentMsg = parentId ? msgById.get(parentId) : undefined;
          return (
        <MediaBubble
          msg={item}
          isMine={item.senderId === effectiveMe?._id}
          myUserId={effectiveMe?._id}
          senderDisplayName={
            isGroupChat && item.senderId !== effectiveMe?._id
              ? resolveSenderName(item.senderId, item.senderName)
              : undefined
          }
          parentMsg={parentMsg}
          onPressParent={parentMsg ? () => jumpToMessage(parentId) : undefined}
          onReceiveOncePress={() => handleReceiveOnceTombstone(item)}
          isJumpHighlighted={jumpHighlightId === String(item._id)}
          appearance={chatAppearance}
          e2eeStatus={e2eeStatus}
          onLongPress={viewerSuspension || isBroadcastReadOnly ? () => {} : () => {
            // While in multi-select mode, long-press is reserved
            // for toggling selection (matching the easier muscle
            // memory of "tap to toggle, long-press to enter").
            if (multiSelectIds) {
              onToggleMultiSelect(String(item._id));
              return;
            }
            // Local outbox (RED) messages aren't on the server yet —
            // the action sheet's server ops don't apply. Long-press
            // retries the send instead.
            if (item.__outbox) {
              void flushOutbox();
              return;
            }
            onLongPressMessage(item);
          }}
          onPress={
            item.__outbox
              ? () => { void flushOutbox(); }
              : multiSelectIds
                ? () => onToggleMultiSelect(String(item._id))
                : undefined
          }
          multiSelected={multiSelectIds ? multiSelectIds.includes(String(item._id)) : undefined}
          searchTerm={searchTermNorm || null}
          isActiveSearchMatch={activeMatchTimelineIdx >= 0 && index === activeMatchTimelineIdx}
          onToggleReaction={
            viewerSuspension || isBroadcastReadOnly || multiSelectIds
              ? () => {}
              : (emoji) => onToggleMyReaction(item._id, emoji)
          }
        />
          );
        })()}
      </SwipeToReply>
    </>
  );
}

export const ChatMessageRow = React.memo(ChatMessageRowBase);
