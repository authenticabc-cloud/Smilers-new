/**
 * Devotional Broadcasts — Compose
 *
 * Three modes (selected via segmented control):
 *   1. Text  → user types a devotional + optional title; sends
 *              api.devotionals.create({type: 'text', text, title?})
 *   2. Voice → record via expo-audio (HIGH_QUALITY preset),
 *              upload, then create({type: 'voice', storageId, duration, mimeType, fileSize, title?})
 *   3. Video → pick/record via ImagePicker (Videos), upload, then
 *              create({type: 'video', ...})
 *
 * Uses the existing uploadFile helper (api.messages.generateUploadUrl
 * flow). Title is optional but encouraged so the feed has a glance-able
 * heading regardless of devotional type.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useConvex, useMutation } from 'convex/react';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

import { api } from '../../src/convexApi';
import { uploadFile } from '../../src/lib/uploadFile';
import { Colors, FontSize, FontWeight, Radius, Shadow, Spacing } from '../../src/theme';

type ComposeMode = 'text' | 'voice' | 'video';

export default function DevotionalsComposeScreen() {
  const router = useRouter();
  const convex = useConvex();
  const createDevotional = useMutation((api as any).devotionals?.create);

  const [mode, setMode] = useState<ComposeMode>('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  const [recordedDuration, setRecordedDuration] = useState<number>(0);
  const [pickedVideo, setPickedVideo] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const recordStartMsRef = useRef<number>(0);

  // ===== Audio recorder (same plumbing as chat voice notes) =====
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder, 250);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: true,
      shouldRouteThroughEarpiece: false,
    }).catch(() => undefined);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Microphone permission needed', 'Enable microphone access in Settings → Apps → Smilers to record a voice devotional.');
        return;
      }
      await audioRecorder.prepareToRecordAsync();
      recordStartMsRef.current = Date.now();
      setRecordedUri(null);
      setRecordedDuration(0);
      audioRecorder.record();
    } catch (errorValue: any) {
      Alert.alert('Recording failed', errorValue?.message || 'Could not start the recording.');
    }
  }, [audioRecorder]);

  const stopRecording = useCallback(async () => {
    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      const ms = recorderState.durationMillis || Date.now() - recordStartMsRef.current;
      setRecordedUri(uri || null);
      setRecordedDuration(Math.max(1, Math.round(ms / 1000)));
    } catch (errorValue: any) {
      Alert.alert('Recording stopped with an error', errorValue?.message || 'Please try again.');
    }
  }, [audioRecorder, recorderState.durationMillis]);

  const discardRecording = useCallback(() => {
    setRecordedUri(null);
    setRecordedDuration(0);
  }, []);

  // ===== Video pick / record =====
  const pickVideo = useCallback(async (source: 'library' | 'camera') => {
    try {
      const permission =
        source === 'library'
          ? await ImagePicker.requestMediaLibraryPermissionsAsync()
          : await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Permission needed',
          `Enable ${source === 'camera' ? 'camera' : 'media library'} access in Settings to add a video devotional.`,
        );
        return;
      }
      const launch =
        source === 'library' ? ImagePicker.launchImageLibraryAsync : ImagePicker.launchCameraAsync;
      const result = await launch({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        quality: 0.5,
        allowsEditing: false,
        videoMaxDuration: 120,
      });
      if (result.canceled || !result.assets?.[0]) return;
      setPickedVideo(result.assets[0]);
    } catch (errorValue: any) {
      Alert.alert('Video selection failed', errorValue?.message || 'Unknown error.');
    }
  }, []);

  // ===== Submit =====
  const canSubmit = (() => {
    if (submitting) return false;
    if (mode === 'text') return text.trim().length > 0;
    if (mode === 'voice') return !!recordedUri && recordedDuration > 0;
    if (mode === 'video') return !!pickedVideo?.uri;
    return false;
  })();

  const onSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const trimmedTitle = title.trim();
      if (mode === 'text') {
        await (createDevotional as any)({
          type: 'text',
          text: text.trim(),
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
        });
      } else if (mode === 'voice' && recordedUri) {
        const info = await FileSystem.getInfoAsync(recordedUri).catch(() => null);
        const fileSize =
          info && typeof (info as any).size === 'number' ? (info as any).size : undefined;
        const storageId = await uploadFile(convex, recordedUri, 'audio/m4a');
        await (createDevotional as any)({
          type: 'voice',
          storageId,
          duration: recordedDuration,
          mimeType: 'audio/m4a',
          ...(fileSize ? { fileSize } : {}),
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
        });
      } else if (mode === 'video' && pickedVideo) {
        const mime = pickedVideo.mimeType || 'video/mp4';
        const storageId = await uploadFile(convex, pickedVideo.uri, mime);
        const durationSec = pickedVideo.duration
          ? Math.round(pickedVideo.duration / 1000)
          : undefined;
        await (createDevotional as any)({
          type: 'video',
          storageId,
          mimeType: mime,
          ...(durationSec ? { duration: durationSec } : {}),
          ...(typeof pickedVideo.fileSize === 'number' ? { fileSize: pickedVideo.fileSize } : {}),
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
        });
      }
      Alert.alert('Devotional posted', 'Your broadcast is now visible to your audience.', [
        {
          text: 'OK',
          onPress: () => router.back(),
        },
      ]);
    } catch (errorValue: any) {
      const message = String(errorValue?.message || '');
      if (
        message.includes('CouldNotFindFunction') ||
        message.toLowerCase().includes('not found')
      ) {
        Alert.alert(
          'Devotionals backend pending',
          'The api.devotionals.create endpoint isn\u2019t deployed yet. Once the web team ships it, your post will go through.',
        );
      } else {
        Alert.alert('Could not post', message || 'Unknown error.');
      }
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, convex, createDevotional, mode, pickedVideo, recordedDuration, recordedUri, router, text, title]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="devotionals-compose-back">
          <Feather name="arrow-left" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New devotional</Text>
        <TouchableOpacity
          onPress={onSubmit}
          disabled={!canSubmit}
          hitSlop={12}
          testID="devotionals-submit"
        >
          {submitting ? (
            <ActivityIndicator color={Colors.primary} />
          ) : (
            <Text style={[styles.postButton, !canSubmit ? styles.postButtonDisabled : null]}>
              Post
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === 'ios' ? 60 : 0}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Type segmented control */}
          <View style={styles.modeRow}>
            <ModeButton
              icon="file-document-edit-outline"
              label="Text"
              active={mode === 'text'}
              onPress={() => setMode('text')}
              testID="devotional-mode-text"
            />
            <ModeButton
              icon="microphone-outline"
              label="Voice"
              active={mode === 'voice'}
              onPress={() => setMode('voice')}
              testID="devotional-mode-voice"
            />
            <ModeButton
              icon="video-outline"
              label="Video"
              active={mode === 'video'}
              onPress={() => setMode('video')}
              testID="devotional-mode-video"
            />
          </View>

          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Title (optional)"
            placeholderTextColor={Colors.textMuted}
            style={styles.titleInput}
            maxLength={120}
            testID="devotional-title-input"
          />

          {mode === 'text' ? (
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Share a devotion in your own words…"
              placeholderTextColor={Colors.textMuted}
              style={styles.textInput}
              multiline
              textAlignVertical="top"
              testID="devotional-text-input"
            />
          ) : null}

          {mode === 'voice' ? (
            <View style={styles.recordBox}>
              {recordedUri ? (
                <View style={styles.previewRow}>
                  <MaterialCommunityIcons name="microphone" size={20} color={Colors.primary} />
                  <Text style={styles.previewLabel}>
                    Recorded · {Math.floor(recordedDuration / 60)}:
                    {(recordedDuration % 60).toString().padStart(2, '0')}
                  </Text>
                  <TouchableOpacity onPress={discardRecording} hitSlop={8} testID="devotional-voice-discard">
                    <Feather name="trash-2" size={18} color={Colors.danger} />
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.previewRow}>
                  <Text style={styles.previewHint}>
                    {recorderState.isRecording
                      ? `Recording… ${Math.floor((recorderState.durationMillis || 0) / 1000)}s`
                      : 'Tap the mic to start recording'}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                onPress={recorderState.isRecording ? stopRecording : startRecording}
                style={[
                  styles.recordButton,
                  recorderState.isRecording ? styles.recordButtonActive : null,
                ]}
                disabled={!!recordedUri}
                testID="devotional-voice-record-btn"
              >
                <MaterialCommunityIcons
                  name={recorderState.isRecording ? 'stop' : 'microphone'}
                  size={32}
                  color={Colors.white}
                />
              </TouchableOpacity>
              <Text style={styles.recordHint}>
                {recorderState.isRecording
                  ? 'Tap stop when done'
                  : recordedUri
                    ? 'Tap the trash icon to record again'
                    : 'Up to 5 minutes recommended'}
              </Text>
            </View>
          ) : null}

          {mode === 'video' ? (
            <View style={styles.videoBox}>
              {pickedVideo ? (
                <View style={styles.videoPickedCard}>
                  <MaterialCommunityIcons name="video" size={20} color={Colors.primary} />
                  <Text style={styles.previewLabel} numberOfLines={1}>
                    {pickedVideo.fileName || 'video.mp4'}
                  </Text>
                  <TouchableOpacity onPress={() => setPickedVideo(null)} hitSlop={8} testID="devotional-video-clear">
                    <Feather name="x" size={18} color={Colors.danger} />
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.videoPickerRow}>
                  <TouchableOpacity
                    onPress={() => pickVideo('camera')}
                    style={styles.videoBtn}
                    testID="devotional-video-camera"
                  >
                    <Feather name="video" size={20} color={Colors.primary} />
                    <Text style={styles.videoBtnText}>Record</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => pickVideo('library')}
                    style={styles.videoBtn}
                    testID="devotional-video-library"
                  >
                    <Feather name="folder" size={20} color={Colors.primary} />
                    <Text style={styles.videoBtnText}>Choose from library</Text>
                  </TouchableOpacity>
                </View>
              )}
              <Text style={styles.recordHint}>Keep videos under 2 minutes for best reach.</Text>
            </View>
          ) : null}

          <View style={styles.translateNotice}>
            <Feather name="globe" size={14} color={Colors.textSecondary} />
            <Text style={styles.translateNoticeText}>
              Your devotional will be auto-translated for viewers whose preferred
              language differs from yours.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ModeButton({
  icon,
  label,
  active,
  onPress,
  testID,
}: {
  icon: any;
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.modeButton, active ? styles.modeButtonActive : null]}
      onPress={onPress}
      testID={testID}
    >
      <MaterialCommunityIcons name={icon} size={20} color={active ? Colors.primary : Colors.textSecondary} />
      <Text style={[styles.modeLabel, active ? styles.modeLabelActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  flexOne: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  postButton: { color: Colors.primary, fontWeight: FontWeight.bold, fontSize: FontSize.base },
  postButtonDisabled: { color: Colors.textMuted },
  scrollContent: { padding: Spacing.base, paddingBottom: 40 },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  modeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  modeButtonActive: { borderColor: Colors.primary, backgroundColor: '#F2FBF5' },
  modeLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: FontWeight.medium },
  modeLabelActive: { color: Colors.primary },
  titleInput: {
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    marginBottom: 12,
  },
  textInput: {
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    padding: 12,
    minHeight: 220,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  recordBox: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    alignItems: 'center',
    gap: 14,
    ...Shadow.sm,
  },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  previewLabel: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.medium, flex: 1 },
  previewHint: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 },
  recordButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordButtonActive: { backgroundColor: Colors.danger },
  recordHint: { fontSize: FontSize.xs, color: Colors.textMuted, textAlign: 'center' },
  videoBox: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    gap: 12,
    ...Shadow.sm,
  },
  videoPickedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: Radius.md,
    backgroundColor: Colors.background,
  },
  videoPickerRow: { flexDirection: 'row', gap: 10 },
  videoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  videoBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: FontWeight.medium },
  translateNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: Radius.md,
    backgroundColor: '#E6F8EC',
  },
  translateNoticeText: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary },
});
