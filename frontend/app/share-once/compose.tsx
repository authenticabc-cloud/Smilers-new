/**
 * Share Once — compose a post (any content type) + pick who can view it.
 * Uses the same 3-step media upload as chat (uploadFile → storageId).
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { useConvex, useMutation } from 'convex/react';
import { api } from '../../src/convexApi';
import Header from '../../src/components/Header';
import { Colors } from '../../src/theme';
import { uploadFile } from '../../src/lib/uploadFile';
import { computeFileHashFromUri } from '../../src/lib/fileHash';
import { VOICE_RECORDING_OPTIONS } from '../../src/lib/audioRecording';
import AudiencePicker, { AudienceSelection } from '../../src/components/shareOnce/AudiencePicker';

type Attachment = { uri: string; type: 'image' | 'video' | 'audio' | 'file' | 'voice'; mime: string; name?: string; size?: number; duration?: number };

const fmtDur = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function ShareOnceCompose() {
  const router = useRouter();
  const convex = useConvex();
  const createPost = useMutation(api.shareOnce.createPost);
  const [text, setText] = useState('');
  const [att, setAtt] = useState<Attachment | null>(null);
  const [audience, setAudience] = useState<AudienceSelection>({ audienceMode: 'all' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 250);

  const pickMedia = async (mediaTypes: 'images' | 'videos') => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to attach media.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes, quality: 0.9 });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    setAtt({ uri: a.uri, type: mediaTypes === 'images' ? 'image' : 'video', mime: a.mimeType || (mediaTypes === 'images' ? 'image/jpeg' : 'video/mp4'), name: a.fileName || undefined, size: a.fileSize });
  };

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow camera access to take a photo/video.');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    const isVid = (a.type || '').includes('video');
    setAtt({ uri: a.uri, type: isVid ? 'video' : 'image', mime: a.mimeType || (isVid ? 'video/mp4' : 'image/jpeg'), name: a.fileName || undefined, size: a.fileSize });
  };

  const pickDoc = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: '*/*' });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    const mime = a.mimeType || 'application/octet-stream';
    const type: Attachment['type'] = mime.startsWith('audio/') ? 'audio' : 'file';
    setAtt({ uri: a.uri, type, mime, name: a.name, size: a.size ?? undefined });
  };

  // Attach an existing audio file from the device.
  const pickAudioFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: 'audio/*' });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    setAtt({ uri: a.uri, type: 'audio', mime: a.mimeType || 'audio/mpeg', name: a.name, size: a.size ?? undefined });
  };

  // Voice note mic — same choice pattern as the other attach buttons:
  // record a new voice note OR attach an existing audio file.
  const onVoicePress = () => {
    Alert.alert('Voice note', 'Record a new voice note or attach an audio file.', [
      { text: 'Record', onPress: () => void startRecording() },
      { text: 'Attach audio', onPress: () => void pickAudioFile() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const startRecording = useCallback(async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Microphone needed', 'Allow microphone access to record a voice note.');
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'duckOthers',
        shouldRouteThroughEarpiece: false,
      });
      await new Promise((r) => setTimeout(r, 120));
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch (e: any) {
      setRecording(false);
      Alert.alert('Recording failed', e?.message || 'Could not start recording.');
    }
  }, [recorder]);

  const stopRecording = useCallback(
    async (action: 'save' | 'cancel') => {
      const totalSec = Math.max(1, Math.round((recorderState.durationMillis || 0) / 1000));
      setRecording(false);
      let uri: string | null = null;
      try {
        await recorder.stop();
        uri = recorder.uri;
      } catch {}
      if (action === 'cancel' || !uri) return;
      // Copy out of the volatile cache into a stable path before upload.
      let playable = uri;
      try {
        const dir = `${LegacyFileSystem.documentDirectory}voice-notes`;
        const info: any = await LegacyFileSystem.getInfoAsync(dir);
        if (!info?.exists) await LegacyFileSystem.makeDirectoryAsync(dir, { intermediates: true });
        const dest = `${dir}/so-vn-${Date.now()}.m4a`;
        await LegacyFileSystem.copyAsync({ from: uri, to: dest });
        const copied: any = await LegacyFileSystem.getInfoAsync(dest, { size: true } as any);
        if (copied?.exists && Number(copied?.size || 0) > 0) playable = dest;
      } catch {}
      setAtt({ uri: playable, type: 'voice', mime: 'audio/m4a', name: 'Voice note', duration: totalSec });
    },
    [recorder, recorderState.durationMillis],
  );

  const post = async () => {
    if (busy) return;
    if (!att && !text.trim()) {
      Alert.alert('Nothing to post', 'Add a message or attach a file.');
      return;
    }
    setBusy(true);
    try {
      const args: any = { type: att ? att.type : 'text', ...audience };
      if (text.trim()) args.text = text.trim();
      if (att) {
        const storageId = await uploadFile(convex, att.uri, att.mime);
        args.storageId = storageId;
        if (att.name) args.fileName = att.name;
        if (att.size) args.fileSize = att.size;
        args.mimeType = att.mime;
        if (att.duration) args.duration = att.duration;
        const hash = await computeFileHashFromUri(att.uri);
        if (hash) args.fileHash = hash;
      }
      const res: any = await createPost(args);
      Alert.alert('Shared', `${res?.viewerCount ?? 0} people can now view this. Invite links were sent.`);
      router.back();
    } catch (e: any) {
      Alert.alert('Could not share', e?.data?.message || e?.message || 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const audienceLabel: Record<AudienceSelection['audienceMode'], string> = {
    all: 'Everyone', trustees: 'Only Trustees', voiceTask: 'Only Voice-task users', specific: 'Only selected', allExcept: 'Everyone except',
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header title="New Share Once" showBack onBack={() => router.back()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
          <TextInput
            style={styles.input}
            placeholder="Write a message… (optional if you attach a file)"
            placeholderTextColor={Colors.textMuted}
            value={text}
            onChangeText={setText}
            multiline
            testID="share-once-text"
          />

          {att ? (
            <View style={styles.attWrap}>
              {att.type === 'image' ? (
                <Image source={{ uri: att.uri }} style={styles.attImg} />
              ) : (
                <View style={styles.attFile}>
                  <Ionicons name={att.type === 'video' ? 'videocam' : att.type === 'audio' || att.type === 'voice' ? 'musical-notes' : 'document'} size={26} color={Colors.primary} />
                  <Text style={styles.attName} numberOfLines={1}>
                    {att.type === 'voice' ? `Voice note · ${fmtDur(att.duration || 0)}` : att.name || att.type}
                  </Text>
                </View>
              )}
              <TouchableOpacity style={styles.attRemove} onPress={() => setAtt(null)}>
                <Ionicons name="close-circle" size={24} color="#e53935" />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.attRow}>
              <AttachBtn icon="camera" label="Camera" onPress={takePhoto} />
              <AttachBtn icon="image" label="Photo" onPress={() => pickMedia('images')} />
              <AttachBtn icon="film" label="Video" onPress={() => pickMedia('videos')} />
              <AttachBtn icon="mic" label="Voice" onPress={onVoicePress} />
              <AttachBtn icon="paperclip" label="File" onPress={pickDoc} />
            </View>
          )}

          <TouchableOpacity style={styles.audienceBtn} onPress={() => setPickerOpen(true)} testID="share-once-audience">
            <Ionicons name="people" size={20} color={Colors.primary} />
            <Text style={styles.audienceText}>Who can view: {audienceLabel[audience.audienceMode]}{audience.audienceGroupIds?.length ? ` +${audience.audienceGroupIds.length} group(s)` : ''}</Text>
            <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
        </ScrollView>

        <TouchableOpacity style={[styles.postBtn, busy && { opacity: 0.6 }]} onPress={post} disabled={busy} testID="share-once-post">
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.postText}>Share once</Text>}
        </TouchableOpacity>
      </KeyboardAvoidingView>

      <AudiencePicker visible={pickerOpen} onClose={() => setPickerOpen(false)} onConfirm={(sel) => { setAudience(sel); setPickerOpen(false); }} />

      <Modal visible={recording} transparent animationType="fade" onRequestClose={() => void stopRecording('cancel')}>
        <View style={styles.recBackdrop}>
          <View style={styles.recCard}>
            <View style={styles.recPulse}>
              <Ionicons name="mic" size={30} color="#fff" />
            </View>
            <Text style={styles.recTimer}>{fmtDur(Math.round((recorderState.durationMillis || 0) / 1000))}</Text>
            <Text style={styles.recHint}>Recording voice note…</Text>
            <View style={styles.recBtnRow}>
              <TouchableOpacity style={[styles.recBtn, styles.recCancel]} onPress={() => void stopRecording('cancel')} testID="share-once-rec-cancel">
                <Text style={styles.recCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.recBtn, styles.recStop]} onPress={() => void stopRecording('save')} testID="share-once-rec-stop">
                <Ionicons name="stop" size={18} color="#fff" />
                <Text style={styles.recStopText}>Stop</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function AttachBtn({ icon, label, onPress }: { icon: any; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.attBtn} onPress={onPress} testID={`share-once-attach-${label.toLowerCase()}`}>
      <Feather name={icon} size={22} color={Colors.primary} />
      <Text style={styles.attBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  input: { minHeight: 100, backgroundColor: Colors.surface, borderRadius: 12, padding: 14, fontSize: 16, color: Colors.textPrimary, textAlignVertical: 'top', borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  attRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  attBtn: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: 14, marginHorizontal: 4, borderRadius: 12, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  attBtnText: { fontSize: 12, fontWeight: '700', color: Colors.textPrimary },
  attWrap: { marginTop: 16, position: 'relative' },
  attImg: { width: '100%', height: 220, borderRadius: 12, backgroundColor: '#000' },
  attFile: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 12, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  attName: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  attRemove: { position: 'absolute', top: 8, right: 8, backgroundColor: '#fff', borderRadius: 12 },
  audienceBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20, padding: 14, borderRadius: 12, backgroundColor: 'rgba(233,181,59,0.12)', borderWidth: 1, borderColor: 'rgba(233,181,59,0.35)' },
  audienceText: { flex: 1, fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  postBtn: { margin: 16, height: 52, borderRadius: 26, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  postText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  recBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  recCard: { width: '100%', maxWidth: 340, backgroundColor: '#fff', borderRadius: 20, padding: 24, alignItems: 'center' },
  recPulse: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#e53935', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  recTimer: { fontSize: 30, fontWeight: '800', color: Colors.textPrimary, fontVariant: ['tabular-nums'] },
  recHint: { fontSize: 13, color: Colors.textSecondary, marginTop: 4, marginBottom: 20 },
  recBtnRow: { flexDirection: 'row', gap: 12, alignSelf: 'stretch' },
  recBtn: { flex: 1, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  recCancel: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  recCancelText: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  recStop: { backgroundColor: Colors.primary },
  recStopText: { fontSize: 15, fontWeight: '800', color: '#fff' },
});
