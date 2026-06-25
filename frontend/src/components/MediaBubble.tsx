import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  createAudioPlayer,
  setAudioModeAsync as setExpoAudioModeAsync,
  type AudioPlayer,
  type AudioSource,
} from 'expo-audio';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import * as Linking from 'expo-linking';
import { router as expoRouter } from 'expo-router';
import { useConvex, useMutation, useQuery } from 'convex/react';
import { api } from '../convexApi';
import {
  parseRichTextSegments,
  stripRichTextTags,
} from '../lib/chatRichText';
import {
  getBubbleRadius,
  getBubbleTailRadius,
  getIncomingBubbleColor,
  getOutgoingBubbleColor,
  getTextSize,
} from '../lib/chatAppearance';
import { Colors, FontSize, FontWeight, Radius } from '../theme';
import BubbleErrorBoundary from './BubbleErrorBoundary';
import { getMessageDurationSec } from '../hooks/useResolvedStorageUrl';
import { useDecryptedMediaUrl } from '../hooks/useDecryptedMediaUrl';
import type { E2EEStatus } from '../hooks/useConversationE2EE';
import { getCachedTranscription, type CachedTranscription, type TranscriptionSegment } from '../lib/triggerTranscription';
import { SharedContactBubble } from './chat/SharedContactBubble';
// iter-218 — Safe Browsing gate for links
import { useUrlSafety, isDangerousFile } from '../lib/safeBrowsing';
// iter-125: full-screen photo viewer toolbar helpers
import {
  saveMessageMediaToGallery,
  shareMessage,
  setMessageImageAsProfilePhoto,
} from '../lib/messageMedia';
import { usePhoneMessageActions, findPhoneMatches } from '../lib/usePhoneMessageActions';
import { useAutoDownloadMedia } from '../lib/mediaAutoDownload';
import { purgeMessageMedia } from '../lib/deletedMediaPurge';

// Module-level "currently playing" audio singleton — guarantees only one
// voice message plays at a time. Uses expo-audio's AudioPlayer (expo-av
// has been deprecated in SDK 54).
let CURRENT_SOUND: AudioPlayer | null = null;
let CURRENT_STOP: (() => void) | null = null;

function fmtDur(sec: number): string {
  const seconds = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function extractFirstUrl(text?: string) {
  const match = text?.match(/https?:\/\/[^\s]+/i);
  return match?.[0];
}

/**
 * SystemMessagePill — renders a centered, neutral pill for messages with
 * `type:'system'`. Currently handles `systemKind:'numberChanged'` per the
 * Identity Rework contract; falls back to a generic label for any other
 * future systemKind so unknown system events still render gracefully.
 *
 * Backend shape (canonical contract, iter-166):
 *   {
 *     type: 'system',
 *     systemKind: 'numberChanged',
 *     senderId,                  // user who triggered it
 *     systemMeta: { userId, oldPhoneE164?, newPhoneE164 },
 *     _creationTime,
 *   }
 *
 * We intentionally do NOT show the changing user's name lookup here — the
 * chat header already shows the conversation peer, and the web app shows
 * a self-contained sentence with just the numbers. Mirrors that.
 */
function SystemMessagePill({ msg, timeStr, myUserId }: { msg: any; timeStr: string; myUserId?: string }) {
  const kind = String(msg?.systemKind || '');
  const meta = (msg?.systemMeta && typeof msg.systemMeta === 'object') ? msg.systemMeta : {};
  const isSelf =
    !!myUserId && (String(meta?.userId || '') === String(myUserId) || String(msg?.senderId || '') === String(myUserId));

  let body = '';
  if (kind === 'numberChanged') {
    const oldNum = typeof meta.oldPhoneE164 === 'string' ? meta.oldPhoneE164 : '';
    const newNum = typeof meta.newPhoneE164 === 'string' ? meta.newPhoneE164 : '';
    if (isSelf) {
      body = oldNum
        ? `You changed your number from ${oldNum} to ${newNum}`
        : `You changed your number to ${newNum}`;
    } else {
      body = oldNum
        ? `Changed number from ${oldNum} to ${newNum}`
        : `Changed number to ${newNum}`;
    }
  } else if (typeof msg?.text === 'string' && msg.text.length > 0) {
    body = msg.text;
  } else {
    body = 'System update';
  }

  return (
    <View style={styles.systemRow} testID={`system-message-${msg._id}`}>
      <View style={styles.systemPill}>
        <Text style={styles.systemText} numberOfLines={3}>
          {body}
        </Text>
        <Text style={styles.systemTime}>{timeStr}</Text>
      </View>
    </View>
  );
}

interface BubbleProps {
  msg: any;
  isMine: boolean;
  myUserId?: string;
  parentMsg?: any;
  appearance?: any;
  e2eeStatus?: E2EEStatus | null;
  onLongPress: () => void;
  onToggleReaction: (emoji: string) => void;
  // iter-99: multi-select forward mode. When `onPress` is supplied,
  // taps on the bubble fire it instead of the default no-op.
  // `multiSelected` drives the checkmark overlay visual.
  onPress?: () => void;
  multiSelected?: boolean;
  // In-conversation search (iter-220). When `searchTerm` is set, every
  // occurrence inside this bubble's text is highlighted. `isActiveSearchMatch`
  // marks the message the up/down navigator is currently focused on (brighter
  // highlight + a subtle outline so it stands out among the other matches).
  searchTerm?: string | null;
  isActiveSearchMatch?: boolean;
}

export default function MediaBubble({
  msg,
  isMine,
  myUserId,
  parentMsg,
  appearance,
  e2eeStatus,
  onLongPress,
  onToggleReaction,
  onPress,
  multiSelected,
  searchTerm,
  isActiveSearchMatch,
}: BubbleProps) {
  const time = msg._creationTime ? new Date(msg._creationTime) : new Date();
  const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  // "Delete for everyone" native purge: when the sender deletes a message for
  // everyone, the web backend permanently corrupts the file server-side
  // (storage 404s) and stamps `deletedAt`. Once that reactive update reaches
  // this device we wipe any app-owned local copies (cache / SmilersDownloads)
  // we previously saved for this message. Idempotent + best-effort.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!msg?.deletedAt) return;
    const id = String(msg?._id || '');
    if (!id) return;
    purgeMessageMedia(id).catch(() => {});
  }, [msg?.deletedAt, msg?._id]);

  // iter-166 system-message renderer (Identity Rework).
  // Backend per canonical contract emits:
  //   { type:'system', systemKind:'numberChanged',
  //     senderId, systemMeta:{ userId, oldPhoneE164?, newPhoneE164 } }
  // Renders as a centered pill — NOT a chat bubble — to match the web
  // app's "X changed their number" treatment. We deliberately omit the
  // old number when missing (E.164 only).
  if (msg?.type === 'system') {
    return (
      <SystemMessagePill
        msg={msg}
        timeStr={timeStr}
        myUserId={myUserId}
      />
    );
  }

  // 4-colour delivery status (sender's own messages only) — evaluated
  // top-down per the web native-message-delivery-status-contract:
  //   RED    → local outbox: queued offline, never reached the server
  //   BLUE   → read   (any other participant opened the chat — readBy)
  //   GREEN  → delivered (any other participant's device received it)
  //   YELLOW → on server, not delivered to anyone yet (resting state)
  // We exclude the sender's own userId from readBy/deliveredTo because the
  // server records the sender as the original delivery target. Group chats
  // use ANY-recipient logic (`.length > 0`).
  const isOutbox = msg.__outbox === true || msg.__failed === true;
  const senderUserId = msg.senderId ? String(msg.senderId) : null;
  const readByOthers = Array.isArray(msg.readBy)
    ? msg.readBy.filter((uid: any) => uid && String(uid) !== senderUserId)
    : [];
  const deliveredToOthers = Array.isArray(msg.deliveredTo)
    ? msg.deliveredTo.filter((uid: any) => uid && String(uid) !== senderUserId)
    : [];
  const statusDotColor = isOutbox
    ? Colors.tickRed
    : readByOthers.length > 0
      ? Colors.tickBlue
      : deliveredToOthers.length > 0
        ? Colors.tickGreen
        : Colors.tickYellow;

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

  const bubbleRadius = getBubbleRadius(appearance?.bubbleStyle);
  const bubbleTailRadius = getBubbleTailRadius(appearance?.bubbleStyle);
  const bubbleBackground = isMine
    ? getOutgoingBubbleColor(appearance?.outgoingColor)
    : getIncomingBubbleColor(appearance?.incomingColor);
  const bubbleDynamicStyle = {
    backgroundColor: bubbleBackground,
    borderRadius: bubbleRadius,
    borderBottomRightRadius: isMine ? bubbleTailRadius : bubbleRadius,
    borderBottomLeftRadius: isMine ? bubbleRadius : bubbleTailRadius,
  };
  const messageTextSize = getTextSize(appearance?.textSize);
  const bubbleTextStyle = { fontSize: messageTextSize, lineHeight: messageTextSize + 6 };
  const isOutgoing = isMine;
  const messageTextColor = isOutgoing ? '#F6FFF9' : Colors.textPrimary;
  const metaTextColor = isOutgoing ? 'rgba(246,255,249,0.82)' : Colors.textMuted;
  // For "edited" indicator: prefer msg.editedAt (server canonical timestamp),
  // fall back to msg._creationTime if the backend doesn't expose it but the
  // local edit just happened. Web app shows "edited HH:MM" inline with the
  // timestamp. Per iter-98 user screenshot of the web app design.
  const editedAtMs =
    typeof msg.editedAt === 'number'
      ? msg.editedAt
      : typeof msg.editedAt === 'string'
        ? Date.parse(msg.editedAt) || null
        : null;
  const editedTimeStr =
    editedAtMs && Number.isFinite(editedAtMs)
      ? new Date(editedAtMs).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : timeStr;
  const isEdited = !!editedAtMs || msg.edited === true || msg.isEdited === true;

  if (msg.deletedAt) {
    // Web-app parity for deleted messages: faded bubble (opacity), italic
    // text "This message was deleted", and timestamp on the right —
    // matching the screenshot the user shared in iter-98.
    const deletedTimeMs =
      typeof msg.deletedAt === 'number'
        ? msg.deletedAt
        : typeof msg.deletedAt === 'string'
          ? Date.parse(msg.deletedAt) || time.getTime()
          : time.getTime();
    const deletedTimeStr = new Date(deletedTimeMs).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <View
          style={[
            styles.bubble,
            isMine ? styles.bubbleMine : styles.bubbleOther,
            bubbleDynamicStyle,
            styles.deletedBubble,
          ]}
          testID={`message-bubble-deleted-${msg._id}`}
        >
          <Text style={[styles.bubbleText, bubbleTextStyle, styles.deletedText]}>
            This message was deleted
          </Text>
          <View style={styles.bubbleMeta}>
            <Text style={[styles.bubbleTime, styles.deletedTimeText, { color: metaTextColor }]}>
              {deletedTimeStr}
            </Text>
            {isMine ? (
              <View
                style={[styles.statusDot, { backgroundColor: statusDotColor }]}
                testID={`msg-status-dot-${msg._id}`}
              />
            ) : null}
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
        onPress={onPress}
        style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleOther,
          bubbleDynamicStyle,
          msg.type === 'image' ? styles.bubbleImage : null,
          // Multi-select visual feedback (iter-99): green ring + light
          // tint when this bubble is in the selection set.
          multiSelected ? styles.bubbleMultiSelected : null,
          isActiveSearchMatch ? styles.bubbleActiveSearchMatch : null,
        ]}
        testID={`message-bubble-${msg._id}`}
      >
        {/* Multi-select checkmark overlay — only visible when this
            bubble is one of the user's selections. Positioned top-right
            so it doesn't obscure the text body. */}
        {multiSelected ? (
          <View style={styles.multiSelectCheckOverlay} pointerEvents="none">
            <Feather name="check-circle" size={18} color="#FFFFFF" />
          </View>
        ) : null}
        <View style={styles.encryptedRow}>
          <Ionicons name="shield-checkmark-outline" size={12} color={isOutgoing ? '#F6FFF9' : Colors.primary} />
          <Text style={[styles.encryptedText, { color: isOutgoing ? '#F6FFF9' : Colors.primary }]}>Encrypted</Text>
        </View>

        {parentMsg ? (
          <View style={styles.quoteBlock}>
            <View style={styles.quoteAccent} />
            <View style={styles.flexOne}>
              <Text style={styles.quoteName}>
                {parentMsg.senderName || (parentMsg.senderId === myUserId ? 'You' : 'Reply')}
              </Text>
              <Text style={styles.quoteText} numberOfLines={2}>
                {stripRichTextTags(parentMsg.text) || `[${parentMsg.type}]`}
              </Text>
            </View>
          </View>
        ) : null}

        <BubbleBody msg={msg} timeStr={timeStr} textStyle={[bubbleTextStyle, { color: messageTextColor }]} isMine={isMine} e2eeStatus={e2eeStatus || null} searchTerm={searchTerm} isActiveSearchMatch={isActiveSearchMatch} />

        <View style={styles.bubbleMeta}>
          {msg.starred ? <Feather name="star" size={11} color={Colors.tickYellow} style={styles.starIcon} /> : null}
          {/* Web-app parity (iter-98 screenshot): if the message was
              edited, show italic "edited HH:MM" inline before the
              regular time stamp. We render this only for non-image
              messages because image bubbles have their own time
              overlay inside the media frame. */}
          {isEdited && msg.type !== 'image' ? (
            <Text style={[styles.bubbleTime, styles.editedBadge, { color: metaTextColor }]}>
              edited {editedTimeStr}
            </Text>
          ) : null}
          {msg.type === 'image' ? null : <Text style={[styles.bubbleTime, { color: metaTextColor }]}>{timeStr}</Text>}
          {isMine ? (
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

function BubbleBody({ msg, timeStr, textStyle, isMine, e2eeStatus, searchTerm, isActiveSearchMatch }: { msg: any; timeStr: string; textStyle?: any; isMine: boolean; e2eeStatus: E2EEStatus | null; searchTerm?: string | null; isActiveSearchMatch?: boolean }) {
  return (
    <BubbleErrorBoundary fallbackLabel="Message couldn't load">
      <BubbleBodyInner msg={msg} timeStr={timeStr} textStyle={textStyle} isMine={isMine} e2eeStatus={e2eeStatus} searchTerm={searchTerm} isActiveSearchMatch={isActiveSearchMatch} />
    </BubbleErrorBoundary>
  );
}

function BubbleBodyInner({ msg, timeStr, textStyle, isMine, e2eeStatus, searchTerm, isActiveSearchMatch }: { msg: any; timeStr: string; textStyle?: any; isMine: boolean; e2eeStatus: E2EEStatus | null; searchTerm?: string | null; isActiveSearchMatch?: boolean }) {
  // iter-134: Call logs in chat. Backend may surface call history as
  // virtual messages with either `type: 'call'` or `kind: 'call'`,
  // so we detect both. The CallLogMessage component is purely
  // presentational + a tap-to-call-back affordance.
  if (msg?.type === 'call' || msg?.kind === 'call') {
    return <CallLogMessage msg={msg} isMine={isMine} />;
  }

  // iter-219: DANGEROUS-FILE GATE.
  //
  // We replace the file message entirely with the canonical
  // "removed for security reasons" bubble whenever the attachment is
  // an executable / installer / script type (APK, EXE, BAT, SH, JS,
  // JAR, …). Google Safe Browsing only flags URLs, not file content,
  // so a malicious APK sitting in our own Convex storage would pass a
  // URL check trivially — the only safe default is to refuse to render
  // file types that are essentially never legitimate as a chat
  // attachment. Photos, videos, audio and documents are intentionally
  // NOT covered here — they're rendered normally.
  if (msg?.type === 'file' || msg?.type === 'document') {
    const danger = isDangerousFile({
      fileName: msg?.fileName,
      mimeType: msg?.mimeType,
    });
    if (danger.dangerous) {
      return (
        <Text
          style={[
            styles.bubbleText,
            textStyle,
            styles.maliciousMessageText,
          ]}
          testID={`dangerous-file-${msg._id}`}
        >
          ⚠️ This message was removed for security reasons
        </Text>
      );
    }
  }

  switch (msg.type) {
    case 'image':
      return <ImageMessage msg={msg} timeStr={timeStr} textStyle={textStyle} e2eeStatus={e2eeStatus} isMine={isMine} />;
    case 'video':
      return <VideoMessage msg={msg} timeStr={timeStr} textStyle={textStyle} e2eeStatus={e2eeStatus} isMine={isMine} />;
    case 'voice':
    case 'audio':
      return <VoiceMessage msg={msg} e2eeStatus={e2eeStatus} isMine={isMine} />;
    case 'poll':
      return <PollMessage msg={msg} />;
    case 'file':
    case 'document':
      return <FileMessage msg={msg} isMine={isMine} e2eeStatus={e2eeStatus} />;
    case 'contact':
      // iter-203 Share Contacts (canonical spec: docs/SHARE_CONTACTS_NATIVE_CONTRACT.md).
      // Each contact message carries an array of cards via `sharedContacts`.
      // We render the array (one card per contact) and let the inner
      // component handle the "Message" tap → getOrCreateDirect navigation.
      return (
        <SharedContactBubble
          contacts={Array.isArray(msg.sharedContacts) ? msg.sharedContacts : []}
          isMine={isMine}
        />
      );
    case 'text':
    default:
      if (extractFirstUrl(msg.text || '')) {
        return <LinkPreviewMessage msg={msg} textStyle={textStyle} isMine={isMine} />;
      }
      return <RichMessageText text={msg.text || ''} textStyle={textStyle} highlightTerm={searchTerm} highlightActive={isActiveSearchMatch} enablePhoneLinks />;
  }
}

/**
 * Split `text` into segments around every case-insensitive occurrence of
 * `term`, flagging which pieces are matches. Used to wrap matched words in a
 * highlight <Text> for in-conversation search.
 */
function splitByTerm(text: string, term: string): { text: string; match: boolean }[] {
  if (!term) return [{ text, match: false }];
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let from = 0;
  let idx = lowerText.indexOf(lowerTerm, from);
  while (idx !== -1) {
    if (idx > from) out.push({ text: text.slice(from, idx), match: false });
    out.push({ text: text.slice(idx, idx + term.length), match: true });
    from = idx + term.length;
    idx = lowerText.indexOf(lowerTerm, from);
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false });
  return out;
}

/** Render a plain string with optional search-term highlighting. Returns an
 *  array of strings / <Text> nodes suitable as children of a <Text>. */
function renderHighlighted(
  text: string,
  term: string,
  matchStyle: any,
  keyPrefix: string,
): React.ReactNode[] {
  if (!term) return [text];
  return splitByTerm(text, term).map((part, partIndex) =>
    part.match ? (
      <Text key={`${keyPrefix}-h${partIndex}`} style={matchStyle}>
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  );
}

function RichMessageText({
  text,
  textStyle,
  numberOfLines,
  highlightTerm,
  highlightActive,
  enablePhoneLinks,
}: {
  text: string;
  textStyle?: any;
  numberOfLines?: number;
  highlightTerm?: string | null;
  highlightActive?: boolean;
  /** When true, phone numbers in the text become tappable (Message/Invite). */
  enablePhoneLinks?: boolean;
}) {
  const segments = useMemo(() => parseRichTextSegments(text), [text]);
  const term = (highlightTerm || '').trim();
  const matchStyle = highlightActive ? styles.searchHighlightActive : styles.searchHighlight;
  // Hooks are always called (cheap context reads) so we can conditionally
  // enable phone-number actions without breaking the rules of hooks.
  const { onPhonePress } = usePhoneMessageActions();
  return (
    <Text style={[styles.bubbleText, textStyle]} numberOfLines={numberOfLines}>
      {segments.map((segment, index) => {
        const segStyle = [
          segment.bold ? styles.richTextBold : null,
          segment.color ? { color: segment.color } : null,
        ];
        const phoneMatches = enablePhoneLinks ? findPhoneMatches(segment.text) : [];
        if (phoneMatches.length === 0) {
          if (!term) {
            return (
              <Text key={`${index}-${segment.text}`} style={segStyle}>
                {segment.text}
              </Text>
            );
          }
          return (
            <Text key={`${index}-${segment.text}`} style={segStyle}>
              {renderHighlighted(segment.text, term, matchStyle, `${index}`)}
            </Text>
          );
        }
        // Split the segment around phone matches; non-phone slices still
        // get search highlighting, phone slices become tappable links.
        const children: React.ReactNode[] = [];
        let cursor = 0;
        phoneMatches.forEach((pm, pmIndex) => {
          if (pm.start > cursor) {
            children.push(
              ...renderHighlighted(
                segment.text.slice(cursor, pm.start),
                term,
                matchStyle,
                `${index}-pre${pmIndex}`,
              ),
            );
          }
          children.push(
            <Text
              key={`${index}-phone${pmIndex}`}
              style={styles.phoneLink}
              onPress={() => onPhonePress(pm.text.trim())}
              suppressHighlighting
            >
              {pm.text}
            </Text>,
          );
          cursor = pm.end;
        });
        if (cursor < segment.text.length) {
          children.push(
            ...renderHighlighted(segment.text.slice(cursor), term, matchStyle, `${index}-tail`),
          );
        }
        return (
          <Text key={`${index}-${segment.text}`} style={segStyle}>
            {children}
          </Text>
        );
      })}
    </Text>
  );
}

function LinkPreviewMessage({ msg, textStyle, isMine }: { msg: any; textStyle?: any; isMine: boolean }) {
  const url = extractFirstUrl(msg.text || '') || '';
  const safeUrl = url.replace(/^https?:\/\//, '');
  const domain = safeUrl.split('/')[0] || 'link';
  const path = safeUrl.includes('/') ? `/${safeUrl.split('/').slice(1).join('/')}` : '/';
  const cardTextColor = isMine ? '#F6FFF9' : Colors.textPrimary;
  const subColor = isMine ? 'rgba(246,255,249,0.78)' : Colors.textSecondary;
  const leadText = stripRichTextTags((msg.text || '').replace(url, '').trim() || domain);

  // iter-218 — Safe-Browsing gate. If Google flags this URL we replace
  // the preview card with a non-tappable warning. The check is async
  // and cached — first render shows the URL normally (state==='unknown'),
  // then the verdict applies. We never hide a legitimate message.
  const safety = useUrlSafety(url);
  const isMalicious = safety.state === 'malicious';

  const onOpen = async () => {
    if (isMalicious) return; // belt-and-braces — handler is also disabled below
    try {
      await Linking.openURL(url);
    } catch {}
  };

  if (isMalicious) {
    // iter-218: match the canonical "removed for security reasons" UX —
    // the WHOLE message is replaced with an italic warning inside the
    // existing bubble shape, so the user never sees any portion of the
    // malicious link, the surrounding text it was embedded in, OR the
    // preview metadata. The bubble keeps its normal time/delivery
    // indicators so the conversation flow stays intact.
    return (
      <Text
        style={[
          styles.bubbleText,
          textStyle,
          styles.maliciousMessageText,
        ]}
        testID={`malicious-link-${msg._id}`}
      >
        ⚠️ This message was removed for security reasons
      </Text>
    );
  }

  return (
    <TouchableOpacity onPress={onOpen} activeOpacity={0.82} testID={`link-preview-${msg._id}`}>
      <Text style={[styles.bubbleText, textStyle, styles.linkLeadText]}>{leadText}</Text>
      <View style={[styles.linkCard, isMine ? styles.linkCardMine : null]}>
        <Text style={[styles.linkCardTitle, { color: cardTextColor }]} numberOfLines={1}>{domain}</Text>
        <Text style={[styles.linkCardDomain, { color: subColor }]} numberOfLines={1}>{domain}</Text>
        <Text style={[styles.linkCardPath, { color: subColor }]} numberOfLines={1}>{path}</Text>
        <View style={styles.linkCardActionRow}>
          <Feather name="external-link" size={13} color={cardTextColor} />
          <Text style={[styles.linkCardActionText, { color: cardTextColor }]}>Tap to open</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function ImageMessage({ msg, timeStr, textStyle, e2eeStatus, isMine }: { msg: any; timeStr: string; textStyle?: any; e2eeStatus: E2EEStatus | null; isMine: boolean }) {
  const [open, setOpen] = useState(false);
  const { url: src, loading, error } = useDecryptedMediaUrl(msg, e2eeStatus);
  useAutoDownloadMedia({ msg, isMine, src, mediaType: 'image' });

  if (!src) {
    return (
      <View style={styles.imagePlaceholder} testID="image-bubble-loading">
        {error ? (
          <Feather name="lock" size={20} color={Colors.danger} />
        ) : (
          <ActivityIndicator color={Colors.primary} />
        )}
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity activeOpacity={0.9} onPress={() => setOpen(true)} testID="image-bubble" disabled={loading}>
        <View style={styles.imageWrap}>
          <Image source={{ uri: src }} style={styles.image} resizeMode="cover" />
          <View style={styles.imageTimeOverlay}>
            <Text style={styles.bubbleTimeOverlay}>{timeStr}</Text>
          </View>
        </View>
        {msg.text ? <RichMessageText text={msg.text} textStyle={[textStyle, styles.imageCaption]} /> : null}
      </TouchableOpacity>
      <ImageViewer visible={open} onClose={() => setOpen(false)} uri={src} msg={msg} />
    </>
  );
}

/**
 * ImageViewer — full-screen photo viewer with a bottom action toolbar.
 *
 * iter-125: added Download / Share / Set as profile photo per the
 * web-parity spec. Helpers (download to cache, request permissions,
 * call backend mutation) live in /app/frontend/src/lib/messageMedia.ts.
 *
 * All three actions are GUARDED by the message kind:
 *   - Download / Share: visible when the message has any media URL.
 *   - Set as profile photo: only for messages whose kind === 'image'.
 *
 * Failures surface via Alert.alert from the helper; we never crash the
 * viewer.
 */
function ImageViewer({
  visible,
  onClose,
  uri,
  msg,
}: {
  visible: boolean;
  onClose: () => void;
  uri: string;
  msg?: any;
}) {
  const convex = useConvex();
  const insets = useSafeAreaInsets();
  const [busyAction, setBusyAction] = useState<null | 'download' | 'share' | 'profile'>(null);

  const isImage =
    msg?.kind === 'image' ||
    msg?.type === 'image' ||
    (typeof msg?.mimeType === 'string' && msg.mimeType.startsWith('image/'));

  const handleDownload = useCallback(async () => {
    if (busyAction) return;
    setBusyAction('download');
    try {
      const ok = await saveMessageMediaToGallery({ client: convex as any, message: msg, localUri: uri });
      if (ok) Alert.alert('Saved', 'Photo saved to your gallery.');
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, convex, msg, uri]);

  const handleShare = useCallback(async () => {
    if (busyAction) return;
    setBusyAction('share');
    try {
      await shareMessage({ client: convex as any, message: msg });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, convex, msg]);

  const handleSetProfile = useCallback(() => {
    if (busyAction) return;
    if (!isImage) return;
    Alert.alert(
      'Use as profile photo?',
      'Replace your current profile photo with this image.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Use photo',
          onPress: async () => {
            setBusyAction('profile');
            try {
              const ok = await setMessageImageAsProfilePhoto({
                client: convex as any,
                message: msg,
              });
              if (ok) Alert.alert('Updated', 'Profile photo updated.');
            } finally {
              setBusyAction(null);
            }
          },
        },
      ],
    );
  }, [busyAction, convex, msg, isImage]);

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewerWrap} testID="media-viewer">
        <Pressable style={styles.viewerBackdrop} onPress={onClose}>
          <Image source={{ uri }} style={styles.viewerImage} resizeMode="contain" />
        </Pressable>
        <TouchableOpacity style={styles.viewerClose} onPress={onClose} hitSlop={12} testID="media-viewer-close">
          <Feather name="x" size={28} color={Colors.white} />
        </TouchableOpacity>

        {/* Bottom action toolbar — iter-125 */}
        {msg ? (
          <View
            style={[
              styles.viewerToolbar,
              { paddingBottom: Math.max(12, insets.bottom + 8) },
            ]}
            testID="media-viewer-toolbar"
          >
            <TouchableOpacity
              style={styles.viewerAction}
              onPress={handleDownload}
              disabled={!!busyAction}
              testID="media-viewer-download"
            >
              {busyAction === 'download' ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Feather name="download" size={22} color={Colors.white} />
              )}
              <Text style={styles.viewerActionLabel}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.viewerAction}
              onPress={handleShare}
              disabled={!!busyAction}
              testID="media-viewer-share"
            >
              {busyAction === 'share' ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Feather name="share-2" size={22} color={Colors.white} />
              )}
              <Text style={styles.viewerActionLabel}>Share</Text>
            </TouchableOpacity>
            {isImage ? (
              <TouchableOpacity
                style={styles.viewerAction}
                onPress={handleSetProfile}
                disabled={!!busyAction}
                testID="media-viewer-profile"
              >
                {busyAction === 'profile' ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Feather name="user" size={22} color={Colors.white} />
                )}
                <Text style={styles.viewerActionLabel}>Use as profile</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/**
 * VideoMessage — web-parity inline video player with:
 *   - Poster/first-frame preview
 *   - Center play/pause overlay button
 *   - Bottom-left elapsed time pill (0:06 style)
 *   - Top-right fullscreen expand button → opens VideoViewer
 *   - Subtitle pill below the bubble (uses existing TranscriptionPill)
 */
function VideoMessage({
  msg,
  timeStr,
  textStyle,
  e2eeStatus,
  isMine,
}: {
  msg: any;
  timeStr: string;
  textStyle?: any;
  e2eeStatus: E2EEStatus | null;
  isMine: boolean;
}) {
  const { url: src, loading, error } = useDecryptedMediaUrl(msg, e2eeStatus);
  useAutoDownloadMedia({ msg, isMine, src, mediaType: 'video' });
  // expo-video: useVideoPlayer creates the player and the setup callback runs
  // once. We start PAUSED (videos in chat don't auto-play; user taps Play).
  const player = useVideoPlayer(
    src ? { uri: src } : null,
    (p) => {
      try {
        p.loop = false;
        p.muted = false;
      } catch {}
    },
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [durMs, setDurMs] = useState<number>(() => {
    const remote = getMessageDurationSec(msg);
    return remote ? remote * 1000 : 0;
  });
  const [viewerOpen, setViewerOpen] = useState(false);

  // Track playback status via expo-video event listeners. statusChange fires
  // when player.status flips between idle / loading / readyToPlay / error.
  // timeUpdate fires every ~200ms while playing — gives us currentTime.
  // playToEnd fires once when the video finishes.
  useEffect(() => {
    if (!player) return;
    const statusSub = player.addListener('statusChange', () => {
      try {
        setIsPlaying(!!player.playing);
        if (typeof player.duration === 'number' && player.duration > 0) {
          setDurMs(player.duration * 1000);
        }
      } catch {}
    });
    const timeSub = player.addListener('timeUpdate', (event: any) => {
      const current = typeof event?.currentTime === 'number' ? event.currentTime : player.currentTime;
      const playing = typeof event?.isPlaying === 'boolean' ? event.isPlaying : !!player.playing;
      if (typeof current === 'number') {
        setPosMs(current * 1000);
      }
      setIsPlaying(playing);
    });
    const endSub = player.addListener('playToEnd', () => {
      setIsPlaying(false);
      try {
        if (typeof player.seekTo === 'function') {
          void player.seekTo(0);
        } else {
          player.currentTime = 0;
        }
      } catch {}
    });
    return () => {
      try {
        statusSub.remove();
      } catch {}
      try {
        timeSub.remove();
      } catch {}
      try {
        endSub.remove();
      } catch {}
    };
  }, [player]);

  // Clean up when unmounting so other media doesn't keep playing.
  useEffect(() => {
    return () => {
      try {
        player?.pause();
      } catch {}
    };
  }, [player]);

  const togglePlay = useCallback(async () => {
    if (!src || !player) return;
    try {
      if (player.playing) {
        player.pause();
      } else {
        const cur = typeof player.currentTime === 'number' ? player.currentTime : 0;
        const dur = typeof player.duration === 'number' ? player.duration : 0;
        if (dur > 0 && cur >= dur - 0.05) {
          if (typeof player.seekTo === 'function') {
            await player.seekTo(0);
          } else {
            player.currentTime = 0;
          }
        }
        player.play();
      }
    } catch {}
  }, [src, player]);

  if (!src) {
    return (
      <View style={[styles.videoPlaceholder]} testID="video-bubble-loading">
        {error ? (
          <Feather name="lock" size={22} color={Colors.danger} />
        ) : loading ? (
          <ActivityIndicator color={Colors.primary} />
        ) : (
          <Feather name="video" size={28} color={Colors.textMuted} />
        )}
      </View>
    );
  }

  const elapsedSec = Math.floor(posMs / 1000);
  const totalSec = Math.floor(durMs / 1000);
  // Show elapsed when playing, total duration when paused at start.
  const timeLabel = isPlaying || elapsedSec > 0 ? fmtDur(elapsedSec) : (totalSec > 0 ? fmtDur(totalSec) : '0:00');

  return (
    <>
      <View>
        <TouchableOpacity activeOpacity={0.9} onPress={togglePlay} testID="video-bubble" style={styles.videoWrap}>
          <VideoView
            player={player}
            style={styles.videoPlayer}
            contentFit="cover"
            nativeControls={false}
          />

          {/* Center play/pause overlay */}
          <View style={styles.videoCenterOverlay} pointerEvents="none">
            <View style={styles.videoPlayBtn}>
              <Feather
                name={isPlaying ? 'pause' : 'play'}
                size={22}
                color="#0F172A"
                style={isPlaying ? undefined : { marginLeft: 3 }}
              />
            </View>
          </View>

          {/* Top-right fullscreen */}
          <TouchableOpacity
            style={styles.videoFullscreenBtn}
            onPress={(event) => {
              event.stopPropagation?.();
              setViewerOpen(true);
            }}
            hitSlop={6}
            testID="video-fullscreen-btn"
          >
            <Feather name="maximize-2" size={14} color={Colors.white} />
          </TouchableOpacity>

          {/* Bottom-left elapsed/duration pill */}
          <View style={styles.videoTimePill}>
            <Text style={styles.videoTimePillText}>{timeLabel}</Text>
          </View>
        </TouchableOpacity>

        {/* Caption (if any) */}
        {msg.text ? <RichMessageText text={msg.text} textStyle={[textStyle, styles.imageCaption]} /> : null}

        {/* Subtitles / transcription */}
        <TranscriptionPill msg={msg} />
      </View>

      {/* Fullscreen viewer */}
      <VideoViewer visible={viewerOpen} onClose={() => setViewerOpen(false)} uri={src} initialPositionMs={posMs} msg={msg} />
    </>
  );
}

function VideoViewer({
  visible,
  onClose,
  uri,
  initialPositionMs,
  msg,
}: {
  visible: boolean;
  onClose: () => void;
  uri: string;
  initialPositionMs?: number;
  msg?: any;
}) {
  // expo-video: create a player only when the modal is open. We pass uri
  // as the source — when the modal closes, the player is still around
  // (managed by the hook), so we explicitly pause on close.
  const player = useVideoPlayer(visible ? { uri } : null, (p) => {
    try {
      p.loop = false;
    } catch {}
    try {
      // expo-video only emits `timeUpdate` when this interval is > 0. Without
      // it the caption overlay never advances (posMs stays at 0), so the live
      // subtitles appear frozen. ~4 updates/sec keeps them in sync smoothly.
      p.timeUpdateEventInterval = 0.25;
    } catch {}
  });
  const [posMs, setPosMs] = useState(0);
  const [segments, setSegments] = useState<TranscriptionSegment[] | null>(null);

  // Resolve segments: prefer message field, fall back to local cache (keyed by storageId).
  useEffect(() => {
    if (!visible) return;
    const inline = Array.isArray(msg?.transcriptionSegments) ? msg.transcriptionSegments : null;
    if (inline && inline.length > 0) {
      setSegments(inline);
      return;
    }
    const storageId = msg?.storageId || msg?.mediaStorageId;
    if (!storageId) {
      setSegments(null);
      return;
    }
    let alive = true;
    (async () => {
      const cached = await getCachedTranscription(String(storageId));
      if (alive) setSegments(cached?.segments && cached.segments.length > 0 ? cached.segments : null);
    })();
    return () => {
      alive = false;
    };
  }, [visible, msg]);

  // On open, seek to the position the bubble was at + auto-play.
  useEffect(() => {
    if (!visible || !player) return;
    const t = setTimeout(async () => {
      try {
        if (initialPositionMs && initialPositionMs > 200) {
          if (typeof player.seekTo === 'function') {
            await player.seekTo(initialPositionMs / 1000);
          } else {
            player.currentTime = initialPositionMs / 1000;
          }
        }
        player.play();
      } catch {}
    }, 200);
    return () => clearTimeout(t);
  }, [visible, initialPositionMs, player]);

  // Listen for time updates to drive the caption overlay.
  useEffect(() => {
    if (!player || !visible) return;
    const timeSub = player.addListener('timeUpdate', (event: any) => {
      const current = typeof event?.currentTime === 'number' ? event.currentTime : player.currentTime;
      if (typeof current === 'number') {
        setPosMs(current * 1000);
      }
    });
    return () => {
      try {
        timeSub.remove();
      } catch {}
    };
  }, [player, visible]);

  // Stop playback when modal closes.
  useEffect(() => {
    if (!visible && player) {
      try {
        player.pause();
      } catch {}
    }
  }, [visible, player]);

  // Find the segment whose [start, end] range contains the current position.
  const activeCaption = useMemo(() => {
    if (!segments || segments.length === 0) return null;
    const sec = posMs / 1000;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (sec >= seg.start && sec <= seg.end) {
        const text = (seg.text || '').trim();
        return text || null;
      }
    }
    return null;
  }, [segments, posMs]);

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewerWrap} testID="video-viewer">
        <VideoView
          player={player}
          style={styles.viewerVideo}
          contentFit="contain"
          nativeControls
        />

        {/* Time-synced caption overlay */}
        {activeCaption ? (
          <View style={styles.videoCaptionWrap} pointerEvents="none" testID="video-caption-overlay">
            <View style={styles.videoCaptionBubble}>
              <Text style={styles.videoCaptionText}>{activeCaption}</Text>
            </View>
          </View>
        ) : null}

        <TouchableOpacity style={styles.viewerClose} onPress={onClose} hitSlop={12} testID="video-viewer-close">
          <Feather name="x" size={28} color={Colors.white} />
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

function VoiceMessage({ msg, e2eeStatus, isMine }: { msg: any; e2eeStatus: E2EEStatus | null; isMine: boolean }) {
  const totalSec = getMessageDurationSec(msg);
  const { url: src, error: srcError } = useDecryptedMediaUrl(msg, e2eeStatus);
  useAutoDownloadMedia({ msg, isMine, src, mediaType: msg?.type === 'audio' ? 'audio' : 'voice' });

  // expo-audio: AudioPlayer instance for THIS voice bubble's playback.
  const playerRef = useRef<AudioPlayer | null>(null);
  const statusListenerRef = useRef<{ remove: () => void } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [posSec, setPosSec] = useState(0);

  useEffect(() => {
    return () => {
      const player = playerRef.current;
      if (CURRENT_SOUND === player) {
        CURRENT_SOUND = null;
        CURRENT_STOP = null;
      }
      playerRef.current = null;
      try {
        statusListenerRef.current?.remove?.();
      } catch {}
      statusListenerRef.current = null;
      if (player) {
        try {
          player.pause();
        } catch {}
        try {
          player.remove();
        } catch {}
      }
    };
  }, []);

  const stopOtherSounds = () => {
    if (CURRENT_SOUND && CURRENT_SOUND !== playerRef.current) {
      try {
        CURRENT_SOUND.pause();
      } catch {}
      if (CURRENT_STOP) CURRENT_STOP();
    }
  };

  const toggle = async () => {
    if (!src) return;
    try {
      stopOtherSounds();
      let player = playerRef.current;
      if (!player) {
        // Create + start a fresh player. expo-audio: createAudioPlayer
        // replaces Audio.Sound.createAsync. We then subscribe to
        // 'playbackStatusUpdate' for play/pause/position events.
        const newPlayer = createAudioPlayer({ uri: src } as AudioSource);
        try {
          newPlayer.volume = 1.0;
        } catch {}
        const listener = newPlayer.addListener('playbackStatusUpdate', (status: any) => {
          if (!status) return;
          if (typeof status.isLoaded === 'boolean' && !status.isLoaded) return;
          setIsPlaying(!!status.playing);
          const pos = typeof status.currentTime === 'number'
            ? status.currentTime
            : typeof status.positionMillis === 'number'
              ? status.positionMillis / 1000
              : 0;
          setPosSec(pos);
          if (status.didJustFinish) {
            // Spec: voice notes play once. Stop and reset to start so
            // the user can replay by tapping again.
            setIsPlaying(false);
            setPosSec(0);
            try {
              newPlayer.pause();
            } catch {}
            try {
              if (typeof newPlayer.seekTo === 'function') {
                newPlayer.seekTo(0);
              } else {
                newPlayer.currentTime = 0;
              }
            } catch {}
            if (CURRENT_SOUND === newPlayer) {
              CURRENT_SOUND = null;
              CURRENT_STOP = null;
            }
          }
        });
        statusListenerRef.current = listener;
        try {
          newPlayer.play();
        } catch {}
        player = newPlayer;
        playerRef.current = newPlayer;
        CURRENT_SOUND = newPlayer;
        CURRENT_STOP = () => setIsPlaying(false);
      } else {
        // Toggle existing player.
        const playing = !!player.playing;
        if (playing) {
          try {
            player.pause();
          } catch {}
        } else {
          // If we reached the end, rewind before playing again.
          try {
            const dur = typeof player.duration === 'number' ? player.duration : 0;
            const cur = typeof player.currentTime === 'number' ? player.currentTime : 0;
            if (dur > 0 && cur >= dur - 0.05) {
              if (typeof player.seekTo === 'function') {
                await player.seekTo(0);
              } else {
                player.currentTime = 0;
              }
            }
          } catch {}
          try {
            player.play();
          } catch {}
          CURRENT_SOUND = player;
          CURRENT_STOP = () => setIsPlaying(false);
        }
      }
    } catch {}
  };

  const progress = totalSec > 0 ? Math.min(1, posSec / totalSec) : 0;
  const remaining = Math.max(0, Math.ceil(totalSec - posSec));

  if (!src) {
    return (
      <View style={styles.voiceWrap} testID="voice-loading-state">
        <View style={styles.voiceHeaderRow}>
          <Feather name="mic" size={12} color={Colors.primary} />
          <Text style={styles.voiceHeaderLabel}>Voice Message</Text>
        </View>
        <View style={styles.voiceBody}>
          <View style={styles.voicePlayBtnLoading}>
            {srcError ? (
              <Feather name="lock" size={14} color={Colors.danger} />
            ) : (
              <ActivityIndicator size="small" color={Colors.primary} />
            )}
          </View>
          <View style={styles.voiceBar}>
            <View style={styles.voiceProgress} />
          </View>
          <Text style={styles.voiceDuration}>{fmtDur(totalSec)}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.voiceWrap} testID="voice-message-body">
      <View style={styles.voiceHeaderRow}>
        <Feather name="mic" size={12} color={Colors.primary} />
        <Text style={styles.voiceHeaderLabel}>Voice Message</Text>
      </View>
      <View style={styles.voiceBody}>
        <TouchableOpacity onPress={toggle} style={styles.voicePlayBtn} testID="voice-play">
          <Feather name={isPlaying ? 'pause' : 'play'} size={16} color={Colors.white} />
        </TouchableOpacity>
        <View style={styles.voiceBar}>
          <View style={[styles.voiceProgress, { width: `${progress * 100}%` }]} />
        </View>
        <Text style={styles.voiceDuration}>{fmtDur(remaining)}</Text>
      </View>
      <TranscriptionPill msg={msg} />
    </View>
  );
}

/**
 * Transcription pill — renders below voice and video bubbles when the
 * message carries a transcription. Mirrors the web app's design exactly:
 * a small language tag on top, then the transcribed text in a light card.
 */
function TranscriptionPill({ msg }: { msg: any }) {
  // Local AsyncStorage cache fallback — keyed by storageId — guarantees the
  // pill renders even when the Convex `messages.setTranscription` mutation
  // hasn't been deployed yet (the mobile transcription pipeline still writes
  // the result to disk on this device).
  const storageId: string | null =
    (typeof msg?.storageId === 'string' && msg.storageId) ||
    (typeof msg?.audioStorageId === 'string' && msg.audioStorageId) ||
    null;
  const [cached, setCached] = useState<CachedTranscription | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!storageId) return;
      const value = await getCachedTranscription(storageId);
      if (!cancelled) setCached(value);
    };
    void load();
    // Re-poll briefly while Whisper is running so the pill flips from
    // 'Transcribing…' to the actual text without needing a screen re-mount.
    const interval = setInterval(() => {
      if (cached?.status === 'ready' || cached?.status === 'error') return;
      void load();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [storageId, cached?.status]);

  const transcription: string =
    (typeof msg?.transcription === 'string' && msg.transcription.trim()) ||
    (cached?.text || '');
  const language: string =
    (typeof msg?.transcriptionLanguage === 'string' && msg.transcriptionLanguage) ||
    (cached?.language || '');
  const messageStatus: string | undefined =
    typeof msg?.transcriptionStatus === 'string' ? msg.transcriptionStatus : undefined;
  const isPending = messageStatus === 'pending' || (!transcription && cached?.status === 'pending');
  const isError = messageStatus === 'error' || (!transcription && cached?.status === 'error');

  if (!transcription && !isPending && !isError) return null;

  return (
    <View style={styles.transcriptPill} testID={`transcript-${msg?._id || ''}`}>
      {isPending ? (
        <View style={styles.transcriptPendingRow}>
          <ActivityIndicator size="small" color={Colors.primary} />
          <Text style={styles.transcriptPendingText}>Transcribing…</Text>
        </View>
      ) : isError ? (
        <View style={styles.transcriptPendingRow}>
          <Feather name="alert-circle" size={12} color={Colors.danger} />
          <Text style={[styles.transcriptPendingText, { color: Colors.danger }]}>
            Transcription failed
          </Text>
        </View>
      ) : (
        <>
          {language ? (
            <Text style={styles.transcriptLanguage} testID="transcript-language">
              {language}
            </Text>
          ) : null}
          <Text style={styles.transcriptText} testID="transcript-text">
            {transcription}
          </Text>
        </>
      )}
    </View>
  );
}

function PollMessage({ msg }: { msg: any }) {
  const poll = msg.poll || { question: '', options: [] };
  const myUser = useQuery(api.users.getCurrentUser, {});
  const votePoll = useMutation(api.messages.votePoll);
  const myId = myUser?._id;

  const totalVotes = useMemo(() => {
    return (poll.options || []).reduce((sum: number, option: any) => {
      return sum + (Array.isArray(option.votes) ? option.votes.length : option.voteCount || 0);
    }, 0);
  }, [poll.options]);

  const onVote = async (optionId: string) => {
    try {
      await votePoll({ messageId: msg._id, optionId });
    } catch {}
  };

  return (
    <View style={styles.pollBody} testID={`poll-message-${msg._id}`}>
      <View style={styles.pollHeaderRow}>
        <Feather name="bar-chart-2" size={14} color={Colors.primary} />
        <Text style={styles.pollLabel}>POLL</Text>
      </View>
      <Text style={styles.pollQuestion}>{poll.question || '—'}</Text>
      {(poll.options || []).map((option: any) => {
        const voteList: any[] = Array.isArray(option.votes) ? option.votes : [];
        const count = voteList.length || option.voteCount || 0;
        const mine = myId
          ? voteList.some((vote: any) => (typeof vote === 'string' ? vote : vote?.userId) === myId)
          : false;
        const pct = totalVotes > 0 ? count / totalVotes : 0;
        const optionId = option.id || option._id;

        return (
          <TouchableOpacity
            key={optionId}
            style={styles.pollOption}
            onPress={() => onVote(optionId)}
            activeOpacity={0.85}
            testID={`poll-vote-${optionId}`}
          >
            <View
              style={[
                styles.pollFill,
                { width: `${pct * 100}%`, backgroundColor: mine ? Colors.primary : Colors.primaryLight },
              ]}
            />
            <View style={styles.pollOptionRow}>
              <View style={[styles.pollRadio, mine ? styles.pollRadioOn : null]}>
                {mine ? <Feather name="check" size={12} color={Colors.white} /> : null}
              </View>
              <Text style={[styles.pollOptionText, mine ? styles.pollOptionTextMine : null]} numberOfLines={2}>
                {option.text}
              </Text>
              <Text style={styles.pollOptionCount}>{count}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
      <Text style={styles.pollTotal}>{totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}</Text>
    </View>
  );
}

function FileMessage({ msg, isMine, e2eeStatus }: { msg: any; isMine: boolean; e2eeStatus: E2EEStatus | null }) {
  const { url: src, error: srcError } = useDecryptedMediaUrl(msg, e2eeStatus);
  useAutoDownloadMedia({ msg, isMine, src, mediaType: 'document' });

  // iter-179: APKs are allowed (WhatsApp-style policy) but received ones
  // carry an explicit caution so less tech-savvy users don't sideload
  // blindly. Sender's own bubble stays clean.
  const isApk = /\.apk$/i.test(msg.fileName || '');
  const showApkCaution = isApk && !isMine;

  const onOpen = async () => {
    if (!src) return;
    try {
      await Linking.openURL(src);
    } catch {}
  };

  return (
    <View>
      <TouchableOpacity
        style={styles.fileBody}
        onPress={onOpen}
        disabled={!src}
        activeOpacity={0.7}
        testID={`file-open-${msg._id}`}
      >
        <View style={[styles.fileIcon, isMine ? styles.fileIconMine : null, !src ? { opacity: 0.5 } : null]}>
          <Feather name="file-text" size={22} color={isMine ? '#2C4129' : Colors.white} />
        </View>
        <View style={styles.flexOne}>
          <Text style={[styles.fileName, isMine ? styles.fileNameMine : null]} numberOfLines={2}>{msg.fileName || 'Document'}</Text>
          <Text style={[styles.fileMeta, isMine ? styles.fileMetaMine : null]}>
            {[formatBytes(msg.fileSize), msg.mimeType?.split('/')?.pop()?.toUpperCase()].filter(Boolean).join(' · ') || 'File'}
          </Text>
        </View>
        <Feather
          name={srcError ? 'lock' : src ? 'download' : 'loader'}
          size={20}
          color={srcError ? Colors.danger : isMine ? '#F6FFF9' : Colors.primary}
        />
      </TouchableOpacity>
      {showApkCaution ? (
        <View style={styles.apkCaution} testID={`apk-caution-${msg._id}`}>
          <Feather name="alert-triangle" size={13} color={Colors.warning} />
          <Text style={styles.apkCautionText}>
            App install file — only install if you trust the sender
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function PlaceholderBody({
  type,
  icon,
  iconLib,
  subtitle,
}: {
  type: string;
  icon: string;
  iconLib: 'feather' | 'ion' | 'mc';
  subtitle?: string;
}) {
  const Icon: any = iconLib === 'ion' ? Ionicons : iconLib === 'mc' ? MaterialCommunityIcons : Feather;
  return (
    <View style={styles.placeholderBody}>
      <View style={styles.placeholderIcon}>
        <Icon name={icon as any} size={20} color={Colors.primary} />
      </View>
      <View style={styles.flexOne}>
        <Text style={styles.placeholderTitle}>{type}</Text>
        {subtitle ? <Text style={styles.placeholderSub} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

function formatBytes(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const IMG_W = Math.min(220, Dimensions.get('window').width * 0.6);

/**
 * CallLogMessage — renders a call history entry inside a chat bubble.
 *
 * iter-134: backend (Convex) merges entries from the `callLogs` table
 * into the messages stream as virtual items with `type: 'call'` (or
 * `kind: 'call'`). The renderer is defensive about field names since
 * the backend may use slightly different shapes per call kind. Tapping
 * the card opens a fresh outgoing call of the same kind to the
 * conversation (voice/video).
 *
 * Supported fields (any of):
 *   callType | mediaKind | kind       → 'voice' | 'audio' | 'video'
 *   status   | result    | endReason  → 'missed' | 'answered' | 'completed' | 'declined' | 'rejected' | 'cancelled' | 'no_answer' | 'busy'
 *   duration | durationSec | durationMs (ms divided by 1000)
 *   conversationId (required to wire the tap-to-call-back action)
 *   direction | initiatorId  (optional explicit direction)
 */
function CallLogMessage({ msg, isMine }: { msg: any; isMine: boolean }) {
  // Resolve call media kind (voice vs video). Backends differ in naming.
  const rawKind = String(
    msg?.callType || msg?.mediaKind || (msg?.kind && msg.kind !== 'call' ? msg.kind : '') || ''
  ).toLowerCase();
  const isVideo = rawKind === 'video';

  // Resolve status — accept several possible field names + variants.
  const rawStatus = String(msg?.status || msg?.result || msg?.endReason || '').toLowerCase();
  const isMissed = rawStatus === 'missed' || rawStatus === 'no_answer' || rawStatus === 'no-answer';
  const isDeclined = rawStatus === 'declined' || rawStatus === 'rejected' || rawStatus === 'busy';
  const isCancelled = rawStatus === 'cancelled' || rawStatus === 'canceled';
  const isAnswered =
    !isMissed && !isDeclined && !isCancelled &&
    (rawStatus === 'answered' || rawStatus === 'completed' || rawStatus === 'ended' || rawStatus === '' || !!msg?.duration || !!msg?.durationSec || !!msg?.durationMs);

  // Resolve duration in seconds (0 when call never connected).
  const durationSec: number = (() => {
    if (typeof msg?.duration === 'number' && Number.isFinite(msg.duration) && msg.duration >= 0) {
      // Heuristic: values > 86400 are almost certainly ms.
      return msg.duration > 86400 ? Math.round(msg.duration / 1000) : Math.round(msg.duration);
    }
    if (typeof msg?.durationSec === 'number' && Number.isFinite(msg.durationSec)) return Math.max(0, Math.round(msg.durationSec));
    if (typeof msg?.durationMs === 'number' && Number.isFinite(msg.durationMs)) return Math.max(0, Math.round(msg.durationMs / 1000));
    return 0;
  })();

  // Direction. Prefer explicit field; fall back to isMine (senderId === me).
  const explicitDirection = typeof msg?.direction === 'string' ? msg.direction.toLowerCase() : '';
  const isOutgoing =
    explicitDirection === 'outgoing' || explicitDirection === 'out'
      ? true
      : explicitDirection === 'incoming' || explicitDirection === 'in'
        ? false
        : isMine;

  // Title + subtitle composition (WhatsApp-style).
  const callLabel = isVideo ? 'Video call' : 'Voice call';
  let titleText = '';
  let subtitleText = '';
  if (isMissed) {
    titleText = isOutgoing ? `No answer · ${callLabel.toLowerCase()}` : `Missed ${callLabel.toLowerCase()}`;
    subtitleText = 'Tap to call back';
  } else if (isDeclined) {
    titleText = isOutgoing ? `Call declined · ${callLabel.toLowerCase()}` : `Declined ${callLabel.toLowerCase()}`;
    subtitleText = 'Tap to call back';
  } else if (isCancelled) {
    titleText = isOutgoing ? `Cancelled ${callLabel.toLowerCase()}` : `Cancelled ${callLabel.toLowerCase()}`;
    subtitleText = 'Tap to call back';
  } else if (isAnswered && durationSec > 0) {
    titleText = `${isOutgoing ? 'Outgoing' : 'Incoming'} ${callLabel.toLowerCase()}`;
    subtitleText = fmtDur(durationSec);
  } else {
    titleText = `${isOutgoing ? 'Outgoing' : 'Incoming'} ${callLabel.toLowerCase()}`;
    subtitleText = 'Tap to call back';
  }

  // Visual flavor: red icon for missed, neutral otherwise.
  const accentColor = isMissed ? Colors.danger : isVideo ? '#2563EB' : Colors.primary;
  const directionIcon: 'arrow-down-left' | 'arrow-up-right' = isOutgoing ? 'arrow-up-right' : 'arrow-down-left';

  // Tap behavior: navigate to the call screen and let it auto-initiate
  // a new outgoing call of the same kind. Falls back gracefully when no
  // conversationId is attached (we just no-op rather than crash).
  const onCallBack = useCallback(() => {
    const convoId = msg?.conversationId;
    if (!convoId || typeof convoId !== 'string') return;
    try {
      // expo-router's imperative router accepts a flexible href shape.
      expoRouter.push(`/call/${convoId}?type=${isVideo ? 'video' : 'voice'}` as any);
    } catch (errorValue) {
      // Defensive no-op — never crash the bubble.
      console.warn('Call log tap navigation failed', errorValue);
    }
  }, [msg?.conversationId, isVideo]);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onCallBack}
      style={styles.callLogRow}
      testID={`call-log-${msg._id}`}
      accessibilityRole="button"
      accessibilityLabel={`${titleText}. ${subtitleText}`}
    >
      <View style={[styles.callLogIconWrap, { backgroundColor: `${accentColor}1A` }]}>
        <Feather name={isVideo ? 'video' : 'phone'} size={18} color={accentColor} />
        <View style={[styles.callLogDirectionBadge, { backgroundColor: accentColor }]}>
          <Feather name={directionIcon} size={9} color="#FFFFFF" />
        </View>
      </View>
      <View style={styles.callLogTextWrap}>
        <Text
          style={[styles.callLogTitle, isMissed ? { color: Colors.danger } : null]}
          numberOfLines={1}
        >
          {titleText}
        </Text>
        <Text style={styles.callLogSubtitle} numberOfLines={1}>
          {subtitleText}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bubbleRow: { marginVertical: 5, flexDirection: 'row', position: 'relative' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  // iter-166 system message pill (Identity Rework numberChanged + future kinds)
  systemRow: {
    marginVertical: 6,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  systemPill: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(61,42,0,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(61,42,0,0.1)',
    alignItems: 'center',
    gap: 2,
  },
  systemText: {
    fontSize: 12,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 17,
  },
  systemTime: {
    fontSize: 10,
    color: Colors.textMuted,
    marginTop: 1,
  },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(61,42,0,0.08)',
  },
  bubbleMine: { backgroundColor: Colors.bubbleOut, borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: Colors.bubbleIn, borderBottomLeftRadius: 4 },
  bubbleImage: { padding: 5 },
  bubbleText: { fontSize: FontSize.sm, lineHeight: 20, color: Colors.textPrimary },
  encryptedRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  encryptedText: { fontSize: 10, fontWeight: FontWeight.semibold },
  // iter-134: call log entry card (rendered when msg.type === 'call').
  // Lives inside the existing bubble shell — only the body content changes.
  callLogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 180,
    paddingVertical: 2,
  },
  callLogIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  callLogDirectionBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  callLogTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  callLogTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
  },
  callLogSubtitle: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', marginTop: 6 },
  bubbleTime: { fontSize: 11, color: Colors.textMuted },
  bubbleTimeOverlay: { color: Colors.white, fontSize: 11, fontWeight: FontWeight.medium },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginLeft: 4,
  },
  transcriptPill: {
    marginTop: 8,
    padding: 8,
    paddingHorizontal: 10,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(34,197,94,0.10)',
    borderLeftWidth: 3,
    borderLeftColor: '#22c55e',
  },
  transcriptLanguage: {
    fontSize: 10,
    color: '#16a34a',
    fontWeight: FontWeight.bold,
    textTransform: 'lowercase',
    letterSpacing: 0.3,
    marginBottom: 3,
  },
  transcriptText: {
    fontSize: 13,
    color: Colors.textPrimary,
    lineHeight: 18,
  },
  transcriptPendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  transcriptPendingText: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },
  quoteBlock: {
    flexDirection: 'row',
    backgroundColor: 'rgba(61,42,0,0.08)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 7,
    marginBottom: 8,
    gap: 7,
  },
  quoteAccent: { width: 3, borderRadius: 2, backgroundColor: Colors.primary },
  quoteName: { fontSize: 12, fontWeight: FontWeight.bold, color: Colors.primary },
  quoteText: { fontSize: 13, lineHeight: 18, color: Colors.textSecondary },
  imageWrap: { position: 'relative' },
  image: { width: IMG_W, height: IMG_W, borderRadius: Radius.md, backgroundColor: Colors.borderLight },
  imagePlaceholder: { width: IMG_W, height: IMG_W, borderRadius: Radius.md, backgroundColor: Colors.borderLight, alignItems: 'center', justifyContent: 'center' },
  imageCaption: { marginTop: 8 },
  imageTimeOverlay: { position: 'absolute', right: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  reactionsRow: { position: 'absolute', bottom: -10, flexDirection: 'row', gap: 4 },
  reactionsRowMine: { right: 8 },
  reactionsRowOther: { left: 8 },
  reactionChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 12, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, gap: 2 },
  reactionChipMine: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  reactionChipEmoji: { fontSize: 12 },
  reactionChipCount: { fontSize: 10, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  placeholderBody: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 },
  linkLeadText: { marginBottom: 10 },
  linkCard: {
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.08)',
    padding: 10,
  },
  linkCardMine: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  linkCardTitle: { fontSize: 14, fontWeight: FontWeight.bold },
  linkCardDomain: { marginTop: 2, fontSize: 12 },
  linkCardPath: { marginTop: 2, fontSize: 11 },
  linkCardActionRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  linkCardActionText: { fontSize: 11, fontWeight: FontWeight.medium },
  // iter-218: malicious-link warning rendered as italic in-bubble text
  // (matches the user's canonical "This message was removed for security
  // reasons" UX from the screenshot). NO red panel — the bubble keeps
  // its normal background so the conversation flow stays intact.
  maliciousMessageText: {
    fontStyle: 'italic',
    opacity: 0.9,
  },
  placeholderIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  placeholderTitle: { fontSize: 15, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  placeholderSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  voiceWrap: { paddingVertical: 4, minWidth: 200 },
  voiceHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  voiceHeaderLabel: { fontSize: 10, fontWeight: FontWeight.bold, color: Colors.primary, letterSpacing: 0.5 },
  voiceBody: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  voicePlayBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  voicePlayBtnLoading: { width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  voiceBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.12)', overflow: 'hidden' },
  voiceProgress: { height: '100%', backgroundColor: Colors.primary },
  voiceDuration: { fontSize: 11, color: Colors.textSecondary, fontVariant: ['tabular-nums'], minWidth: 30 },
  pollBody: { paddingVertical: 2, minWidth: 220, gap: 6 },
  pollHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pollLabel: { fontSize: 10, fontWeight: FontWeight.bold, color: Colors.primary, letterSpacing: 1 },
  pollQuestion: { fontSize: 15, fontWeight: FontWeight.semibold, color: Colors.textPrimary, marginBottom: 4 },
  pollOption: { borderRadius: 10, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.04)', marginVertical: 2, position: 'relative' },
  pollFill: { position: 'absolute', left: 0, top: 0, bottom: 0, opacity: 0.45 },
  pollOptionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  pollRadio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: Colors.textMuted, alignItems: 'center', justifyContent: 'center' },
  pollRadioOn: { borderColor: Colors.primary, backgroundColor: Colors.primary },
  pollOptionText: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary },
  pollOptionTextMine: { fontWeight: FontWeight.semibold },
  pollOptionCount: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.semibold, minWidth: 20, textAlign: 'right' },
  pollTotal: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  fileBody: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, minWidth: 200 },
  fileIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#8B5CF6', alignItems: 'center', justifyContent: 'center' },
  fileIconMine: { backgroundColor: '#E3F2D7' },
  fileName: { fontSize: 14, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  fileNameMine: { color: '#F6FFF9' },
  apkCaution: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: Colors.warningLight,
  },
  apkCautionText: {
    flex: 1,
    fontSize: 11,
    fontWeight: FontWeight.medium,
    color: '#92400E',
  },
  fileMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  fileMetaMine: { color: 'rgba(246,255,249,0.78)' },
  viewerWrap: { flex: 1, backgroundColor: '#000' },
  viewerBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
  viewerVideo: { width: '100%', height: '100%' },
  viewerClose: { position: 'absolute', top: 48, right: 16, padding: 8, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 20 },
  // iter-125: bottom action toolbar for full-screen photo viewer
  viewerToolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 24,
    paddingTop: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  viewerAction: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    minHeight: 48,
  },
  viewerActionLabel: {
    color: Colors.white,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    textAlign: 'center',
  },

  /* ── Time-synced video captions ── */
  videoCaptionWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 64,
    alignItems: 'center',
  },
  videoCaptionBubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.75)',
    maxWidth: '90%',
  },
  videoCaptionText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: FontWeight.semibold,
    textAlign: 'center',
    lineHeight: 22,
  },

  /* ── Video bubble ── */
  videoWrap: {
    position: 'relative',
    width: IMG_W,
    height: Math.round(IMG_W * 1.33),
    borderRadius: Radius.md,
    overflow: 'hidden',
    backgroundColor: '#0F172A',
  },
  videoPlayer: {
    width: '100%',
    height: '100%',
  },
  videoPlaceholder: {
    width: IMG_W,
    height: Math.round(IMG_W * 1.33),
    borderRadius: Radius.md,
    backgroundColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoCenterOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoPlayBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoFullscreenBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoTimePill: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  videoTimePillText: {
    color: Colors.white,
    fontSize: 11,
    fontWeight: FontWeight.semibold,
    fontVariant: ['tabular-nums'],
  },
  richTextBold: { fontWeight: FontWeight.bold },
  // In-conversation search highlight (iter-220). Every occurrence of the
  // search term gets a yellow marker; the message the up/down navigator is
  // currently focused on uses the brighter `Active` variant + a bubble outline
  // so it stands out among the other matches.
  searchHighlight: { backgroundColor: '#FDE68A', color: '#1A1A1A' },
  searchHighlightActive: { backgroundColor: '#FACC15', color: '#1A1A1A', fontWeight: FontWeight.bold },
  phoneLink: { textDecorationLine: 'underline', fontWeight: FontWeight.bold },
  bubbleActiveSearchMatch: { borderWidth: 2, borderColor: '#F59E0B' },
  deletedBubble: { opacity: 0.55 },
  // bubbleMultiSelected — visual feedback when this bubble is in the
  // multi-select forwarding set (iter-99). Light green tint + a
  // primary-colour border ring. Works for both incoming + outgoing bubbles.
  bubbleMultiSelected: {
    borderWidth: 2,
    borderColor: Colors.primary,
    backgroundColor: 'rgba(74, 222, 128, 0.18)',
  },
  // multiSelectCheckOverlay — checkmark badge in the top-right
  // corner of the bubble while selected.
  multiSelectCheckOverlay: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  // deletedTimeText — italic + slightly muted to match the web app's
  // "This message was deleted | 6:45 PM" pattern (iter-98 screenshot).
  deletedTimeText: { fontStyle: 'italic', opacity: 0.85 },
  deletedContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deletedText: { fontStyle: 'italic', color: Colors.textMuted },
  // editedBadge — italic "edited HH:MM" rendered before the real time
  // stamp inside the bubble meta row. Per web-app design parity.
  editedBadge: { fontStyle: 'italic', marginRight: 6, opacity: 0.85 },
  starIcon: { marginRight: 4 },
  tickIcon: { marginLeft: 4 },
  flexOne: { flex: 1 },
});