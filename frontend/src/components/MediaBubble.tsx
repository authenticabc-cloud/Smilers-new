import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Audio, ResizeMode, Video } from 'expo-av';
import * as Linking from 'expo-linking';
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

let CURRENT_SOUND: Audio.Sound | null = null;
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

interface BubbleProps {
  msg: any;
  isMine: boolean;
  myUserId?: string;
  parentMsg?: any;
  appearance?: any;
  e2eeStatus?: E2EEStatus | null;
  onLongPress: () => void;
  onToggleReaction: (emoji: string) => void;
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
}: BubbleProps) {
  const time = msg._creationTime ? new Date(msg._creationTime) : new Date();
  const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Delivery status indicator (sender's own messages only) — per web spec:
  //   green  → sent (server received, not delivered yet)
  //   yellow → delivered (reached recipient device, not opened)
  //   blue   → read (recipient opened the chat)
  // We must exclude the sender's own userId from readBy/deliveredTo because
  // the server records the sender as the original delivery target.
  const senderUserId = msg.senderId ? String(msg.senderId) : null;
  const readByOthers = Array.isArray(msg.readBy)
    ? msg.readBy.filter((uid: any) => uid && String(uid) !== senderUserId)
    : [];
  const deliveredToOthers = Array.isArray(msg.deliveredTo)
    ? msg.deliveredTo.filter((uid: any) => uid && String(uid) !== senderUserId)
    : [];
  const statusDotColor =
    readByOthers.length > 0
      ? Colors.tickBlue
      : deliveredToOthers.length > 0
        ? Colors.tickYellow
        : Colors.tickGreen;

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

  if (msg.deletedAt) {
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther, bubbleDynamicStyle, styles.deletedBubble]}>
          <View style={styles.deletedContent}>
            <Feather name="slash" size={12} color={Colors.textMuted} />
            <Text style={[styles.bubbleText, bubbleTextStyle, styles.deletedText]}>Message deleted</Text>
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
        style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther, bubbleDynamicStyle, msg.type === 'image' ? styles.bubbleImage : null]}
        testID={`message-bubble-${msg._id}`}
      >
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

        <BubbleBody msg={msg} timeStr={timeStr} textStyle={[bubbleTextStyle, { color: messageTextColor }]} isMine={isMine} e2eeStatus={e2eeStatus || null} />

        <View style={styles.bubbleMeta}>
          {msg.starred ? <Feather name="star" size={11} color={Colors.tickYellow} style={styles.starIcon} /> : null}
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

function BubbleBody({ msg, timeStr, textStyle, isMine, e2eeStatus }: { msg: any; timeStr: string; textStyle?: any; isMine: boolean; e2eeStatus: E2EEStatus | null }) {
  return (
    <BubbleErrorBoundary fallbackLabel="Message couldn't load">
      <BubbleBodyInner msg={msg} timeStr={timeStr} textStyle={textStyle} isMine={isMine} e2eeStatus={e2eeStatus} />
    </BubbleErrorBoundary>
  );
}

function BubbleBodyInner({ msg, timeStr, textStyle, isMine, e2eeStatus }: { msg: any; timeStr: string; textStyle?: any; isMine: boolean; e2eeStatus: E2EEStatus | null }) {
  switch (msg.type) {
    case 'image':
      return <ImageMessage msg={msg} timeStr={timeStr} textStyle={textStyle} e2eeStatus={e2eeStatus} />;
    case 'video':
      return <VideoMessage msg={msg} timeStr={timeStr} textStyle={textStyle} e2eeStatus={e2eeStatus} />;
    case 'voice':
    case 'audio':
      return <VoiceMessage msg={msg} e2eeStatus={e2eeStatus} />;
    case 'poll':
      return <PollMessage msg={msg} />;
    case 'file':
    case 'document':
      return <FileMessage msg={msg} isMine={isMine} e2eeStatus={e2eeStatus} />;
    case 'text':
    default:
      if (extractFirstUrl(msg.text || '')) {
        return <LinkPreviewMessage msg={msg} textStyle={textStyle} isMine={isMine} />;
      }
      return <RichMessageText text={msg.text || ''} textStyle={textStyle} />;
  }
}

function RichMessageText({ text, textStyle, numberOfLines }: { text: string; textStyle?: any; numberOfLines?: number }) {
  const segments = useMemo(() => parseRichTextSegments(text), [text]);
  return (
    <Text style={[styles.bubbleText, textStyle]} numberOfLines={numberOfLines}>
      {segments.map((segment, index) => (
        <Text
          key={`${index}-${segment.text}`}
          style={[
            segment.bold ? styles.richTextBold : null,
            segment.color ? { color: segment.color } : null,
          ]}
        >
          {segment.text}
        </Text>
      ))}
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

  const onOpen = async () => {
    try {
      await Linking.openURL(url);
    } catch {}
  };

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

function ImageMessage({ msg, timeStr, textStyle, e2eeStatus }: { msg: any; timeStr: string; textStyle?: any; e2eeStatus: E2EEStatus | null }) {
  const [open, setOpen] = useState(false);
  const { url: src, loading, error } = useDecryptedMediaUrl(msg, e2eeStatus);

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
      <ImageViewer visible={open} onClose={() => setOpen(false)} uri={src} />
    </>
  );
}

function ImageViewer({ visible, onClose, uri }: { visible: boolean; onClose: () => void; uri: string }) {
  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewerWrap} testID="media-viewer">
        <Pressable style={styles.viewerBackdrop} onPress={onClose}>
          <Image source={{ uri }} style={styles.viewerImage} resizeMode="contain" />
        </Pressable>
        <TouchableOpacity style={styles.viewerClose} onPress={onClose} hitSlop={12} testID="media-viewer-close">
          <Feather name="x" size={28} color={Colors.white} />
        </TouchableOpacity>
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
}: {
  msg: any;
  timeStr: string;
  textStyle?: any;
  e2eeStatus: E2EEStatus | null;
}) {
  const { url: src, loading, error } = useDecryptedMediaUrl(msg, e2eeStatus);
  const videoRef = useRef<Video | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [durMs, setDurMs] = useState<number>(() => {
    const remote = getMessageDurationSec(msg);
    return remote ? remote * 1000 : 0;
  });
  const [viewerOpen, setViewerOpen] = useState(false);

  // Clean up when unmounting so other media doesn't keep playing.
  useEffect(() => {
    return () => {
      const v = videoRef.current;
      if (v) {
        v.pauseAsync?.().catch(() => {});
      }
    };
  }, []);

  const togglePlay = useCallback(async () => {
    if (!src || !videoRef.current) return;
    try {
      const status: any = await videoRef.current.getStatusAsync();
      if (status?.isPlaying) {
        await videoRef.current.pauseAsync();
      } else {
        if (status?.didJustFinish || (status?.positionMillis ?? 0) >= (status?.durationMillis ?? 0) - 50) {
          await videoRef.current.setPositionAsync(0);
        }
        await videoRef.current.playAsync();
      }
    } catch {}
  }, [src]);

  const onStatus = useCallback((status: any) => {
    if (!status?.isLoaded) return;
    setIsPlaying(!!status.isPlaying);
    setPosMs(status.positionMillis || 0);
    if (status.durationMillis && status.durationMillis !== durMs) {
      setDurMs(status.durationMillis);
    }
    if (status.didJustFinish) {
      setIsPlaying(false);
      videoRef.current?.setPositionAsync(0).catch(() => {});
    }
  }, [durMs]);

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
          <Video
            ref={(r) => { videoRef.current = r; }}
            source={{ uri: src }}
            style={styles.videoPlayer}
            resizeMode={ResizeMode.COVER}
            useNativeControls={false}
            shouldPlay={false}
            isMuted={false}
            onPlaybackStatusUpdate={onStatus}
            posterStyle={styles.videoPlayer}
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
  const fullRef = useRef<Video | null>(null);
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

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(async () => {
      try {
        if (initialPositionMs && initialPositionMs > 200) {
          await fullRef.current?.setPositionAsync(initialPositionMs);
        }
        await fullRef.current?.playAsync();
      } catch {}
    }, 200);
    return () => clearTimeout(t);
  }, [visible, initialPositionMs]);

  const onStatus = useCallback((status: any) => {
    if (!status?.isLoaded) return;
    setPosMs(status.positionMillis || 0);
  }, []);

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
        <Video
          ref={(r) => { fullRef.current = r; }}
          source={{ uri }}
          style={styles.viewerVideo}
          resizeMode={ResizeMode.CONTAIN}
          useNativeControls
          shouldPlay={false}
          onPlaybackStatusUpdate={onStatus}
          progressUpdateIntervalMillis={250}
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

function VoiceMessage({ msg, e2eeStatus }: { msg: any; e2eeStatus: E2EEStatus | null }) {
  const totalSec = getMessageDurationSec(msg);
  const { url: src, error: srcError } = useDecryptedMediaUrl(msg, e2eeStatus);

  const soundRef = useRef<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [posSec, setPosSec] = useState(0);

  useEffect(() => {
    return () => {
      const sound = soundRef.current;
      if (CURRENT_SOUND === sound) {
        CURRENT_SOUND = null;
        CURRENT_STOP = null;
      }
      soundRef.current = null;
      if (sound) {
        sound.unloadAsync().catch(() => {});
      }
    };
  }, []);

  const stopOtherSounds = async () => {
    if (CURRENT_SOUND && CURRENT_SOUND !== soundRef.current) {
      try {
        await CURRENT_SOUND.pauseAsync();
      } catch {}
      if (CURRENT_STOP) CURRENT_STOP();
    }
  };

  const toggle = async () => {
    if (!src) return;
    try {
      await stopOtherSounds();
      let sound = soundRef.current;
      if (!sound) {
        const created = await Audio.Sound.createAsync(
          { uri: src },
          { shouldPlay: true, isLooping: false },
          (status: any) => {
            if (!status?.isLoaded) return;
            setIsPlaying(!!status.isPlaying);
            setPosSec((status.positionMillis || 0) / 1000);
            if (status.didJustFinish) {
              // The sound finished — stop playback explicitly so the player
              // doesn't auto-replay from start on the next status update.
              // (Spec: voice notes play once unless the user taps Play again.)
              setIsPlaying(false);
              setPosSec(0);
              try {
                created.sound.pauseAsync().catch(() => {});
                created.sound.setPositionAsync(0).catch(() => {});
              } catch {}
              if (CURRENT_SOUND === created.sound) {
                CURRENT_SOUND = null;
                CURRENT_STOP = null;
              }
            }
          }
        );
        sound = created.sound;
        soundRef.current = sound;
        CURRENT_SOUND = sound;
        CURRENT_STOP = () => setIsPlaying(false);
      } else {
        const status: any = await sound.getStatusAsync();
        if (status.isPlaying) {
          await sound.pauseAsync();
        } else {
          if (status.didJustFinish || status.positionMillis >= (status.durationMillis || 0)) {
            await sound.setPositionAsync(0);
          }
          await sound.playAsync();
          CURRENT_SOUND = sound;
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

  const onOpen = async () => {
    if (!src) return;
    try {
      await Linking.openURL(src);
    } catch {}
  };

  return (
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

const styles = StyleSheet.create({
  bubbleRow: { marginVertical: 5, flexDirection: 'row', position: 'relative' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
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
  fileMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  fileMetaMine: { color: 'rgba(246,255,249,0.78)' },
  viewerWrap: { flex: 1, backgroundColor: '#000' },
  viewerBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
  viewerVideo: { width: '100%', height: '100%' },
  viewerClose: { position: 'absolute', top: 48, right: 16, padding: 8, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 20 },

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
  deletedBubble: { opacity: 0.55 },
  deletedContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deletedText: { fontStyle: 'italic', color: Colors.textMuted },
  starIcon: { marginRight: 4 },
  tickIcon: { marginLeft: 4 },
  flexOne: { flex: 1 },
});