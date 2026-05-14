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
  const createStatus = useMutation(api.statuses.create);
  const palette = BG_PRESETS[bgIdx];

  const onPost = useCallback(async () => {
    const value = text.trim();
    if (!value) return;

    setPosting(true);
    try {
      await createStatus({
        type: 'text',
        text: value,
        backgroundColor: palette.bg,
        textColor: palette.fg,
      });
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
            <TouchableOpacity onPress={onPost} hitSlop={12} disabled={!text.trim() || posting} testID="status-post">
              {posting ? (
                <ActivityIndicator color={palette.fg} />
              ) : (
                <Text style={[styles.headerPost, { color: palette.fg, opacity: text.trim() ? 1 : 0.4 }]}>Post</Text>
              )}
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
});