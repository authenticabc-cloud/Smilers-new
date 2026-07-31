/**
 * VoiceTypingButton — hands-free dictation control for the chat composer.
 *
 * Tap the mic to start dictating; finalized speech streams into the composer
 * (`onAppendText`). After a 5s pause a prompt asks "Send or keep talking?".
 * Long-press the mic to choose the dictation language (only high-accuracy
 * languages are offered). Native-only (needs a real build).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme';
import { useVoiceTyping } from '../../lib/voiceTyping/useVoiceTyping';
import { spokenToEmoji } from '../../lib/voiceTyping/spokenToEmoji';
import {
  VOICE_TYPING_LANGUAGES,
  ALL_VOICE_TYPING_CODES,
  AUTO_CODE,
  defaultVoiceTypingCode,
  labelForCode,
  flagForCode,
} from '../../lib/voiceTyping/voiceTypingLanguages';

const LANG_KEY = 'smilers_voice_typing_lang';

export function VoiceTypingButton({
  disabled,
  onAppendText,
  onRequestSend,
}: {
  disabled?: boolean;
  onAppendText: (text: string) => void;
  onRequestSend: () => void;
}) {
  const [languageCode, setLanguageCode] = useState<string>(defaultVoiceTypingCode());
  const [listening, setListening] = useState(false);
  const [showLang, setShowLang] = useState(false);
  const [pausePrompt, setPausePrompt] = useState(false);
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const dictatedRef = useRef(false); // any speech captured this session?

  const isAuto = languageCode === AUTO_CODE;
  // On iOS the recognizer can't auto-detect, so "Auto" falls back to the
  // device's default supported language.
  const baseLang = isAuto ? defaultVoiceTypingCode() : languageCode;

  // Load the persisted language once.
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(LANG_KEY);
        if (saved && (saved === AUTO_CODE || VOICE_TYPING_LANGUAGES.some((l) => l.code === saved))) {
          setLanguageCode(saved);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const handleFinalText = useCallback(
    (t: string) => {
      dictatedRef.current = true;
      onAppendText(spokenToEmoji(t));
    },
    [onAppendText],
  );

  const handleSilence = useCallback(() => {
    // Pause and ask the user only if we actually captured something.
    if (!dictatedRef.current) return;
    setListening(false);
    setPausePrompt(true);
  }, []);

  const { partial } = useVoiceTyping({
    listening,
    languageCode: baseLang,
    onFinalText: handleFinalText,
    onSilence: handleSilence,
    silenceMs: 5000,
    autoDetect: isAuto,
    allowedLanguages: ALL_VOICE_TYPING_CODES,
    onDetectLanguage: (c) => setDetectedLang(c),
  });

  const toggle = useCallback(() => {
    if (disabled) return;
    setPausePrompt(false);
    setListening((v) => {
      if (!v) {
        dictatedRef.current = false;
        setDetectedLang(null);
      }
      return !v;
    });
  }, [disabled]);

  const pickLanguage = useCallback(async (code: string) => {
    setLanguageCode(code);
    setShowLang(false);
    try {
      await AsyncStorage.setItem(LANG_KEY, code);
    } catch {
      /* ignore */
    }
  }, []);

  // Pulsing red dot while listening.
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!listening) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  const onSend = useCallback(() => {
    setPausePrompt(false);
    onRequestSend();
  }, [onRequestSend]);

  const onKeepTalking = useCallback(() => {
    setPausePrompt(false);
    setListening(true);
  }, []);

  const onStop = useCallback(() => {
    setPausePrompt(false);
    setListening(false);
  }, []);

  return (
    <>
      <TouchableOpacity
        style={[styles.webToolBtn, listening && styles.micActive, disabled ? styles.disabled : null]}
        onPress={toggle}
        onLongPress={() => setShowLang(true)}
        disabled={disabled}
        testID="composer-voice-typing"
        accessibilityLabel="Voice typing"
      >
        {listening ? (
          <Animated.View style={{ opacity: pulse }}>
            <Feather name="mic" size={18} color={Colors.white} />
          </Animated.View>
        ) : (
          <Feather name="mic" size={18} color={Colors.primary} />
        )}
      </TouchableOpacity>

      {/* Live listening banner */}
      <Modal visible={listening} transparent animationType="fade" onRequestClose={onStop}>
        <View style={styles.bannerWrap} pointerEvents="box-none">
          <View style={styles.banner} testID="voice-typing-banner">
            <View style={styles.recDot} />
            <View style={styles.flexOne}>
              <Text style={styles.bannerTitle}>
                Listening ·{' '}
                {isAuto
                  ? detectedLang
                    ? `Auto · ${flagForCode(detectedLang)} ${labelForCode(detectedLang)}`
                    : 'Auto-detect'
                  : `${flagForCode(languageCode)} ${labelForCode(languageCode)}`}
              </Text>
              <Text style={styles.bannerPartial} numberOfLines={2}>
                {partial ? partial : 'Speak now… pause to send'}
              </Text>
            </View>
            <TouchableOpacity onPress={onStop} style={styles.bannerStop} testID="voice-typing-stop">
              <Feather name="x" size={20} color={Colors.white} />
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 5s-pause confirmation */}
      <Modal visible={pausePrompt} transparent animationType="fade" onRequestClose={onStop}>
        <Pressable style={styles.promptBackdrop} onPress={onStop}>
          <Pressable style={styles.promptCard} onPress={() => {}} testID="voice-typing-prompt">
            <Feather name="pause-circle" size={30} color={Colors.primary} />
            <Text style={styles.promptTitle}>You paused</Text>
            <Text style={styles.promptSub}>Send this message or keep talking?</Text>
            <View style={styles.promptRow}>
              <TouchableOpacity style={[styles.promptBtn, styles.promptGhost]} onPress={onKeepTalking} testID="voice-typing-continue">
                <Feather name="mic" size={18} color={Colors.primary} />
                <Text style={styles.promptGhostText}>Keep talking</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.promptBtn, styles.promptSolid]} onPress={onSend} testID="voice-typing-send">
                <Feather name="send" size={18} color={Colors.white} />
                <Text style={styles.promptSolidText}>Send</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Language picker */}
      <Modal visible={showLang} transparent animationType="slide" onRequestClose={() => setShowLang(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setShowLang(false)}>
          <Pressable style={styles.langSheet} onPress={() => {}} testID="voice-typing-lang-sheet">
            <Text style={styles.langTitle}>Voice typing language</Text>
            <Text style={styles.langHint}>Only high-accuracy languages are available.</Text>
            <FlatList
              data={VOICE_TYPING_LANGUAGES}
              keyExtractor={(l) => l.code}
              ListHeaderComponent={
                <TouchableOpacity
                  style={[styles.langRow, isAuto && styles.langRowActive]}
                  onPress={() => pickLanguage(AUTO_CODE)}
                  testID="voice-typing-lang-auto"
                >
                  <Text style={styles.langFlag}>🌐</Text>
                  <View style={styles.flexOne}>
                    <Text style={[styles.langLabel, isAuto && styles.langLabelActive]}>Auto-detect</Text>
                    <Text style={styles.langNote}>
                      {Platform.OS === 'ios' ? 'Falls back to your device language on iOS' : 'Detects & switches language as you speak'}
                    </Text>
                  </View>
                  {isAuto ? <Feather name="check" size={18} color={Colors.primary} /> : null}
                </TouchableOpacity>
              }
              renderItem={({ item }) => {
                const active = item.code === languageCode;
                return (
                  <TouchableOpacity
                    style={[styles.langRow, active && styles.langRowActive]}
                    onPress={() => pickLanguage(item.code)}
                    testID={`voice-typing-lang-${item.code}`}
                  >
                    <Text style={styles.langFlag}>{item.flag}</Text>
                    <Text style={[styles.langLabel, active && styles.langLabelActive]}>{item.label}</Text>
                    {active ? <Feather name="check" size={18} color={Colors.primary} /> : null}
                  </TouchableOpacity>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flexOne: { flex: 1 },
  webToolBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
  },
  micActive: { backgroundColor: Colors.danger },
  disabled: { opacity: 0.4 },
  bannerWrap: { flex: 1, justifyContent: 'flex-end', paddingBottom: 120, paddingHorizontal: Spacing.base },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1c1c1e',
    borderRadius: Radius.lg,
    padding: Spacing.base,
    ...Shadow.lg,
  },
  recDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.danger },
  bannerTitle: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  bannerPartial: { color: '#c7c7cc', fontSize: FontSize.sm, marginTop: 2 },
  bannerStop: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  promptBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 28 },
  promptCard: {
    backgroundColor: Colors.surface,
    borderRadius: 18,
    padding: Spacing.lg,
    alignItems: 'center',
    ...Shadow.lg,
  },
  promptTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginTop: 8 },
  promptSub: { fontSize: FontSize.base, color: Colors.textSecondary, marginTop: 4, textAlign: 'center' },
  promptRow: { flexDirection: 'row', gap: 12, marginTop: Spacing.lg },
  promptBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    height: 46,
    borderRadius: 23,
  },
  promptGhost: { backgroundColor: Colors.primaryLight },
  promptGhostText: { color: Colors.primary, fontWeight: FontWeight.bold },
  promptSolid: { backgroundColor: Colors.primary },
  promptSolidText: { color: Colors.white, fontWeight: FontWeight.bold },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  langSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: Spacing.md,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.lg,
    maxHeight: '70%',
    ...Shadow.lg,
  },
  langTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary, textAlign: 'center' },
  langHint: { fontSize: FontSize.sm, color: Colors.textMuted, textAlign: 'center', marginTop: 2, marginBottom: 8 },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  langRowActive: {},
  langFlag: { fontSize: 22 },
  langLabel: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  langLabelActive: { color: Colors.primary, fontWeight: FontWeight.bold },
  langNote: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },
});

export default VoiceTypingButton;
