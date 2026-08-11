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
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme';
import { useVoiceTyping } from '../../lib/voiceTyping/useVoiceTyping';
import { spokenToEmoji } from '../../lib/voiceTyping/spokenToEmoji';
import { EMOJI_PHRASE_LIST, EMOJI_TRIGGER_WORDS } from '../../lib/voiceTyping/spokenToEmoji';
import { applyCorrections, learnFromDiff, loadCorrections, learnCorrection, parseSpellingCorrection, getCorrectionWords } from '../../lib/voiceTyping/corrections';
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
  currentText = '',
  onReplaceText,
}: {
  disabled?: boolean;
  onAppendText: (text: string) => void;
  onRequestSend: () => void;
  /** Current composer text — seeds the "Edit" corrector. */
  currentText?: string;
  /** Replace the whole composer text (used after an "Edit" correction). */
  onReplaceText?: (text: string) => void;
}) {
  const [languageCode, setLanguageCode] = useState<string>(defaultVoiceTypingCode());
  const [listening, setListening] = useState(false);
  const [showLang, setShowLang] = useState(false);
  const [pausePrompt, setPausePrompt] = useState(false);
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [showCheat, setShowCheat] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editValue, setEditValue] = useState('');
  const editBeforeRef = useRef(''); // pre-edit text to diff for learning
  const dictatedRef = useRef(false); // any speech captured this session?
  const commandModeRef = useRef(false); // during the pause prompt, listen for "send"/"continue"
  const voiceCorrectRef = useRef(false); // voice-driven "edit" correction mode
  const [voiceCorrect, setVoiceCorrect] = useState(false);
  const [correctNote, setCorrectNote] = useState<string | null>(null);
  const [ctxWords, setCtxWords] = useState<string[]>([]);

  // Load the learned correction dictionary once so finalized speech is
  // auto-fixed for words the user previously corrected.
  useEffect(() => {
    void loadCorrections().then(() => setCtxWords(getCorrectionWords()));
  }, []);

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
      if (voiceCorrectRef.current) {
        voiceCorrectionRef.current(t);
        return;
      }
      if (commandModeRef.current) {
        interpretCommandRef.current(t);
        return;
      }
      dictatedRef.current = true;
      onAppendText(spokenToEmoji(applyCorrections(t)));
    },
    [onAppendText],
  );

  const handleSilence = useCallback(() => {
    // Pause and ask the user only if we actually captured something. Keep the
    // recognizer running in COMMAND MODE so the user can say "send"/"continue".
    if (!dictatedRef.current) return;
    commandModeRef.current = true;
    setPausePrompt(true);
    setListening(true);
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
    contextualStrings: ctxWords,
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
    commandModeRef.current = false;
    setPausePrompt(false);
    setListening(false);
    onRequestSend();
  }, [onRequestSend]);

  const onKeepTalking = useCallback(() => {
    commandModeRef.current = false;
    setPausePrompt(false);
    setListening(true);
  }, []);

  const onStop = useCallback(() => {
    commandModeRef.current = false;
    voiceCorrectRef.current = false;
    setVoiceCorrect(false);
    setPausePrompt(false);
    setListening(false);
  }, []);

  // Enter hands-free voice-correction mode from the pause prompt (spoken "edit"
  // or the Edit button). Keeps the recognizer running to catch the spelling.
  const startVoiceCorrect = useCallback(() => {
    commandModeRef.current = false;
    voiceCorrectRef.current = true;
    setVoiceCorrect(true);
    setPausePrompt(false);
    setCorrectNote(null);
    setListening(true);
  }, []);

  const exitVoiceCorrect = useCallback((thenSend?: boolean) => {
    voiceCorrectRef.current = false;
    setVoiceCorrect(false);
    setCorrectNote(null);
    if (thenSend) {
      setListening(false);
      onRequestSend();
    } else {
      dictatedRef.current = false;
      setListening(true);
    }
  }, [onRequestSend]);

  // Third option on the pause prompt: hand-correct wrongly transcribed words.
  // Pauses the recognizer, opens an editor seeded with the current message.
  const onEdit = useCallback(() => {
    commandModeRef.current = false;
    setListening(false);
    setPausePrompt(false);
    editBeforeRef.current = currentText || '';
    setEditValue(currentText || '');
    setEditOpen(true);
  }, [currentText]);

  // Save the correction: push the edited text back to the composer AND learn
  // the misheard→intended word mappings for next time. Then either keep
  // talking or send.
  const commitEdit = useCallback(
    async (thenSend: boolean) => {
      const edited = editValue;
      onReplaceText?.(edited);
      try {
        await learnFromDiff(editBeforeRef.current, edited);
      } catch {
        /* ignore */
      }
      setEditOpen(false);
      if (thenSend) {
        setListening(false);
        onRequestSend();
      } else {
        // resume dictation, appending after the corrected text
        dictatedRef.current = false;
        setListening(true);
      }
    },
    [editValue, onReplaceText, onRequestSend],
  );

  // Voice-sensitive prompt: interpret "send" / "continue" / "edit" spoken during the pause.
  const interpretCommandRef = useRef<(t: string) => void>(() => {});
  interpretCommandRef.current = (text: string) => {
    if (!commandModeRef.current) return;
    const s = String(text || '').toLowerCase();
    if (/\bsend\b/.test(s)) onSend();
    else if (/\b(edit|correct|correction|spelling|fix)\b/.test(s)) startVoiceCorrect();
    else if (/\b(continue|keep|talking|talk|resume)\b/.test(s)) onKeepTalking();
  };

  // Voice-correction mode: user says "<word> is spelt X y z" → learn + apply.
  const voiceCorrectionRef = useRef<(t: string) => void>(() => {});
  voiceCorrectionRef.current = (text: string) => {
    if (!voiceCorrectRef.current) return;
    const s = String(text || '').toLowerCase().trim();
    if (/\b(done|finish|finished|stop|that'?s all)\b/.test(s) && !/spel/.test(s)) {
      exitVoiceCorrect();
      return;
    }
    const parsed = parseSpellingCorrection(text);
    if (!parsed) {
      setCorrectNote('Say: “<word> is spelt A B C”');
      return;
    }
    void learnCorrection(parsed.misheard, parsed.correct).then(() => setCtxWords(getCorrectionWords()));
    // Fix any occurrence already in the composer.
    if (onReplaceText && currentText) onReplaceText(applyCorrections(currentText));
    setCorrectNote(`Learned: “${parsed.misheard}” → “${parsed.correct}”`);
  };
  // Interim results give a snappier response than waiting for the final chunk.
  useEffect(() => {
    if (pausePrompt && commandModeRef.current && partial) interpretCommandRef.current(partial);
  }, [partial, pausePrompt]);

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

      {/* Live listening banner (hidden while the pause prompt / voice-correct is up) */}
      <Modal visible={listening && !pausePrompt && !voiceCorrect} transparent animationType="fade" onRequestClose={onStop}>
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
            <Text style={styles.promptHint}>🎙 Say “Send”, “Continue” or “Edit”</Text>
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
            <TouchableOpacity style={styles.promptEditBtn} onPress={onEdit} testID="voice-typing-edit">
              <Feather name="edit-3" size={16} color={Colors.textSecondary} />
              <Text style={styles.promptEditText}>Edit &amp; correct words</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Edit & correct — hand-fix mis-transcribed words; corrections are learned. */}
      <Modal visible={editOpen} transparent animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView style={styles.editBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.editCard} testID="voice-typing-edit-sheet">
            <View style={styles.editHeader}>
              <Text style={styles.editTitle}>Edit &amp; correct</Text>
              <TouchableOpacity onPress={() => setEditOpen(false)} hitSlop={8} testID="voice-typing-edit-close">
                <Feather name="x" size={22} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.editHint}>
              Fix any wrongly heard words. Smilers remembers your fixes and transcribes them correctly next time.
            </Text>
            <TextInput
              style={styles.editInput}
              value={editValue}
              onChangeText={setEditValue}
              multiline
              autoFocus
              placeholder="Your dictated text…"
              placeholderTextColor={Colors.textMuted}
              testID="voice-typing-edit-input"
            />
            <View style={styles.promptRow}>
              <TouchableOpacity style={[styles.promptBtn, styles.promptGhost]} onPress={() => void commitEdit(false)} testID="voice-typing-edit-continue">
                <Feather name="mic" size={18} color={Colors.primary} />
                <Text style={styles.promptGhostText}>Save &amp; talk</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.promptBtn, styles.promptSolid]} onPress={() => void commitEdit(true)} testID="voice-typing-edit-send">
                <Feather name="send" size={18} color={Colors.white} />
                <Text style={styles.promptSolidText}>Save &amp; send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Voice-correction mode — teach a spelling entirely by voice. */}
      <Modal visible={voiceCorrect} transparent animationType="fade" onRequestClose={() => exitVoiceCorrect(false)}>
        <View style={styles.bannerWrap} pointerEvents="box-none">
          <View style={styles.vcCard} testID="voice-correct-banner">
            <View style={styles.vcHeaderRow}>
              <View style={styles.recDot} />
              <Text style={styles.vcTitle}>Voice correction</Text>
            </View>
            <Text style={styles.vcInstruction}>
              Say the word, then spell it — e.g. “Santi is spelt S a n t i”.
            </Text>
            {partial ? (
              <Text style={styles.vcPartial} numberOfLines={2}>{partial}</Text>
            ) : null}
            {correctNote ? (
              <View style={styles.vcNote}>
                <Feather name="check-circle" size={14} color="#34c759" />
                <Text style={styles.vcNoteText} numberOfLines={2}>{correctNote}</Text>
              </View>
            ) : null}
            <View style={styles.promptRow}>
              <TouchableOpacity style={[styles.promptBtn, styles.promptGhost]} onPress={() => exitVoiceCorrect(false)} testID="voice-correct-done">
                <Feather name="mic" size={18} color={Colors.primary} />
                <Text style={styles.promptGhostText}>Done, keep talking</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.promptBtn, styles.promptSolid]} onPress={() => exitVoiceCorrect(true)} testID="voice-correct-send">
                <Feather name="send" size={18} color={Colors.white} />
                <Text style={styles.promptSolidText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Language picker */}
      <Modal visible={showLang} transparent animationType="slide" onRequestClose={() => setShowLang(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setShowLang(false)}>
          <Pressable style={styles.langSheet} onPress={() => {}} testID="voice-typing-lang-sheet">
            <View style={styles.langHeaderRow}>
              <Text style={styles.langTitle}>Voice typing language</Text>
              <TouchableOpacity onPress={() => setShowCheat(true)} hitSlop={10} testID="voice-typing-cheat-open">
                <Feather name="info" size={20} color={Colors.primary} />
              </TouchableOpacity>
            </View>
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

      {/* Voice emoji commands cheat-sheet */}
      <Modal visible={showCheat} transparent animationType="slide" onRequestClose={() => setShowCheat(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setShowCheat(false)}>
          <Pressable style={styles.langSheet} onPress={() => {}} testID="voice-typing-cheat-sheet">
            <Text style={styles.langTitle}>Voice emoji commands</Text>
            <Text style={styles.langHint}>Say a phrase and it turns into an emoji (English).</Text>
            <FlatList
              data={EMOJI_PHRASE_LIST}
              keyExtractor={(i) => i.phrase}
              numColumns={2}
              columnWrapperStyle={styles.cheatCol}
              ListFooterComponent={
                <View style={styles.cheatFooter}>
                  <Text style={styles.cheatFooterTitle}>Tip: say “emoji …”</Text>
                  <Text style={styles.cheatFooterSub}>
                    {EMOJI_TRIGGER_WORDS.slice(0, 8).map((t) => `${t.emoji} ${t.word}`).join('   ')}
                  </Text>
                </View>
              }
              renderItem={({ item }) => (
                <View style={styles.cheatRow}>
                  <Text style={styles.cheatEmoji}>{item.emoji}</Text>
                  <Text style={styles.cheatPhrase} numberOfLines={1}>“{item.phrase}”</Text>
                </View>
              )}
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
  promptHint: { fontSize: FontSize.sm, color: Colors.primary, marginTop: 8, fontWeight: FontWeight.semibold },
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
  promptEditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 6,
  },
  promptEditText: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  vcCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: Radius.lg,
    padding: Spacing.base,
    gap: 10,
    ...Shadow.lg,
  },
  vcHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  vcTitle: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  vcInstruction: { color: '#c7c7cc', fontSize: FontSize.sm, lineHeight: 19 },
  vcPartial: { color: Colors.white, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  vcNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(52,199,89,0.15)',
    borderRadius: Radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  vcNoteText: { flex: 1, color: '#e6ffe9', fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  editBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  editCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: Spacing.lg,
    gap: Spacing.md,
    ...Shadow.lg,
  },
  editHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  editHint: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 },
  editInput: {
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border || '#E5E7EB',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    minHeight: 96,
    maxHeight: 220,
    textAlignVertical: 'top',
  },
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
  langHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  langHint: { fontSize: FontSize.sm, color: Colors.textMuted, textAlign: 'center', marginTop: 2, marginBottom: 8 },
  cheatCol: { gap: 10 },
  cheatRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryLight,
    marginBottom: 8,
  },
  cheatEmoji: { fontSize: 20 },
  cheatPhrase: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary },
  cheatFooter: { marginTop: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  cheatFooterTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  cheatFooterSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, lineHeight: 22 },
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
