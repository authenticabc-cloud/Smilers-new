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
import { api } from '../convexApi';
import { useSafeConvexQuery } from '../hooks/useSafeConvexQuery';
import { Colors, FontSize, FontWeight, Radius, Shadow } from '../theme';

let CURRENT_SOUND: Audio.Sound | null = null;
let CURRENT_STOP: (() => void) | null = null;

function fmtDur(sec: number): string {
  const seconds = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

interface BubbleProps {
  msg: any;
  isMine: boolean;
  myUserId?: string;
  parentMsg?: any;
  onLongPress: () => void;
  onToggleReaction: (emoji: string) => void;
}

export default function MediaBubble({
  msg,
  isMine,
  myUserId,
  parentMsg,
  onLongPress,
  onToggleReaction,
}: BubbleProps) {
  const time = msg._creationTime ? new Date(msg._creationTime) : new Date();
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tickColor =
    msg.readBy?.length > 1 ? Colors.tickBlue : msg.deliveredTo?.length ? Colors.tickYellow : Colors.tickGray;
  const tickIcon = msg.readBy?.length > 1 || msg.deliveredTo?.length ? 'checkmark-done' : 'checkmark';

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

  if (msg.deletedAt) {
    return (
      <View style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
        <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther, styles.deletedBubble]}>
          <View style={styles.deletedContent}>
            <Feather name="slash" size={12} color={Colors.textMuted} />
            <Text style={[styles.bubbleText, styles.deletedText]}>Message deleted</Text>
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
        style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther, msg.type === 'image' ? styles.bubbleImage : null]}
        testID={`message-bubble-${msg._id}`}
      >
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
        ) : null}

        <BubbleBody msg={msg} timeStr={timeStr} />

        <View style={styles.bubbleMeta}>
          {msg.starred ? <Feather name="star" size={11} color={Colors.tickYellow} style={styles.starIcon} /> : null}
          {msg.type === 'image' ? null : <Text style={styles.bubbleTime}>{timeStr}</Text>}
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

function BubbleBody({ msg, timeStr }: { msg: any; timeStr: string }) {
  switch (msg.type) {
    case 'image':
      return <ImageMessage msg={msg} timeStr={timeStr} />;
    case 'voice':
    case 'audio':
      return <VoiceMessage msg={msg} />;
    case 'poll':
      return <PlaceholderBody type="Poll" icon="bar-chart-2" iconLib="feather" subtitle={msg.poll?.question} />;
    case 'file':
    case 'document':
      return <PlaceholderBody type={msg.fileName || 'File'} icon="file" iconLib="feather" subtitle={formatBytes(msg.fileSize)} />;
    case 'text':
    default:
      return <Text style={styles.bubbleText}>{msg.text || ''}</Text>;
  }
}

function ImageMessage({ msg, timeStr }: { msg: any; timeStr: string }) {
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
        {msg.text ? <Text style={[styles.bubbleText, styles.imageCaption]}>{msg.text}</Text> : null}
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
  bubbleRow: { marginVertical: 6, flexDirection: 'row', position: 'relative' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '78%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: Radius.lg, ...Shadow.sm },
  bubbleMine: { backgroundColor: Colors.bubbleOut, borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: Colors.bubbleIn, borderBottomLeftRadius: 4 },
  bubbleImage: { padding: 4 },
  bubbleText: { fontSize: FontSize.base, color: Colors.textPrimary },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', marginTop: 4 },
  bubbleTime: { fontSize: 10, color: Colors.textMuted },
  bubbleTimeOverlay: { color: Colors.white, fontSize: 10, fontWeight: FontWeight.medium },
  quoteBlock: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: 8, padding: 6, marginBottom: 6, gap: 6 },
  quoteAccent: { width: 3, borderRadius: 2, backgroundColor: Colors.primary },
  quoteName: { fontSize: 11, fontWeight: FontWeight.bold, color: Colors.primary },
  quoteText: { fontSize: 12, color: Colors.textSecondary },
  imageWrap: { position: 'relative' },
  image: { width: IMG_W, height: IMG_W, borderRadius: Radius.md, backgroundColor: Colors.borderLight },
  imagePlaceholder: { width: IMG_W, height: IMG_W, borderRadius: Radius.md, backgroundColor: Colors.borderLight, alignItems: 'center', justifyContent: 'center' },
  imageCaption: { marginTop: 6 },
  imageTimeOverlay: { position: 'absolute', right: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  reactionsRow: { position: 'absolute', bottom: -10, flexDirection: 'row', gap: 4 },
  reactionsRowMine: { right: 8 },
  reactionsRowOther: { left: 8 },
  reactionChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 12, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, gap: 2 },
  reactionChipMine: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  reactionChipEmoji: { fontSize: 12 },
  reactionChipCount: { fontSize: 10, color: Colors.textSecondary, fontWeight: FontWeight.semibold },
  placeholderBody: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 },
  placeholderIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  placeholderTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  placeholderSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  voiceBody: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, minWidth: 180 },
  voicePlayBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  voicePlayBtnLoading: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  voiceBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.12)', overflow: 'hidden' },
  voiceProgress: { height: '100%', backgroundColor: Colors.primary },
  voiceDuration: { fontSize: 11, color: Colors.textSecondary, fontVariant: ['tabular-nums'], minWidth: 32 },
  viewerWrap: { flex: 1, backgroundColor: '#000' },
  viewerBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
  viewerClose: { position: 'absolute', top: 48, right: 16, padding: 8, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 20 },
  deletedBubble: { opacity: 0.55 },
  deletedContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deletedText: { fontStyle: 'italic', color: Colors.textMuted },
  starIcon: { marginRight: 4 },
  tickIcon: { marginLeft: 4 },
  flexOne: { flex: 1 },
});