import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Header from '../src/components/Header';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../src/theme';
import {
  BUBBLE_STYLE_OPTIONS,
  INCOMING_BUBBLE_OPTIONS,
  OUTGOING_BUBBLE_OPTIONS,
  TEXT_SIZE_OPTIONS,
  WALLPAPER_OPTIONS,
  getBubbleRadius,
  getBubbleTailRadius,
  getIncomingBubbleColor,
  getOutgoingBubbleColor,
  getTextSize,
  getWallpaperColor,
  normalizeChatAppearance,
} from '../src/lib/chatAppearance';
import {
  CHAT_APPEARANCE_KEY,
  DEFAULT_CHAT_APPEARANCE,
  readStoredJson,
  writeStoredJson,
} from '../src/lib/settingsStorage';

export default function ChatAppearanceScreen() {
  const router = useRouter();
  const [appearance, setAppearance] = useState(DEFAULT_CHAT_APPEARANCE);
  const [statusNote, setStatusNote] = useState('Loading chat appearance…');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const stored = await readStoredJson(CHAT_APPEARANCE_KEY, DEFAULT_CHAT_APPEARANCE);
      if (mounted) {
        setAppearance(normalizeChatAppearance(stored));
        setStatusNote('Saved on this device');
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const previewStyles = useMemo(() => {
    const radius = getBubbleRadius(appearance.bubbleStyle);
    const tail = getBubbleTailRadius(appearance.bubbleStyle);
    const textSize = getTextSize(appearance.textSize);
    return {
      wallpaper: getWallpaperColor(appearance.wallpaper),
      mine: {
        backgroundColor: getOutgoingBubbleColor(appearance.outgoingColor),
        borderRadius: radius,
        borderBottomRightRadius: tail,
      },
      other: {
        backgroundColor: getIncomingBubbleColor(appearance.incomingColor),
        borderRadius: radius,
        borderBottomLeftRadius: tail,
      },
      textSize,
    };
  }, [appearance]);

  const saveAppearance = async (patch: Record<string, string>) => {
    const nextAppearance = normalizeChatAppearance({ ...appearance, ...patch });
    setAppearance(nextAppearance);
    await writeStoredJson(CHAT_APPEARANCE_KEY, nextAppearance);
    setStatusNote('Saved on this device');
  };

  const resetAppearance = async () => {
    setAppearance(DEFAULT_CHAT_APPEARANCE);
    await writeStoredJson(CHAT_APPEARANCE_KEY, DEFAULT_CHAT_APPEARANCE);
    setStatusNote('Reset to default appearance');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="chat-appearance-screen">
      <Header title="Chat Appearance" showBack onBack={() => router.back()} variant="dark" subtitle="Wallpapers and bubble themes" />
      <ScrollView contentContainerStyle={styles.content} testID="chat-appearance-scroll-view">
        <View style={styles.heroCard} testID="chat-appearance-hero-card">
          <View style={styles.heroIconWrap} testID="chat-appearance-hero-icon-wrap">
            <Ionicons name="brush-outline" size={24} color={Colors.primary} />
          </View>
          <View style={styles.flexOne}>
            <Text style={styles.heroTitle} testID="chat-appearance-hero-title">Make chats feel like yours</Text>
            <Text style={styles.heroSub} testID="chat-appearance-hero-subtitle">
              Choose your wallpaper, bubble colours, and message density — with a live preview below.
            </Text>
          </View>
        </View>

        <Text style={styles.statusNote} testID="chat-appearance-status-note">{statusNote}</Text>

        <View style={[styles.previewCard, { backgroundColor: previewStyles.wallpaper }]} testID="chat-appearance-preview-card">
          <Text style={styles.previewTitle} testID="chat-appearance-preview-title">Chat preview</Text>
          <View style={[styles.previewBubble, styles.previewBubbleOther, previewStyles.other]} testID="chat-appearance-preview-other">
            <Text style={[styles.previewText, { fontSize: previewStyles.textSize }]}>Hey! Can we move the meeting to 4:30?</Text>
          </View>
          <View style={[styles.previewBubble, styles.previewBubbleMine, previewStyles.mine]} testID="chat-appearance-preview-mine">
            <Text style={[styles.previewText, { fontSize: previewStyles.textSize }]}>Yes — that works for me. See you then.</Text>
          </View>
        </View>

        <OptionSection
          title="Wallpaper"
          description="Set the chat background tone."
          options={WALLPAPER_OPTIONS}
          value={appearance.wallpaper}
          onSelect={(key) => saveAppearance({ wallpaper: key })}
          optionTestPrefix="chat-appearance-wallpaper"
        />

        <OptionSection
          title="Outgoing bubbles"
          description="Choose the colour for your messages."
          options={OUTGOING_BUBBLE_OPTIONS}
          value={appearance.outgoingColor}
          onSelect={(key) => saveAppearance({ outgoingColor: key })}
          optionTestPrefix="chat-appearance-outgoing"
        />

        <OptionSection
          title="Incoming bubbles"
          description="Choose the colour for replies from others."
          options={INCOMING_BUBBLE_OPTIONS}
          value={appearance.incomingColor}
          onSelect={(key) => saveAppearance({ incomingColor: key })}
          optionTestPrefix="chat-appearance-incoming"
        />

        <OptionSection
          title="Bubble style"
          description="Control the overall bubble shape."
          options={BUBBLE_STYLE_OPTIONS}
          value={appearance.bubbleStyle}
          onSelect={(key) => saveAppearance({ bubbleStyle: key })}
          optionTestPrefix="chat-appearance-bubble-style"
        />

        <OptionSection
          title="Message size"
          description="Choose how compact or spacious chat text feels."
          options={TEXT_SIZE_OPTIONS}
          value={appearance.textSize}
          onSelect={(key) => saveAppearance({ textSize: key })}
          optionTestPrefix="chat-appearance-text-size"
        />

        <TouchableOpacity style={styles.resetButton} onPress={resetAppearance} testID="chat-appearance-reset-button">
          <Ionicons name="refresh-outline" size={18} color={Colors.primary} />
          <Text style={styles.resetButtonText}>Reset to default</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function OptionSection({
  title,
  description,
  options,
  value,
  onSelect,
  optionTestPrefix,
}: {
  title: string;
  description: string;
  options: Array<{ key: string; label: string; color?: string }>;
  value: string;
  onSelect: (key: string) => void;
  optionTestPrefix: string;
}) {
  return (
    <View style={styles.optionCard} testID={`${optionTestPrefix}-card`}>
      <Text style={styles.sectionTitle} testID={`${optionTestPrefix}-title`}>{title}</Text>
      <Text style={styles.sectionSub} testID={`${optionTestPrefix}-subtitle`}>{description}</Text>
      <View style={styles.optionGrid} testID={`${optionTestPrefix}-grid`}>
        {options.map((option) => {
          const selected = value === option.key;
          return (
            <TouchableOpacity
              key={option.key}
              style={[styles.optionChip, selected ? styles.optionChipActive : null]}
              onPress={() => onSelect(option.key)}
              testID={`${optionTestPrefix}-${option.key}`}
            >
              {option.color ? <View style={[styles.swatch, { backgroundColor: option.color }]} /> : null}
              <Text style={[styles.optionChipText, selected ? styles.optionChipTextActive : null]}>{option.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.base, paddingBottom: 56, gap: Spacing.base },
  heroCard: {
    flexDirection: 'row',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
  },
  heroIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryLight,
  },
  heroTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  heroSub: { marginTop: 4, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  statusNote: { fontSize: FontSize.sm, color: Colors.textSecondary },
  previewCard: {
    borderRadius: Radius.lg,
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 10,
  },
  previewTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  previewBubble: {
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  previewBubbleMine: { alignSelf: 'flex-end' },
  previewBubbleOther: { alignSelf: 'flex-start' },
  previewText: { color: Colors.textPrimary },
  optionCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
  },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  sectionSub: { marginTop: 4, marginBottom: Spacing.base, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  optionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  optionChip: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  optionChipActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryLight },
  optionChipText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: Colors.textSecondary },
  optionChipTextActive: { color: Colors.primaryDark },
  swatch: { width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: '#00000010' },
  resetButton: {
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  resetButtonText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: Colors.textPrimary },
  flexOne: { flex: 1 },
});