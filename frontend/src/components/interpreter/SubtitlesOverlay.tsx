/**
 * SubtitlesOverlay — live captions during a call.
 * Shows the newest lines in MY listening language (falls back to the
 * original text). Long-press a line to Copy / Share.
 */
import React, { useMemo } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../theme';
import type { SubtitleLine } from '../../lib/interpreter/useTranslatedPlayback';

function textFor(line: SubtitleLine, listeningLanguage: string): string {
  return (line.translations?.[listeningLanguage] || line.originalText || '').trim();
}

export function SubtitlesOverlay({
  lines,
  listeningLanguage,
  showOriginal,
}: {
  lines: SubtitleLine[];
  listeningLanguage: string;
  showOriginal: boolean;
}) {
  // Newest 6, displayed oldest→newest so the latest sits at the bottom.
  const visible = useMemo(
    () => lines.slice().sort((a, b) => a.createdAt - b.createdAt).slice(-6),
    [lines],
  );

  const onLongPress = async (line: SubtitleLine) => {
    const shown = textFor(line, listeningLanguage);
    Alert.alert(line.speakerName || 'Subtitle', shown, [
      {
        text: 'Copy',
        onPress: () => Clipboard.setStringAsync(shown).catch(() => {}),
      },
      {
        text: 'Share',
        onPress: () => Share.share({ message: `${line.speakerName}: ${shown}` }).catch(() => {}),
      },
      { text: 'Close', style: 'cancel' },
    ]);
  };

  if (visible.length === 0) return null;

  return (
    <View style={styles.wrap} pointerEvents="box-none" testID="subtitles-overlay">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {visible.map((line) => {
          const shown = textFor(line, listeningLanguage);
          if (!shown) return null;
          return (
            <Pressable
              key={line._id}
              onLongPress={() => onLongPress(line)}
              delayLongPress={250}
              style={[styles.line, line.isMe && styles.lineMine]}
              testID={`subtitle-${line._id}`}
            >
              <Text style={styles.speaker} numberOfLines={1}>
                {line.isMe ? 'You' : line.speakerName || 'Speaker'}
              </Text>
              <Text style={styles.text}>{shown}</Text>
              {showOriginal && !line.isMe && shown !== line.originalText ? (
                <Text style={styles.original} numberOfLines={2}>
                  {line.originalText}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.hintRow}>
        <Feather name="type" size={11} color="#9a9a9a" />
        <Text style={styles.hint}>Live subtitles · long-press to copy or share</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { maxHeight: 240, gap: 4 },
  scroll: { flexGrow: 0 },
  content: { gap: 6, paddingHorizontal: 4 },
  line: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  lineMine: { borderLeftColor: '#6b7280', opacity: 0.85 },
  speaker: { color: Colors.primary, fontSize: 11, fontWeight: '700', marginBottom: 2 },
  text: { color: '#fff', fontSize: 15, lineHeight: 20 },
  original: { color: '#b5b5b5', fontSize: 12, fontStyle: 'italic', marginTop: 3 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 5, justifyContent: 'center' },
  hint: { color: '#9a9a9a', fontSize: 10 },
});
