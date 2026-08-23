/**
 * DocScanModal — "Enhance / Scan" a document photo. Sends the image to the
 * backend, which returns a scanner-quality cleaned image + a text
 * transcription (Gemini). Shows both; the transcription is selectable so it
 * can be copied.
 *
 * Accepts EITHER a resolved `imageUri` (data:/http(s)/file URI, e.g. Share Once
 * broadcast photos) OR an encrypted chat `msg` + `e2ee` status, which it
 * decrypts on-demand via `useDecryptedMediaUrl`. Pass `msg={null}` while closed
 * so the hook never fetches in the background.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useDecryptedMediaUrl } from '../../hooks/useDecryptedMediaUrl';
import { savePhotoToGallery } from '../../lib/savePhotoToGallery';
import { Colors } from '../../theme';

/** Write an enhanced `data:...;base64,...` image to a temp file:// for sharing. */
async function enhancedDataUriToFile(dataUri: string): Promise<string> {
  const comma = dataUri.indexOf(',');
  const header = dataUri.slice(5, comma); // e.g. "image/png;base64"
  const mime = header.split(';')[0] || 'image/png';
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const out = `${LegacyFileSystem.cacheDirectory}scanned_${Date.now()}.${ext}`;
  await LegacyFileSystem.writeAsStringAsync(out, dataUri.slice(comma + 1), { encoding: 'base64' as any });
  return out;
}

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL;

/** Turn any image URI (data:/file:/http(s):) into raw base64 + mime type. */
async function uriToBase64(uri: string): Promise<{ base64: string; mimeType: string }> {
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    const header = uri.slice(5, comma); // e.g. "image/png;base64"
    const mimeType = header.split(';')[0] || 'image/jpeg';
    return { base64: uri.slice(comma + 1), mimeType };
  }
  if (uri.startsWith('file://')) {
    const base64 = await LegacyFileSystem.readAsStringAsync(uri, { encoding: 'base64' as any });
    return { base64, mimeType: 'image/jpeg' };
  }
  // Remote http(s): download to cache first, then read as base64.
  const dest = `${LegacyFileSystem.cacheDirectory}docscan_${Date.now()}.img`;
  const dl = await LegacyFileSystem.downloadAsync(uri, dest);
  const base64 = await LegacyFileSystem.readAsStringAsync(dl.uri, { encoding: 'base64' as any });
  try {
    await LegacyFileSystem.deleteAsync(dl.uri, { idempotent: true });
  } catch {
    /* best-effort cleanup */
  }
  return { base64, mimeType: 'image/jpeg' };
}

export default function DocScanModal({
  visible,
  imageUri,
  msg,
  e2ee,
  onClose,
}: {
  visible: boolean;
  imageUri?: string | null;
  msg?: any;
  e2ee?: any;
  onClose: () => void;
}) {
  const resolved = useDecryptedMediaUrl(msg ?? null, e2ee ?? null);
  const effectiveUri = imageUri ?? resolved.url;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enhanced, setEnhanced] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<string>('');
  const [action, setAction] = useState<null | 'save' | 'share'>(null);

  const handleSave = async () => {
    if (!enhanced || action) return;
    setAction('save');
    try {
      const ok = await savePhotoToGallery(enhanced);
      if (ok) Alert.alert('Saved', 'Scanned document saved to your gallery.');
    } catch {
      Alert.alert('Could not save', 'Something went wrong saving the scanned document.');
    } finally {
      setAction(null);
    }
  };

  const handleShare = async () => {
    if (!enhanced || action) return;
    setAction('share');
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Sharing unavailable', 'Sharing is not available on this device.');
        return;
      }
      const fileUri = await enhancedDataUriToFile(enhanced);
      await Sharing.shareAsync(fileUri, { dialogTitle: 'Share scanned document' });
    } catch {
      Alert.alert('Could not share', 'Something went wrong sharing the scanned document.');
    } finally {
      setAction(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!visible || !effectiveUri) return;
    setBusy(true);
    setError(null);
    setEnhanced(null);
    setTranscription('');
    (async () => {
      try {
        const { base64, mimeType } = await uriToBase64(effectiveUri);
        const res = await fetch(`${BACKEND}/api/documents/enhance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: base64, mimeType }),
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setEnhanced(
          data.enhancedImageBase64
            ? `data:${data.enhancedMimeType || 'image/png'};base64,${data.enhancedImageBase64}`
            : null
        );
        setTranscription(data.transcription || '');
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Could not process the document.');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, effectiveUri]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>Document scan</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12} testID="doc-scan-close">
            <Ionicons name="close" size={26} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>

        {busy || (!effectiveUri && visible) ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.hint}>Cleaning up and reading the document…</Text>
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Ionicons name="alert-circle-outline" size={40} color="#e53935" />
            <Text style={styles.hint}>{error}</Text>
            <TouchableOpacity style={styles.retry} onPress={onClose}>
              <Text style={styles.retryText}>Close</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
            {enhanced ? (
              <View>
                <Text style={styles.sectionLbl}>ENHANCED</Text>
                <Image source={{ uri: enhanced }} style={styles.enhImg} resizeMode="contain" />
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.actionBtn}
                    onPress={handleSave}
                    disabled={!!action}
                    testID="doc-scan-save"
                  >
                    {action === 'save' ? (
                      <ActivityIndicator size="small" color={Colors.primary} />
                    ) : (
                      <Ionicons name="download-outline" size={20} color={Colors.primary} />
                    )}
                    <Text style={styles.actionLabel}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.actionBtn}
                    onPress={handleShare}
                    disabled={!!action}
                    testID="doc-scan-share"
                  >
                    {action === 'share' ? (
                      <ActivityIndicator size="small" color={Colors.primary} />
                    ) : (
                      <Ionicons name="share-outline" size={20} color={Colors.primary} />
                    )}
                    <Text style={styles.actionLabel}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
            {transcription ? (
              <View>
                <Text style={styles.sectionLbl}>TRANSCRIPTION (tap &amp; hold to copy)</Text>
                <View style={styles.textBox}>
                  <Text style={styles.transcript} selectable>{transcription}</Text>
                </View>
              </View>
            ) : (
              !enhanced ? <Text style={styles.hint}>No readable content found.</Text> : null
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border || '#e5e7eb' },
  title: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  hint: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  retry: { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  retryText: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  sectionLbl: { fontSize: 12, fontWeight: '800', color: Colors.textSecondary, letterSpacing: 0.5, marginBottom: 8 },
  enhImg: { width: '100%', height: 360, borderRadius: 12, backgroundColor: '#000' },
  actionRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border || '#e5e7eb',
  },
  actionLabel: { fontSize: 15, fontWeight: '700', color: Colors.primary },
  textBox: { backgroundColor: Colors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: Colors.border || '#e5e7eb' },
  transcript: { fontSize: 15, color: Colors.textPrimary, lineHeight: 22 },
});
