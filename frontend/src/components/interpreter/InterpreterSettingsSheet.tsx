/**
 * InterpreterSettingsSheet — full configuration for the AI Voice Interpreter.
 * Language pickers (speaking / listening), voice mode, and local voice
 * preferences (gender / style / speed) + auto-enable.
 */
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors } from '../../theme';
import {
  MVP_LANGUAGES,
  VOICE_MODES,
  type LangName,
  type TransSpeed,
  type VoiceGender,
  type VoiceMode,
  type VoiceStyle,
} from '../../lib/interpreter/languages';
import type { InterpreterPrefs } from '../../lib/interpreter/prefs';

interface Props {
  visible: boolean;
  onClose: () => void;
  enabled: boolean;
  speakingLanguage: LangName;
  listeningLanguage: LangName;
  voiceMode: VoiceMode;
  prefs: InterpreterPrefs;
  onSave: (patch: {
    enabled?: boolean;
    speakingLanguage?: LangName;
    listeningLanguage?: LangName;
    voiceMode?: VoiceMode;
  }) => void;
  onPrefs: (patch: Partial<InterpreterPrefs>) => void;
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipOn]}>
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function InterpreterSettingsSheet({
  visible,
  onClose,
  enabled,
  speakingLanguage,
  listeningLanguage,
  voiceMode,
  prefs,
  onSave,
  onPrefs,
}: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <Feather name="globe" size={18} color={Colors.primary} />
              <Text style={styles.title}>AI Voice Interpreter</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8}>
              <Feather name="x" size={22} color="#fff" />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Master switch */}
            <View style={styles.switchRow}>
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>Translate this call</Text>
                <Text style={styles.rowSub}>
                  Everyone speaks their own language; you hear yours.
                </Text>
              </View>
              <Switch
                value={enabled}
                onValueChange={(v) => onSave({ enabled: v })}
                trackColor={{ true: Colors.primary, false: '#555' }}
                thumbColor="#fff"
                testID="interpreter-master-switch"
              />
            </View>

            {/* Speaking language */}
            <Text style={styles.section}>I speak</Text>
            <View style={styles.chipWrap}>
              {MVP_LANGUAGES.map((l) => (
                <Chip
                  key={l.name}
                  label={`${l.flag} ${l.name}`}
                  active={speakingLanguage === l.name}
                  onPress={() => onSave({ speakingLanguage: l.name })}
                />
              ))}
            </View>

            {/* Listening language */}
            <Text style={styles.section}>I want to hear</Text>
            <View style={styles.chipWrap}>
              {MVP_LANGUAGES.map((l) => (
                <Chip
                  key={l.name}
                  label={`${l.flag} ${l.name}`}
                  active={listeningLanguage === l.name}
                  onPress={() => onSave({ listeningLanguage: l.name })}
                />
              ))}
            </View>

            {/* Mode */}
            <Text style={styles.section}>Mode</Text>
            {VOICE_MODES.map((m) => (
              <Pressable
                key={m.mode}
                onPress={() => onSave({ voiceMode: m.mode })}
                style={[styles.modeRow, voiceMode === m.mode && styles.modeRowOn]}
              >
                <Feather
                  name={m.icon as any}
                  size={18}
                  color={voiceMode === m.mode ? Colors.primary : '#ccc'}
                />
                <View style={styles.flex}>
                  <Text style={styles.modeLabel}>{m.label}</Text>
                  <Text style={styles.modeDesc}>{m.desc}</Text>
                </View>
                {voiceMode === m.mode ? (
                  <Feather name="check-circle" size={18} color={Colors.primary} />
                ) : null}
              </Pressable>
            ))}

            {/* Voice prefs */}
            <Text style={styles.section}>Translated voice</Text>
            <Text style={styles.miniLabel}>Voice</Text>
            <View style={styles.chipWrap}>
              {(['female', 'male'] as VoiceGender[]).map((g) => (
                <Chip
                  key={g}
                  label={g === 'female' ? 'Female' : 'Male'}
                  active={prefs.voiceGender === g}
                  onPress={() => onPrefs({ voiceGender: g })}
                />
              ))}
            </View>
            <Text style={styles.miniLabel}>Style</Text>
            <View style={styles.chipWrap}>
              {(['natural', 'professional', 'friendly'] as VoiceStyle[]).map((s) => (
                <Chip
                  key={s}
                  label={s[0].toUpperCase() + s.slice(1)}
                  active={prefs.voiceStyle === s}
                  onPress={() => onPrefs({ voiceStyle: s })}
                />
              ))}
            </View>
            <Text style={styles.miniLabel}>Speed</Text>
            <View style={styles.chipWrap}>
              {(
                [
                  ['fast', 'Fast'],
                  ['balanced', 'Balanced'],
                  ['accurate', 'Highest accuracy'],
                ] as [TransSpeed, string][]
              ).map(([v, label]) => (
                <Chip
                  key={v}
                  label={label}
                  active={prefs.speed === v}
                  onPress={() => onPrefs({ speed: v })}
                />
              ))}
            </View>

            <View style={styles.switchRow}>
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>Auto-enable on future calls</Text>
                <Text style={styles.rowSub}>Turn the interpreter on automatically.</Text>
              </View>
              <Switch
                value={prefs.autoEnable}
                onValueChange={(v) => onPrefs({ autoEnable: v })}
                trackColor={{ true: Colors.primary, false: '#555' }}
                thumbColor="#fff"
              />
            </View>

            <Text style={styles.privacy}>
              Audio is securely processed for translation only, per Smilers&apos; privacy policy.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 14,
    maxHeight: '86%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  rowTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowSub: { color: '#9a9a9a', fontSize: 12, marginTop: 2 },
  section: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
  },
  miniLabel: { color: '#c7c7cc', fontSize: 13, marginTop: 8, marginBottom: 6 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  chipOn: { backgroundColor: Colors.primary },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: '#222' },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 6,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  modeRowOn: { backgroundColor: 'rgba(228,181,59,0.14)' },
  modeLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  modeDesc: { color: '#9a9a9a', fontSize: 12, marginTop: 1 },
  privacy: {
    color: '#7a7a7a',
    fontSize: 11,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 18,
    lineHeight: 16,
  },
});
