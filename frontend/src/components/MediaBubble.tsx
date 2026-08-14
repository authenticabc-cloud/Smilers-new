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
import Slider from '@react-native-community/slider';
import {
  createAudioPlayer,
  type AudioPlayer,
  type AudioSource,
} from 'expo-audio';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { openGalleryFor, isGalleryHostMounted } from '../lib/chat/mediaGalleryStore';
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
import ZoomableImage from './ZoomableImage';
import BubbleErrorBoundary from './BubbleErrorBoundary';
import { getMessageDurationSec } from '../hooks/useResolvedStorageUrl';
import { useDecryptedMediaUrl } from '../hooks/useDecryptedMediaUrl';
import type { E2EEStatus } from '../hooks/useConversationE2EE';
import { getCachedTranscription, clearCachedTranscription, type CachedTranscription, type TranscriptionSegment } from '../lib/triggerTranscription';
import { SharedContactBubble } from './chat/SharedContactBubble';
import { ForwardedTag } from './chat/ForwardedTag';
import { getLanguageByCode, getEffectivePreferredLanguage } from '../lib/languages';
import { getOrCreateVoiceTranslation, type VoiceTranslation } from '../lib/voiceTranslation';
import { ensureVoicePlaybackMode } from '../lib/audio/voicePlaybackMode';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  startPlaybackNotification,
  stopPlaybackNotification,
  setPlaybackStopHandler,
} from '../lib/audio/playbackNotification';
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

// iter-292 MEDIA CONSUMPTION TRACKING.
// Records when a RECIPIENT actually plays / watches / opens / views an
// incoming media message, so the sender's "Message Info" sheet can show
// "Played/Watched/Viewed/Opened by …" separately from "Read by …".
// Self-contained per media component (no prop threading): each player calls
// the returned `markConsumed()` on its first real interaction.
//   • Only fires for INCOMING media (`!isMine`).
//   • Idempotent — guarded by a per-instance ref so repeated plays don't spam.
//   • Fully graceful: if the backend hasn't deployed `messages.markConsumed`
//     yet, the call rejects and is swallowed (UI never breaks).
function useMarkConsumedOnce(msg: any, isMine: boolean): () => void {
  const markConsumed = useMutation((api as any).messages?.markConsumed);
  const firedRef = useRef(false);
  return useCallback(() => {
    if (firedRef.current) return;
    if (isMine) return;
    const messageId = msg?._id;
    if (!messageId || typeof markConsumed !== 'function') return;
    firedRef.current = true;
    try {
      void Promise.resolve(markConsumed({ messageId })).catch(() => {});
    } catch {
      /* backend mutation not deployed — ignore */
    }
  }, [msg?._id, isMine, markConsumed]);
}


// Module-level "currently playing" audio singleton — guarantees only one
// voice message plays at a time. Uses expo-audio's AudioPlayer (expo-av
// has been deprecated in SDK 54).
let CURRENT_SOUND: AudioPlayer | null = null;
let CURRENT_STOP: (() => void) | null = null;

// Auto-advance registry — every mounted voice message registers its play()
// function keyed by message id + creation time. When one finishes, we start
// the next UNPLAYED voice message (by chronological order) so they chain like
// WhatsApp without ever re-playing notes you've already heard.
type VoiceReg = { id: string; creationTime: number; play: () => void };
const VOICE_REGISTRY = new Map<string, VoiceReg>();

// Persisted set of voice-note ids the user has already played, so the
// auto-advance "seen filter" survives across sessions. Loaded once at startup.
const PLAYED_VOICE_IDS = new Set<string>();
const PLAYED_VOICE_KEY = 'sml.playedVoiceIds.v1';
let playedVoiceLoaded = false;
// Subscribers (voice bubbles) that re-check their played state when it changes.
const playedVoiceListeners = new Set<() => void>();
function notifyPlayedVoiceChange(): void {
  playedVoiceListeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}
async function loadPlayedVoiceIds(): Promise<void> {
  if (playedVoiceLoaded) return;
  playedVoiceLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(PLAYED_VOICE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach((x) => PLAYED_VOICE_IDS.add(String(x)));
    }
  } catch {}
  notifyPlayedVoiceChange();
}
void loadPlayedVoiceIds();
function markVoicePlayed(id: string): void {
  if (!id || PLAYED_VOICE_IDS.has(id)) return;
  PLAYED_VOICE_IDS.add(id);
  try {
    // Cap to the most recent 2000 ids to keep the stored blob small.
    const capped = Array.from(PLAYED_VOICE_IDS).slice(-2000);
    void AsyncStorage.setItem(PLAYED_VOICE_KEY, JSON.stringify(capped));
  } catch {}
  notifyPlayedVoiceChange();
}

function playNextVoiceAfter(creationTime: number, currentId: string): void {
  let best: VoiceReg | null = null;
  for (const reg of VOICE_REGISTRY.values()) {
    if (reg.id === currentId) continue;
    if (PLAYED_VOICE_IDS.has(reg.id)) continue; // seen filter: skip already-played
    if (reg.creationTime > creationTime && (!best || reg.creationTime < best.creationTime)) {
      best = reg;
    }
  }
  if (best) {
    try {
      best.play();
    } catch {}
  }
}

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
  // iter-291: tapping the quoted reply preview jumps to (and highlights) the
  // original message it references. `onPressParent` is wired only when a
  // parent message exists. `isJumpHighlighted` briefly flashes this bubble
  // when it is the target of such a jump.
  onPressParent?: () => void;
  isJumpHighlighted?: boolean;
  // iter-337: resolved sender name for GROUP incoming bubbles (device-contact
  // name first, Google/account name fallback). Undefined → not shown.
  senderDisplayName?: string;
  // iter-323 "Receive once" 🔂: when the backend hides a duplicate file for
  // this viewer (`msg.receiveOnceHidden === true`), we render a tappable
  // footprint instead of the media. Tapping fires this so the parent can offer
  // "View original" / "Allow receipt".
  onReceiveOncePress?: () => void;
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
  onPressParent,
  isJumpHighlighted,
  senderDisplayName,
  onReceiveOncePress,
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
    if (!msg?.deletedAt && msg?.isDeleted !== true) return;
    const id = String(msg?._id || '');
    if (!id) return;
    purgeMessageMedia(id).catch(() => {});
  }, [msg?.deletedAt, msg?.isDeleted, msg?._id]);

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

  // Delivery status (sender's own messages only) — matches the WEB app
  // EXACTLY (verified from the deployed web bundle, chat/page.tsx:3205-3208):
  //   RED    → local outbox: queued offline, never reached the server
  //   BLUE   → read      (readBy, excl. sender, length > 0)        "Read"
  //   GREEN  → delivered (deliveredTo, excl. sender, length > 0)   "Delivered"
  //   YELLOW → sent, not yet delivered to anyone                   "Sent"
  // Group chats use ANY-recipient logic (`.length > 0`).
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

  // iter-323 "Receive once" 🔂: a duplicate file the backend has hidden for
  // this viewer. Show a tappable footprint (like the deleted tombstone) —
  // tapping opens "View original / Allow receipt". mediaUrl is omitted by the
  // server when hidden, so we must return BEFORE any media-render path.
  if (msg.receiveOnceHidden === true) {
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <TouchableOpacity
          activeOpacity={0.75}
          onPress={onReceiveOncePress}
          style={[
            styles.bubble,
            isMine ? styles.bubbleMine : styles.bubbleOther,
            bubbleDynamicStyle,
            styles.deletedBubble,
          ]}
          testID={`message-bubble-receive-once-${msg._id}`}
        >
          <View style={styles.receiveOnceRow}>
            <Feather name="rotate-cw" size={13} color={Colors.textMuted} />
            <Text style={[styles.bubbleText, bubbleTextStyle, styles.deletedText]}>
              file deleted for multiple receipt
            </Text>
          </View>
          <View style={styles.bubbleMeta}>
            <Text style={[styles.bubbleTime, styles.deletedTimeText, { color: metaTextColor }]}>
              {timeStr}
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  if (msg.deletedAt || msg.isDeleted === true) {
    // Web-app parity: the web uses a unified `isDeleted` boolean (set
    // per-viewer for delete-for-me / delete-for-receiver, and globally for
    // delete-for-everyone). Mobile previously only checked `deletedAt`, so
    // per-user deletes (and some media deletes) never showed the tombstone.
    // Faded bubble, italic "This message was deleted", timestamp on the right.
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
          isJumpHighlighted ? styles.bubbleJumpHighlight : null,
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

        <ForwardedTag msg={msg} color={isOutgoing ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.5)'} />

        {/* iter-337: group sender name — only on incoming bubbles when the
            parent resolved a name (device-contact name first, else Google). */}
        {!isMine && senderDisplayName ? (
          <Text style={styles.senderNameLabel} numberOfLines={1}>
            {senderDisplayName}
          </Text>
        ) : null}

        {/* iter-293: status-reply indicator. When a DM was sent as a reply to
            someone's status, show a small banner so BOTH sender & receiver can
            see it references a status (not a normal DM). Reads the
            `replyToStatusId` link (web-parity field) and any status preview
            the backend echoes back. */}
        {(msg.replyToStatusId || msg.replyStatusId || msg.statusReplyTo) ? (
          <View style={[styles.statusReplyBanner, { borderLeftColor: isOutgoing ? '#F6FFF9' : Colors.primary }]}>
            <Ionicons
              name="ellipse"
              size={10}
              color={isOutgoing ? '#F6FFF9' : Colors.primary}
              style={styles.statusReplyDot}
            />
            <View style={styles.flexOne}>
              <Text style={[styles.statusReplyLabel, { color: isOutgoing ? '#F6FFF9' : Colors.primary }]} numberOfLines={1}>
                {isMine ? 'You replied to a status' : 'Replied to your status'}
              </Text>
              {(msg.replyToStatusText || msg.statusReplyText || msg.replyToStatusCaption) ? (
                <Text
                  style={[styles.statusReplyPreview, { color: isOutgoing ? 'rgba(246,255,249,0.85)' : Colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {msg.replyToStatusText || msg.statusReplyText || msg.replyToStatusCaption}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {parentMsg ? (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={onPressParent}
            disabled={!onPressParent}
            style={styles.quoteBlock}
            testID={`reply-quote-${msg._id}`}
          >
            <View style={styles.quoteAccent} />
            <View style={styles.flexOne}>
              <Text style={styles.quoteName}>
                {parentMsg.senderName || (parentMsg.senderId === myUserId ? 'You' : 'Reply')}
              </Text>
              <Text style={styles.quoteText} numberOfLines={2}>
                {stripRichTextTags(parentMsg.text) || `[${parentMsg.type}]`}
              </Text>
            </View>
          </TouchableOpacity>
        ) : null}

        <BubbleBody msg={msg} timeStr={timeStr} textStyle={[bubbleTextStyle, { color: messageTextColor }]} isMine={isMine} e2eeStatus={e2eeStatus || null} searchTerm={searchTerm} isActiveSearchMatch={isActiveSearchMatch} onLongPress={onLongPress} />

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

function BubbleBody({ msg, timeStr, textStyle, isMine, e2eeStatus, searchTerm, isActiveSearchMatch, onLongPress }: { msg: any; timeStr: string; textStyle?: any; isMine: boolean; e2eeStatus: E2EEStatus | null; searchTerm?: string | null; isActiveSearchMatch?: boolean; onLongPress?: () => void }) {
  return (
    <BubbleErrorBoundary fallbackLabel="Message couldn't load">
      <BubbleBodyInner msg={msg} timeStr={timeStr} textStyle={textStyle} isMine={isMine} e2eeStatus={e2eeStatus} searchTerm={searchTerm} isActiveSearchMatch={isActiveSearchMatch} onLongPress={onLongPress} />
    </BubbleErrorBoundary>
  );
}

function BubbleBodyInner({ msg, timeStr, textStyle, isMine, e2eeStatus, searchTerm, isActiveSearchMatch, onLongPress }: { msg: any; timeStr: string; textStyle?: any; isMine: boolean; e2eeStatus: E2EEStatus | null; searchTerm?: string | null; isActiveSearchMatch?: boolean; onLongPress?: () => void }) {
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
        return <LinkPreviewMessage msg={msg} textStyle={textStyle} isMine={isMine} onLongPress={onLongPress} />;
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
          segment.italic ? styles.richTextItalic : null,
          segment.underline ? styles.richTextUnderline : null,
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

function LinkPreviewMessage({ msg, textStyle, isMine, onLongPress }: { msg: any; textStyle?: any; isMine: boolean; onLongPress?: () => void }) {
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
    <TouchableOpacity
      onPress={onOpen}
      onLongPress={onLongPress}
      delayLongPress={250}
      activeOpacity={0.82}
      testID={`link-preview-${msg._id}`}
    >
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
  const markConsumed = useMarkConsumedOnce(msg, isMine);

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
      <TouchableOpacity activeOpacity={0.9} onPress={() => { markConsumed(); if (isGalleryHostMounted() && msg?._id) { openGalleryFor(String(msg._id)); } else { setOpen(true); } }} testID="image-bubble" disabled={loading}>
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
        <View style={styles.viewerBackdrop}>
          <ZoomableImage uri={uri} onClose={onClose} />
        </View>
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
  const markConsumed = useMarkConsumedOnce(msg, isMine);
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

  // Mark this incoming video as "Watched" the first time the recipient plays it.
  const handleTogglePlay = useCallback(() => {
    if (player && !player.playing) markConsumed();
    void togglePlay();
  }, [player, togglePlay, markConsumed]);

  // Seek to an absolute position (seconds) — used by the scrubber + 5s skips.
  const seekVideoSec = useCallback(
    (sec: number) => {
      if (!player) return;
      const durS =
        typeof player.duration === 'number' && player.duration > 0
          ? player.duration
          : durMs / 1000;
      const clamped = Math.max(0, Math.min(sec, durS > 0 ? durS : sec));
      try {
        if (typeof player.seekTo === 'function') {
          void player.seekTo(clamped);
        } else {
          player.currentTime = clamped;
        }
      } catch {}
      setPosMs(clamped * 1000);
    },
    [player, durMs],
  );

  // iter-314: one-tap Save-to-gallery directly on the video bubble (WhatsApp
  // parity) so users don't have to open the fullscreen viewer first.
  const convex = useConvex();
  const [savingVideo, setSavingVideo] = useState(false);
  const handleSaveVideo = useCallback(async () => {
    if (savingVideo) return;
    setSavingVideo(true);
    try {
      const ok = await saveMessageMediaToGallery({ client: convex as any, message: msg, localUri: src });
      if (ok) Alert.alert('Saved', 'Video saved to your gallery.');
    } finally {
      setSavingVideo(false);
    }
  }, [savingVideo, convex, msg, src]);

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
        <TouchableOpacity activeOpacity={0.9} onPress={handleTogglePlay} testID="video-bubble" style={styles.videoWrap}>
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
              if (isGalleryHostMounted() && msg?._id) {
                openGalleryFor(String(msg._id));
              } else {
                setViewerOpen(true);
              }
            }}
            hitSlop={6}
            testID="video-fullscreen-btn"
          >
            <Feather name="maximize-2" size={14} color={Colors.white} />
          </TouchableOpacity>

          {/* Top-right save-to-gallery (one-tap, next to fullscreen) */}
          <TouchableOpacity
            style={styles.videoSaveBtn}
            onPress={(event) => {
              event.stopPropagation?.();
              void handleSaveVideo();
            }}
            hitSlop={6}
            disabled={savingVideo}
            testID="video-save-btn"
          >
            {savingVideo ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Feather name="download" size={14} color={Colors.white} />
            )}
          </TouchableOpacity>

          {/* Bottom-left elapsed/duration pill */}
          <View style={styles.videoTimePill}>
            <Text style={styles.videoTimePillText}>{timeLabel}</Text>
          </View>
        </TouchableOpacity>

        {/* Scrubber + 5s rewind/forward (seek before, during, or after play) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
          <TouchableOpacity onPress={() => seekVideoSec(posMs / 1000 - 5)} hitSlop={8} style={{ padding: 4 }} testID="video-rewind">
            <MaterialCommunityIcons name="rewind-5" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <View style={{ flex: 1, marginHorizontal: 4 }}>
            <SeekBar positionSec={posMs / 1000} durationSec={durMs / 1000} onSeek={seekVideoSec} testIDPrefix="video" />
          </View>
          <TouchableOpacity onPress={() => seekVideoSec(posMs / 1000 + 5)} hitSlop={8} style={{ padding: 4 }} testID="video-forward">
            <MaterialCommunityIcons name="fast-forward-5" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>

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

  // iter-313: Save-to-gallery + Share actions for videos, mirroring the
  // ImageViewer toolbar. Reuses the same generic media helpers (they handle
  // video mime types + E2EE-decrypted local URIs).
  const convex = useConvex();
  const insets = useSafeAreaInsets();
  const [busyAction, setBusyAction] = useState<null | 'download' | 'share'>(null);

  const handleDownloadVideo = useCallback(async () => {
    if (busyAction) return;
    setBusyAction('download');
    try {
      const ok = await saveMessageMediaToGallery({ client: convex as any, message: msg, localUri: uri });
      if (ok) Alert.alert('Saved', 'Video saved to your gallery.');
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, convex, msg, uri]);

  const handleShareVideo = useCallback(async () => {
    if (busyAction) return;
    setBusyAction('share');
    try {
      await shareMessage({ client: convex as any, message: msg });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, convex, msg]);

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

        {/* Bottom action toolbar — Save / Share (iter-313) */}
        {msg ? (
          <View
            style={[styles.viewerToolbar, { paddingBottom: Math.max(12, insets.bottom + 8) }]}
            testID="video-viewer-toolbar"
          >
            <TouchableOpacity
              style={styles.viewerAction}
              onPress={handleDownloadVideo}
              disabled={!!busyAction}
              testID="video-viewer-download"
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
              onPress={handleShareVideo}
              disabled={!!busyAction}
              testID="video-viewer-share"
            >
              {busyAction === 'share' ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Feather name="share-2" size={22} color={Colors.white} />
              )}
              <Text style={styles.viewerActionLabel}>Share</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

// Shared draggable seek bar for audio + video bubbles. Lets the user scrub to
// any position — before, during, or after playback. Uses local `scrubbing`
// state so the thumb tracks the finger smoothly instead of fighting the
// periodic timeUpdate events.
function SeekBar({
  positionSec,
  durationSec,
  onSeek,
  dark = false,
  testIDPrefix,
}: {
  positionSec: number;
  durationSec: number;
  onSeek: (sec: number) => void;
  dark?: boolean;
  testIDPrefix: string;
}) {
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubVal, setScrubVal] = useState(0);
  const max = durationSec > 0 ? durationSec : 1;
  const value = scrubbing ? scrubVal : Math.max(0, Math.min(positionSec, max));
  return (
    <Slider
      style={{ width: '100%', height: 28 }}
      minimumValue={0}
      maximumValue={max}
      value={value}
      minimumTrackTintColor={Colors.primary}
      maximumTrackTintColor={dark ? 'rgba(255,255,255,0.35)' : Colors.border}
      thumbTintColor={dark ? Colors.white : Colors.primary}
      onValueChange={(v) => {
        setScrubbing(true);
        setScrubVal(v);
      }}
      onSlidingComplete={(v) => {
        setScrubbing(false);
        onSeek(v);
      }}
      testID={`${testIDPrefix}-seek`}
    />
  );
}

// Shared 5-second rewind / fast-forward buttons for audio + video bubbles.
function SkipButtons({
  onRewind,
  onForward,
  dark = false,
  testIDPrefix,
}: {
  onRewind: () => void;
  onForward: () => void;
  dark?: boolean;
  testIDPrefix: string;
}) {
  const color = dark ? Colors.white : Colors.textSecondary;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 32, marginTop: 2 }}>
      <TouchableOpacity onPress={onRewind} hitSlop={10} style={{ padding: 4 }} testID={`${testIDPrefix}-rewind`}>
        <MaterialCommunityIcons name="rewind-5" size={24} color={color} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onForward} hitSlop={10} style={{ padding: 4 }} testID={`${testIDPrefix}-forward`}>
        <MaterialCommunityIcons name="fast-forward-5" size={24} color={color} />
      </TouchableOpacity>
    </View>
  );
}

function VoiceMessage({ msg, e2eeStatus, isMine }: { msg: any; e2eeStatus: E2EEStatus | null; isMine: boolean }) {
  const totalSec = getMessageDurationSec(msg);
  const { url: src, error: srcError } = useDecryptedMediaUrl(msg, e2eeStatus);
  useAutoDownloadMedia({ msg, isMine, src, mediaType: msg?.type === 'audio' ? 'audio' : 'voice' });
  const markConsumed = useMarkConsumedOnce(msg, isMine);

  // sml-transcript-privacy: the SENDER can hide/show this voice note's
  // transcript for recipients at any time (api.messages.setTranscriptHidden).
  // When hidden the backend strips the transcript from recipients' reads; the
  // sender keeps their own copy. We surface a small eye toggle on the sender's
  // own bubble whenever a transcript exists.
  const setTranscriptHidden = useMutation(api.messages.setTranscriptHidden);
  const [togglingTranscript, setTogglingTranscript] = useState(false);
  const transcriptHidden = !!msg?.transcriptHidden;
  const hasTranscript =
    (typeof msg?.transcript === 'string' && msg.transcript.trim().length > 0) ||
    (typeof msg?.transcription === 'string' && msg.transcription.trim().length > 0);
  const onToggleTranscript = async () => {
    if (!isMine || !msg?._id || togglingTranscript) return;
    setTogglingTranscript(true);
    try {
      await setTranscriptHidden({ messageId: msg._id, hidden: !transcriptHidden } as any);
    } catch (e: any) {
      Alert.alert(
        'Could not update transcript',
        String(e?.data?.message || e?.message || 'Please try again.'),
      );
    } finally {
      setTogglingTranscript(false);
    }
  };

  // expo-audio: AudioPlayer instance for THIS voice bubble's playback.
  const playerRef = useRef<AudioPlayer | null>(null);
  const statusListenerRef = useRef<{ remove: () => void } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [posSec, setPosSec] = useState(0);
  // Playback speed: cycles 1x → 1.5x → 2x. Persisted only for this bubble.
  const [rate, setRate] = useState(1);
  // Unplayed indicator: true until the user has listened to this note (only
  // meaningful for received notes). Reactive to the shared played-set.
  const [voicePlayed, setVoicePlayed] = useState(() => PLAYED_VOICE_IDS.has(String(msg?._id || '')));
  useEffect(() => {
    const id = String(msg?._id || '');
    const update = () => setVoicePlayed(PLAYED_VOICE_IDS.has(id));
    update();
    playedVoiceListeners.add(update);
    return () => {
      playedVoiceListeners.delete(update);
    };
  }, [msg?._id]);
  // Stable handle the auto-advance registry calls to start THIS note.
  const startPlaybackRef = useRef<() => void>(() => {});

  useEffect(() => {
    return () => {
      const player = playerRef.current;
      playerRef.current = null;
      // Keep the ACTIVE sound playing across navigation / backgrounding.
      // Its status listener stays attached and clears CURRENT_SOUND on finish.
      if (player && CURRENT_SOUND === player) {
        return;
      }
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

  // Create the AudioPlayer + attach the status listener on first use, WITHOUT
  // auto-playing. Both play/pause (toggle) and the seek slider reuse this so
  // the user can scrub before ever pressing play.
  const ensurePlayer = (): AudioPlayer | null => {
    if (!src) return null;
    if (playerRef.current) return playerRef.current;
    const newPlayer = createAudioPlayer({ uri: src } as AudioSource);
    try {
      newPlayer.volume = 1.0;
      newPlayer.shouldCorrectPitch = true;
      newPlayer.playbackRate = rate;
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
        stopPlaybackNotification();
        // Mark this note played so the seen-filter skips it in future chains,
        // then chain to the next UNPLAYED voice message.
        markVoicePlayed(String(msg?._id || ''));
        playNextVoiceAfter(msg?._creationTime || 0, String(msg?._id || ''));
      }
    });
    statusListenerRef.current = listener;
    playerRef.current = newPlayer;
    return newPlayer;
  };

  // Start (or restart) playback of THIS note. Used by the play button and by
  // the auto-advance chain when the previous note finishes.
  const startPlayback = async () => {
    if (!src) return;
    try {
      markConsumed();
      markVoicePlayed(String(msg?._id || ''));
      stopOtherSounds();
      const player = ensurePlayer();
      if (!player) return;
      // Configure the iOS audio session for PLAYBACK *before* starting, and
      // await it. A prior recording (chat composer, diary, calls, etc.) leaves
      // the session in PlayAndRecord which routes to the earpiece at near-zero
      // volume — the "taps but doesn't play" symptom. Reapplying first fixes it.
      await ensureVoicePlaybackMode();
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
        player.shouldCorrectPitch = true;
        player.playbackRate = rate;
      } catch {}
      try {
        player.play();
      } catch {}
      CURRENT_SOUND = player;
      CURRENT_STOP = () => setIsPlaying(false);
      startPlaybackNotification('Voice message');
      setPlaybackStopHandler(() => {
        try {
          player.pause();
        } catch {}
        setIsPlaying(false);
      });
    } catch {}
  };
  startPlaybackRef.current = () => {
    void startPlayback();
  };

  // Register/unregister with the auto-advance chain.
  useEffect(() => {
    const id = String(msg?._id || '');
    if (!id) return undefined;
    VOICE_REGISTRY.set(id, {
      id,
      creationTime: typeof msg?._creationTime === 'number' ? msg._creationTime : 0,
      play: () => startPlaybackRef.current?.(),
    });
    return () => {
      VOICE_REGISTRY.delete(id);
    };
  }, [msg?._id, msg?._creationTime]);

  const toggle = async () => {
    if (!src) return;
    const player = ensurePlayer();
    if (player && player.playing) {
      try {
        player.pause();
      } catch {}
      stopPlaybackNotification();
      return;
    }
    await startPlayback();
  };

  // Cycle playback speed 1x → 1.5x → 2x and apply live if a player exists.
  const cycleRate = () => {
    setRate((prev) => {
      const next = prev >= 2 ? 1 : prev === 1 ? 1.5 : 2;
      const player = playerRef.current;
      if (player) {
        try {
          player.shouldCorrectPitch = true;
          player.playbackRate = next;
        } catch {}
      }
      return next;
    });
  };


  // Seek to an absolute position (seconds). Works before, during, or after
  // playback; creates the player lazily if needed and keeps the current
  // play/pause state.
  const seekToSec = (sec: number) => {
    const player = ensurePlayer();
    if (!player) return;
    const clamped = Math.max(0, Math.min(sec, totalSec > 0 ? totalSec : sec));
    try {
      if (typeof player.seekTo === 'function') {
        void player.seekTo(clamped);
      } else {
        player.currentTime = clamped;
      }
    } catch {}
    setPosSec(clamped);
  };

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
        {isMine && hasTranscript ? (
          <>
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              onPress={onToggleTranscript}
              disabled={togglingTranscript}
              style={styles.transcriptEyeBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              testID={`transcript-eye-${msg._id}`}
            >
              <Feather
                name={transcriptHidden ? 'eye-off' : 'eye'}
                size={13}
                color={transcriptHidden ? Colors.textMuted : Colors.primary}
              />
              <Text
                style={[
                  styles.transcriptEyeLabel,
                  { color: transcriptHidden ? Colors.textMuted : Colors.primary },
                ]}
              >
                {transcriptHidden ? 'Hidden' : 'Visible'}
              </Text>
            </TouchableOpacity>
          </>
        ) : null}
        {!isMine && !voicePlayed ? (
          <>
            <View style={{ flex: 1 }} />
            <View style={styles.voiceUnplayedDot} testID={`voice-unplayed-${msg._id}`} />
          </>
        ) : null}
      </View>
      <View style={styles.voiceBody}>
        <TouchableOpacity onPress={toggle} style={styles.voicePlayBtn} testID="voice-play">
          <Feather name={isPlaying ? 'pause' : 'play'} size={16} color={Colors.white} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginHorizontal: 6 }}>
          <SeekBar positionSec={posSec} durationSec={totalSec} onSeek={seekToSec} testIDPrefix="voice" />
        </View>
        <Text style={styles.voiceDuration}>{fmtDur(remaining)}</Text>
        <TouchableOpacity
          onPress={cycleRate}
          style={styles.voiceRateBtn}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          testID="voice-rate"
        >
          <Text style={styles.voiceRateText}>{rate === 1 ? '1x' : rate === 1.5 ? '1.5x' : '2x'}</Text>
        </TouchableOpacity>
      </View>
      <SkipButtons
        onRewind={() => seekToSec(posSec - 5)}
        onForward={() => seekToSec(posSec + 5)}
        testIDPrefix="voice"
      />
      <TranscriptionPill msg={msg} isMine={isMine} />
      <VoiceTranslationPill msg={msg} />
    </View>
  );
}

/**
 * Transcription pill — renders below voice and video bubbles when the
 * message carries a transcription. Mirrors the web app's design exactly:
 * a small language tag on top, then the transcribed text in a light card.
 */
function TranscriptionPill({ msg, isMine }: { msg: any; isMine?: boolean }) {
  // Local AsyncStorage cache fallback — keyed by storageId — guarantees the
  // pill renders even when the Convex `messages.setTranscription` mutation
  // hasn't been deployed yet (the mobile transcription pipeline still writes
  // the result to disk on this device).
  const storageId: string | null =
    (typeof msg?.storageId === 'string' && msg.storageId) ||
    (typeof msg?.audioStorageId === 'string' && msg.audioStorageId) ||
    null;
  const [cached, setCached] = useState<CachedTranscription | null>(null);

  // sml-transcript-privacy: when the SENDER hides this note's transcript, the
  // backend strips it from the recipient's read — but the recipient's phone may
  // have already transcribed the audio on-device and cached it. Purge that
  // local copy and render nothing so "hidden" truly hides it for recipients.
  // The sender always keeps their own transcript.
  const transcriptHidden = !!msg?.transcriptHidden;
  const suppressForRecipient = transcriptHidden && !isMine;
  useEffect(() => {
    if (suppressForRecipient && storageId) {
      void clearCachedTranscription(storageId);
      setCached(null);
    }
  }, [suppressForRecipient, storageId]);

  useEffect(() => {
    if (suppressForRecipient) return undefined;
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
  }, [storageId, cached?.status, suppressForRecipient]);

  // Recipient + hidden → show nothing at all.
  if (suppressForRecipient) return null;

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
      {/* Sender-side cue that recipients currently can't see this transcript. */}
      {isMine && transcriptHidden ? (
        <View style={styles.transcriptHiddenRow}>
          <Feather name="eye-off" size={11} color={Colors.textMuted} />
          <Text style={styles.transcriptHiddenText}>Hidden from recipients</Text>
        </View>
      ) : null}
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

/**
 * VoiceTranslationPill — auto-translates a RECEIVED voice note's transcript
 * into the receiver's preferred language and lets them play it aloud (synthetic
 * voice). Skipped entirely when the receiver already understands the language
 * the note was spoken in (honours their "skip / spoken languages").
 */
function VoiceTranslationPill({ msg }: { msg: any }) {
  const me = useQuery(api.users.getCurrentUser, {}) as any | null | undefined;
  const isMine = !!me?._id && String(msg?.senderId || '') === String(me._id);

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
    const interval = setInterval(() => {
      if (cached?.status === 'ready' || cached?.status === 'error') return;
      void load();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [storageId, cached?.status]);

  const transcript: string =
    (typeof msg?.transcription === 'string' && msg.transcription.trim()) || (cached?.text || '');
  const sourceLanguage: string =
    (typeof msg?.transcriptionLanguage === 'string' && msg.transcriptionLanguage) ||
    (cached?.language || '');

  // Receiver's preferred language + the set of languages they understand.
  const targetCode = getEffectivePreferredLanguage(me);
  const targetName = getLanguageByCode(targetCode)?.name || '';
  const skipCodes = useMemo<string[]>(() => {
    if (Array.isArray(me?.skipTranslationLanguages)) return me.skipTranslationLanguages;
    if (Array.isArray(me?.spokenLanguages)) return me.spokenLanguages;
    if (Array.isArray(me?.languages)) return me.languages;
    return [];
  }, [me?.skipTranslationLanguages, me?.spokenLanguages, me?.languages]);
  const skipLangNames = useMemo(
    () =>
      Array.from(
        new Set(
          skipCodes
            .map((c) => getLanguageByCode(String(c))?.name)
            .filter((n): n is string => !!n),
        ),
      ),
    [skipCodes],
  );
  const understood = useMemo(() => {
    const set = new Set<string>();
    [targetCode, ...skipCodes].forEach((c) => {
      const code = String(c || '').trim().toLowerCase();
      if (!code) return;
      set.add(code);
      const name = getLanguageByCode(code)?.name;
      if (name) set.add(name.toLowerCase());
    });
    return set;
  }, [targetCode, skipCodes]);

  const [result, setResult] = useState<VoiceTranslation | null>(null);
  const [loading, setLoading] = useState(false);

  // Skip conditions: own message, no target set, transcript not ready, or the
  // note is already in a language the receiver understands.
  const srcLower = sourceLanguage.trim().toLowerCase();
  const shouldSkip =
    isMine || !targetCode || !targetName || !transcript || (!!srcLower && understood.has(srcLower));

  useEffect(() => {
    if (shouldSkip || !storageId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getOrCreateVoiceTranslation({
      storageId,
      transcript,
      targetLangCode: targetCode,
      targetLangName: targetName,
      skipLangNames,
    })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setResult(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldSkip, storageId, transcript, targetCode, targetName]);

  // Playback of the synthesized translation. Shares the module-level
  // single-sound singleton (CURRENT_SOUND / CURRENT_STOP) with the voice-note
  // player so the two never fight over the audio session, and does NOT mutate
  // the global audio mode (the voice player relies on the platform default).
  const playerRef = useRef<AudioPlayer | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const releaseAsCurrent = useCallback(() => {
    if (CURRENT_SOUND === playerRef.current) {
      CURRENT_SOUND = null;
      CURRENT_STOP = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      const p = playerRef.current;
      playerRef.current = null;
      // Keep the ACTIVE translation playing across navigation / backgrounding.
      if (p && CURRENT_SOUND === p) {
        return;
      }
      releaseAsCurrent();
      if (p) {
        try {
          p.pause();
        } catch {}
        try {
          p.remove();
        } catch {}
      }
    };
  }, [releaseAsCurrent]);

  const toggleSpeak = useCallback(async () => {
    const uri = result?.audioUri;
    if (!uri) return;
    try {
      if (!playerRef.current) {
        const p = createAudioPlayer({ uri } as AudioSource);
        try {
          p.volume = 1.0;
          p.loop = false;
        } catch {}
        playerRef.current = p;
        p.addListener('playbackStatusUpdate', (status: any) => {
          setSpeaking(!!status?.playing);
          if (status?.didJustFinish) {
            setSpeaking(false);
            // Play ONCE: pause before resetting so it doesn't loop.
            try {
              p.pause();
            } catch {}
            try {
              p.seekTo(0);
            } catch {}
            if (CURRENT_SOUND === p) {
              CURRENT_SOUND = null;
              CURRENT_STOP = null;
            }
            stopPlaybackNotification();
          }
        });
      }
      const player = playerRef.current;
      if (speaking) {
        player.pause();
        setSpeaking(false);
        releaseAsCurrent();
        stopPlaybackNotification();
      } else {
        // Stop whatever else is currently playing (a voice note or another
        // translation) so only one sound plays at a time.
        if (CURRENT_SOUND && CURRENT_SOUND !== player) {
          try {
            CURRENT_SOUND.pause();
          } catch {}
          if (CURRENT_STOP) CURRENT_STOP();
        }
        CURRENT_SOUND = player;
        CURRENT_STOP = () => {
          try {
            player.pause();
          } catch {}
          setSpeaking(false);
        };
        try {
          if (typeof player.seekTo === 'function') player.seekTo(0);
        } catch {}
        // Await the playback-session config before starting (see VoiceMessage).
        await ensureVoicePlaybackMode();
        player.play();
        setSpeaking(true);
        startPlaybackNotification(`Translated message · ${targetName}`);
        setPlaybackStopHandler(() => {
          try {
            player.pause();
          } catch {}
          setSpeaking(false);
        });
      }
    } catch {
      /* ignore playback errors */
    }
  }, [result?.audioUri, speaking, releaseAsCurrent]);

  if (shouldSkip) return null;
  if (loading && !result) {
    return (
      <View style={styles.voiceTransPill} testID={`voice-translation-${msg?._id || ''}`}>
        <View style={styles.transcriptPendingRow}>
          <ActivityIndicator size="small" color={Colors.primary} />
          <Text style={styles.transcriptPendingText}>Translating to {targetName}…</Text>
        </View>
      </View>
    );
  }
  if (!result || result.status !== 'ready' || !result.translatedText) return null;

  return (
    <View style={styles.voiceTransPill} testID={`voice-translation-${msg?._id || ''}`}>
      <View style={styles.voiceTransHeader}>
        <Feather name="globe" size={11} color={Colors.primary} />
        <Text style={styles.transcriptLanguage}>{targetName}</Text>
        {result.audioUri ? (
          <TouchableOpacity
            onPress={toggleSpeak}
            style={styles.voiceTransPlayBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            testID="voice-translation-play"
          >
            <Feather name={speaking ? 'pause' : 'volume-2'} size={12} color={Colors.white} />
            <Text style={styles.voiceTransPlayText}>{speaking ? 'Stop' : `Play in ${targetName}`}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={styles.transcriptText} testID="voice-translation-text">
        {result.translatedText}
      </Text>
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
  const { url: src, error: srcError, loading, deferred, decrypt, progress } = useDecryptedMediaUrl(msg, e2eeStatus);
  useAutoDownloadMedia({ msg, isMine, src, mediaType: 'document' });
  const markConsumed = useMarkConsumedOnce(msg, isMine);

  // iter-179: APKs are allowed (WhatsApp-style policy) but received ones
  // carry an explicit caution so less tech-savvy users don't sideload
  // blindly. Sender's own bubble stays clean.
  const isApk = /\.apk$/i.test(msg.fileName || '');
  const showApkCaution = isApk && !isMine;

  // iter-410: large encrypted files decrypt lazily (on first open) to avoid
  // freezing/OOM on render. If the user tapped a deferred file, run the pending
  // action (open or save) as soon as the decrypted URL is ready.
  const pendingActionRef = useRef<null | 'open' | 'save'>(null);

  const runAction = useCallback(async (uri: string, mode: 'open' | 'save') => {
    markConsumed();
    // Android blocks handing a raw file:// URI to another app (FileUriExposed),
    // so decrypted/cached documents (file://) must go through the OS share
    // sheet, which exposes a content:// URI via the FileProvider. On mobile the
    // share sheet is also the canonical "Save to Files / Drive" entry point.
    try {
      if (uri.startsWith('file://')) {
        const Sharing = await import('expo-sharing');
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, {
            mimeType: msg.mimeType || undefined,
            dialogTitle: mode === 'save' ? 'Save to Files' : (msg.fileName || 'Open document'),
            UTI: msg.mimeType || undefined,
          });
          return;
        }
      }
      await Linking.openURL(uri);
    } catch {
      try {
        await Linking.openURL(uri);
      } catch {
        Alert.alert('Couldn’t open file', 'No app is available to open this document.');
      }
    }
  }, [markConsumed, msg.mimeType, msg.fileName]);

  useEffect(() => {
    if (src && pendingActionRef.current) {
      const mode = pendingActionRef.current;
      pendingActionRef.current = null;
      void runAction(src, mode);
    }
  }, [src, runAction]);

  // Shared entry for both the row tap (open) and the Save button.
  const trigger = (mode: 'open' | 'save') => {
    if (!src) {
      if (loading) return; // decryption already in progress
      if (deferred) {
        // First tap on a large file — decrypt, then run the action when ready.
        pendingActionRef.current = mode;
        decrypt?.();
        return;
      }
      if (srcError) {
        const reason = String(srcError).slice(0, 140);
        console.warn('[FileMessage] action blocked — srcError:', srcError, 'size:', msg?.fileSize);
        Alert.alert(
          'Couldn’t open file',
          `This document failed to download or decrypt. Check your connection and try again.\n\n(${reason})`,
        );
      }
      return;
    }
    void runAction(src, mode);
  };

  const onOpen = () => trigger('open');
  const onSave = () => trigger('save');

  return (
    <View>
      <TouchableOpacity
        style={styles.fileBody}
        onPress={onOpen}
        disabled={loading || (!src && !srcError && !deferred)}
        activeOpacity={0.7}
        testID={`file-open-${msg._id}`}
      >
        <View style={[styles.fileIcon, isMine ? styles.fileIconMine : null, (!src && !deferred) ? { opacity: 0.5 } : null]}>
          <Feather name="file-text" size={22} color={isMine ? '#2C4129' : Colors.white} />
        </View>
        <View style={styles.flexOne}>
          <Text style={[styles.fileName, isMine ? styles.fileNameMine : null]} numberOfLines={2}>{msg.fileName || 'Document'}</Text>
          <Text style={[styles.fileMeta, isMine ? styles.fileMetaMine : null]}>
            {loading
              ? (progress && progress.total > 0
                  ? `Downloading… ${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
                  : 'Decrypting…')
              : ([formatBytes(msg.fileSize), msg.mimeType?.split('/')?.pop()?.toUpperCase()].filter(Boolean).join(' · ') || 'File')}
          </Text>
          {loading && progress && progress.total > 0 ? (
            <View style={[styles.fileProgressTrack, isMine ? styles.fileProgressTrackMine : null]}>
              <View
                style={[
                  styles.fileProgressFill,
                  isMine ? styles.fileProgressFillMine : null,
                  { width: `${Math.min(100, Math.round((progress.received / progress.total) * 100))}%` },
                ]}
              />
            </View>
          ) : null}
        </View>
        {loading ? (
          <ActivityIndicator size="small" color={isMine ? '#F6FFF9' : Colors.primary} />
        ) : (
          <Feather
            name={srcError ? 'lock' : (src || deferred) ? 'download' : 'loader'}
            size={20}
            color={srcError ? Colors.danger : isMine ? '#F6FFF9' : Colors.primary}
          />
        )}
      </TouchableOpacity>
      {!loading && !srcError && (src || deferred) ? (
        <TouchableOpacity
          style={styles.fileSaveBtn}
          onPress={onSave}
          activeOpacity={0.7}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          testID={`file-save-${msg._id}`}
        >
          <Feather name="download" size={13} color={isMine ? 'rgba(246,255,249,0.9)' : Colors.primary} />
          <Text style={[styles.fileSaveText, isMine ? styles.fileSaveTextMine : null]}>Save to Files</Text>
        </TouchableOpacity>
      ) : null}
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
  senderNameLabel: {
    fontSize: 13,
    fontWeight: FontWeight.bold,
    color: Colors.primary,
    marginBottom: 2,
  },
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
  voiceTransPill: {
    marginTop: 6,
    padding: 8,
    paddingHorizontal: 10,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(59,130,246,0.10)',
    borderLeftWidth: 3,
    borderLeftColor: '#3b82f6',
  },
  voiceTransHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 3,
  },
  voiceTransPlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    backgroundColor: Colors.primary,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  voiceTransPlayText: {
    fontSize: 11,
    color: Colors.white,
    fontWeight: FontWeight.bold,
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
  statusReplyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 2,
    paddingLeft: 7,
    marginBottom: 6,
    gap: 6,
  },
  statusReplyDot: { marginRight: 2 },
  statusReplyLabel: { fontSize: 11.5, fontWeight: FontWeight.semibold },
  statusReplyPreview: { fontSize: 12, lineHeight: 16 },
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
  transcriptEyeBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 2, paddingHorizontal: 4 },
  transcriptEyeLabel: { fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.3 },
  transcriptHiddenRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  transcriptHiddenText: { fontSize: 10, fontStyle: 'italic', color: Colors.textMuted },
  voiceBody: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  voicePlayBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  voicePlayBtnLoading: { width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  voiceBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.12)', overflow: 'hidden' },
  voiceProgress: { height: '100%', backgroundColor: Colors.primary },
  voiceDuration: { fontSize: 11, color: Colors.textSecondary, fontVariant: ['tabular-nums'], minWidth: 30 },
  voiceRateBtn: { marginLeft: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 11, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center', minWidth: 32 },
  voiceRateText: { fontSize: 11, fontWeight: '800', color: Colors.primary, fontVariant: ['tabular-nums'] },
  voiceUnplayedDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#2f9bff' },
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
  fileProgressTrack: {
    height: 4,
    borderRadius: 2,
    marginTop: 6,
    backgroundColor: 'rgba(0,0,0,0.10)',
    overflow: 'hidden',
  },
  fileProgressTrackMine: { backgroundColor: 'rgba(246,255,249,0.25)' },
  fileProgressFill: { height: '100%', borderRadius: 2, backgroundColor: Colors.primary },
  fileProgressFillMine: { backgroundColor: '#F6FFF9' },
  fileSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    marginTop: 6,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  fileSaveText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: Colors.primary },
  fileSaveTextMine: { color: 'rgba(246,255,249,0.9)' },
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
  videoSaveBtn: {
    position: 'absolute',
    top: 8,
    right: 46,
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
  richTextItalic: { fontStyle: 'italic' },
  richTextUnderline: { textDecorationLine: 'underline' },
  // In-conversation search highlight (iter-220). Every occurrence of the
  // search term gets a yellow marker; the message the up/down navigator is
  // currently focused on uses the brighter `Active` variant + a bubble outline
  // so it stands out among the other matches.
  searchHighlight: { backgroundColor: '#FDE68A', color: '#1A1A1A' },
  searchHighlightActive: { backgroundColor: '#FACC15', color: '#1A1A1A', fontWeight: FontWeight.bold },
  phoneLink: { textDecorationLine: 'underline', fontWeight: FontWeight.bold },
  bubbleActiveSearchMatch: { borderWidth: 2, borderColor: '#F59E0B' },
  bubbleJumpHighlight: { borderWidth: 2, borderColor: Colors.primary, opacity: 0.92 },
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
  receiveOnceRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // editedBadge — italic "edited HH:MM" rendered before the real time
  // stamp inside the bubble meta row. Per web-app design parity.
  editedBadge: { fontStyle: 'italic', marginRight: 6, opacity: 0.85 },
  starIcon: { marginRight: 4 },
  tickIcon: { marginLeft: 4 },
  flexOne: { flex: 1 },
});