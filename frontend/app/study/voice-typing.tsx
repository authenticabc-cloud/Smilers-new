/**
 * Voice Typing — dictate text with live word-by-word transcription
 * (expo-speech-recognition, on-device). When the user pauses for >10s, a spoken
 * prompt (device TTS) asks whether they're finished or want to continue:
 *   - Finished  → a second spoken prompt asks whether to copy to the clipboard.
 *                 Either way the note is saved to the on-device history (always
 *                 copyable). "Yes" also copies it immediately.
 *   - Continue  → the session is put ON HOLD until the user resumes. The same
 *                 10s-pause cycle repeats every time they pause again.
 * Users can respond by tapping buttons OR by voice (yes/no keywords).
 *
 * NATIVE-ONLY: on-device speech recognition needs a development/production
 * build — it does not run in Expo Go or the web preview.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import * as Speech from 'expo-speech';
import * as Clipboard from 'expo-clipboard';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useAction } from 'convex/react';

import { Colors } from '../../src/theme';
import { api } from '../../src/convexApi';
import { liveCapitalize, applyCaps } from '../../src/lib/voiceTyping/capitalize';
import {
  loadVoiceNotes,
  saveVoiceNote,
  deleteVoiceNote,
  type VoiceNote,
} from '../../src/lib/voiceTyping/historyStore';

const PAUSE_MS = 10000; // 10s of silence → prompt

type Phase = 'idle' | 'listening' | 'promptFinish' | 'promptCopy' | 'onhold';
type Mode = 'dictation' | 'finishCmd' | 'copyCmd';

// Command keywords — English + common local-language equivalents (Akan/Twi,
// French, Hausa, Ewe/Ga) so voice replies to the prompts work for more users.
const FINISH_WORDS = [
  // English
  'finish', 'finished', 'done', 'complete', 'stop', "that's all", 'thats all', 'yes',
  // Akan / Twi
  'awie', 'awiei', 'me awie', 'aba awiei',
  // French
  'fini', 'termin', 'oui',
  // Hausa
  'an gama', 'gama',
  // Ewe / Ga
  'vɔ', 'ewu', 'egbe',
];
const CONTINUE_WORDS = [
  // English
  'continue', 'resume', 'keep going', 'not yet', 'more', 'carry on', 'no',
  // Akan / Twi
  'kɔ so', 'ko so', 'toa so', 'toaso', 'daabi',
  // French
  'continuer', 'continue', 'encore', 'non', 'pas encore',
  // Hausa
  'ci gaba', "a'a",
  // Ewe / Ga
  'yi edzi', 'kɔ yi',
];
const YES_WORDS = [
  'yes', 'yeah', 'yep', 'sure', 'copy', 'ok', 'okay', 'please',
  'aane', 'yiw', 'oui', 'copie', 'na', 'eh',
];
const NO_WORDS = [
  'no', 'nope', "don't", 'dont', 'keep', 'leave', 'save',
  'daabi', 'non', "a'a", 'aa',
];

function matchAny(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w));
}

export default function VoiceTypingScreen() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [committed, setCommitted] = useState('');
  const [interim, setInterim] = useState('');
  const [history, setHistory] = useState<VoiceNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // CAPS-lock: when ON, everything is displayed/saved uppercase. The buffer in
  // `committedRef` always stays natural-cased so toggling OFF is non-lossy.
  const [capsLock, setCapsLock] = useState(false);
  // Grammar-adaptive AI polish (proper nouns, punctuation, obvious grammar).
  const [polishing, setPolishing] = useState(false);

  const phaseRef = useRef<Phase>('idle');
  const modeRef = useRef<Mode>('dictation');
  const committedRef = useRef('');
  const capsLockRef = useRef(false);
  const lastSpeechRef = useRef(Date.now());
  const pauseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const polishAction = useAction(api.study.voiceTypingGrammar.polish);

  const setPhaseSafe = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  // Load persisted history.
  useEffect(() => {
    loadVoiceNotes().then(setHistory);
  }, []);

  // ── Speech recognition events ─────────────────────────────────────────────
  useSpeechRecognitionEvent('result', (e: any) => {
    const transcript = String(e?.results?.[0]?.transcript ?? '').trim();
    lastSpeechRef.current = Date.now();

    if (modeRef.current === 'dictation') {
      if (!transcript) return;
      if (e?.isFinal) {
        committedRef.current = liveCapitalize((committedRef.current + ' ' + transcript).trim());
        setCommitted(committedRef.current);
        setInterim('');
      } else {
        setInterim(transcript);
      }
      return;
    }

    // Command mode (voice reply to a prompt). Only act on a final result.
    if (!e?.isFinal || !transcript) return;
    if (modeRef.current === 'finishCmd') {
      // "Continue" wins over "finish" when both loosely match, unless a strong
      // finish word is present (avoids ambiguity around shared yes/no tokens).
      const strongFinish = ['finish', 'finished', 'done', 'complete', 'stop', 'awie', 'fini', 'gama'];
      if (matchAny(transcript, CONTINUE_WORDS) && !matchAny(transcript, strongFinish)) {
        handleContinue();
      } else if (matchAny(transcript, FINISH_WORDS)) {
        handleFinished();
      }
    } else if (modeRef.current === 'copyCmd') {
      if (matchAny(transcript, NO_WORDS) && !matchAny(transcript, ['yes', 'copy'])) {
        finalizeNote(false);
      } else if (matchAny(transcript, YES_WORDS)) {
        finalizeNote(true);
      }
    }
  });

  useSpeechRecognitionEvent('speechstart', () => {
    lastSpeechRef.current = Date.now();
  });

  useSpeechRecognitionEvent('error', (e: any) => {
    const code = String(e?.error || '');
    if (code === 'language-not-supported') {
      setError("This language isn't available for voice typing. Try switching your keyboard/device language to a supported one.");
    } else if (code === 'not-allowed' || code === 'service-not-allowed') {
      setError('Microphone or speech permission was denied.');
    } else if (code === 'network') {
      setError('Network error — voice typing needs a connection unless on-device recognition is available.');
    } else if (code === 'no-speech') {
      // benign — the pause handler covers this
      return;
    }
    // In command mode a mis-fire shouldn't wedge the state machine — buttons stay.
  });

  // If recognition ends on its own while we're still dictating, restart it so
  // dictation stays continuous.
  useSpeechRecognitionEvent('end', () => {
    if (phaseRef.current === 'listening' && modeRef.current === 'dictation') {
      try {
        startRecognition('dictation');
      } catch {}
    }
  });

  // ── Pause watchdog: 10s of silence while dictating → finish prompt ─────────
  useEffect(() => {
    if (phase !== 'listening') return;
    pauseTimerRef.current = setInterval(() => {
      if (phaseRef.current !== 'listening') return;
      if (Date.now() - lastSpeechRef.current >= PAUSE_MS) {
        triggerFinishPrompt();
      }
    }, 1000);
    return () => {
      if (pauseTimerRef.current) clearInterval(pauseTimerRef.current);
      pauseTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {}
      try {
        Speech.stop();
      } catch {}
      if (pauseTimerRef.current) clearInterval(pauseTimerRef.current);
    };
  }, []);

  // ── Recognition control ───────────────────────────────────────────────────
  const startRecognition = useCallback((mode: Mode) => {
    modeRef.current = mode;
    try {
      ExpoSpeechRecognitionModule.start({
        // No explicit lang → device default; auto language-detection on Android.
        interimResults: mode === 'dictation',
        continuous: mode === 'dictation',
        addsPunctuation: true,
        androidIntentOptions:
          mode === 'dictation'
            ? { EXTRA_ENABLE_LANGUAGE_DETECTION: true }
            : undefined,
      } as any);
    } catch {
      setError('Could not start voice typing on this device.');
    }
  }, []);

  const stopRecognition = useCallback(() => {
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {}
  }, []);

  const ensurePermission = useCallback(async (): Promise<boolean> => {
    try {
      const cur = await ExpoSpeechRecognitionModule.getPermissionsAsync();
      if (cur.granted) return true;
      if (cur.canAskAgain) {
        const req = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (req.granted) return true;
        if (!req.canAskAgain) {
          Alert.alert(
            'Microphone needed',
            'Voice Typing needs microphone & speech access. Enable it in Settings to continue.',
            [
              { text: 'Not now', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ],
          );
        }
        return false;
      }
      Alert.alert(
        'Microphone needed',
        'Voice Typing needs microphone & speech access. Enable it in Settings to continue.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ],
      );
      return false;
    } catch {
      return false;
    }
  }, []);

  const beginListening = useCallback(async () => {
    setError(null);
    if (Platform.OS === 'web') {
      setError('Voice Typing needs a device build — it does not run in the web preview.');
      return;
    }
    const ok = await ensurePermission();
    if (!ok) return;
    lastSpeechRef.current = Date.now();
    setPhaseSafe('listening');
    startRecognition('dictation');
  }, [ensurePermission, setPhaseSafe, startRecognition]);

  // ── Prompt flow ───────────────────────────────────────────────────────────
  const speak = useCallback((text: string) => {
    try {
      Speech.stop();
      Speech.speak(text, { rate: 0.98 });
    } catch {}
  }, []);

  const triggerFinishPrompt = useCallback(() => {
    if (pauseTimerRef.current) clearInterval(pauseTimerRef.current);
    stopRecognition();
    setInterim('');
    setPhaseSafe('promptFinish');
    speak('Have you finished typing, or do you want to continue?');
    // Listen for a spoken yes/no after a short beat so TTS doesn't feed the mic.
    setTimeout(() => {
      if (phaseRef.current === 'promptFinish') startRecognition('finishCmd');
    }, 2200);
  }, [setPhaseSafe, speak, startRecognition, stopRecognition]);

  const handleContinue = useCallback(() => {
    stopRecognition();
    try {
      Speech.stop();
    } catch {}
    modeRef.current = 'dictation';
    setPhaseSafe('onhold');
  }, [setPhaseSafe, stopRecognition]);

  // Apply CAPS-lock + on-device live capitalization, then run the backend
  // grammar-adaptive polish (proper nouns, punctuation, obvious grammar). The
  // action never rewrites the speaker's words — it only fixes casing/grammar.
  const runPolish = useCallback(async () => {
    const raw = committedRef.current.trim();
    if (!raw) return;
    const base = capsLockRef.current ? raw.toUpperCase() : liveCapitalize(raw);
    committedRef.current = base;
    setCommitted(base);
    setPolishing(true);
    try {
      const res = await polishAction({ text: base, allCaps: capsLockRef.current });
      if (typeof res === 'string' && res.trim()) {
        committedRef.current = res;
        setCommitted(res);
      }
    } catch {
      /* polish is best-effort — keep the live-capitalized text on failure */
    }
    setPolishing(false);
  }, [polishAction]);

  // CAPS-lock toggle. The buffer stays natural-cased; only display/output casing
  // flips, so turning it OFF restores natural sentence capitalization.
  const toggleCaps = useCallback(() => {
    setCapsLock((prev) => {
      const next = !prev;
      capsLockRef.current = next;
      return next;
    });
  }, []);

  const handleFinished = useCallback(async () => {
    stopRecognition();
    // Grammar-adaptive polish runs here, BEFORE the copy prompt, so the copied/
    // saved text is already corrected.
    await runPolish();
    setPhaseSafe('promptCopy');
    speak('Do you want to copy it to the clipboard?');
    setTimeout(() => {
      if (phaseRef.current === 'promptCopy') startRecognition('copyCmd');
    }, 2200);
  }, [runPolish, setPhaseSafe, speak, startRecognition, stopRecognition]);

  const finalizeNote = useCallback(
    async (copy: boolean) => {
      stopRecognition();
      try {
        Speech.stop();
      } catch {}
      modeRef.current = 'dictation';
      const text = applyCaps(committedRef.current.trim(), capsLockRef.current);
      if (copy && text) {
        try {
          await Clipboard.setStringAsync(text);
        } catch {}
        speak('Copied to clipboard.');
      }
      if (text) {
        const next = await saveVoiceNote(text);
        setHistory(next);
      }
      // Reset the working buffer for the next dictation.
      committedRef.current = '';
      setCommitted('');
      setInterim('');
      setPhaseSafe('idle');
    },
    [setPhaseSafe, speak, stopRecognition],
  );

  const resumeFromHold = useCallback(async () => {
    const ok = await ensurePermission();
    if (!ok) return;
    lastSpeechRef.current = Date.now();
    setPhaseSafe('listening');
    startRecognition('dictation');
  }, [ensurePermission, setPhaseSafe, startRecognition]);

  // Manual "stop" button (finish immediately without waiting for the pause).
  const stopAndFinish = useCallback(() => {
    handleFinished();
  }, [handleFinished]);

  const copyCurrent = useCallback(async () => {
    const text = applyCaps((committedRef.current + ' ' + interim).trim(), capsLockRef.current);
    if (!text) return;
    await Clipboard.setStringAsync(text);
    setError(null);
    Alert.alert('Copied', 'Your text was copied to the clipboard.');
  }, [interim]);

  const copyNote = useCallback(async (note: VoiceNote) => {
    await Clipboard.setStringAsync(note.text);
    setCopiedId(note.id);
    setTimeout(() => setCopiedId((c) => (c === note.id ? null : c)), 1500);
  }, []);

  const removeNote = useCallback((note: VoiceNote) => {
    Alert.alert('Delete note', 'Remove this saved note?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => setHistory(await deleteVoiceNote(note.id)),
      },
    ]);
  }, []);

  // "Send to…" — route a saved note straight into Study AI, the Diary composer,
  // or the OS share sheet (to drop it into any chat/app).
  const sendNote = useCallback((note: VoiceNote) => {
    Alert.alert('Send to…', undefined, [
      {
        text: 'Ask Study AI',
        onPress: () => router.push({ pathname: '/study/session', params: { q: note.text } } as any),
      },
      {
        text: 'Save to Diary',
        onPress: () => router.push({ pathname: '/diary', params: { prefill: note.text } } as any),
      },
      {
        text: 'Share…',
        onPress: () => {
          Share.share({ message: note.text }).catch(() => {});
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, []);

  const displayText = useMemo(() => {
    const natural = liveCapitalize((committed + (interim ? ' ' + interim : '')).trim());
    return applyCaps(natural, capsLock);
  }, [committed, interim, capsLock]);
  const isPrompt = phase === 'promptFinish' || phase === 'promptCopy';

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Voice Typing</Text>
          <Text style={styles.subtitle}>Speak and it types for you</Text>
        </View>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {error ? (
          <View style={styles.errorBox}>
            <Feather name="alert-triangle" size={16} color={Colors.warningDark} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Transcript card */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardLabel}>
              {phase === 'listening' ? 'Listening…' : phase === 'onhold' ? 'On hold' : 'Your text'}
            </Text>
            <View style={styles.cardHeadActions}>
              <TouchableOpacity
                onPress={toggleCaps}
                style={[styles.capsBtn, capsLock && styles.capsBtnOn]}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ selected: capsLock }}
              >
                <Feather name="type" size={13} color={capsLock ? Colors.white : Colors.primaryDark} />
                <Text style={[styles.capsBtnText, capsLock && styles.capsBtnTextOn]}>
                  CAPS {capsLock ? 'ON' : 'OFF'}
                </Text>
              </TouchableOpacity>
              {displayText ? (
                <TouchableOpacity onPress={copyCurrent} style={styles.copyInline} hitSlop={8}>
                  <Feather name="copy" size={14} color={Colors.primaryDark} />
                  <Text style={styles.copyInlineText}>Copy</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
          <Text style={[styles.transcript, !displayText && styles.transcriptPlaceholder]}>
            {displayText || 'Tap the mic and start speaking. When you pause for 10 seconds I\u2019ll ask if you\u2019re done.'}
          </Text>
          {committed ? (
            <TouchableOpacity
              onPress={runPolish}
              style={styles.polishBtn}
              disabled={polishing}
              hitSlop={6}
            >
              {polishing ? (
                <ActivityIndicator size="small" color={Colors.primaryDark} />
              ) : (
                <Feather name="check-circle" size={15} color={Colors.primaryDark} />
              )}
              <Text style={styles.polishBtnText}>
                {polishing ? 'Fixing…' : 'Fix grammar & capitals'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Prompt actions (also voice-controllable) */}
        {phase === 'promptFinish' ? (
          <View style={styles.promptBox}>
            <Text style={styles.promptTitle}>Finished, or continue?</Text>
            <View style={styles.promptRow}>
              <Pressable style={[styles.promptBtn, styles.promptPrimary]} onPress={handleFinished}>
                <Feather name="check" size={18} color={Colors.white} />
                <Text style={styles.promptBtnText}>Finished</Text>
              </Pressable>
              <Pressable style={[styles.promptBtn, styles.promptGhost]} onPress={handleContinue}>
                <Feather name="mic" size={18} color={Colors.textPrimary} />
                <Text style={[styles.promptBtnText, { color: Colors.textPrimary }]}>Continue</Text>
              </Pressable>
            </View>
            <Text style={styles.promptHint}>You can also say “finished” or “continue”.</Text>
          </View>
        ) : null}

        {phase === 'promptCopy' ? (
          <View style={styles.promptBox}>
            <Text style={styles.promptTitle}>Copy to clipboard?</Text>
            <View style={styles.promptRow}>
              <Pressable style={[styles.promptBtn, styles.promptPrimary]} onPress={() => finalizeNote(true)}>
                <Feather name="copy" size={18} color={Colors.white} />
                <Text style={styles.promptBtnText}>Yes, copy</Text>
              </Pressable>
              <Pressable style={[styles.promptBtn, styles.promptGhost]} onPress={() => finalizeNote(false)}>
                <Feather name="save" size={18} color={Colors.textPrimary} />
                <Text style={[styles.promptBtnText, { color: Colors.textPrimary }]}>No, just save</Text>
              </Pressable>
            </View>
            <Text style={styles.promptHint}>You can also say “yes” or “no”. It’s saved either way.</Text>
          </View>
        ) : null}

        {/* History */}
        {history.length > 0 ? (
          <View style={styles.historyWrap}>
            <Text style={styles.historyTitle}>Saved notes</Text>
            {history.map((n) => (
              <View key={n.id} style={styles.noteRow}>
                <Text style={styles.noteText} numberOfLines={4}>{n.text}</Text>
                <View style={styles.noteActions}>
                  <TouchableOpacity onPress={() => sendNote(n)} style={styles.noteBtn} hitSlop={8}>
                    <Feather name="send" size={16} color={Colors.primaryDark} />
                    <Text style={styles.noteBtnText}>Send</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => copyNote(n)} style={styles.noteBtn} hitSlop={8}>
                    <Feather name={copiedId === n.id ? 'check' : 'copy'} size={16} color={Colors.primaryDark} />
                    <Text style={styles.noteBtnText}>{copiedId === n.id ? 'Copied' : 'Copy'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => removeNote(n)} style={styles.noteBtn} hitSlop={8}>
                    <Feather name="trash-2" size={16} color={Colors.danger} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* Mic control */}
      <View style={styles.footer}>
        {phase === 'idle' ? (
          <TouchableOpacity style={styles.micBtn} onPress={beginListening}>
            <Feather name="mic" size={28} color={Colors.white} />
            <Text style={styles.micLabel}>Start voice typing</Text>
          </TouchableOpacity>
        ) : phase === 'listening' ? (
          <TouchableOpacity style={[styles.micBtn, styles.micActive]} onPress={stopAndFinish}>
            <Feather name="square" size={24} color={Colors.white} />
            <Text style={styles.micLabel}>Stop &amp; finish</Text>
          </TouchableOpacity>
        ) : phase === 'onhold' ? (
          <TouchableOpacity style={styles.micBtn} onPress={resumeFromHold}>
            <Feather name="mic" size={28} color={Colors.white} />
            <Text style={styles.micLabel}>Resume voice typing</Text>
          </TouchableOpacity>
        ) : (
          <View style={[styles.micBtn, styles.micWaiting]}>
            <Feather name="volume-2" size={22} color={Colors.white} />
            <Text style={styles.micLabel}>Answer the prompt…</Text>
          </View>
        )}
        {isPrompt ? null : (
          <Text style={styles.footerHint}>
            {phase === 'listening'
              ? 'Pause for 10s and I’ll ask if you’re done.'
              : phase === 'onhold'
                ? 'Held — resume any time. Your text is kept.'
                : 'On-device dictation. Needs a device build.'}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary },
  subtitle: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  body: { flex: 1, paddingHorizontal: 16 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.warningLight,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  errorText: { flex: 1, color: Colors.warningDark, fontSize: 13 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    minHeight: 140,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardHeadActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardLabel: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  capsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.surface,
  },
  capsBtnOn: { backgroundColor: Colors.primary },
  capsBtnText: { fontSize: 11, fontWeight: '800', color: Colors.primaryDark, letterSpacing: 0.5 },
  capsBtnTextOn: { color: Colors.white },
  copyInline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  copyInlineText: { color: Colors.primaryDark, fontWeight: '700', fontSize: 13 },
  transcript: { fontSize: 17, lineHeight: 26, color: Colors.textPrimary },
  transcriptPlaceholder: { color: Colors.textMuted, fontStyle: 'italic' },
  polishBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    alignSelf: 'flex-start',
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: Colors.borderLight,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  polishBtnText: { color: Colors.primaryDark, fontWeight: '800', fontSize: 13 },
  promptBox: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    marginTop: 14,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  promptTitle: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, marginBottom: 12 },
  promptRow: { flexDirection: 'row', gap: 12 },
  promptBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
  promptPrimary: { backgroundColor: Colors.primary },
  promptGhost: { backgroundColor: Colors.borderLight, borderWidth: 1, borderColor: Colors.border },
  promptBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  promptHint: { fontSize: 12, color: Colors.textSecondary, marginTop: 10, textAlign: 'center' },
  historyWrap: { marginTop: 22 },
  historyTitle: { fontSize: 14, fontWeight: '800', color: Colors.textSecondary, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  noteRow: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noteText: { fontSize: 15, lineHeight: 22, color: Colors.textPrimary },
  noteActions: { flexDirection: 'row', gap: 18, marginTop: 10, justifyContent: 'flex-end' },
  noteBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  noteBtnText: { color: Colors.primaryDark, fontWeight: '700', fontSize: 13 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: 'center',
  },
  micBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 30,
    width: '100%',
  },
  micActive: { backgroundColor: Colors.danger },
  micWaiting: { backgroundColor: Colors.headerBg },
  micLabel: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  footerHint: { fontSize: 12, color: Colors.textSecondary, marginTop: 8, textAlign: 'center' },
});
