import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Colors, FontSize, FontWeight, Radius, Shadow } from '../src/theme';
import {
  BUBBLE_THEME_OPTIONS,
  BUBBLE_STYLE_OPTIONS,
  INCOMING_BUBBLE_OPTIONS,
  OUTGOING_BUBBLE_OPTIONS,
  TEXT_SIZE_OPTIONS,
  WALLPAPER_OPTIONS,
  getBubbleRadius,
  getBubbleTailRadius,
  getIncomingBubbleColor,
  getOutgoingBubbleColor,
  getWallpaperCardColors,
  getTextSize,
  getWallpaperPreviewColors,
  normalizeChatAppearance,
} from '../src/lib/chatAppearance';
import {
  CHAT_APPEARANCE_KEY,
  DEFAULT_CHAT_APPEARANCE,
  readStoredJson,
  writeStoredJson,
} from '../src/lib/settingsStorage';

type AppearanceTab = 'wallpapers' | 'bubble-theme';
type ChatAppearanceState = typeof DEFAULT_CHAT_APPEARANCE;

export default function ChatAppearanceScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [appearance, setAppearance] = useState(DEFAULT_CHAT_APPEARANCE);
  const [activeTab, setActiveTab] = useState<AppearanceTab>('wallpapers');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const stored = await readStoredJson(CHAT_APPEARANCE_KEY, DEFAULT_CHAT_APPEARANCE);
      if (mounted) {
        setAppearance(normalizeChatAppearance(stored));
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
      wallpaper: getWallpaperPreviewColors(appearance.wallpaper),
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

  const selectedThemeKey = useMemo(
    () =>
      BUBBLE_THEME_OPTIONS.find(
        (item) =>
          item.wallpaper === appearance.wallpaper &&
          item.outgoingColor === appearance.outgoingColor &&
          item.incomingColor === appearance.incomingColor &&
          item.bubbleStyle === appearance.bubbleStyle &&
          item.textSize === appearance.textSize
      )?.key || '',
    [appearance]
  );

  const wallpaperCardSize = Math.max(94, Math.floor((width - 32 - 24) / 3));

  const saveAppearance = async (patch: Partial<ChatAppearanceState>) => {
    const nextAppearance = normalizeChatAppearance({ ...appearance, ...patch });
    setAppearance(nextAppearance);
    await writeStoredJson(CHAT_APPEARANCE_KEY, nextAppearance);
  };

  const resetAppearance = async () => {
    setAppearance(DEFAULT_CHAT_APPEARANCE);
    await writeStoredJson(CHAT_APPEARANCE_KEY, DEFAULT_CHAT_APPEARANCE);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']} testID="chat-appearance-screen">
      <StatusBar style="light" backgroundColor={Colors.headerBg} />

      <View style={styles.header} testID="chat-appearance-header">
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBackButton} testID="chat-appearance-back-button">
            <Ionicons name="arrow-back" size={31} color={Colors.white} />
          </TouchableOpacity>
          <MaterialCommunityIcons name="brush-variant" size={31} color={Colors.white} testID="chat-appearance-header-icon" />
          <Text style={styles.headerTitle} testID="chat-appearance-header-title">Chat Appearance</Text>
        </View>
      </View>

      <View style={styles.tabBar} testID="chat-appearance-tab-bar">
        <AppearanceTabButton
          icon="image-outline"
          label="Wallpapers"
          active={activeTab === 'wallpapers'}
          onPress={() => setActiveTab('wallpapers')}
          testID="chat-appearance-tab-wallpapers"
        />
        <AppearanceTabButton
          icon="brush-outline"
          label="Bubble Theme"
          active={activeTab === 'bubble-theme'}
          onPress={() => setActiveTab('bubble-theme')}
          testID="chat-appearance-tab-bubble-theme"
        />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="chat-appearance-scroll-view">
        <View style={styles.previewShell} testID="chat-appearance-preview-shell">
          <LinearGradient colors={previewStyles.wallpaper} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.previewCard}>
            <Text style={styles.previewTitle} testID="chat-appearance-preview-title">Preview</Text>
            <View style={[styles.previewBubble, styles.previewBubbleOther, previewStyles.other]} testID="chat-appearance-preview-other">
              <Text style={[styles.previewMessageText, { fontSize: previewStyles.textSize }]} testID="chat-appearance-preview-other-text">
                Hey! How are you?
              </Text>
              <Text style={styles.previewTime} testID="chat-appearance-preview-other-time">10:30 AM</Text>
            </View>

            <View style={[styles.previewBubble, styles.previewBubbleMine, previewStyles.mine]} testID="chat-appearance-preview-mine">
              <Text style={[styles.previewMessageTextMine, { fontSize: previewStyles.textSize }]} testID="chat-appearance-preview-mine-text">
                I'm great, thanks!
              </Text>
              <Text style={styles.previewTimeMine} testID="chat-appearance-preview-mine-time">10:31 AM</Text>
            </View>
          </LinearGradient>
        </View>

        {activeTab === 'wallpapers' ? (
          <>
            <Text style={styles.sectionHeading} testID="chat-appearance-wallpaper-heading">CHOOSE A WALLPAPER</Text>
            <View style={styles.wallpaperGrid} testID="chat-appearance-wallpaper-grid">
              {WALLPAPER_OPTIONS.map((option) => {
                const selected = appearance.wallpaper === option.key;
                return (
                  <TouchableOpacity
                    key={option.key}
                    activeOpacity={0.9}
                    onPress={() => saveAppearance({ wallpaper: option.key })}
                    style={[
                      styles.wallpaperCard,
                      { width: wallpaperCardSize, height: Math.round(wallpaperCardSize * 1.64) },
                      selected ? styles.wallpaperCardSelected : null,
                    ]}
                    testID={`chat-appearance-wallpaper-${option.key}`}
                  >
                    <LinearGradient colors={getWallpaperCardColors(option.key)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.wallpaperArtwork}>
                      {selected ? (
                        <View style={styles.selectedBadge} testID={`chat-appearance-wallpaper-selected-${option.key}`}>
                          <Ionicons name="checkmark" size={20} color={Colors.headerBg} />
                        </View>
                      ) : null}
                    </LinearGradient>
                    <View style={styles.wallpaperFooter} testID={`chat-appearance-wallpaper-label-${option.key}`}>
                      <Text style={styles.wallpaperFooterText}>{option.label}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        ) : (
          <>
            <Text style={styles.sectionHeading} testID="chat-appearance-bubble-heading">CHOOSE A BUBBLE THEME</Text>
            <View style={styles.themeGrid} testID="chat-appearance-theme-grid">
              {BUBBLE_THEME_OPTIONS.map((option) => {
                const themeSelected = selectedThemeKey === option.key;
                return (
                  <TouchableOpacity
                    key={option.key}
                    style={[styles.themeCard, themeSelected ? styles.themeCardSelected : null]}
                    activeOpacity={0.9}
                    onPress={() =>
                      saveAppearance({
                        wallpaper: option.wallpaper,
                        outgoingColor: option.outgoingColor,
                        incomingColor: option.incomingColor,
                        bubbleStyle: option.bubbleStyle,
                        textSize: option.textSize,
                      })
                    }
                    testID={`chat-appearance-theme-${option.key}`}
                  >
                    <LinearGradient
                      colors={getWallpaperPreviewColors(option.wallpaper)}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.themePreview}
                    >
                      <View
                        style={[
                          styles.themePreviewBubble,
                          styles.themePreviewBubbleLeft,
                          { backgroundColor: getIncomingBubbleColor(option.incomingColor) },
                        ]}
                      />
                      <View
                        style={[
                          styles.themePreviewBubble,
                          styles.themePreviewBubbleRight,
                          { backgroundColor: getOutgoingBubbleColor(option.outgoingColor) },
                        ]}
                      />
                    </LinearGradient>
                    <View style={styles.themeTextRow}>
                      <Text style={styles.themeTitle} testID={`chat-appearance-theme-title-${option.key}`}>{option.label}</Text>
                      {themeSelected ? <Ionicons name="checkmark-circle" size={20} color={Colors.primary} /> : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <BubbleChoiceSection
              title="Outgoing bubble"
              options={OUTGOING_BUBBLE_OPTIONS}
              value={appearance.outgoingColor}
              onSelect={(key) => saveAppearance({ outgoingColor: key })}
              testPrefix="chat-appearance-outgoing"
            />

            <BubbleChoiceSection
              title="Incoming bubble"
              options={INCOMING_BUBBLE_OPTIONS}
              value={appearance.incomingColor}
              onSelect={(key) => saveAppearance({ incomingColor: key })}
              testPrefix="chat-appearance-incoming"
            />

            <ChoicePillSection
              title="Bubble shape"
              options={BUBBLE_STYLE_OPTIONS}
              value={appearance.bubbleStyle}
              onSelect={(key) => saveAppearance({ bubbleStyle: key })}
              testPrefix="chat-appearance-shape"
            />

            <ChoicePillSection
              title="Message size"
              options={TEXT_SIZE_OPTIONS}
              value={appearance.textSize}
              onSelect={(key) => saveAppearance({ textSize: key })}
              testPrefix="chat-appearance-size"
            />

            <TouchableOpacity style={styles.resetButton} onPress={resetAppearance} testID="chat-appearance-reset-button">
              <Ionicons name="refresh-outline" size={18} color={Colors.primary} />
              <Text style={styles.resetButtonText}>Reset to screenshot style</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function AppearanceTabButton({
  icon,
  label,
  active,
  onPress,
  testID,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity style={styles.tabButton} activeOpacity={0.9} onPress={onPress} testID={testID}>
      <View style={styles.tabButtonInner}>
        <Ionicons name={icon} size={22} color={active ? Colors.primary : '#7B736A'} />
        <Text style={[styles.tabButtonText, active ? styles.tabButtonTextActive : null]}>{label}</Text>
      </View>
      <View style={[styles.tabUnderline, active ? styles.tabUnderlineActive : null]} />
    </TouchableOpacity>
  );
}

function BubbleChoiceSection({
  title,
  options,
  value,
  onSelect,
  testPrefix,
}: {
  title: string;
  options: Array<{ key: string; label: string; color: string }>;
  value: string;
  onSelect: (key: string) => void;
  testPrefix: string;
}) {
  return (
    <View style={styles.optionSection} testID={`${testPrefix}-section`}>
      <Text style={styles.optionSectionTitle} testID={`${testPrefix}-title`}>{title}</Text>
      <View style={styles.choiceWrap} testID={`${testPrefix}-grid`}>
        {options.map((option) => {
          const selected = option.key === value;
          return (
            <TouchableOpacity
              key={option.key}
              style={[styles.colorChoice, selected ? styles.colorChoiceSelected : null]}
              activeOpacity={0.9}
              onPress={() => onSelect(option.key)}
              testID={`${testPrefix}-${option.key}`}
            >
              <View style={[styles.colorDot, { backgroundColor: option.color }]} />
              <Text style={styles.colorChoiceText}>{option.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function ChoicePillSection({
  title,
  options,
  value,
  onSelect,
  testPrefix,
}: {
  title: string;
  options: Array<{ key: string; label: string }>;
  value: string;
  onSelect: (key: string) => void;
  testPrefix: string;
}) {
  return (
    <View style={styles.optionSection} testID={`${testPrefix}-section`}>
      <Text style={styles.optionSectionTitle} testID={`${testPrefix}-title`}>{title}</Text>
      <View style={styles.choiceWrap} testID={`${testPrefix}-choices`}>
        {options.map((option) => {
          const selected = value === option.key;
          return (
            <TouchableOpacity
              key={option.key}
              onPress={() => onSelect(option.key)}
              activeOpacity={0.9}
              style={[styles.choicePill, selected ? styles.choicePillSelected : null]}
              testID={`${testPrefix}-${option.key}`}
            >
              <Text style={[styles.choicePillText, selected ? styles.choicePillTextSelected : null]}>{option.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F3EC' },
  header: {
    backgroundColor: Colors.headerBg,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 18,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 64,
  },
  headerBackButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -6,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#F8F5EE',
    borderBottomWidth: 1,
    borderBottomColor: '#E8DCC2',
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
  },
  tabButtonInner: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  tabButtonText: {
    fontSize: 17,
    fontWeight: FontWeight.medium,
    color: '#6F665C',
  },
  tabButtonTextActive: {
    color: Colors.primary,
    fontWeight: FontWeight.semibold,
  },
  tabUnderline: {
    width: '100%',
    height: 4,
    backgroundColor: 'transparent',
  },
  tabUnderlineActive: {
    backgroundColor: Colors.primary,
  },
  content: {
    paddingBottom: 54,
  },
  previewShell: {
    backgroundColor: '#F7F3EC',
    borderTopWidth: 1,
    borderTopColor: '#F2DDB1',
    borderBottomWidth: 1,
    borderBottomColor: '#E8DCC2',
  },
  previewCard: {
    minHeight: 440,
    paddingTop: 58,
    paddingHorizontal: 22,
    paddingBottom: 46,
  },
  previewTitle: {
    fontSize: 18,
    fontWeight: FontWeight.medium,
    color: 'rgba(79, 60, 15, 0.45)',
    textAlign: 'center',
    marginBottom: 40,
  },
  previewBubble: {
    maxWidth: '82%',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 14,
    ...Shadow.md,
  },
  previewBubbleMine: {
    alignSelf: 'flex-end',
    marginTop: 18,
    minWidth: '58%',
  },
  previewBubbleOther: {
    alignSelf: 'flex-start',
    minWidth: '60%',
  },
  previewMessageText: {
    color: '#18483B',
    fontWeight: FontWeight.medium,
  },
  previewMessageTextMine: {
    color: '#F7FFFB',
    fontWeight: FontWeight.medium,
  },
  previewTime: {
    marginTop: 12,
    fontSize: 14,
    color: 'rgba(55, 92, 89, 0.52)',
    textAlign: 'right',
  },
  previewTimeMine: {
    marginTop: 12,
    fontSize: 14,
    color: 'rgba(233, 248, 244, 0.82)',
    textAlign: 'right',
  },
  sectionHeading: {
    fontSize: 18,
    color: '#57514A',
    letterSpacing: 1.8,
    paddingHorizontal: 18,
    paddingTop: 34,
    paddingBottom: 18,
  },
  wallpaperGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 18,
  },
  wallpaperCard: {
    overflow: 'hidden',
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  wallpaperCardSelected: {
    borderColor: Colors.primary,
    borderWidth: 3,
  },
  wallpaperArtwork: {
    flex: 1,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    padding: 10,
  },
  selectedBadge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFC51E',
  },
  wallpaperFooter: {
    backgroundColor: 'rgba(80, 79, 73, 0.62)',
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  wallpaperFooterText: {
    fontSize: 13,
    fontWeight: FontWeight.semibold,
    color: Colors.white,
    textAlign: 'center',
  },
  themeGrid: {
    paddingHorizontal: 18,
    gap: 12,
  },
  themeCard: {
    backgroundColor: Colors.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E8DCC2',
    overflow: 'hidden',
  },
  themeCardSelected: {
    borderColor: Colors.primary,
    borderWidth: 2,
  },
  themePreview: {
    minHeight: 124,
    padding: 14,
    justifyContent: 'space-between',
  },
  themePreviewBubble: {
    height: 28,
    borderRadius: 18,
  },
  themePreviewBubbleLeft: {
    width: '50%',
  },
  themePreviewBubbleRight: {
    width: '58%',
    alignSelf: 'flex-end',
  },
  themeTextRow: {
    minHeight: 54,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  themeTitle: {
    fontSize: 15,
    fontWeight: FontWeight.semibold,
    color: '#3F372D',
  },
  optionSection: {
    paddingHorizontal: 18,
    paddingTop: 28,
  },
  optionSectionTitle: {
    fontSize: 16,
    fontWeight: FontWeight.semibold,
    color: '#5D5146',
    marginBottom: 14,
  },
  choiceWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  colorChoice: {
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: Radius.pill,
    backgroundColor: '#FFF9EF',
    borderWidth: 1,
    borderColor: '#E8DCC2',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  colorChoiceSelected: {
    borderColor: Colors.primary,
    backgroundColor: '#FFF0C9',
  },
  colorDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#00000010',
  },
  colorChoiceText: {
    fontSize: 14,
    color: '#4B453D',
    fontWeight: FontWeight.medium,
  },
  choicePill: {
    minHeight: 46,
    paddingHorizontal: 18,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF9EF',
    borderWidth: 1,
    borderColor: '#E8DCC2',
  },
  choicePillSelected: {
    backgroundColor: '#FFF0C9',
    borderColor: Colors.primary,
  },
  choicePillText: {
    fontSize: 14,
    color: '#665E55',
    fontWeight: FontWeight.medium,
  },
  choicePillTextSelected: {
    color: Colors.headerBg,
    fontWeight: FontWeight.semibold,
  },
  resetButton: {
    minHeight: 52,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E8DCC2',
    backgroundColor: '#FFF9EF',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 18,
    marginTop: 28,
  },
  resetButtonText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: '#4B453D',
  },
});