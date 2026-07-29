/**
 * MessageBubble + ActionRow (extracted iter-184) — the plain-text message
 * bubble used by the chat timeline, including reply quotes, reactions,
 * edited/starred badges, deleted state, and the iter-107/121 render-time
 * security scan. Logic unchanged from app/chat/[conversationId].tsx.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { scanMessage, explainScanResult, extractUrls, enrichScanWithRemoteAPI } from '../../lib/securityScanner';
import { useTextScamScan, describeScamCategory } from '../../lib/textScamScan';
import { Colors, FontSize, FontWeight, Radius, Shadow } from '../../theme';
import { ForwardedTag } from './ForwardedTag';

// iter: make URLs in chat text tappable. Safe messages already passed the
// render-time security scan (malicious links are blocked/hidden above), so
// here we just linkify + confirm before opening an external link.
const CHAT_URL_REGEX = /((?:https?:\/\/|www\.)[^\s]+)/gi;
const IS_CHAT_URL = (s: string) => /^(?:https?:\/\/|www\.)[^\s]+$/i.test(s);
const HAS_URL = (s: string) => /(?:https?:\/\/|www\.)[^\s]+/i.test(s);

function LinkifiedBubbleText({ text, style }: { text: string; style: any }) {
  if (!text || !HAS_URL(text)) {
    return <Text style={style}>{text}</Text>;
  }
  const parts = text.split(CHAT_URL_REGEX);
  const openLink = (raw: string) => {
    const cleaned = raw.replace(/[.,);!?]+$/, '');
    const url = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
    Alert.alert('Open link?', cleaned, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open',
        onPress: () => {
          Linking.openURL(url).catch(() => Alert.alert('Could not open link', cleaned));
        },
      },
    ]);
  };
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        IS_CHAT_URL(part) ? (
          <Text key={`l-${i}`} style={styles.linkText} onPress={() => openLink(part)} suppressHighlighting>
            {part}
          </Text>
        ) : (
          <Text key={`t-${i}`}>{part}</Text>
        ),
      )}
    </Text>
  );
}

export function ActionRow({
  icon,
  lib,
  label,
  onPress,
  danger,
}: {
  icon: string;
  lib: 'feather' | 'ion' | 'mc';
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const Icon: any = lib === 'ion' ? Ionicons : lib === 'mc' ? MaterialCommunityIcons : Feather;

  return (
    <TouchableOpacity
      style={styles.actionRow}
      onPress={onPress}
      testID={`action-${label.toLowerCase()}`}
    >
      <Icon name={icon as any} size={20} color={danger ? Colors.danger : Colors.textPrimary} />
      <Text style={[styles.actionLabel, danger ? styles.actionLabelDanger : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function MessageBubble({
  msg,
  isMine,
  myUserId,
  parentMsg,
  onLongPress,
  onToggleReaction,
}: {
  msg: any;
  isMine: boolean;
  myUserId?: string;
  parentMsg?: any;
  onLongPress: () => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const text = msg.text || (msg.type !== 'text' ? `[${msg.type}]` : '');
  const time = msg._creationTime ? new Date(msg._creationTime) : new Date();
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // 4-state delivery status (sender's own messages only). Per the web
  // native-message-delivery-status-contract: evaluate top-down, exclude my own
  // id from readBy/deliveredTo, ANY-recipient logic for groups.
  //   RED  = local outbox (never reached server) → msg.__outbox / __failed
  //   BLUE = any other participant has read it (readBy)
  //   GREEN= any other participant's device received it (deliveredTo)
  //   YELLOW = on server, not yet delivered (resting/default)
  const statusDotColor = (() => {
    if (!isMine) return null;
    if (msg.__outbox || msg.__failed) return Colors.tickRed;
    const others = (arr?: string[]) =>
      Array.isArray(arr) ? arr.filter((id) => id && id !== myUserId) : [];
    if (others(msg.readBy).length > 0) return Colors.tickBlue;
    if (others(msg.deliveredTo).length > 0) return Colors.tickGreen;
    return Colors.tickYellow;
  })();

  const reactionSummary = useMemo(() => {
    const reactions: any[] = Array.isArray(msg.reactions) ? msg.reactions : [];
    const map = new Map<string, { emoji: string; count: number; mine: boolean }>();
    reactions.forEach((reaction) => {
      const current = map.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, mine: false };
      current.count += 1;
      if (myUserId && reaction.userId === myUserId) current.mine = true;
      map.set(reaction.emoji, current);
    });
    return Array.from(map.values());
  }, [msg.reactions, myUserId]);

  // iter-107: client-side security scan. Runs heuristic checks on every
  // rendered message — IP-host URLs, brand typosquatting, deceptive
  // user-info, Punycode look-alikes, phishing keywords, dangerous file
  // extensions — and if anything is flagged BLOCK we replace the entire
  // bubble with the same "Deleted" treatment used elsewhere, but with
  // the label "Deleted for security reasons". The raw `msg` is left
  // untouched in the database; this is a render-time guard only so
  // moderators can still audit the original payload server-side.
  //
  // Memoised on the precise fields the scanner reads — avoids re-scanning
  // on every render of an unchanged message.
  //
  // iter-121: also kicks off an ASYNC Google Safe Browsing v4 lookup if
  // the message body contains URLs. The result, if it upgrades the
  // verdict, is stored in `remoteScan` state and merged into the
  // displayed verdict below. Heuristic-only result is shown immediately
  // (no UI blocking) and the remote enrichment may flip a `warn` →
  // `block` once Google responds. If Google is down/key invalid/quota
  // exhausted, the heuristic verdict stands.
  const securityScan = useMemo(() => {
    if (msg.deletedAt) return null; // already deleted — no need to scan
    try {
      return scanMessage({
        body: typeof msg.text === 'string' ? msg.text : '',
        attachment: msg.fileName || msg.storageId || msg.mimeType
          ? { fileName: msg.fileName, mimeType: msg.mimeType, storageId: msg.storageId }
          : null,
      });
    } catch {
      // Scanner must never throw — fall back to safe.
      return null;
    }
  }, [msg.deletedAt, msg.text, msg.fileName, msg.storageId, msg.mimeType]);

  // iter-121: remote Safe Browsing enrichment. Fires when the heuristic
  // verdict is not already `block` (no need to double-block) AND there
  // are URLs in the text. Stores upgrade findings in state. Cancels on
  // unmount via the cancelled flag pattern.
  const [remoteFindings, setRemoteFindings] = useState<null | ReturnType<typeof scanMessage>>(null);
  // Lets a recipient recover a rare false-positive scam flag without leaving chat.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (msg.deletedAt) return;
    if (!securityScan) return;
    if (securityScan.severity === 'block') return; // heuristic already enough
    const urls = extractUrls(typeof msg.text === 'string' ? msg.text : '');
    if (urls.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const enriched = await enrichScanWithRemoteAPI(urls);
        if (cancelled) return;
        if (enriched && enriched.severity === 'block') {
          setRemoteFindings(enriched);
        }
      } catch {
        // Never throw — Safe Browsing failure should not break rendering.
      }
    })();
    return () => { cancelled = true; };
  }, [msg.deletedAt, msg.text, securityScan]);

  // Effective verdict = heuristic merged with any remote upgrade.
  const effectiveScan = useMemo(() => {
    if (!securityScan) return null;
    if (remoteFindings && remoteFindings.severity === 'block') {
      return {
        severity: 'block' as const,
        findings: [...securityScan.findings, ...remoteFindings.findings],
        shouldHide: true,
      };
    }
    return securityScan;
  }, [securityScan, remoteFindings]);

  // AI Safety Shield (text scams): only scan INCOMING, non-deleted, non-URL-blocked
  // messages. Conservative LLM classifier flags fake-prize/phishing/investment cons.
  const scamVerdict = useTextScamScan(
    typeof msg.text === 'string' ? msg.text : '',
    !isMine && !msg.deletedAt && effectiveScan?.severity !== 'block',
  );
  const scamBlocked = scamVerdict.state === 'scam';

  // URL/file threats (Google Safe Browsing / dangerous extensions) are
  // high-confidence and stay masked. Text scams are an LLM judgement call,
  // so we let the recipient tap "Show anyway" to recover a false positive.
  const urlOrFileBlocked = !!effectiveScan?.shouldHide;
  if ((urlOrFileBlocked || scamBlocked) && !revealed) {
    const blockedTimeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const why = urlOrFileBlocked
      ? explainScanResult(effectiveScan!)
      : scamVerdict.state === 'scam'
        ? (scamVerdict.reason || describeScamCategory(scamVerdict.category))
        : '';
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <View
          style={[
            styles.bubble,
            isMine ? styles.bubbleMine : styles.bubbleOther,
            styles.deletedBubble,
          ]}
          testID={`message-bubble-security-blocked-${msg._id}`}
        >
          <View style={styles.securityRow}>
            <Feather name="shield" size={14} color={Colors.textMuted} />
            <Text style={[styles.bubbleText, styles.deletedText]}>Deleted for security reasons</Text>
          </View>
          {why ? (
            <Text style={styles.securityReasonText} numberOfLines={2}>
              {why}
            </Text>
          ) : null}
          {/* Only text-scam flags are recoverable — malware URLs/files stay hidden. */}
          {!urlOrFileBlocked && scamBlocked ? (
            <TouchableOpacity
              onPress={() => setRevealed(true)}
              style={styles.revealButton}
              testID={`message-reveal-${msg._id}`}
            >
              <Feather name="eye" size={12} color={Colors.primary} />
              <Text style={styles.revealText}>Show anyway</Text>
            </TouchableOpacity>
          ) : null}
          <View style={styles.bubbleMeta}>
            <Text style={[styles.bubbleTime, styles.deletedTimeText]}>{blockedTimeStr}</Text>
          </View>
        </View>
      </View>
    );
  }

  if (msg.deletedAt || msg.isDeleted === true) {
    // Web-app parity (iter-98 + iter-243): show the tombstone for both global
    // delete-for-everyone (deletedAt) AND per-viewer deletes (isDeleted —
    // delete-for-me / delete-for-receiver), matching MediaBubble.
    const deletedTimeMs =
      typeof msg.deletedAt === 'number'
        ? msg.deletedAt
        : typeof msg.deletedAt === 'string'
          ? Date.parse(msg.deletedAt) || time.getTime()
          : time.getTime();
    const deletedTimeStr = new Date(deletedTimeMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <View
          style={[
            styles.bubble,
            isMine ? styles.bubbleMine : styles.bubbleOther,
            styles.deletedBubble,
          ]}
          testID={`message-bubble-deleted-${msg._id}`}
        >
          <Text style={[styles.bubbleText, styles.deletedText]}>This message was deleted</Text>
          <View style={styles.bubbleMeta}>
            <Text style={[styles.bubbleTime, styles.deletedTimeText]}>{deletedTimeStr}</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={onLongPress}
        delayLongPress={250}
        testID={`message-bubble-${msg._id}`}
        style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleOther,
        ]}
      >
        <ForwardedTag msg={msg} color={isMine ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.5)'} />
        {parentMsg ? (
          <View style={styles.quoteBlock}>
            <View style={styles.quoteAccent} />
            <View style={styles.flexOne}>
              <Text style={styles.quoteName}>
                {parentMsg.senderName || (parentMsg.senderId === myUserId ? 'You' : 'Reply')}
              </Text>
              <Text style={styles.quoteText} numberOfLines={2}>
                {parentMsg.text || `[${parentMsg.type}]`}
              </Text>
            </View>
          </View>
        ) : (msg.replyToId || msg.replyToMessageId) ? (
          <View style={styles.quoteBlock}>
            <View style={styles.quoteAccent} />
            <Text style={styles.quoteText} numberOfLines={1}>
              Replying to earlier message
            </Text>
          </View>
        ) : null}

        <LinkifiedBubbleText text={text} style={styles.bubbleText} />
        <View style={styles.bubbleMeta}>
          {msg.starred ? (
            <Feather name="star" size={11} color={Colors.tickYellow} style={styles.starIcon} />
          ) : null}
          {/* Web-app parity: "edited HH:MM" inline before the timestamp
              for messages the user (or the other party) has edited.
              Mirrors the same pattern added in MediaBubble. */}
          {(() => {
            const editedAtMs =
              typeof msg.editedAt === 'number'
                ? msg.editedAt
                : typeof msg.editedAt === 'string'
                  ? Date.parse(msg.editedAt) || null
                  : null;
            const isEdited = !!editedAtMs || msg.edited === true || msg.isEdited === true;
            if (!isEdited) return null;
            const editedTimeStr =
              editedAtMs && Number.isFinite(editedAtMs)
                ? new Date(editedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : timeStr;
            // iter-333: when a group post was last edited by someone OTHER than
            // the author, the backend resolves `lastEditedByName`. Show
            // "edited by <name>"; otherwise fall back to "edited <time>".
            const byName =
              typeof msg.lastEditedByName === 'string' && msg.lastEditedByName.trim()
                ? msg.lastEditedByName.trim()
                : null;
            return (
              <Text style={[styles.bubbleTime, styles.editedBadge]}>
                {byName ? `edited by ${byName}` : `edited ${editedTimeStr}`}
              </Text>
            );
          })()}
          <Text style={styles.bubbleTime}>{timeStr}</Text>
          {statusDotColor ? (
            <View
              style={[styles.statusDot, { backgroundColor: statusDotColor }]}
              testID={`msg-status-dot-${msg._id}`}
            />
          ) : null}
        </View>
      </TouchableOpacity>

      {reactionSummary.length > 0 ? (
        <View style={[styles.reactionsRow, isMine ? styles.reactionsRowMine : styles.reactionsRowOther]}>
          {reactionSummary.map((reaction) => (
            <TouchableOpacity
              key={reaction.emoji}
              style={[styles.reactionChip, reaction.mine ? styles.reactionChipMine : null]}
              onPress={() => onToggleReaction(reaction.emoji)}
              testID={`bubble-react-${reaction.emoji}`}
            >
              <Text style={styles.reactionChipEmoji}>{reaction.emoji}</Text>
              {reaction.count > 1 ? <Text style={styles.reactionChipCount}>{reaction.count}</Text> : null}
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
  bubbleRow: {
    marginVertical: 6,
    flexDirection: 'row',
    position: 'relative',
  },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.lg,
    ...Shadow.sm,
  },
  bubbleMine: {
    backgroundColor: Colors.bubbleOut,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: Colors.bubbleIn,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  linkText: {
    color: Colors.primary,
    textDecorationLine: 'underline',
  },
  quoteBlock: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: 8,
    padding: 6,
    marginBottom: 6,
    gap: 6,
  },
  quoteAccent: { width: 3, borderRadius: 2, backgroundColor: Colors.primary },
  quoteName: { fontSize: 11, fontWeight: FontWeight.bold, color: Colors.primary },
  quoteText: { fontSize: 12, color: Colors.textSecondary },
  bubbleMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginTop: 4,
  },
  bubbleTime: {
    fontSize: 10,
    color: Colors.textMuted,
  },
  reactionsRow: {
    position: 'absolute',
    bottom: -10,
    flexDirection: 'row',
    gap: 4,
  },
  reactionsRowMine: { right: 8 },
  reactionsRowOther: { left: 8 },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 2,
  },
  reactionChipMine: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  reactionChipEmoji: { fontSize: 12 },
  reactionChipCount: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: FontWeight.semibold,
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  actionLabel: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    fontWeight: FontWeight.medium,
  },
  actionLabelDanger: { color: Colors.danger },
  deletedBubble: { opacity: 0.55 },
  deletedText: { fontStyle: 'italic', color: Colors.textMuted },
  deletedTimeText: { fontStyle: 'italic', opacity: 0.85, color: Colors.textMuted },
  securityRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  securityReasonText: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    color: Colors.textMuted,
    marginTop: 4,
    lineHeight: 16,
  },
  revealButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
    paddingVertical: 4,
  },
  revealText: {
    fontSize: FontSize.xs,
    color: Colors.primary,
    fontWeight: FontWeight.semibold,
  },
  editedBadge: { fontStyle: 'italic', marginRight: 6, opacity: 0.85 },
  starIcon: { marginRight: 4 },
  tickIcon: { marginLeft: 4 },
  statusDot: { width: 9, height: 9, borderRadius: 5, marginLeft: 6 },
});
