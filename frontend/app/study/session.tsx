/**
 * Study AI session screen — ask a question (text + photos/PDF), pick a
 * response mode, and read the step-by-step reply. Premium-gated via the
 * `ask` action (PREMIUM_REQUIRED). Reply renders reactively from getSession.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Colors } from '../../src/theme';
import { StudyAnswer } from '../../src/components/study/StudyAnswer';
import {
  isPremiumRequiredError,
  useStudyAsk,
  useStudySession,
  useStudySessions,
  useStudySpeak,
  type StudyMode,
} from '../../src/lib/study/useStudyAi';

const MODES: { key: StudyMode; label: string }[] = [
  { key: 'guided', label: 'Guide me' },
  { key: 'hint', label: 'Hint' },
  { key: 'explain', label: 'Explain' },
  { key: 'check_work', label: 'Check my work' },
  { key: 'verify', label: 'Just verify' },
  { key: 'similar_practice', label: 'Similar practice' },
];

const STUDY_LANGS = ['English', 'Italian', 'French', 'Spanish', 'German', 'Portuguese', 'Arabic'];

function answerToText(m: any): string {
  const a = m?.answer || m?.reply || m || {};
  if (typeof a === 'string') return a;
  const parts: string[] = [];
  if (a.summary) parts.push(String(a.summary));
  const steps = a.steps || [];
  if (Array.isArray(steps)) {
    for (const s of steps) {
      const t = s?.explanation || s?.text;
      if (t) parts.push(String(t));
    }
  }
  if (a.finalAnswer || a.final_answer) parts.push(String(a.finalAnswer || a.final_answer));
  if (parts.length === 0 && (a.content || a.body || a.message)) {
    parts.push(String(a.content || a.body || a.message));
  }
  return parts.join('. ');
}

export default function StudySession() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ sessionId?: string; subject?: string; mode?: string; capture?: string }>();
  const [sessionId, setSessionId] = useState<string | null>(params.sessionId || null);
  const [text, setText] = useState('');
  const [images, setImages] = useState<{ uri: string; mime?: string }[]>([]);
  const [mode, setMode] = useState<StudyMode>((params.mode as StudyMode) || 'guided');
  const [targetLang, setTargetLang] = useState('English');
  const subject = params.subject;
  const isLanguage = subject === 'language';

  const { ask, uploadImages, asking, uploading } = useStudyAsk();
  const { speak, stop, speakingId } = useStudySpeak();
  const { session } = useStudySession(sessionId);
  const { setSessionSaved } = useStudySessions();
  const scrollRef = useRef<ScrollView>(null);
  const capturedRef = useRef(false);

  const messages: any[] = session?.messages || session?.thread || [];
  const isSaved = !!session?.isSaved;

  const pickFromCamera = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera needed', 'Allow camera access to photograph homework.', [
        { text: 'OK' },
      ]);
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.7 });
    if (!res.canceled && res.assets?.[0]) {
      setImages((prev) => [...prev, { uri: res.assets[0].uri, mime: res.assets[0].mimeType }].slice(0, 5));
    }
  }, []);

  const pickFromGallery = useCallback(async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 5,
      quality: 0.7,
    });
    if (!res.canceled) {
      setImages((prev) =>
        [...prev, ...res.assets.map((a) => ({ uri: a.uri, mime: a.mimeType }))].slice(0, 5),
      );
    }
  }, []);

  const pickPdf = useCallback(async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
    if (!res.canceled && res.assets?.[0]) {
      setImages((prev) => [...prev, { uri: res.assets[0].uri, mime: 'application/pdf' }].slice(0, 5));
    }
  }, []);

  // Auto-open camera when launched from the "Scan Homework" card.
  useEffect(() => {
    if (params.capture === '1' && !capturedRef.current) {
      capturedRef.current = true;
      pickFromCamera();
    }
  }, [params.capture, pickFromCamera]);

  const send = useCallback(async () => {
    if (asking || uploading) return;
    if (!text.trim() && images.length === 0) return;
    try {
      const imageStorageIds = images.length ? await uploadImages(images) : undefined;
      const res: any = await ask({
        sessionId,
        text: text.trim() || undefined,
        imageStorageIds,
        mode: isLanguage ? undefined : mode,
        subject,
        language: isLanguage ? targetLang : 'English',
      });
      const newId = res?.sessionId || res?._id || sessionId;
      if (newId && newId !== sessionId) setSessionId(String(newId));
      setText('');
      setImages([]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 250);
    } catch (err: any) {
      if (isPremiumRequiredError(err)) {
        Alert.alert('Study AI is Premium', 'Upgrade to use the AI tutor.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Upgrade', onPress: () => router.push('/premium' as any) },
        ]);
      } else {
        Alert.alert('Something went wrong', err?.data?.message || err?.message || 'Please try again.');
      }
    }
  }, [asking, uploading, text, images, uploadImages, ask, sessionId, mode, subject, isLanguage, targetLang]);

  const toggleSaved = useCallback(() => {
    if (!sessionId) return;
    setSessionSaved({ sessionId, isSaved: !isSaved } as any).catch(() => {});
  }, [sessionId, isSaved, setSessionSaved]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior="padding"
    >
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Feather name="arrow-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {session?.title || subject ? String(session?.title || subject) : 'Study AI'}
        </Text>
        {sessionId ? (
          <TouchableOpacity onPress={toggleSaved} hitSlop={10}>
            <Feather name={isSaved ? 'bookmark' : 'bookmark'} size={22} color={isSaved ? Colors.primary : Colors.textSecondary} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.thread}
        contentContainerStyle={styles.threadContent}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="edit-3" size={28} color={Colors.textSecondary} />
            <Text style={styles.emptyText}>
              Ask a question or scan your homework. I&apos;ll guide you step by step.
            </Text>
          </View>
        ) : null}

        {messages.map((m: any, i: number) => {
          const role = m.role || m.sender || (m.answer || m.steps ? 'assistant' : 'user');
          if (role === 'user') {
            return (
              <View key={m._id || i} style={styles.userBubble}>
                {m.text ? <Text style={styles.userText}>{m.text}</Text> : null}
              </View>
            );
          }
          const bubbleId = String(m._id || `ai-${i}`);
          const isSpeaking = speakingId === bubbleId;
          return (
            <View key={m._id || i} style={styles.aiBubble}>
              <StudyAnswer answer={m.answer || m.reply || m} />
              {isLanguage ? (
                <TouchableOpacity
                  style={styles.readAloudBtn}
                  onPress={() =>
                    isSpeaking ? stop() : speak(bubbleId, answerToText(m), targetLang)
                  }
                  hitSlop={8}
                >
                  <Feather
                    name={isSpeaking ? 'square' : 'volume-2'}
                    size={16}
                    color={Colors.primary}
                  />
                  <Text style={styles.readAloudText}>
                    {isSpeaking ? 'Stop' : 'Read aloud'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}

        {(asking || uploading) ? (
          <View style={styles.thinking}>
            <ActivityIndicator color={Colors.primary} />
            <Text style={styles.thinkingText}>{uploading ? 'Uploading…' : 'Thinking…'}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Response mode chips (or target-language chips in Language Coach) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.modeScroll}
        contentContainerStyle={styles.modeRow}
      >
        {isLanguage
          ? STUDY_LANGS.map((lang) => (
              <TouchableOpacity
                key={lang}
                onPress={() => setTargetLang(lang)}
                style={[styles.modeChip, targetLang === lang && styles.modeChipOn]}
              >
                <Text style={[styles.modeChipText, targetLang === lang && styles.modeChipTextOn]}>
                  {lang}
                </Text>
              </TouchableOpacity>
            ))
          : MODES.map((mo) => (
              <TouchableOpacity
                key={mo.key}
                onPress={() => setMode(mo.key)}
                style={[styles.modeChip, mode === mo.key && styles.modeChipOn]}
              >
                <Text style={[styles.modeChipText, mode === mo.key && styles.modeChipTextOn]}>
                  {mo.label}
                </Text>
              </TouchableOpacity>
            ))}
      </ScrollView>

      {images.length > 0 ? (
        <ScrollView horizontal style={styles.thumbs} showsHorizontalScrollIndicator={false}>
          {images.map((im, idx) => (
            <View key={idx} style={styles.thumbWrap}>
              {im.mime === 'application/pdf' ? (
                <View style={styles.pdfThumb}>
                  <Feather name="file-text" size={22} color={Colors.primary} />
                </View>
              ) : (
                <Image source={{ uri: im.uri }} style={styles.thumb} />
              )}
              <Pressable
                style={styles.thumbClose}
                onPress={() => setImages((prev) => prev.filter((_, j) => j !== idx))}
              >
                <Feather name="x" size={12} color="#fff" />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
        <TouchableOpacity onPress={pickFromCamera} style={styles.iconBtn} hitSlop={6}>
          <Feather name="camera" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={pickFromGallery} style={styles.iconBtn} hitSlop={6}>
          <Feather name="image" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={pickPdf} style={styles.iconBtn} hitSlop={6}>
          <Feather name="file-text" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          placeholder="Ask a question…"
          placeholderTextColor={Colors.textSecondary}
          value={text}
          onChangeText={setText}
          multiline
        />
        <TouchableOpacity
          onPress={send}
          disabled={asking || uploading || (!text.trim() && images.length === 0)}
          style={[
            styles.sendBtn,
            (asking || uploading || (!text.trim() && images.length === 0)) && styles.sendBtnDisabled,
          ]}
        >
          <Feather name="arrow-up" size={20} color="#fff" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border || 'rgba(0,0,0,0.06)',
  },
  headerTitle: { flex: 1, color: Colors.textPrimary, fontSize: 17, fontWeight: '700' },
  thread: { flex: 1 },
  threadContent: { padding: 16, gap: 14 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 48, paddingHorizontal: 24 },
  emptyText: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: Colors.primary,
    borderRadius: 16,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userText: { color: '#fff', fontSize: 15, lineHeight: 21 },
  aiBubble: {
    backgroundColor: Colors.surface || '#fff',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border || 'rgba(0,0,0,0.06)',
  },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  thinkingText: { color: Colors.textSecondary, fontSize: 14 },
  modeRow: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  modeScroll: { flexGrow: 0, maxHeight: 52 },
  modeChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: Colors.surfaceMuted || 'rgba(0,0,0,0.05)',
    marginRight: 8,
  },
  modeChipOn: { backgroundColor: Colors.primary },
  modeChipText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },
  modeChipTextOn: { color: '#fff' },
  readAloudBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(37,99,235,0.08)',
  },
  readAloudText: { color: Colors.primary, fontSize: 13, fontWeight: '600' },
  thumbs: { maxHeight: 76, paddingHorizontal: 12 },
  thumbWrap: { marginRight: 8, marginBottom: 8 },
  thumb: { width: 60, height: 60, borderRadius: 10 },
  pdfThumb: {
    width: 60,
    height: 60,
    borderRadius: 10,
    backgroundColor: 'rgba(37,99,235,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbClose: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border || 'rgba(0,0,0,0.06)',
    backgroundColor: Colors.background,
  },
  iconBtn: { padding: 8 },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    backgroundColor: Colors.surfaceMuted || 'rgba(0,0,0,0.05)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    color: Colors.textPrimary,
    fontSize: 15,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
});
