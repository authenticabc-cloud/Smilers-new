/**
 * InterpreterBanner — compact in-call status pill.
 *   🎤 Speaking: <lang>   🎧 Hearing: <lang>   [Translate ON/OFF]
 * Tap the pill to open the full settings sheet.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../theme';
import { flagFor } from '../../lib/interpreter/languages';

export function InterpreterBanner({
  enabled,
  listening,
  speakingLanguage,
  listeningLanguage,
  onOpen,
  onToggle,
  onOpenAi,
}: {
  enabled: boolean;
  listening?: boolean;
  speakingLanguage: string;
  listeningLanguage: string;
  onOpen: () => void;
  onToggle: () => void;
  onOpenAi: () => void;
}) {
  return (
    <View style={styles.wrap} testID="interpreter-banner">
      <Pressable style={styles.pill} onPress={onOpen} hitSlop={6}>
        {enabled ? (
          <View style={styles.statusSeg} testID="interpreter-status">
            <View style={[styles.statusDot, listening ? styles.statusDotLive : styles.statusDotIdle]} />
            <Text style={styles.statusText} numberOfLines={1}>
              {listening ? 'Listening' : 'Ready'}
            </Text>
          </View>
        ) : null}
        <View style={styles.seg}>
          <Feather name="mic" size={12} color="#fff" />
          <Text style={styles.segText} numberOfLines={1}>
            {flagFor(speakingLanguage)} {speakingLanguage}
          </Text>
        </View>
        <Feather name="arrow-right" size={11} color="#8a8a8a" />
        <View style={styles.seg}>
          <Feather name="headphones" size={12} color="#fff" />
          <Text style={styles.segText} numberOfLines={1}>
            {flagFor(listeningLanguage)} {listeningLanguage}
          </Text>
        </View>
        <Feather name="settings" size={13} color="#bbb" style={styles.gear} />
      </Pressable>
      <Pressable onPress={onOpenAi} style={styles.aiBtn} hitSlop={6} testID="interpreter-ai">
        <Feather name="zap" size={14} color={Colors.primary} />
      </Pressable>
      <Pressable
        onPress={onToggle}
        style={[styles.toggle, enabled && styles.toggleOn]}
        hitSlop={6}
        testID="interpreter-toggle"
      >
        <Feather name="globe" size={13} color={enabled ? '#222' : '#fff'} />
        <Text style={[styles.toggleText, enabled && styles.toggleTextOn]}>
          {enabled ? 'ON' : 'Translate'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: '68%',
  },
  seg: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  statusSeg: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusDotLive: { backgroundColor: '#3ddc84' },
  statusDotIdle: { backgroundColor: '#8a8a8a' },
  statusText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  segText: { color: '#fff', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  gear: { marginLeft: 2 },
  aiBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  toggleOn: { backgroundColor: Colors.primary },
  toggleText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  toggleTextOn: { color: '#222' },
});
