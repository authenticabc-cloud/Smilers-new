import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { Audio } from 'expo-av';
import * as Linking from 'expo-linking';
import { useMutation, useQuery } from 'convex/react';
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
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius } from '../theme';

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
  onLongPress: () => void;
  onToggleReaction: (emoji: string) => void;
}

export default function MediaBubble({
  msg,
  isMine,
  myUserId,
  parentMsg,
  appearance,
  onLongPress,
  onToggleReaction,
}: BubbleProps) {
  const time = msg._creationTime ? new Date(msg._creationTime) : new Date();
  const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const tickColor =
    msg.readBy?.length ? Colors.tickBlue : msg.deliveredTo?.length ? Colors.tickYellow : Colors.tickGray;
  const tickIcon = msg.readBy?.length || msg.deliveredTo?.length ? 'checkmark-done' : 'checkmark';

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

        <BubbleBody msg={msg} timeStr={timeStr} textStyle={[bubbleTextStyle, { color: messageTextColor }]} isMine={isMine} />

        <View style={styles.bubbleMeta}>
          {msg.starred ? <Feather name="star" size={11} color={Colors.tickYellow} style={styles.starIcon} /> : null}
          {msg.type === 'image' ? null : <Text style={[styles.bubbleTime, { color: metaTextColor }]}>{timeStr}</Text>}
          {isMine ? <Ionicons name={tickIcon as any} size={14} color={tickColor} style={styles.tickIcon} /> : null}
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

function BubbleBody({ msg, timeStr, textStyle, isMine }: { msg: any; timeStr: string; textStyle?: any; isMine: boolean }) {
  switch (msg.type) {
    case 'image':
      return <ImageMessage msg={msg} timeStr={timeStr} textStyle={textStyle} />;
    case 'voice':
    case 'audio':
      return <VoiceMessage msg={msg} />;
    case 'poll':
      return <PollMessage msg={msg} />;
    case 'file':
    case 'document':
      return <FileMessage msg={msg} isMine={isMine} />;
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

function ImageMessage({ msg, timeStr, textStyle }: { msg: any; timeStr: string; textStyle?: any }) {
  const [open, setOpen] = useState(false);
  const { data: resolvedUrl } = useSafeConvexQuery<string | null>(
    api.files.getUrl,
    msg.storageId ? { storageId: msg.storageId } : {},
    null,
    !msg.fileUrl && !!msg.storageId
  );
  const src = msg.fileUrl || resolvedUrl;

  if (!src) {
    return (
      <View style={styles.imagePlaceholder} testID="image-bubble-loading">
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity activeOpacity={0.9} onPress={() => setOpen(true)} testID="image-bubble">
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

function VoiceMessage({ msg }: { msg: any }) {
  const totalSec = msg.audioDuration || 0;
  const { data: resolvedUrl } = useSafeConvexQuery<string | null>(
    api.files.getUrl,
    msg.storageId ? { storageId: msg.storageId } : {},
    null,
    !msg.fileUrl && !!msg.storageId
  );
  const src = msg.fileUrl || resolvedUrl;

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
          { shouldPlay: true },
          (status: any) => {
            if (!status?.isLoaded) return;
            setIsPlaying(!!status.isPlaying);
            setPosSec((status.positionMillis || 0) / 1000);
            if (status.didJustFinish) {
              setIsPlaying(false);
              setPosSec(0);
              try {
                created.sound.setPositionAsync(0).catch(() => {});
              } catch {}
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
      <View style={styles.voiceBody} testID="voice-loading-state">
        <View style={styles.voicePlayBtnLoading}>
          <ActivityIndicator size="small" color={Colors.primary} />
        </View>
        <View style={styles.voiceBar}>
          <View style={styles.voiceProgress} />
        </View>
        <Text style={styles.voiceDuration}>{fmtDur(totalSec)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.voiceBody} testID="voice-message-body">
      <TouchableOpacity onPress={toggle} style={styles.voicePlayBtn} testID="voice-play">
        <Feather name={isPlaying ? 'pause' : 'play'} size={18} color={Colors.white} />
      </TouchableOpacity>
      <View style={styles.voiceBar}>
        <View style={[styles.voiceProgress, { width: `${progress * 100}%` }]} />
      </View>
      <Text style={styles.voiceDuration}>{fmtDur(remaining)}</Text>
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

function FileMessage({ msg, isMine }: { msg: any; isMine: boolean }) {
  const url = useQuery(
    api.files.getUrl,
    msg.fileUrl ? 'skip' : msg.storageId ? { storageId: msg.storageId } : 'skip'
  ) as string | null | undefined;
  const src = msg.fileUrl || url;

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
      <Feather name={src ? 'download' : 'loader'} size={20} color={isMine ? '#F6FFF9' : Colors.primary} />
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

const IMG_W = Math.min(260, Dimensions.get('window').width * 0.65);

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
  voiceBody: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, minWidth: 180 },
  voicePlayBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  voicePlayBtnLoading: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  voiceBar: { flex: 1, height: 5, borderRadius: 3, backgroundColor: 'rgba(0,0,0,0.12)', overflow: 'hidden' },
  voiceProgress: { height: '100%', backgroundColor: Colors.primary },
  voiceDuration: { fontSize: 11, color: Colors.textSecondary, fontVariant: ['tabular-nums'], minWidth: 32 },
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
  viewerClose: { position: 'absolute', top: 48, right: 16, padding: 8, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 20 },
  richTextBold: { fontWeight: FontWeight.bold },
  deletedBubble: { opacity: 0.55 },
  deletedContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deletedText: { fontStyle: 'italic', color: Colors.textMuted },
  starIcon: { marginRight: 4 },
  tickIcon: { marginLeft: 4 },
  flexOne: { flex: 1 },
});