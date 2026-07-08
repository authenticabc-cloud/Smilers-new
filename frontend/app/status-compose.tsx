import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  ScrollView,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useMutation } from 'convex/react';
import { api } from '../src/convexApi';
import { Colors, FontSize, FontWeight, Spacing, Shadow } from '../src/theme';

const BG_PRESETS = [
  { id: 'amber', bg: '#F4A93B', fg: '#FFFFFF' },
  { id: 'brown', bg: '#3A2608', fg: '#FBC871' },
  { id: 'rose', bg: '#E11D48', fg: '#FFFFFF' },
  { id: 'violet', bg: '#7C3AED', fg: '#FFFFFF' },
  { id: 'emerald', bg: '#059669', fg: '#FFFFFF' },
  { id: 'ocean', bg: '#0EA5E9', fg: '#FFFFFF' },
  { id: 'slate', bg: '#1F2937', fg: '#FBC871' },
  { id: 'cream', bg: '#F5EFE0', fg: '#3A2608' },
];

export default function StatusComposeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ initialText?: string }>();
  const [text, setText] = useState(params.initialText || '');
  const [bgIdx, setBgIdx] = useState(0);
  const [posting, setPosting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const createStatus = useMutation(api.statuses.create);
  const palette = BG_PRESETS[bgIdx];

  // Step 1: open the preview/confirm sheet instead of posting immediately.
  const onPreview = useCallback(() => {
    if (!text.trim()) return;
    setShowPreview(true);
  }, [text]);

  // Step 2: actually publish after the user confirms.
  const onConfirmPost = useCallback(async () => {
    const value = text.trim();
    if (!value) return;
    setPosting(true);
    try {
      await createStatus({
        type: 'text',
        content: value,
        backgroundColor: palette.bg,
        textColor: palette.fg,
      });
      setShowPreview(false);
      router.back();
    } catch (errorValue: any) {
      Alert.alert('Failed to post status', errorValue?.message || 'Unknown error');
    } finally {
      setPosting(false);
    }
  }, [text, palette, createStatus, router]);

  return (
    <View style={[styles.container, { backgroundColor: palette.bg }]} testID="status-compose-screen">
      <SafeAreaView edges={['top', 'bottom']} style={styles.flexOne}>
        <KeyboardAvoidingView style={styles.flexOne} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="status-close">
              <Feather name="x" size={26} color={palette.fg} />
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: palette.fg }]}>Status</Text>
            <TouchableOpacity onPress={onPreview} hitSlop={12} disabled={!text.trim() || posting} testID="status-post">
              <Text style={[styles.headerPost, { color: palette.fg, opacity: text.trim() ? 1 : 0.4 }]}>Preview</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.canvas}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Type a status…"
              placeholderTextColor={`${palette.fg}99`}
              style={[styles.input, { color: palette.fg }]}
              multiline
              autoFocus
              maxLength={500}
              textAlign="center"
              testID="status-text-input"
            />
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.palette}>
            {BG_PRESETS.map((preset, idx) => (
              <TouchableOpacity
                key={preset.id}
                style={[styles.swatch, { backgroundColor: preset.bg }, idx === bgIdx ? styles.swatchActive : null]}
                onPress={() => setBgIdx(idx)}
                testID={`status-bg-${preset.id}`}
              />
            ))}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {/* Preview & confirm sheet — shows exactly how the status will look
          before it goes live. */}
      <Modal visible={showPreview} transparent animationType="fade" onRequestClose={() => setShowPreview(false)}>
        <View style={styles.previewBackdrop}>
          <View style={styles.previewSheet}>
            <Text style={styles.previewTitle}>Preview your status</Text>
            <View style={[styles.previewCard, { backgroundColor: palette.bg }]}>
              <Text style={[styles.previewText, { color: palette.fg }]}>{text.trim()}</Text>
            </View>
            <Text style={styles.previewHint}>Visible to your contacts for 24 hours.</Text>
            <View style={styles.previewActions}>
              <TouchableOpacity
                style={[styles.previewBtn, styles.previewBtnGhost]}
                onPress={() => setShowPreview(false)}
                disabled={posting}
                testID="status-preview-edit"
              >
                <Feather name="edit-2" size={16} color={Colors.textPrimary} />
                <Text style={styles.previewBtnGhostText}>Keep editing</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.previewBtn, styles.previewBtnPrimary]}
                onPress={onConfirmPost}
                disabled={posting}
                testID="status-preview-confirm"
              >
                {posting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Feather name="send" size={16} color="#fff" />
                    <Text style={styles.previewBtnPrimaryText}>Confirm &amp; Post</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flexOne: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  headerPost: { fontSize: FontSize.base, fontWeight: FontWeight.bold, letterSpacing: 0.3 },
  canvas: { flex: 1, justifyContent: 'center', paddingHorizontal: Spacing.lg },
  input: { fontSize: 28, fontWeight: FontWeight.bold, lineHeight: 36, minHeight: 120 },
  palette: { paddingHorizontal: Spacing.base, paddingBottom: Spacing.lg, gap: 10, alignItems: 'center' },
  swatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
    ...Shadow.sm,
  },
  swatchActive: { borderColor: '#FFFFFF', borderWidth: 3, transform: [{ scale: 1.12 }] },
  previewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  previewSheet: {
    backgroundColor: Colors.surface,
    borderRadius: 20,
    padding: Spacing.lg,
  },
  previewTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: Spacing.md,
    textAlign: 'center',
  },
  previewCard: {
    borderRadius: 16,
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  previewText: { fontSize: 22, fontWeight: FontWeight.bold, textAlign: 'center', lineHeight: 30 },
  previewHint: {
    marginTop: Spacing.md,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  previewActions: { flexDirection: 'row', gap: 12, marginTop: Spacing.lg },
  previewBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  previewBtnGhost: { backgroundColor: Colors.surfaceMuted || '#EFE7D6' },
  previewBtnGhostText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  previewBtnPrimary: { backgroundColor: Colors.primary },
  previewBtnPrimaryText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: '#fff' },
});